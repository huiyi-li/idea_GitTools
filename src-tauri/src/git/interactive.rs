use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::Write;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RebasePreview {
    pub head: String,
    pub branch: String,
    pub base: Option<String>,
    pub onto: Option<String>,
    pub commits: Vec<Commit>,
    pub merge_count: usize,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct RebaseEntry {
    pub hash: String,
    pub action: String,
    pub message: String,
}

#[derive(Deserialize, Serialize)]
struct Plan {
    preview: RebasePreview,
    entries: Vec<RebaseEntry>,
}

impl Git {
    pub(crate) async fn preview_interactive(
        &self,
        base: &str,
        onto: &str,
    ) -> Result<RebasePreview, String> {
        let repository = self.repository().await?;
        if repository.operation != "none" || !self.status().await?.changes.is_empty() {
            return Err("请先保存本地修改并完成当前 Git 操作".into());
        }
        let head = repository.head.ok_or("仓库尚无提交")?;
        let branch = repository.branch.ok_or("请先签出本地分支")?;
        let base = if base.trim().is_empty() {
            None
        } else {
            Some(self.resolve_commit(base).await?)
        };
        let onto = if onto.trim().is_empty() {
            None
        } else {
            Some(self.resolve_commit(onto).await?)
        };
        let range = base
            .as_ref()
            .map_or_else(|| head.clone(), |base| format!("{base}..{head}"));
        let format = format!("--format={LOG_FORMAT}");
        let commits = parse_commits(
            &self
                .bytes(&[
                    "log",
                    "--reverse",
                    "--topo-order",
                    "--no-merges",
                    "-z",
                    &format,
                    &range,
                    "--",
                ])
                .await?,
        )?;
        let merge_count = self
            .text(&["rev-list", "--count", "--merges", &range, "--"])
            .await?
            .trim()
            .parse()
            .map_err(|_| "合并提交数量无效")?;
        Ok(RebasePreview {
            head,
            branch,
            base,
            onto,
            commits,
            merge_count,
        })
    }

    pub(crate) async fn interactive_command(
        &self,
        preview: RebasePreview,
        entries: Vec<RebaseEntry>,
    ) -> Result<Command, String> {
        let fresh = self
            .preview_interactive(
                preview.base.as_deref().unwrap_or(""),
                preview.onto.as_deref().unwrap_or(""),
            )
            .await?;
        if fresh != preview {
            return Err("分支或提交范围已改变，请重新读取计划".into());
        }
        validate_entries(&preview, &entries)?;
        let directory = PathBuf::from(
            self.text(&["rev-parse", "--absolute-git-dir"])
                .await?
                .trim(),
        );
        let path = directory.join("ideagittool-interactive.json");
        let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        file.write_all(
            &serde_json::to_vec(&Plan {
                preview: preview.clone(),
                entries,
            })
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(&path).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        self.bytes(&[
            "update-ref",
            &format!("refs/ideagittool/interactive/{stamp}"),
            &preview.head,
        ])
        .await?;
        let mut command = Command::new("git");
        command.current_dir(&self.root).args([
            "-c",
            "core.abbrev=40",
            "rebase",
            "--interactive",
            "--reapply-cherry-picks",
            "--empty=keep",
        ]);
        if let Some(onto) = &preview.onto {
            command.args(["--onto", onto]);
        }
        if let Some(base) = &preview.base {
            command.arg(base);
        } else {
            command.arg("--root");
        }
        for (key, value) in self.interactive_environment().await? {
            command.env(key, value);
        }
        Ok(command)
    }

    pub(super) async fn interactive_environment(&self) -> Result<Vec<(String, String)>, String> {
        let directory = PathBuf::from(
            self.text(&["rev-parse", "--absolute-git-dir"])
                .await?
                .trim(),
        );
        let path = directory.join("ideagittool-interactive.json");
        let mut environment = vec![("GIT_EDITOR".into(), "true".into())];
        let rebase = directory.join("rebase-merge");
        let owns_rebase = !rebase.exists()
            || std::fs::read(&path)
                .ok()
                .zip(std::fs::read_to_string(rebase.join("ideagittool-plan")).ok())
                .is_some_and(|(plan, marker)| marker == format!("{:x}", Sha256::digest(plan)));
        if path.exists() && owns_rebase {
            let executable = std::env::current_exe().map_err(|e| e.to_string())?;
            let executable = format!(
                "'{}'",
                executable
                    .to_string_lossy()
                    .replace('\\', "/")
                    .replace('\'', "'\\''")
            );
            environment = vec![
                (
                    "GIT_SEQUENCE_EDITOR".into(),
                    format!("{executable} --git-sequence-editor"),
                ),
                (
                    "GIT_EDITOR".into(),
                    format!("{executable} --git-message-editor"),
                ),
                ("IDEAGITTOOL_REBASE_PLAN".into(), git_path(&path)),
            ];
        }
        Ok(environment)
    }
}

fn validate_entries(preview: &RebasePreview, entries: &[RebaseEntry]) -> Result<(), String> {
    let expected: BTreeSet<_> = preview
        .commits
        .iter()
        .map(|commit| commit.hash.as_str())
        .collect();
    let actual: BTreeSet<_> = entries.iter().map(|entry| entry.hash.as_str()).collect();
    if actual != expected || entries.len() != expected.len() {
        return Err("计划必须包含范围内每个提交各一次".into());
    }
    let mut previous = false;
    for entry in entries {
        if !matches!(
            entry.action.as_str(),
            "pick" | "reword" | "squash" | "fixup" | "drop" | "edit"
        ) {
            return Err("不支持的 Rebase 动作".into());
        }
        if matches!(entry.action.as_str(), "squash" | "fixup") && !previous {
            return Err("Squash 和 Fixup 前需要保留一个提交".into());
        }
        if entry.action == "reword" && entry.message.trim().is_empty() {
            return Err("Reword 需要填写新的提交说明".into());
        }
        if entry.message.len() > MAX_FILE {
            return Err("提交说明过长".into());
        }
        if entry.action != "drop" {
            previous = true;
        }
    }
    Ok(())
}

pub(crate) fn editor_helper() -> bool {
    let action = std::env::args().nth(1).unwrap_or_default();
    if !matches!(
        action.as_str(),
        "--git-sequence-editor" | "--git-message-editor"
    ) {
        return false;
    }
    let result = (|| -> Result<(), String> {
        let path = std::env::var("IDEAGITTOOL_REBASE_PLAN").map_err(|e| e.to_string())?;
        let plan_path = Path::new(&path);
        let plan: Plan =
            serde_json::from_slice(&std::fs::read(plan_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let directory = plan_path.parent().ok_or("Rebase 计划目录无效")?;
        let target = PathBuf::from(std::env::args().nth(2).ok_or("缺少编辑文件")?);
        let target = target.canonicalize().map_err(|e| e.to_string())?;
        if !target.starts_with(directory.canonicalize().map_err(|e| e.to_string())?) {
            return Err("Rebase 编辑文件位于 Git 目录之外".into());
        }
        if action == "--git-sequence-editor" {
            let original = std::fs::read_to_string(&target).map_err(|e| e.to_string())?;
            let todo = sequence_text(&plan, &original)?;
            std::fs::write(target, todo).map_err(|e| e.to_string())?;
            let digest = format!(
                "{:x}",
                Sha256::digest(std::fs::read(plan_path).map_err(|e| e.to_string())?)
            );
            std::fs::write(directory.join("rebase-merge/ideagittool-plan"), digest)
                .map_err(|e| e.to_string())?;
        } else {
            let original_head = std::fs::read_to_string(directory.join("rebase-merge/orig-head"))
                .map_err(|e| e.to_string())?;
            if original_head.trim() != plan.preview.head {
                return Ok(());
            }
            let done = std::fs::read_to_string(directory.join("rebase-merge/done"))
                .map_err(|e| e.to_string())?;
            if let Some(message) = planned_message(&plan, &done) {
                std::fs::write(target, message).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })();
    if let Err(error) = &result {
        eprintln!("{error}");
    }
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

fn sequence_text(plan: &Plan, original: &str) -> Result<String, String> {
    validate_entries(&plan.preview, &plan.entries)?;
    let generated: Vec<_> = original
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_whitespace().nth(1))
        .collect();
    if generated.len() != plan.entries.len()
        || plan.entries.iter().any(|entry| {
            generated
                .iter()
                .filter(|hash| entry.hash.starts_with(**hash))
                .count()
                != 1
        })
    {
        return Err("Git 生成的 Rebase 范围与预览不同，操作已停止".into());
    }
    Ok(plan
        .entries
        .iter()
        .map(|entry| format!("{} {}\n", entry.action, entry.hash))
        .collect())
}

fn planned_message<'a>(plan: &'a Plan, done: &str) -> Option<&'a str> {
    let last = done
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty() && !line.starts_with('#'))?;
    let hash = last.split_whitespace().nth(1)?;
    let index = plan
        .entries
        .iter()
        .position(|entry| entry.hash.starts_with(hash))?;
    let entry = &plan.entries[index];
    if entry.action == "reword" {
        return Some(&entry.message);
    }
    if matches!(entry.action.as_str(), "squash" | "fixup") {
        for entry in plan.entries[..=index].iter().rev() {
            if !matches!(entry.action.as_str(), "squash" | "fixup" | "drop") {
                break;
            }
            if entry.action == "squash" && !entry.message.trim().is_empty() {
                return Some(&entry.message);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    #[tokio::test]
    async fn interactive_plans_pin_the_head_and_reject_unknown_or_duplicate_commands() {
        let directory = fixture();
        std::fs::write(directory.path().join("file.txt"), "base").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "base"]);
        let base = run(directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        std::fs::write(directory.path().join("file.txt"), "second").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "second"]);
        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();
        let preview = git.preview_interactive(&base, "").await.unwrap();
        let mut entry = RebaseEntry {
            hash: preview.commits[0].hash.clone(),
            action: "pick".into(),
            message: String::new(),
        };
        assert!(validate_entries(&preview, &[entry.clone()]).is_ok());
        assert!(validate_entries(&preview, &[entry.clone(), entry.clone()]).is_err());
        entry.action = "exec".into();
        assert!(validate_entries(&preview, &[entry.clone()]).is_err());
        entry.action = "squash".into();
        assert!(validate_entries(&preview, &[entry.clone()]).is_err());
        entry.action = "pick".into();
        let plan = Plan {
            preview: preview.clone(),
            entries: vec![entry.clone()],
        };
        assert!(
            sequence_text(&plan, &format!("pick {} second\n", entry.hash))
                .unwrap()
                .contains(&entry.hash)
        );
        assert!(sequence_text(&plan, &format!("pick {} other\n", "b".repeat(40))).is_err());
        std::fs::write(directory.path().join("file.txt"), "third").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "third"]);
        assert!(git.interactive_command(preview, vec![entry]).await.is_err());
    }
}

use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub(crate) mod lines;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HunkPreview {
    pub path: String,
    pub area: String,
    pub fingerprint: String,
    pub header: String,
    pub hunks: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    #[tokio::test]
    async fn hunk_stage_unstage_and_discard_preserve_other_edits_and_detect_staleness() {
        let directory = fixture();
        let base = (0..40)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        let working = base
            .replace("line 2\n", "first edit\n")
            .replace("line 30\n", "second edit\n");
        std::fs::write(directory.path().join("file.txt"), &base).unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "base"]);
        std::fs::write(directory.path().join("file.txt"), &working).unwrap();
        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();
        let preview = git.preview_hunks("file.txt", "unstaged").await.unwrap();
        assert_eq!(preview.hunks.len(), 2);
        git.apply_hunk(preview.clone(), 0, false).await.unwrap();
        let staged = run(directory.path(), &["show", ":file.txt"]);
        assert!(staged.contains("first edit"));
        assert!(!staged.contains("second edit"));
        assert_eq!(
            std::fs::read_to_string(directory.path().join("file.txt")).unwrap(),
            working
        );
        assert!(git.apply_hunk(preview, 1, false).await.is_err());
        let preview = git.preview_hunks("file.txt", "staged").await.unwrap();
        git.apply_hunk(preview, 0, false).await.unwrap();
        assert_eq!(run(directory.path(), &["show", ":file.txt"]), base);
        let preview = git.preview_hunks("file.txt", "unstaged").await.unwrap();
        git.apply_hunk(preview, 0, true).await.unwrap();
        let result = std::fs::read_to_string(directory.path().join("file.txt")).unwrap();
        assert!(!result.contains("first edit"));
        assert!(result.contains("second edit"));
    }

    #[tokio::test]
    async fn new_literal_files_stage_without_a_head_and_amend_preserves_unstaged_contents() {
        let directory = fixture();
        let path = "空 格 [x].txt";
        std::fs::write(directory.path().join(path), "new\n").unwrap();
        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();
        let preview = git.preview_hunks(path, "unstaged").await.unwrap();
        git.apply_hunk(preview, 0, false).await.unwrap();
        git.commit("first").await.unwrap();
        std::fs::write(directory.path().join(path), "staged\n").unwrap();
        git.stage(vec![path.into()], false).await.unwrap();
        let preview = git.preview_amend().await.unwrap();
        run(directory.path(), &["switch", "-c", "other-branch"]);
        assert!(git
            .amend(&preview.head, &preview.fingerprint, "wrong branch")
            .await
            .is_err());
        run(directory.path(), &["switch", "main"]);
        std::fs::write(directory.path().join(path), "working\n").unwrap();
        git.amend(&preview.head, &preview.fingerprint, "amended message")
            .await
            .unwrap();
        assert_eq!(
            run(directory.path(), &["show", &format!("HEAD:{path}")]),
            "staged\n"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join(path)).unwrap(),
            "working\n"
        );
        assert!(git
            .amend(&preview.head, &preview.fingerprint, "stale")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn new_crlf_files_use_the_same_index_normalization_as_git_add() {
        let directory = fixture();
        run(directory.path(), &["config", "core.autocrlf", "true"]);
        std::fs::write(directory.path().join("new.txt"), b"one\r\ntwo\r\n").unwrap();
        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();
        let preview = git.preview_hunks("new.txt", "unstaged").await.unwrap();
        git.apply_hunk(preview, 0, false).await.unwrap();
        assert_eq!(run(directory.path(), &["show", ":new.txt"]), "one\ntwo\n");
        assert_eq!(
            std::fs::read(directory.path().join("new.txt")).unwrap(),
            b"one\r\ntwo\r\n"
        );
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AmendPreview {
    head: String,
    message: String,
    changes: Vec<Change>,
    fingerprint: String,
}

impl Git {
    pub(crate) async fn preview_hunks(
        &self,
        path: &str,
        area: &str,
    ) -> Result<HunkPreview, String> {
        validate_path(path)?;
        if !matches!(area, "staged" | "unstaged") {
            return Err("请选择暂存区或工作区".into());
        }
        let status = self.status().await?;
        let change = status.changes.iter().find(|change| {
            change.path == path
                && if area == "staged" {
                    change.index != ' ' && change.index != '?'
                } else {
                    change.work_tree != ' ' || change.index == '?'
                }
        });
        let Some(change) = change else {
            return Ok(HunkPreview {
                path: path.into(),
                area: area.into(),
                fingerprint: String::new(),
                header: String::new(),
                hunks: vec![],
            });
        };
        if change.conflict {
            return Err("请先处理文件冲突".into());
        }
        let snapshot = if area == "staged" {
            self.index_snapshot(path, true).await?
        } else {
            self.worktree_snapshot(path, true).await?
        };
        if !matches!(
            snapshot.state,
            content::SnapshotState::Text | content::SnapshotState::Missing
        ) {
            return Err("此文件请使用整文件暂存或取消暂存".into());
        }
        let mut args = vec![
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--unified=3",
        ];
        if area == "staged" {
            args.push("--cached");
        }
        if change.index == '?' {
            args.extend(["--no-index", "--", "/dev/null", path]);
        } else {
            args.extend(["--", path]);
        }
        let output = self.execute(&args, None).await?;
        if output.code != 0 && !(change.index == '?' && output.code == 1) {
            return Err(String::from_utf8_lossy(&output.stderr).into());
        }
        let patch = String::from_utf8(output.stdout).map_err(|_| "补丁不是 UTF-8 文本")?;
        let mut header = String::new();
        let mut hunks: Vec<String> = vec![];
        for line in patch.split_inclusive('\n') {
            if line.starts_with("@@ ") {
                hunks.push(String::new());
            }
            if let Some(hunk) = hunks.last_mut() {
                hunk.push_str(line);
            } else {
                header.push_str(line);
            }
        }
        let mut hash = Sha256::new();
        hash.update(self.root_string());
        hash.update(serde_json::to_vec(&status.repository).map_err(|e| e.to_string())?);
        hash.update(self.bytes(&["ls-files", "--stage", "-z"]).await?);
        super::navigation::hash_path(&mut hash, &self.root.join(path))?;
        hash.update(patch);
        Ok(HunkPreview {
            path: path.into(),
            area: area.into(),
            fingerprint: format!("{:x}", hash.finalize()),
            header,
            hunks,
        })
    }

    pub(crate) async fn apply_hunk(
        &self,
        preview: HunkPreview,
        index: usize,
        discard: bool,
    ) -> Result<(), String> {
        if discard && preview.area != "unstaged" {
            return Err("请在未暂存区域放弃修改".into());
        }
        let index_path = self.root.join(
            self.text(&["rev-parse", "--git-path", "index"])
                .await?
                .trim(),
        );
        let transaction = super::merge::IndexTransaction::new(&index_path)?;
        let fresh = self.preview_hunks(&preview.path, &preview.area).await?;
        if fresh != preview {
            return Err("文件或暂存区已改变，请重新读取变化块".into());
        }
        let hunk = fresh.hunks.get(index).ok_or("变化块已不存在")?;
        let patch = format!("{}{hunk}", fresh.header);
        let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
        if !discard {
            args.push("--cached");
        }
        if discard || preview.area == "staged" {
            args.push("--reverse");
        }
        if !index_path.exists() {
            self.execute_with_env(
                &["read-tree", "--empty"],
                None,
                &[("GIT_INDEX_FILE", transaction.temporary_path())],
            )
            .await?
            .checked()?;
        }
        let mut check = args.clone();
        check.push("--check");
        self.execute_with_env(
            &check,
            Some(patch.as_bytes()),
            &[("GIT_INDEX_FILE", transaction.temporary_path())],
        )
        .await?
        .checked()?;
        self.execute_with_env(
            &args,
            Some(patch.as_bytes()),
            &[("GIT_INDEX_FILE", transaction.temporary_path())],
        )
        .await?
        .checked()?;
        if !discard {
            transaction.commit()?;
        }
        Ok(())
    }

    pub(crate) async fn preview_amend(&self) -> Result<AmendPreview, String> {
        let status = self.status().await?;
        let editing = if status.repository.operation == "rebase" {
            let directory = self.text(&["rev-parse", "--absolute-git-dir"]).await?;
            std::fs::read_to_string(Path::new(directory.trim()).join("rebase-merge/done"))
                .ok()
                .and_then(|done| {
                    done.lines()
                        .rev()
                        .find(|line| !line.trim().is_empty() && !line.starts_with('#'))
                        .map(|line| line.starts_with("edit ") || line.starts_with("e "))
                })
                .unwrap_or(false)
        } else {
            false
        };
        if (status.repository.operation != "none" && !editing)
            || status.changes.iter().any(|change| change.conflict)
        {
            return Err("请先完成当前 Git 操作，Rebase 的 Edit 暂停可使用 Amend".into());
        }
        let head = status.repository.head.clone().ok_or("请先创建首次提交")?;
        let mut hash = Sha256::new();
        hash.update(serde_json::to_vec(&status.repository).map_err(|error| error.to_string())?);
        hash.update(self.bytes(&["ls-files", "--stage", "-z"]).await?);
        let fingerprint = format!("{:x}", hash.finalize());
        Ok(AmendPreview {
            message: self
                .text(&["show", "-s", "--format=%B", &head, "--"])
                .await?,
            head,
            changes: status
                .changes
                .into_iter()
                .filter(|change| change.index != ' ' && change.index != '?')
                .collect(),
            fingerprint,
        })
    }

    pub(crate) async fn amend(
        &self,
        expected_head: &str,
        fingerprint: &str,
        message: &str,
    ) -> Result<(), String> {
        validate_hash(expected_head)?;
        let preview = self.preview_amend().await?;
        if preview.head != expected_head || preview.fingerprint != fingerprint {
            return Err("HEAD、分支或暂存区已改变，请重新获取 Amend 预览".into());
        }
        if message.trim().is_empty() || message.len() > MAX_FILE {
            return Err("请填写有效的提交说明".into());
        }
        self.execute(&["commit", "--amend", "-F", "-"], Some(message.as_bytes()))
            .await?
            .checked()?;
        Ok(())
    }
}

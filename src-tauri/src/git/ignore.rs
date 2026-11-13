use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IgnoreMatch {
    source: String,
    line: usize,
    pattern: String,
    negated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IgnoreState {
    pub path: String,
    pub content: String,
    fingerprint: String,
    file_stamp: String,
    pub matches: Vec<IgnoreMatch>,
    pub tracked_count: usize,
    pub tracked_paths: Vec<String>,
    pub directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IgnoreFiles {
    paths: Vec<String>,
    total: usize,
    has_more: bool,
}

impl Git {
    pub(crate) async fn read_ignore(&self, path: &str) -> Result<IgnoreState, String> {
        if !path.is_empty() {
            validate_path(path)?;
        }
        let ignore = super::discard::checked_path(&self.root, ".gitignore")?;
        if std::fs::metadata(&ignore).is_ok_and(|metadata| metadata.len() > MAX_FILE as u64) {
            return Err(".gitignore 超过 1 MiB，请使用外部编辑器".into());
        }
        let file_stamp = super::merge::stamp(&ignore)?;
        let content = match std::fs::read(&ignore) {
            Ok(bytes) => {
                if bytes.len() > MAX_FILE {
                    return Err(".gitignore 超过 1 MiB，请使用外部编辑器".into());
                }
                String::from_utf8(bytes).map_err(|_| ".gitignore 需要使用 UTF-8 编码")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.to_string()),
        };
        if super::merge::stamp(&ignore)? != file_stamp {
            return Err(".gitignore 已改变，请重新读取".into());
        }
        let index = if path.is_empty() {
            Vec::new()
        } else {
            self.bytes(&[
                "--literal-pathspecs",
                "ls-files",
                "--stage",
                "-z",
                "--",
                path,
            ])
            .await?
        };
        let tracked: std::collections::BTreeSet<_> = std::str::from_utf8(&index)
            .map_err(|_| "文件名不是 UTF-8")?
            .split_terminator('\0')
            .filter_map(|record| record.split_once('\t').map(|(_, path)| path.to_owned()))
            .collect();
        let mut matches = Vec::new();
        if !path.is_empty() {
            let output = self
                .execute(
                    &["check-ignore", "--no-index", "--verbose", "-z", "--stdin"],
                    Some(format!("{path}\0").as_bytes()),
                )
                .await?;
            if output.code != 0 && output.code != 1 {
                return Err(String::from_utf8_lossy(&output.stderr).into());
            }
            let text = std::str::from_utf8(&output.stdout).map_err(|_| "忽略规则不是 UTF-8")?;
            for fields in text
                .split_terminator('\0')
                .collect::<Vec<_>>()
                .chunks_exact(4)
            {
                matches.push(IgnoreMatch {
                    source: fields[0].into(),
                    line: fields[1].parse().map_err(|_| "忽略规则行号无效")?,
                    pattern: fields[2].into(),
                    negated: fields[2].starts_with('!'),
                });
            }
        }
        let mut hash = Sha256::new();
        hash.update(self.root_string());
        hash.update(path);
        hash.update(&file_stamp);
        hash.update(index);
        Ok(IgnoreState {
            path: path.into(),
            content,
            fingerprint: format!("{:x}", hash.finalize()),
            file_stamp,
            matches,
            tracked_count: tracked.len(),
            tracked_paths: tracked.into_iter().take(20).collect(),
            directory: !path.is_empty() && self.root.join(path).is_dir(),
        })
    }

    pub(crate) async fn ignore_files(
        &self,
        kind: &str,
        query: &str,
        offset: usize,
    ) -> Result<IgnoreFiles, String> {
        if query.len() > 4096 || query.contains('\0') || offset > 10_000_000 {
            return Err("文件筛选条件无效".into());
        }
        let mut args = vec!["--literal-pathspecs", "ls-files", "-z"];
        match kind {
            "ignored" => args.extend([
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "--no-empty-directory",
            ]),
            "tracked" => args.push("--cached"),
            _ => return Err("请选择忽略文件或已跟踪文件".into()),
        }
        args.push("--");
        if !query.is_empty() && validate_path(query).is_ok() && self.root.join(query).exists() {
            args.push(query);
        }
        let bytes = self.bytes(&args).await?;
        let query = query.to_lowercase();
        let paths: std::collections::BTreeSet<_> = std::str::from_utf8(&bytes)
            .map_err(|_| "文件名不是 UTF-8")?
            .split_terminator('\0')
            .filter(|path| path.to_lowercase().contains(&query))
            .map(String::from)
            .collect();
        let total = paths.len();
        Ok(IgnoreFiles {
            paths: paths.into_iter().skip(offset).take(PAGE_SIZE).collect(),
            total,
            has_more: offset.saturating_add(PAGE_SIZE) < total,
        })
    }

    pub(crate) async fn edit_ignore(
        &self,
        preview: IgnoreState,
        action: &str,
        value: &str,
    ) -> Result<(), String> {
        if action == "untrack" {
            if preview.path.is_empty() || preview.tracked_count == 0 {
                return Err("请选择已跟踪的文件或目录".into());
            }
            let index = self.root.join(
                self.text(&["rev-parse", "--git-path", "index"])
                    .await?
                    .trim(),
            );
            let transaction = super::merge::IndexTransaction::new(&index)?;
            if self.read_ignore(&preview.path).await? != preview {
                return Err("文件索引或忽略规则已改变，请重新检查路径".into());
            }
            if !self
                .bytes(&[
                    "--literal-pathspecs",
                    "ls-files",
                    "--unmerged",
                    "-z",
                    "--",
                    &preview.path,
                ])
                .await?
                .is_empty()
            {
                return Err("请先解决文件冲突".into());
            }
            self.execute_with_env(
                &[
                    "--literal-pathspecs",
                    "rm",
                    "--cached",
                    "-r",
                    "--",
                    &preview.path,
                ],
                None,
                &[("GIT_INDEX_FILE", transaction.temporary_path())],
            )
            .await?
            .checked()?;
            if self.read_ignore(&preview.path).await? != preview {
                return Err("文件索引或忽略规则已改变，请重新检查路径".into());
            }
            return transaction.commit();
        }
        if self.read_ignore(&preview.path).await? != preview {
            return Err("忽略规则已改变，请重新读取后再修改".into());
        }
        let content = match action {
            "append" => {
                if value.trim().is_empty()
                    || value.len() > 4096
                    || value.contains(['\0', '\n', '\r'])
                {
                    return Err("请输入一行有效的忽略规则".into());
                }
                if preview.content.lines().any(|line| line == value) {
                    return Ok(());
                }
                let newline = if preview.content.contains("\r\n") {
                    "\r\n"
                } else {
                    "\n"
                };
                let mut content = preview.content.clone();
                if !content.is_empty() && !content.ends_with('\n') {
                    content.push_str(newline);
                }
                content.push_str(value);
                content.push_str(newline);
                content
            }
            "replace" => {
                if preview.content.contains("\r\n") {
                    value.replace("\r\n", "\n").replace('\n', "\r\n")
                } else {
                    value.into()
                }
            }
            _ => return Err("未知的忽略规则操作".into()),
        };
        if content.len() > MAX_FILE || content.contains('\0') {
            return Err("忽略规则超过大小限制或包含无效字符".into());
        }
        let path = super::discard::checked_path(&self.root, ".gitignore")?;
        super::merge::atomic_write(&path, content.as_bytes(), Some(&preview.file_stamp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    #[tokio::test]
    async fn ignore_rules_preserve_crlf_explain_nested_sources_and_list_ignored_directories() {
        let dir = fixture();
        std::fs::write(dir.path().join(".gitignore"), "# rules\r\n").unwrap();
        std::fs::create_dir(dir.path().join("build")).unwrap();
        std::fs::write(dir.path().join("build/app.exe"), "binary").unwrap();
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let preview = git.read_ignore("build/app.exe").await.unwrap();
        git.edit_ignore(preview.clone(), "append", "/build/")
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "# rules\r\n/build/\r\n"
        );
        assert!(git.edit_ignore(preview, "append", "*.lib").await.is_err());
        let reason = git.read_ignore("build/app.exe").await.unwrap();
        assert_eq!(reason.matches[0].pattern, "/build/");
        assert_eq!(reason.matches[0].line, 2);
        assert!(git
            .ignore_files("ignored", "", 0)
            .await
            .unwrap()
            .paths
            .contains(&"build/".into()));
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/.gitignore"), "*.tmp\n!keep.tmp\n").unwrap();
        std::fs::write(dir.path().join("src/test.tmp"), "tmp").unwrap();
        let nested = git.read_ignore("src/test.tmp").await.unwrap();
        assert_eq!(nested.matches[0].source, "src/.gitignore");
        assert!(git.read_ignore("src/keep.tmp").await.unwrap().matches[0].negated);
    }

    #[tokio::test]
    async fn stop_tracking_is_transactional_preserves_disk_files_and_rejects_stale_indexes() {
        let dir = fixture();
        let path = "空 格 [x].txt";
        std::fs::write(dir.path().join(path), "base\n").unwrap();
        std::fs::write(dir.path().join("other.txt"), "other\n").unwrap();
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-m", "base"]);
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let preview = git.read_ignore(path).await.unwrap();
        std::fs::write(dir.path().join(path), "staged\n").unwrap();
        run(dir.path(), &["add", "--", path]);
        assert!(git.edit_ignore(preview, "untrack", "").await.is_err());
        std::fs::write(dir.path().join(path), "working\n").unwrap();
        let partial = git.read_ignore(path).await.unwrap();
        assert!(git.edit_ignore(partial, "untrack", "").await.is_err());
        assert_eq!(run(dir.path(), &["show", &format!(":{path}")]), "staged\n");
        run(dir.path(), &["restore", "--staged", "--", path]);
        let preview = git.read_ignore(path).await.unwrap();
        assert_eq!(preview.tracked_count, 1);
        git.edit_ignore(preview, "untrack", "").await.unwrap();
        assert!(run(dir.path(), &["ls-files", "--", path]).is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(path)).unwrap(),
            "working\n"
        );
        assert_eq!(run(dir.path(), &["show", ":other.txt"]), "other\n");
        assert!(!dir.path().join(".git/index.lock").exists());
    }

    #[tokio::test]
    async fn literal_rules_editor_and_directory_untracking_preserve_index_and_disk_semantics() {
        let dir = fixture();
        std::fs::create_dir(dir.path().join("generated")).unwrap();
        std::fs::write(dir.path().join("generated/a [x] #!.txt"), "generated\n").unwrap();
        std::fs::write(dir.path().join(".gitignore"), "# initial\r\n").unwrap();
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-m", "base"]);
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let preview = git.read_ignore("generated/a [x] #!.txt").await.unwrap();
        git.edit_ignore(preview, "append", r"/generated/a\ \[x\]\ \#\!.txt")
            .await
            .unwrap();
        assert_eq!(
            git.read_ignore("generated/a [x] #!.txt")
                .await
                .unwrap()
                .matches
                .len(),
            1
        );
        let preview = git.read_ignore("").await.unwrap();
        git.edit_ignore(preview.clone(), "replace", "# updated\n/generated/\n")
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "# updated\r\n/generated/\r\n"
        );
        assert!(git
            .edit_ignore(preview, "replace", "stale\n")
            .await
            .is_err());
        let preview = git.read_ignore("generated/").await.unwrap();
        std::fs::write(dir.path().join(".git/index.lock"), "locked").unwrap();
        assert!(git
            .edit_ignore(preview.clone(), "untrack", "")
            .await
            .is_err());
        std::fs::remove_file(dir.path().join(".git/index.lock")).unwrap();
        git.edit_ignore(preview, "untrack", "").await.unwrap();
        assert!(run(dir.path(), &["ls-files", "--", "generated"]).is_empty());
        assert!(dir.path().join("generated/a [x] #!.txt").exists());
        assert_eq!(
            git.ignore_files("tracked", "", 0).await.unwrap().paths,
            vec![".gitignore"]
        );
    }
}

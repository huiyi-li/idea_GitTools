use super::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub(crate) struct Tag {
    name: String,
    hash: String,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Management {
    status: Status,
    tags: Vec<Tag>,
    remotes: Vec<super::remotes::Remote>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    async fn tracked() -> (tempfile::TempDir, Git, String) {
        let directory = fixture();
        std::fs::write(directory.path().join("file.txt"), "base\n").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "base"]);
        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();
        let head = git.head().await.unwrap().unwrap();
        (directory, git, head)
    }

    #[tokio::test]
    async fn branch_and_annotated_tag_management_keep_the_expected_commits() {
        let (directory, git, head) = tracked().await;
        run(directory.path(), &["branch", "topic"]);
        git.edit_ref(RefEdit {
            action: "branch-rename".into(),
            name: "topic".into(),
            new_name: "renamed".into(),
            hash: head.clone(),
            message: String::new(),
            force: false,
        })
        .await
        .unwrap();
        git.edit_ref(RefEdit {
            action: "branch-delete".into(),
            name: "renamed".into(),
            new_name: String::new(),
            hash: head.clone(),
            message: String::new(),
            force: false,
        })
        .await
        .unwrap();
        assert!(git
            .edit_ref(RefEdit {
                action: "branch-delete".into(),
                name: "main".into(),
                new_name: String::new(),
                hash: head.clone(),
                message: String::new(),
                force: true
            })
            .await
            .is_err());
        git.edit_ref(RefEdit {
            action: "tag-create".into(),
            name: "v-test".into(),
            new_name: String::new(),
            hash: head,
            message: "release description".into(),
            force: false,
        })
        .await
        .unwrap();
        let tag = git.management().await.unwrap().tags.remove(0);
        assert_eq!(tag.subject, "release description");
        assert_eq!(
            run(directory.path(), &["cat-file", "-t", &tag.hash]).trim(),
            "tag"
        );
        git.edit_ref(RefEdit {
            action: "tag-delete".into(),
            name: tag.name,
            new_name: String::new(),
            hash: tag.hash,
            message: String::new(),
            force: false,
        })
        .await
        .unwrap();
        assert!(git.management().await.unwrap().tags.is_empty());
    }

    #[tokio::test]
    async fn stash_preview_includes_untracked_files_and_pop_restores_the_staged_layout() {
        let (directory, git, _) = tracked().await;
        std::fs::write(directory.path().join("file.txt"), "staged\n").unwrap();
        run(directory.path(), &["add", "file.txt"]);
        std::fs::write(directory.path().join("file.txt"), "working\n").unwrap();
        std::fs::write(directory.path().join("new.txt"), "new\n").unwrap();
        git.edit_stash(StashEdit {
            action: "save".into(),
            hash: String::new(),
            message: "test".into(),
            keep_index: false,
            include_untracked: true,
            paths: vec![],
            reference: String::new(),
        })
        .await
        .unwrap();
        assert!(
            !directory.path().join("new.txt").exists(),
            "{}",
            run(directory.path(), &["status", "--short"])
        );
        let hash = git.status().await.unwrap().stashes[0].hash.clone();
        let files = git.stash_files(&hash).await.unwrap();
        assert!(files.iter().any(|file| file.path == "new.txt"));
        assert!(files.iter().any(|file| file.path == "file.txt"));
        git.edit_stash(StashEdit {
            action: "pop".into(),
            hash,
            message: String::new(),
            keep_index: true,
            include_untracked: true,
            paths: vec![],
            reference: "stash@{0}".into(),
        })
        .await
        .unwrap();
        assert!(git.status().await.unwrap().stashes.is_empty());
        assert_eq!(run(directory.path(), &["show", ":file.txt"]), "staged\n");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("file.txt")).unwrap(),
            "working\n"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("new.txt")).unwrap(),
            "new\n"
        );
    }

    #[tokio::test]
    async fn remote_deletion_uses_an_exact_lease_and_stash_duplicates_keep_the_selected_reference()
    {
        let (directory, git, head) = tracked().await;
        let remote = tempfile::tempdir().unwrap();
        run(remote.path(), &["init", "--bare"]);
        run(
            directory.path(),
            &["remote", "add", "origin", &git_path(remote.path())],
        );
        run(directory.path(), &["push", "origin", "main:topic"]);
        let mut command = git
            .delete_remote_ref_command("origin", "topic", "heads", &head)
            .await
            .unwrap();
        assert!(command.output().await.unwrap().status.success());
        assert!(run(remote.path(), &["for-each-ref", "refs/heads/topic"]).is_empty());
        std::fs::write(directory.path().join("file.txt"), "work").unwrap();
        git.save_stash("original").await.unwrap();
        let hash = git.status().await.unwrap().stashes[0].hash.clone();
        std::fs::write(directory.path().join("file.txt"), "different work").unwrap();
        git.save_stash("different").await.unwrap();
        run(
            directory.path(),
            &["stash", "store", "-m", "copy-two", &hash],
        );
        git.edit_stash(StashEdit {
            action: "drop".into(),
            hash,
            reference: "stash@{2}".into(),
            message: String::new(),
            keep_index: false,
            include_untracked: false,
            paths: vec![],
        })
        .await
        .unwrap();
        let stashes = git.status().await.unwrap().stashes;
        assert_eq!(stashes.len(), 2);
        assert!(stashes[0].message.contains("copy-two"));
        assert!(stashes[1].message.contains("different"));
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefEdit {
    pub action: String,
    pub name: String,
    pub new_name: String,
    pub hash: String,
    pub message: String,
    pub force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StashEdit {
    pub action: String,
    pub hash: String,
    pub message: String,
    pub keep_index: bool,
    pub include_untracked: bool,
    pub paths: Vec<String>,
    #[serde(default)]
    pub reference: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StashFile {
    path: String,
    old_path: Option<String>,
    revision: String,
    base: String,
}

impl Git {
    pub(crate) async fn management(&self) -> Result<Management, String> {
        let tags = self
            .text(&[
                "for-each-ref",
                "--format=%(refname:strip=2)%00%(objectname)%00%(subject)",
                "refs/tags",
            ])
            .await?;
        let tags = tags
            .lines()
            .filter_map(|line| {
                let fields: Vec<_> = line.splitn(3, '\0').collect();
                (fields.len() == 3).then(|| Tag {
                    name: fields[0].into(),
                    hash: fields[1].into(),
                    subject: fields[2].into(),
                })
            })
            .collect();
        Ok(Management {
            status: self.status().await?,
            tags,
            remotes: self.remotes().await?,
        })
    }

    pub(crate) async fn edit_ref(&self, request: RefEdit) -> Result<(), String> {
        if request.name.starts_with('-')
            || request.new_name.starts_with('-')
            || request.message.len() > MAX_FILE
        {
            return Err("名称或说明无效".into());
        }
        validate_hash(&request.hash)?;
        let prefix = if request.action.starts_with("tag-") {
            "refs/tags"
        } else {
            "refs/heads"
        };
        let reference = format!("{prefix}/{}", request.name);
        self.bytes(&["check-ref-format", &reference]).await?;
        if request.action == "tag-create" {
            if request.message.trim().is_empty() {
                return Err("请填写标签说明".into());
            }
            self.execute(
                &["tag", "-a", "-F", "-", "--", &request.name, &request.hash],
                Some(request.message.as_bytes()),
            )
            .await?
            .checked()?;
            return Ok(());
        }
        let actual = self.text(&["rev-parse", "--verify", &reference]).await?;
        if actual.trim() != request.hash {
            return Err("分支或标签已改变，请重新选择".into());
        }
        match request.action.as_str() {
            "branch-rename" => {
                self.bytes(&[
                    "check-ref-format",
                    &format!("refs/heads/{}", request.new_name),
                ])
                .await?;
                self.bytes(&["branch", "-m", &request.name, &request.new_name])
                    .await?;
            }
            "branch-delete" => {
                if self.repository().await?.branch.as_deref() == Some(&request.name) {
                    return Err("请先切换到其他分支".into());
                }
                self.bytes(&[
                    "branch",
                    if request.force { "-D" } else { "-d" },
                    "--",
                    &request.name,
                ])
                .await?;
            }
            "tag-delete" => {
                self.bytes(&["update-ref", "-d", &reference, &request.hash])
                    .await?;
            }
            _ => return Err("未知分支或标签操作".into()),
        }
        Ok(())
    }

    pub(crate) async fn tag_push_command(
        &self,
        name: &str,
        hash: &str,
        remote: &str,
    ) -> Result<Command, String> {
        validate_hash(hash)?;
        self.bytes(&["check-ref-format", &format!("refs/tags/{name}")])
            .await?;
        if self
            .text(&["rev-parse", "--verify", &format!("refs/tags/{name}")])
            .await?
            .trim()
            != hash
        {
            return Err("标签已改变，请重新选择".into());
        }
        if !self
            .remotes()
            .await?
            .iter()
            .any(|entry| entry.name == remote)
        {
            return Err("请选择远程".into());
        }
        let mut command = Command::new("git");
        command.current_dir(&self.root).args([
            "push",
            "--progress",
            "--",
            remote,
            &format!("{hash}:refs/tags/{name}"),
        ]);
        Ok(command)
    }

    pub(crate) async fn delete_remote_ref_command(
        &self,
        remote: &str,
        name: &str,
        kind: &str,
        hash: &str,
    ) -> Result<Command, String> {
        validate_hash(hash)?;
        if !matches!(kind, "heads" | "tags")
            || !self
                .remotes()
                .await?
                .iter()
                .any(|entry| entry.name == remote)
        {
            return Err("远程引用参数无效".into());
        }
        let reference = format!("refs/{kind}/{name}");
        self.bytes(&["check-ref-format", &reference]).await?;
        let local = if kind == "heads" {
            format!("refs/remotes/{remote}/{name}")
        } else {
            reference.clone()
        };
        if self.text(&["rev-parse", "--verify", &local]).await?.trim() != hash {
            return Err("本地引用已改变，请重新获取预览".into());
        }
        let mut command = Command::new("git");
        command.current_dir(&self.root).args([
            "push",
            "--progress",
            &format!("--force-with-lease={reference}:{hash}"),
            "--",
            remote,
            &format!(":{reference}"),
        ]);
        Ok(command)
    }

    pub(crate) async fn edit_stash(&self, request: StashEdit) -> Result<(), String> {
        if request.action == "save" {
            if request.paths.len() > 10_000 || request.message.len() > 4096 {
                return Err("Stash 请求过大".into());
            }
            let mut args = vec!["stash", "push", "-m", &request.message];
            if request.keep_index {
                args.push("--keep-index");
            }
            if request.include_untracked {
                args.push("--include-untracked");
            }
            for path in &request.paths {
                validate_path(path)?;
            }
            let literal_paths: Vec<_> = request
                .paths
                .iter()
                .map(|path| format!(":(literal){path}"))
                .collect();
            if !literal_paths.is_empty() {
                args.push("--");
                args.extend(literal_paths.iter().map(String::as_str));
            }
            self.bytes(&args).await?;
            return Ok(());
        }
        validate_hash(&request.hash)?;
        let original = self.status().await?.stashes;
        let selected = original
            .iter()
            .find(|stash| {
                stash.hash == request.hash
                    && (request.reference.is_empty() || stash.reference == request.reference)
            })
            .ok_or("Stash 引用已改变，请重新选择")?;
        let reference = selected.reference.clone();
        if matches!(request.action.as_str(), "apply" | "pop") {
            let mut args = vec!["stash", "apply"];
            if request.keep_index {
                args.push("--index");
            }
            args.push(&request.hash);
            self.bytes(&args).await?;
        }
        if matches!(request.action.as_str(), "drop" | "pop") {
            let status = self.status().await?;
            if status
                .stashes
                .iter()
                .map(|stash| (&stash.reference, &stash.hash))
                .collect::<Vec<_>>()
                != original
                    .iter()
                    .map(|stash| (&stash.reference, &stash.hash))
                    .collect::<Vec<_>>()
            {
                return Err(
                    "Stash 列表已改变，已应用的修改保留在工作区，请刷新后核对再删除 Stash".into(),
                );
            }
            let stash = status
                .stashes
                .iter()
                .find(|stash| stash.reference == reference && stash.hash == request.hash)
                .ok_or("Stash 列表已改变，请刷新")?;
            if self
                .text(&["rev-parse", "--verify", &stash.reference])
                .await?
                .trim()
                != request.hash
            {
                return Err("Stash 引用已改变，请刷新".into());
            }
            self.bytes(&["stash", "drop", &stash.reference]).await?;
        } else if request.action != "apply" {
            return Err("未知 Stash 操作".into());
        }
        Ok(())
    }

    pub(crate) async fn stash_files(&self, hash: &str) -> Result<Vec<StashFile>, String> {
        validate_hash(hash)?;
        if !self
            .status()
            .await?
            .stashes
            .iter()
            .any(|stash| stash.hash == hash)
        {
            return Err("Stash 已不存在".into());
        }
        let ancestry = self
            .text(&["rev-list", "--parents", "-n", "1", hash, "--"])
            .await?;
        let hashes: Vec<_> = ancestry.split_whitespace().collect();
        let base = *hashes.get(1).ok_or("Stash 缺少父提交")?;
        let changes = self
            .bytes(&["diff", "--name-status", "-M", "-z", base, hash, "--"])
            .await?;
        let mut files: Vec<_> = parse_name_status(&changes)?
            .into_iter()
            .map(|change| StashFile {
                path: change.path,
                old_path: change.old_path,
                base: base.into(),
                revision: hash.into(),
            })
            .collect();
        if let Some(untracked) = hashes.get(3) {
            let changes = self
                .text(&["ls-tree", "-r", "--name-only", "-z", untracked])
                .await?;
            files.extend(changes.split_terminator('\0').map(|path| StashFile {
                path: path.into(),
                old_path: None,
                base: base.into(),
                revision: (*untracked).into(),
            }));
        }
        Ok(files)
    }
}

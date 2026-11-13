use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
    async fn deleting_unmerged_and_occupied_branches_requires_native_git_protections() {
        let (directory, git, base) = tracked().await;
        git.create_branch("unmerged").await.unwrap();
        std::fs::write(directory.path().join("topic.txt"), "topic\n").unwrap();
        git.stage(vec!["topic.txt".into()], false).await.unwrap();
        git.commit("topic").await.unwrap();
        let head = git.head().await.unwrap().unwrap();
        git.checkout("refs/heads/main").await.unwrap();
        let deletion = |name: &str, hash: &str, force| RefEdit {
            action: "branch-delete".into(),
            name: name.into(),
            new_name: String::new(),
            hash: hash.into(),
            message: String::new(),
            force,
        };
        assert!(git
            .edit_ref(deletion("unmerged", &base, true))
            .await
            .is_err());
        assert!(git
            .edit_ref(deletion("unmerged", &head, false))
            .await
            .is_err());
        git.edit_ref(deletion("unmerged", &head, true))
            .await
            .unwrap();
        run(directory.path(), &["branch", "occupied"]);
        let parent = tempfile::tempdir().unwrap();
        run(
            directory.path(),
            &[
                "worktree",
                "add",
                &git_path(&parent.path().join("linked")),
                "occupied",
            ],
        );
        assert!(git
            .edit_ref(deletion("occupied", &base, true))
            .await
            .is_err());
        assert_eq!(
            run(directory.path(), &["rev-parse", "occupied"]).trim(),
            base
        );
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
        let untracked = files.iter().find(|file| file.path == "new.txt").unwrap();
        assert!(untracked.base.is_empty());
        let diff = git
            .diff(DiffRequest {
                path: untracked.path.clone(),
                old_path: None,
                revision: Some(untracked.revision.clone()),
                before_revision: None,
                area: None,
            })
            .await
            .unwrap();
        assert_eq!(diff.before, "");
        assert_eq!(diff.after, "new\n");
        let comparison = DiffRequest {
            path: untracked.path.clone(),
            old_path: None,
            revision: None,
            before_revision: Some(untracked.revision.clone()),
            area: None,
        };
        let missing = git.diff(comparison.clone()).await.unwrap();
        assert_eq!(missing.before, "new\n");
        assert_eq!(missing.after, "");
        std::fs::write(directory.path().join("new.txt"), "local edits\n").unwrap();
        let current = git.diff(comparison).await.unwrap();
        assert_eq!(current.before, "new\n");
        assert_eq!(current.after, "local edits\n");
        std::fs::remove_file(directory.path().join("new.txt")).unwrap();
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
    async fn stash_rename_selection_restores_both_paths_and_a_new_branch_restores_the_index() {
        let (directory, git, head) = tracked().await;
        run(directory.path(), &["mv", "file.txt", "renamed.txt"]);
        std::fs::write(directory.path().join("renamed.txt"), "working rename\n").unwrap();
        git.edit_stash(StashEdit {
            action: "save".into(),
            hash: String::new(),
            reference: String::new(),
            message: "rename".into(),
            keep_index: false,
            include_untracked: true,
            paths: vec!["renamed.txt".into()],
        })
        .await
        .unwrap();
        assert!(directory.path().join("file.txt").exists());
        assert!(!directory.path().join("renamed.txt").exists());
        assert!(git.status().await.unwrap().changes.is_empty());
        let stash = git.status().await.unwrap().stashes[0].clone();
        git.restore_stash_branch(StashBranch {
            hash: stash.hash,
            reference: stash.reference,
            name: "restored".into(),
            expected_head: Some(head),
            expected_branch: Some("main".into()),
            expected_stashes: None,
        })
        .await
        .unwrap();
        assert_eq!(
            git.repository().await.unwrap().branch.as_deref(),
            Some("restored")
        );
        assert!(git.status().await.unwrap().stashes.is_empty());
        assert_eq!(run(directory.path(), &["show", ":renamed.txt"]), "base\n");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("renamed.txt")).unwrap(),
            "working rename\n"
        );
        assert!(!directory.path().join("file.txt").exists());
    }

    #[tokio::test]
    async fn stash_clear_checks_the_whole_list_and_pop_conflicts_retain_the_stash() {
        let (directory, mut git, _) = tracked().await;
        std::fs::write(directory.path().join("file.txt"), "stash contents\n").unwrap();
        git.save_stash("original").await.unwrap();
        let original = git.status().await.unwrap().stashes;
        std::fs::write(directory.path().join("file.txt"), "different contents\n").unwrap();
        git.stage(vec!["file.txt".into()], false).await.unwrap();
        git.commit("different change").await.unwrap();
        let stash = &original[0];
        let request = StashEdit {
            action: "pop".into(),
            hash: stash.hash.clone(),
            reference: stash.reference.clone(),
            message: String::new(),
            keep_index: false,
            include_untracked: false,
            paths: vec![],
        };
        assert!(git.edit_stash(request).await.is_err());
        assert_eq!(git.status().await.unwrap().stashes, original);
        let overview = serde_json::to_value(git.merge_overview().await.unwrap()).unwrap();
        assert!(!overview["files"].as_array().unwrap().is_empty());
        let document =
            serde_json::to_value(git.open_merge("file.txt".into()).await.unwrap()).unwrap();
        git.save_merge(super::super::merge::SaveMerge {
            id: document["id"].as_str().unwrap().into(),
            finish: true,
            choice: "right".into(),
            progress: None,
        })
        .await
        .unwrap();
        assert_eq!(
            run(directory.path(), &["show", ":file.txt"]),
            "stash contents\n"
        );
        assert_eq!(git.status().await.unwrap().stashes, original);
        git.commit("resolve stash").await.unwrap();
        std::fs::write(directory.path().join("file.txt"), "second stash\n").unwrap();
        git.save_stash("second").await.unwrap();
        assert!(git.clear_stashes(original).await.is_err());
        let fresh = git.status().await.unwrap().stashes;
        assert_eq!(fresh.len(), 2);
        git.clear_stashes(fresh).await.unwrap();
        assert!(git.status().await.unwrap().stashes.is_empty());
        assert!(!directory.path().join(".git/logs/refs/stash").exists());
    }

    #[tokio::test]
    async fn selected_renames_and_deletions_support_keep_index_and_leave_other_files_alone() {
        for (renamed, include_untracked, keep_index) in [
            (true, false, false),
            (true, true, true),
            (true, false, true),
            (false, false, false),
            (false, true, true),
        ] {
            let (directory, git, _) = tracked().await;
            let path = if renamed {
                run(directory.path(), &["mv", "file.txt", "renamed.txt"]);
                std::fs::write(directory.path().join("renamed.txt"), "working rename\n").unwrap();
                "renamed.txt"
            } else {
                run(directory.path(), &["rm", "file.txt"]);
                "file.txt"
            };
            std::fs::write(directory.path().join("outside.txt"), "unselected\n").unwrap();
            git.edit_stash(StashEdit {
                action: "save".into(),
                hash: String::new(),
                reference: String::new(),
                message: "selected".into(),
                keep_index,
                include_untracked,
                paths: vec![path.into()],
            })
            .await
            .unwrap();
            assert_eq!(
                std::fs::read_to_string(directory.path().join("outside.txt")).unwrap(),
                "unselected\n"
            );
            assert_eq!(directory.path().join("file.txt").exists(), !keep_index);
            if renamed && keep_index {
                assert_eq!(
                    std::fs::read_to_string(directory.path().join("renamed.txt")).unwrap(),
                    "base\n"
                );
            }
            if renamed && !keep_index {
                assert!(!directory.path().join("renamed.txt").exists());
            }
            assert_eq!(git.status().await.unwrap().stashes.len(), 1);
        }
    }

    #[tokio::test]
    async fn list_snapshots_reject_duplicate_hash_reindexing_before_drop() {
        let (directory, git, _) = tracked().await;
        std::fs::write(directory.path().join("file.txt"), "work\n").unwrap();
        git.save_stash("original").await.unwrap();
        let expected = git.status().await.unwrap().stashes;
        let selected = expected[0].clone();
        std::fs::write(directory.path().join("file.txt"), "intermediate\n").unwrap();
        git.save_stash("intermediate").await.unwrap();
        run(
            directory.path(),
            &["stash", "store", "-m", "duplicate", &selected.hash],
        );
        let request = StashEdit {
            action: "drop".into(),
            hash: selected.hash,
            reference: selected.reference,
            message: String::new(),
            keep_index: false,
            include_untracked: false,
            paths: vec![],
        };
        assert!(git
            .edit_stash_snapshot(request, Some(expected))
            .await
            .unwrap_err()
            .contains("列表已改变"));
        assert_eq!(git.status().await.unwrap().stashes.len(), 3);
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StashBranch {
    pub hash: String,
    pub reference: String,
    pub name: String,
    pub expected_head: Option<String>,
    pub expected_branch: Option<String>,
    #[serde(default)]
    pub expected_stashes: Option<Vec<Stash>>,
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
    async fn stash_selection_stamp(&self, paths: &[String]) -> Result<String, String> {
        let mut hash = Sha256::new();
        hash.update(self.head().await?.unwrap_or_default());
        hash.update(self.bytes(&["ls-files", "--stage", "-z"]).await?);
        for path in paths {
            super::navigation::hash_path(&mut hash, &self.root.join(path))?;
        }
        Ok(format!("{:x}", hash.finalize()))
    }
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
        self.edit_stash_snapshot(request, None).await
    }

    pub(crate) async fn edit_stash_snapshot(
        &self,
        request: StashEdit,
        expected: Option<Vec<Stash>>,
    ) -> Result<(), String> {
        if request.action == "save" {
            if request.paths.len() > 10_000 || request.message.len() > 4096 {
                return Err("Stash 请求过大".into());
            }
            let mut paths = request.paths;
            let status = self.status().await?;
            let selected = |path: &str| {
                paths.iter().any(|prefix| {
                    path == prefix
                        || path
                            .strip_prefix(prefix)
                            .is_some_and(|rest| rest.starts_with('/'))
                })
            };
            let selected_changes: Vec<_> = status
                .changes
                .iter()
                .filter(|change| {
                    selected(&change.path) || change.old_path.as_deref().is_some_and(selected)
                })
                .collect();
            let selected_untracked = selected_changes.iter().any(|change| change.index == '?');
            if selected_untracked && !request.include_untracked {
                return Err("已选择未跟踪文件，请开启包含未跟踪文件".into());
            }
            let missing_index_path = !paths.is_empty()
                && selected_changes
                    .iter()
                    .any(|change| matches!(change.index, 'R' | 'D'));
            for change in &selected_changes {
                if change.index == 'R' || change.work_tree == 'R' {
                    paths.push(change.path.clone());
                    if let Some(old_path) = &change.old_path {
                        paths.push(old_path.clone());
                    }
                }
            }
            paths.sort();
            paths.dedup();
            for path in &paths {
                validate_path(path)?;
            }
            let mut args = vec!["stash", "push", "-m", &request.message];
            if request.keep_index {
                args.push("--keep-index");
            }
            // Git's selected-path cleanup can reject staged deletions/rename
            // sources after storing the stash. -u gets past its index-only
            // path validation; the literal pathspec still bounds the selection.
            if request.include_untracked || missing_index_path && !selected_untracked {
                args.push("--include-untracked");
            }
            let literal_paths: Vec<_> = paths
                .iter()
                .map(|path| format!(":(literal){path}"))
                .collect();
            if !literal_paths.is_empty() {
                args.push("--");
                args.extend(literal_paths.iter().map(String::as_str));
            }
            let stamp_paths: Vec<_> = selected_changes
                .iter()
                .flat_map(|change| {
                    std::iter::once(change.path.clone()).chain(change.old_path.clone())
                })
                .collect();
            let before = if missing_index_path {
                Some(self.stash_selection_stamp(&stamp_paths).await?)
            } else {
                None
            };
            let output = self.execute(&args, None).await?;
            if output.code != 0 {
                let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let after = self.status().await?;
                let stored = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .any(|line| line.starts_with("Saved working directory and index state"))
                    && after.stashes.len() == status.stashes.len() + 1
                    && after
                        .stashes
                        .iter()
                        .skip(1)
                        .map(|stash| (&stash.hash, &stash.message))
                        .eq(status
                            .stashes
                            .iter()
                            .map(|stash| (&stash.hash, &stash.message)));
                if stored
                    && missing_index_path
                    && error.contains("pathspec")
                    && before.as_deref() == Some(&self.stash_selection_stamp(&stamp_paths).await?)
                {
                    let mode = if request.keep_index {
                        super::discard::DiscardMode::Unstaged
                    } else {
                        super::discard::DiscardMode::All
                    };
                    let cleanup_paths: Vec<_> = selected_changes
                        .iter()
                        .filter(|change| {
                            !request.keep_index || change.work_tree != ' ' || change.index == '?'
                        })
                        .map(|change| change.path.clone())
                        .collect();
                    if !cleanup_paths.is_empty() {
                        let preview =
                            self.preview_discard(cleanup_paths, mode)
                                .await
                                .map_err(|cleanup| {
                                    format!(
                                        "储藏已保存为 {}，清理预览失败：{cleanup}",
                                        after.stashes[0].reference
                                    )
                                })?;
                        self.discard_changes(preview).await.map_err(|cleanup| {
                            format!(
                                "储藏已保存为 {}，清理工作区失败，修改可从该储藏恢复：{cleanup}",
                                after.stashes[0].reference
                            )
                        })?;
                    }
                } else if stored {
                    return Err(format!(
                        "储藏已保存为 {}，清理工作区未完成，请核对后继续：{error}",
                        after.stashes[0].reference
                    ));
                } else {
                    return Err(error);
                }
            }
            return Ok(());
        }
        validate_hash(&request.hash)?;
        let original = self.status().await?.stashes;
        if expected.is_some_and(|expected| expected != original) {
            return Err("储藏列表已改变，请重新选择后执行".into());
        }
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
            if status.stashes != original {
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

    pub(crate) async fn clear_stashes(&self, expected: Vec<Stash>) -> Result<(), String> {
        if self.status().await?.stashes != expected {
            return Err("储藏列表已改变，请重新读取后确认清空".into());
        }
        if let Some(top) = expected.first() {
            self.bytes(&["update-ref", "-d", "refs/stash", &top.hash])
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn restore_stash_branch(&self, request: StashBranch) -> Result<(), String> {
        validate_hash(&request.hash)?;
        if request.name.starts_with('-') || request.name.len() > 1024 {
            return Err("分支名称无效".into());
        }
        self.bytes(&["check-ref-format", "--branch", &request.name])
            .await?;
        let status = self.status().await?;
        if request
            .expected_stashes
            .is_some_and(|expected| expected != status.stashes)
        {
            return Err("储藏列表已改变，请重新选择后执行".into());
        }
        if status.repository.head != request.expected_head
            || status.repository.branch != request.expected_branch
        {
            return Err("当前分支或 HEAD 已改变，请重新读取储藏预览".into());
        }
        if !status
            .stashes
            .iter()
            .any(|stash| stash.hash == request.hash && stash.reference == request.reference)
        {
            return Err("储藏引用已改变，请重新选择".into());
        }
        self.bytes(&["stash", "branch", &request.name, &request.hash])
            .await?;
        if self.status().await?.stashes != status.stashes {
            return Err("分支已创建且储藏已应用，储藏列表已改变，请刷新核对后手动删除储藏".into());
        }
        self.edit_stash(StashEdit {
            action: "drop".into(),
            hash: request.hash,
            reference: request.reference,
            message: String::new(),
            keep_index: false,
            include_untracked: false,
            paths: vec![],
        })
        .await
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
                base: String::new(),
                revision: (*untracked).into(),
            }));
        }
        Ok(files)
    }
}

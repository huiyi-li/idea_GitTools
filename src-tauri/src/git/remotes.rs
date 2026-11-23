use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Remote {
    pub name: String,
    pub fetch_urls: Vec<String>,
    pub push_urls: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteEdit {
    pub action: String,
    pub name: String,
    pub url: String,
    pub push_url: String,
    pub expected: Option<Remote>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferRequest {
    pub action: String,
    pub remote: String,
    pub branch: String,
    pub expected_head: String,
    pub expected_branch: String,
    pub set_upstream: bool,
    pub rebase: bool,
    pub force: bool,
    #[serde(default)]
    pub push_tags: bool,
    #[serde(default)]
    pub no_verify: bool,
    #[serde(default = "default_prune")]
    pub prune: bool,
    pub expected_remote: Option<String>,
    #[serde(default)]
    pub expected_remote_config: Option<Remote>,
    #[serde(default)]
    pub pull_strategy: Option<String>,
    #[serde(default)]
    pub auto_clean: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum PendingUpdateRestore {
    Shelf { id: String },
    Stash { hash: String, reference: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateFinishResult {
    pub restored: bool,
    pub conflicts: bool,
    pub message: String,
}

fn default_prune() -> bool {
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferOverview {
    pub remotes: Vec<Remote>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: String,
}

impl Git {
    pub(crate) async fn remotes(&self) -> Result<Vec<Remote>, String> {
        let mut remotes = Vec::new();
        for name in self.text(&["remote"]).await?.lines() {
            remotes.push(Remote {
                name: name.into(),
                fetch_urls: self
                    .text(&["remote", "get-url", "--all", name])
                    .await?
                    .lines()
                    .map(str::to_owned)
                    .collect(),
                push_urls: self
                    .text(&["remote", "get-url", "--push", "--all", name])
                    .await?
                    .lines()
                    .map(str::to_owned)
                    .collect(),
            });
        }
        Ok(remotes)
    }

    pub(crate) async fn transfer_overview(&self) -> Result<TransferOverview, String> {
        let repository = self.repository().await?;
        let upstream = self
            .text(&[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ])
            .await
            .unwrap_or_default()
            .trim()
            .into();
        Ok(TransferOverview {
            remotes: self.remotes().await?,
            branch: repository.branch,
            head: repository.head,
            upstream,
        })
    }

    pub(crate) async fn edit_remote(&self, request: RemoteEdit) -> Result<(), String> {
        if request.name.is_empty()
            || request.name.starts_with('-')
            || request.name.contains(['\r', '\n', '\0'])
        {
            return Err("远程名称无效".into());
        }
        self.bytes(&[
            "check-ref-format",
            &format!("refs/remotes/{}/branch", request.name),
        ])
        .await?;
        let remotes = self.remotes().await?;
        let existing = remotes.iter().find(|remote| remote.name == request.name);
        if existing != request.expected.as_ref() {
            return Err("远程配置已改变，请刷新后重试".into());
        }
        match request.action.as_str() {
            "add" | "edit" if (request.action == "add") == existing.is_none() => {
                let url = crate::transport::remote_url(&request.url)?;
                let push_url = if request.push_url.is_empty() {
                    None
                } else {
                    Some(crate::transport::remote_url(&request.push_url)?)
                };
                // Update both URL sets in one atomic replacement of the local config.
                let path = self.root.join(
                    self.text(&["rev-parse", "--git-path", "config"])
                        .await?
                        .trim(),
                );
                let transaction = super::merge::IndexTransaction::new(&path)?;
                if self
                    .remotes()
                    .await?
                    .iter()
                    .find(|remote| remote.name == request.name)
                    != request.expected.as_ref()
                {
                    return Err("远程配置已改变，请刷新后重试".into());
                }
                let config = transaction.temporary_path();
                self.bytes(&[
                    "config",
                    "--file",
                    config,
                    "--replace-all",
                    &format!("remote.{}.url", request.name),
                    &url,
                ])
                .await?;
                if request.action == "add" {
                    self.bytes(&[
                        "config",
                        "--file",
                        config,
                        "--add",
                        &format!("remote.{}.fetch", request.name),
                        &format!("+refs/heads/*:refs/remotes/{}/*", request.name),
                    ])
                    .await?;
                }
                let key = format!("remote.{}.pushurl", request.name);
                let removed = self
                    .execute(&["config", "--file", config, "--unset-all", &key], None)
                    .await?;
                if !matches!(removed.code, 0 | 5) {
                    removed.checked()?;
                }
                if let Some(url) = push_url {
                    self.bytes(&["config", "--file", config, "--add", &key, &url])
                        .await?;
                }
                transaction.commit()?;
            }
            "remove" if existing.is_some() => {
                self.bytes(&["remote", "remove", &request.name]).await?;
            }
            _ => return Err("远程操作与当前状态不匹配".into()),
        }
        Ok(())
    }

    pub(crate) async fn transfer_command(
        &self,
        request: TransferRequest,
    ) -> Result<Command, String> {
        let repository = self.repository().await?;
        if repository.head.as_deref().unwrap_or_default() != request.expected_head
            || repository.branch.as_deref().unwrap_or_default() != request.expected_branch
        {
            return Err("当前分支或 HEAD 已改变，请重新打开传输窗口".into());
        }
        let remotes = self.remotes().await?;
        let selected = remotes
            .iter()
            .find(|remote| remote.name == request.remote)
            .ok_or("远程已不存在，请刷新")?;
        if request
            .expected_remote_config
            .as_ref()
            .is_some_and(|expected| expected != selected)
        {
            return Err("远程地址配置已改变，请重新打开传输窗口".into());
        }
        let mut command = Command::new("git");
        command.current_dir(&self.root);
        if request.action == "fetch" {
            command.args(["fetch", "--progress"]);
            if request.prune {
                command.arg("--prune");
            }
            command.args(["--", &request.remote]);
            return Ok(command);
        }
        if repository.head.is_none() || repository.branch.is_none() {
            return Err("请先创建提交并签出本地分支".into());
        }
        self.bytes(&[
            "check-ref-format",
            &format!("refs/heads/{}", request.branch),
        ])
        .await?;
        match request.action.as_str() {
            "push" => {
                command.args(["push", "--progress"]);
                if request.push_tags {
                    command.arg("--tags");
                }
                if request.no_verify {
                    command.arg("--no-verify");
                }
                if request.set_upstream {
                    command.arg("--set-upstream");
                }
                if request.force {
                    let hash = request
                        .expected_remote
                        .as_ref()
                        .ok_or("请先 Fetch，再确认远程分支位置后使用强制推送")?;
                    validate_hash(hash)?;
                    let reference = format!("refs/remotes/{}/{}", request.remote, request.branch);
                    if self
                        .text(&["rev-parse", "--verify", &reference])
                        .await?
                        .trim()
                        != hash
                    {
                        return Err("远程跟踪分支已改变，请刷新预览".into());
                    }
                    command.arg(format!(
                        "--force-with-lease=refs/heads/{}:{hash}",
                        request.branch
                    ));
                }
                command.arg("--").arg(request.remote).arg(format!(
                    "refs/heads/{}:refs/heads/{}",
                    request.expected_branch, request.branch
                ));
            }
            "pull" => {
                if repository.operation != "none" {
                    return Err("请先处理当前 Git 操作并保存本地修改".into());
                }
                let status = self.status().await?;
                for change in &status.changes {
                    let _ = self.local_history_capture(&change.path, "Before Update").await;
                }
                let pending_path = self.pending_update_path().await?;
                let _ = std::fs::remove_file(&pending_path);
                if !status.changes.is_empty() {
                    match request.auto_clean.as_deref().unwrap_or("none") {
                        "shelf" => {
                            let entry = self
                                .shelf_save("Before Update (Auto-Shelf)", Vec::new(), true)
                                .await?;
                            let pending = PendingUpdateRestore::Shelf { id: entry.id };
                            if let Some(parent) = pending_path.parent() {
                                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                            }
                            let bytes =
                                serde_json::to_vec_pretty(&pending).map_err(|e| e.to_string())?;
                            super::merge::atomic_write(&pending_path, &bytes, None)?;
                        }
                        "stash" => {
                            self.save_stash("Before Update (Auto-Stash)").await?;
                            if let Some(top) = self.status().await?.stashes.first() {
                                let pending = PendingUpdateRestore::Stash {
                                    hash: top.hash.clone(),
                                    reference: top.reference.clone(),
                                };
                                if let Some(parent) = pending_path.parent() {
                                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                                }
                                let bytes = serde_json::to_vec_pretty(&pending)
                                    .map_err(|e| e.to_string())?;
                                super::merge::atomic_write(&pending_path, &bytes, None)?;
                            }
                        }
                        _ => {
                            return Err("请先处理当前 Git 操作并保存本地修改".into());
                        }
                    }
                }
                let strategy_arg = match request.pull_strategy.as_deref() {
                    Some("merge") => "--no-rebase",
                    Some("rebase") => "--rebase",
                    Some("ff-only") => "--ff-only",
                    _ if request.rebase => "--rebase",
                    _ => "--ff-only",
                };
                command.args([
                    "pull",
                    "--progress",
                    strategy_arg,
                    "--",
                    &request.remote,
                    &request.branch,
                ]);
            }
            _ => return Err("未知 Git 传输操作".into()),
        }
        Ok(command)
    }

    async fn pending_update_path(&self) -> Result<std::path::PathBuf, String> {
        let dir = self
            .text(&["rev-parse", "--git-path", "ideagittool-shelf"])
            .await?;
        Ok(self.root.join(dir.trim()).join("pending-update.json"))
    }

    pub(crate) async fn finish_update_project(&self) -> Result<UpdateFinishResult, String> {
        let pending_path = self.pending_update_path().await?;
        let status = self.status().await?;
        let pull_conflicts =
            status.repository.operation != "none" || status.changes.iter().any(|c| c.conflict);
        let pending_bytes = match std::fs::read(&pending_path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        let Some(bytes) = pending_bytes else {
            return Ok(UpdateFinishResult {
                restored: false,
                conflicts: pull_conflicts,
                message: if pull_conflicts {
                    "拉取更新存在合并冲突，请先解决冲突。".into()
                } else {
                    "项目已更新".into()
                },
            });
        };
        let _ = std::fs::remove_file(&pending_path);
        let pending: PendingUpdateRestore =
            serde_json::from_slice(&bytes).map_err(|e| format!("读取更新恢复状态失败。{e}"))?;
        if pull_conflicts {
            return Ok(UpdateFinishResult {
                restored: false,
                conflicts: true,
                message: "拉取更新产生冲突，更新前自动暂存的本地修改已安全保留在 Shelf / Stash 中，请先解决合并冲突。".into(),
            });
        }
        match pending {
            PendingUpdateRestore::Shelf { id } => {
                let res = self.shelf_apply(&id, Vec::new(), true).await?;
                Ok(UpdateFinishResult {
                    restored: true,
                    conflicts: res.conflicts,
                    message: if res.conflicts {
                        "项目已拉取，自动恢复 Shelf 修改时产生冲突，已打开三栏冲突解决器。".into()
                    } else {
                        "项目已更新并自动恢复更新前的 Shelf 修改。".into()
                    },
                })
            }
            PendingUpdateRestore::Stash { hash, reference } => {
                let _ = self
                    .edit_stash(super::management::StashEdit {
                        action: "pop".into(),
                        hash,
                        reference,
                        message: String::new(),
                        keep_index: false,
                        include_untracked: false,
                        paths: Vec::new(),
                    })
                    .await;
                let after = self.status().await?;
                let stash_conflicts = after.repository.operation != "none"
                    || after.changes.iter().any(|c| c.conflict);
                Ok(UpdateFinishResult {
                    restored: true,
                    conflicts: stash_conflicts,
                    message: if stash_conflicts {
                        "项目已拉取，自动恢复 Stash 修改时产生冲突，已打开三栏冲突解决器。".into()
                    } else {
                        "项目已更新并自动恢复更新前的 Stash 修改。".into()
                    },
                })
            }
        }
    }

    pub(crate) async fn outgoing(&self, remote: &str, branch: &str) -> Result<Vec<Commit>, String> {
        if !self
            .remotes()
            .await?
            .iter()
            .any(|entry| entry.name == remote)
        {
            return Err("请选择远程".into());
        }
        self.bytes(&["check-ref-format", &format!("refs/heads/{branch}")])
            .await?;
        let reference = format!("refs/remotes/{remote}/{branch}");
        let mut args = vec!["log", "-z", "--max-count=100"];
        let format = format!("--format={LOG_FORMAT}");
        args.push(&format);
        let range = if self
            .text(&["rev-parse", "--verify", &reference])
            .await
            .is_ok()
        {
            format!("{reference}..HEAD")
        } else {
            "HEAD".into()
        };
        args.extend([&range, "--"]);
        parse_commits(&self.bytes(&args).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    #[tokio::test]
    async fn remote_edits_are_atomic_and_reject_stale_configuration() {
        let directory = fixture();
        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();
        git.edit_remote(RemoteEdit {
            action: "add".into(),
            name: "origin".into(),
            url: "git@github_ming:owner/repo.git".into(),
            push_url: "https://host/push.git".into(),
            expected: None,
        })
        .await
        .unwrap();
        let before = git.remotes().await.unwrap().remove(0);
        assert_eq!(before.push_urls, ["https://host/push.git"]);
        git.edit_remote(RemoteEdit {
            action: "edit".into(),
            name: "origin".into(),
            url: "http://host/repo.git".into(),
            push_url: String::new(),
            expected: Some(before.clone()),
        })
        .await
        .unwrap();
        assert_eq!(
            git.remotes().await.unwrap()[0].push_urls,
            ["http://host/repo.git"]
        );
        assert!(git
            .edit_remote(RemoteEdit {
                action: "remove".into(),
                name: "origin".into(),
                url: String::new(),
                push_url: String::new(),
                expected: Some(before)
            })
            .await
            .is_err());
        assert!(!directory.path().join(".git/config.lock").exists());
    }

    #[tokio::test]
    async fn first_push_sets_upstream_and_stale_head_cannot_be_pushed() {
        let directory = fixture();
        std::fs::write(directory.path().join("file.txt"), "base").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "first"]);
        let remote = tempfile::tempdir().unwrap();
        run(remote.path(), &["init", "--bare"]);
        run(
            directory.path(),
            &["remote", "add", "origin", &git_path(remote.path())],
        );
        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();
        let overview = git.transfer_overview().await.unwrap();
        let request = TransferRequest {
            action: "push".into(),
            remote: "origin".into(),
            branch: "new-branch".into(),
            expected_head: overview.head.unwrap(),
            expected_branch: "main".into(),
            set_upstream: true,
            rebase: false,
            force: false,
            push_tags: false,
            no_verify: false,
            prune: true,
            expected_remote: None,
            expected_remote_config: Some(overview.remotes[0].clone()),
            pull_strategy: None,
            auto_clean: None,
        };
        let fetch = git
            .transfer_command(TransferRequest {
                action: "fetch".into(),
                remote: "origin".into(),
                branch: String::new(),
                expected_head: request.expected_head.clone(),
                expected_branch: request.expected_branch.clone(),
                set_upstream: false,
                rebase: false,
                force: false,
                push_tags: false,
                no_verify: false,
                prune: false,
                expected_remote: None,
                expected_remote_config: request.expected_remote_config.clone(),
                pull_strategy: None,
                auto_clean: None,
            })
            .await
            .unwrap();
        assert!(!format!("{fetch:?}").contains("--prune"));
        let mut command = git.transfer_command(request.clone()).await.unwrap();
        assert!(command.output().await.unwrap().status.success());
        assert_eq!(
            git.transfer_overview().await.unwrap().upstream,
            "origin/new-branch"
        );
        assert!(git
            .outgoing("origin", "new-branch")
            .await
            .unwrap()
            .is_empty());
        let mut stale = request.clone();
        stale.expected_head = "a".repeat(40);
        assert!(git.transfer_command(stale).await.is_err());
        let mut force = request;
        force.force = true;
        force.expected_remote = Some("a".repeat(40));
        assert!(git.transfer_command(force).await.is_err());
    }

    #[tokio::test]
    async fn update_project_captures_local_history_auto_shelves_dirty_worktree_and_restores() {
        let directory = fixture();
        std::fs::write(directory.path().join("file.txt"), "base\n").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "initial"]);

        let remote = tempfile::tempdir().unwrap();
        run(remote.path(), &["init", "--bare"]);
        run(
            directory.path(),
            &["remote", "add", "origin", &git_path(remote.path())],
        );
        run(directory.path(), &["push", "-u", "origin", "main"]);

        // Make a dirty local edit + untracked file
        std::fs::write(directory.path().join("file.txt"), "dirty local edit\n").unwrap();
        std::fs::write(directory.path().join("notes.txt"), "untracked note\n").unwrap();

        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();
        let overview = git.transfer_overview().await.unwrap();
        let pull_req = TransferRequest {
            action: "pull".into(),
            remote: "origin".into(),
            branch: "main".into(),
            expected_head: overview.head.unwrap(),
            expected_branch: "main".into(),
            set_upstream: false,
            rebase: true,
            force: false,
            push_tags: false,
            no_verify: false,
            prune: true,
            expected_remote: None,
            expected_remote_config: Some(overview.remotes[0].clone()),
            pull_strategy: Some("rebase".into()),
            auto_clean: Some("shelf".into()),
        };

        let mut cmd = git.transfer_command(pull_req).await.unwrap();
        // Worktree was cleaned by Auto-Shelf before running git pull
        assert!(git.status().await.unwrap().changes.is_empty());
        assert!(cmd.output().await.unwrap().status.success());

        // Local history captured "Before Update"
        let lh = git.local_history_list("file.txt").await.unwrap();
        assert!(lh.iter().any(|e| e.reason == "Before Update"));

        // Finish update project automatically unshelves both tracked and untracked changes
        let finish = git.finish_update_project().await.unwrap();
        assert!(finish.restored);
        assert!(!finish.conflicts);
        assert_eq!(
            std::fs::read_to_string(directory.path().join("file.txt")).unwrap(),
            "dirty local edit\n"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("notes.txt")).unwrap(),
            "untracked note\n"
        );
    }
}

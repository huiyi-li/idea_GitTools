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
    pub expected_remote: Option<String>,
    #[serde(default)]
    pub expected_remote_config: Option<Remote>,
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
            command.args(["fetch", "--progress", "--prune", "--", &request.remote]);
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
                if repository.operation != "none" || !self.status().await?.changes.is_empty() {
                    return Err("请先处理当前 Git 操作并保存本地修改".into());
                }
                command.args([
                    "pull",
                    "--progress",
                    if request.rebase {
                        "--rebase"
                    } else {
                        "--ff-only"
                    },
                    "--",
                    &request.remote,
                    &request.branch,
                ]);
            }
            _ => return Err("未知 Git 传输操作".into()),
        }
        Ok(command)
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
            expected_remote: None,
            expected_remote_config: Some(overview.remotes[0].clone()),
        };
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
}

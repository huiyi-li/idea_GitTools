use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Worktree {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    pub bare: bool,
    pub main: bool,
    pub current: bool,
    pub dirty: Option<bool>,
    pub error: String,
    pub fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeOverview {
    pub entries: Vec<Worktree>,
    pub branches: Vec<Branch>,
    pub head: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateWorktree {
    pub path: String,
    pub mode: String,
    pub branch: String,
    pub base: String,
}

fn parse_worktrees(bytes: &[u8]) -> Result<Vec<Worktree>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Worktree 路径不是 UTF-8")?;
    let mut entries = Vec::new();
    let mut current = Worktree::default();
    for field in text.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            current.path = path.into();
        } else if field.is_empty() {
            if !current.path.is_empty() {
                current.main = entries.is_empty();
                entries.push(current);
                current = Worktree::default();
            }
        } else if let Some(head) = field.strip_prefix("HEAD ") {
            current.head = head.into();
        } else if let Some(branch) = field.strip_prefix("branch ") {
            current.branch = Some(branch.into());
        } else if field == "bare" {
            current.bare = true;
        } else if field == "locked" || field.starts_with("locked ") {
            current.locked = Some(field.strip_prefix("locked ").unwrap_or("").into());
        } else if field == "prunable" || field.starts_with("prunable ") {
            current.prunable = Some(field.strip_prefix("prunable ").unwrap_or("").into());
        }
    }
    Ok(entries)
}

impl Git {
    pub(crate) async fn worktrees(&self) -> Result<WorktreeOverview, String> {
        let mut entries = parse_worktrees(
            &self
                .bytes(&["worktree", "list", "--porcelain", "-z"])
                .await?,
        )?;
        for entry in &mut entries {
            entry.current = Path::new(&entry.path).canonicalize().ok().as_ref() == Some(&self.root);
            let mut hash = Sha256::new();
            if !entry.bare {
                match self
                    .execute(
                        &[
                            "-C",
                            &entry.path,
                            "status",
                            "--porcelain=v1",
                            "-z",
                            "--untracked-files=normal",
                        ],
                        None,
                    )
                    .await
                {
                    Ok(output) if output.code == 0 => {
                        entry.dirty = Some(!output.stdout.is_empty());
                        hash.update(output.stdout);
                    }
                    Ok(output) => {
                        entry.error = String::from_utf8_lossy(&output.stderr).trim().into()
                    }
                    Err(error) => entry.error = error,
                }
            }
            hash.update(serde_json::to_vec(&entry).map_err(|e| e.to_string())?);
            entry.fingerprint = format!("{:x}", hash.finalize());
        }
        let status = self.status().await?;
        Ok(WorktreeOverview {
            entries,
            branches: status.branches,
            head: status.repository.head,
        })
    }

    pub(crate) async fn create_worktree(&self, request: CreateWorktree) -> Result<String, String> {
        let path = Path::new(&request.path);
        if !path.is_absolute() || request.path.contains(['\0', '\n', '\r']) {
            return Err("请选择 Worktree 的绝对目录".into());
        }
        let parent = path
            .parent()
            .ok_or("目录缺少父路径")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let name = path.file_name().ok_or("请输入新的目录名称")?;
        let target = parent.join(name);
        if target.exists()
            && (!target.is_dir()
                || std::fs::read_dir(&target)
                    .map_err(|e| e.to_string())?
                    .next()
                    .is_some())
        {
            return Err("Worktree 目标目录需要为空或尚未创建".into());
        }
        validate_hash(&request.base)?;
        let base = self.resolve_commit(&request.base).await?;
        let target = git_path(&target);
        let mut args = vec!["worktree", "add"];
        match request.mode.as_str() {
            "existing" => {
                self.bytes(&[
                    "check-ref-format",
                    &format!("refs/heads/{}", request.branch),
                ])
                .await?;
                if self
                    .resolve_commit(&format!("refs/heads/{}", request.branch))
                    .await?
                    != base
                {
                    return Err("分支已移动，请刷新 Worktree 列表".into());
                }
                args.extend(["--", &target, &request.branch]);
            }
            "new" => {
                if request.branch.starts_with('-') {
                    return Err("请输入有效分支名".into());
                }
                self.bytes(&[
                    "check-ref-format",
                    &format!("refs/heads/{}", request.branch),
                ])
                .await?;
                args.extend(["-b", &request.branch, "--", &target, &base]);
            }
            "detached" => args.extend(["--detach", "--", &target, &base]),
            _ => return Err("请选择创建 Worktree 的方式".into()),
        }
        self.execute(&args, None).await?.checked()?;
        Ok(target)
    }

    pub(crate) async fn edit_worktree(
        &self,
        entry: Worktree,
        action: &str,
        reason: &str,
    ) -> Result<(), String> {
        let fresh = self
            .worktrees()
            .await?
            .entries
            .into_iter()
            .find(|item| item.path == entry.path)
            .ok_or("Worktree 已不存在")?;
        if fresh != entry {
            return Err("Worktree 状态已改变，请刷新列表".into());
        }
        if entry.main || entry.bare {
            return Err("主工作区由仓库本身管理".into());
        }
        match action {
            "remove" => {
                if entry.current {
                    return Err("请先打开其他工作区，再删除此 Worktree".into());
                }
                if entry.locked.is_some() || entry.dirty != Some(false) {
                    return Err("请先解锁并处理此 Worktree 的本地更改".into());
                }
                self.bytes(&["worktree", "remove", "--", &entry.path])
                    .await?;
            }
            "lock" => {
                if reason.len() > 1024 || reason.contains(['\0', '\n', '\r']) {
                    return Err("锁定说明无效".into());
                }
                self.bytes(&["worktree", "lock", "--reason", reason, "--", &entry.path])
                    .await?;
            }
            "unlock" => {
                self.bytes(&["worktree", "unlock", "--", &entry.path])
                    .await?;
            }
            _ => return Err("未知的 Worktree 操作".into()),
        }
        Ok(())
    }

    pub(crate) async fn prune_worktrees(&self, entries: Vec<Worktree>) -> Result<String, String> {
        if self.worktrees().await?.entries != entries {
            return Err("Worktree 状态已改变，请重新预览清理".into());
        }
        self.text(&["worktree", "prune", "--verbose", "--expire", "now"])
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    #[tokio::test]
    async fn worktree_lifecycle_preserves_dirty_files_and_rejects_stale_actions() {
        let dir = fixture();
        run(dir.path(), &["commit", "--allow-empty", "-m", "base"]);
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let parent = tempfile::tempdir().unwrap();
        let path = git_path(&parent.path().join("空 格 worktree"));
        let overview = git.worktrees().await.unwrap();
        assert!(overview.entries[0].current && overview.entries[0].main);
        git.create_worktree(CreateWorktree {
            path: path.clone(),
            mode: "new".into(),
            branch: "feature".into(),
            base: overview.head.unwrap(),
        })
        .await
        .unwrap();
        let entry = git.worktrees().await.unwrap().entries[1].clone();
        assert_eq!(entry.branch.as_deref(), Some("refs/heads/feature"));
        git.edit_worktree(entry.clone(), "lock", "working on task")
            .await
            .unwrap();
        assert!(git.edit_worktree(entry, "remove", "").await.is_err());
        let locked = git.worktrees().await.unwrap().entries[1].clone();
        assert_eq!(locked.locked.as_deref(), Some("working on task"));
        git.edit_worktree(locked, "unlock", "").await.unwrap();
        std::fs::write(Path::new(&path).join("keep.txt"), "keep").unwrap();
        let dirty = git.worktrees().await.unwrap().entries[1].clone();
        assert_eq!(dirty.dirty, Some(true));
        assert!(git.edit_worktree(dirty, "remove", "").await.is_err());
        assert!(Path::new(&path).join("keep.txt").exists());
        std::fs::remove_file(Path::new(&path).join("keep.txt")).unwrap();
        let clean = git.worktrees().await.unwrap().entries[1].clone();
        git.edit_worktree(clean, "remove", "").await.unwrap();
        assert!(!Path::new(&path).exists());
        assert_eq!(git.worktrees().await.unwrap().entries.len(), 1);
        // Removing a Worktree keeps its branch available.
        assert!(!run(dir.path(), &["rev-parse", "feature"]).is_empty());
    }

    #[tokio::test]
    async fn detached_existing_occupied_and_prunable_worktrees_follow_git_rules() {
        let dir = fixture();
        run(dir.path(), &["commit", "--allow-empty", "-m", "base"]);
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let base = git.worktrees().await.unwrap().head.unwrap();
        let parent = tempfile::tempdir().unwrap();
        let path = git_path(&parent.path().join("detached"));
        assert!(git
            .create_worktree(CreateWorktree {
                path: path.clone(),
                mode: "existing".into(),
                branch: "main".into(),
                base: base.clone()
            })
            .await
            .is_err());
        git.create_worktree(CreateWorktree {
            path: path.clone(),
            mode: "detached".into(),
            branch: "".into(),
            base,
        })
        .await
        .unwrap();
        let preview = git.worktrees().await.unwrap();
        assert!(preview.entries[1].branch.is_none());
        std::fs::remove_dir_all(&path).unwrap();
        assert!(git.prune_worktrees(preview.entries).await.is_err());
        let fresh = git.worktrees().await.unwrap();
        git.prune_worktrees(fresh.entries).await.unwrap();
        assert_eq!(git.worktrees().await.unwrap().entries.len(), 1);
    }
}

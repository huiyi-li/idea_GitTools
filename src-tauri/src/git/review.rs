pub use super::content::{FileSnapshot, SnapshotState};
use super::*;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSnapshot {
    pub file: FileSnapshot,
    pub branch: String,
    pub head: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitReview {
    pub revision: String,
    pub parent: Option<String>,
    pub before: FileSnapshot,
    pub after: FileSnapshot,
    pub current: WorktreeSnapshot,
}

impl Git {
    #[cfg(test)]
    pub async fn commit_review(&self, revision: &str, path: &str) -> Result<CommitReview, String> {
        self.commit_review_with_options(revision, path, false).await
    }

    #[cfg(test)]
    pub async fn commit_review_with_options(
        &self,
        revision: &str,
        path: &str,
        allow_large: bool,
    ) -> Result<CommitReview, String> {
        self.commit_review_with_encoding(revision, path, allow_large, None)
            .await
    }

    pub async fn commit_review_with_encoding(
        &self,
        revision: &str,
        path: &str,
        allow_large: bool,
        preferred_encoding: Option<&str>,
    ) -> Result<CommitReview, String> {
        validate_path(path)?;
        let details = self.details(revision).await?;
        let change = details
            .changes
            .iter()
            .find(|item| item.path == path)
            .ok_or("文件不属于所选提交的变更列表")?;
        let parent = details.commit.parents.first().cloned();
        let before_path = change.old_path.as_deref().unwrap_or(path);
        let (before_res, after_res, current_res) = tokio::join!(
            self.blob_snapshot_with_encoding(parent.as_deref(), before_path, allow_large, preferred_encoding),
            self.blob_snapshot_with_encoding(Some(revision), path, allow_large, preferred_encoding),
            self.review_worktree_with_encoding(path, allow_large, preferred_encoding),
        );
        let before = before_res?;
        let after = after_res?;
        let current = match current_res {
            Ok(current) => current,
            Err(error) => {
                let mut file = FileSnapshot::new(path, None, SnapshotState::Unavailable, &[]);
                file.reason = error;
                WorktreeSnapshot {
                    file,
                    branch: String::new(),
                    head: None,
                }
            }
        };
        Ok(CommitReview {
            revision: revision.into(),
            parent,
            before,
            after,
            current,
        })
    }

    #[cfg(test)]
    pub async fn review_worktree(&self, selected: &str) -> Result<WorktreeSnapshot, String> {
        self.review_worktree_with_options(selected, false).await
    }

    #[cfg(test)]
    pub async fn review_worktree_with_options(
        &self,
        selected: &str,
        allow_large: bool,
    ) -> Result<WorktreeSnapshot, String> {
        self.review_worktree_with_encoding(selected, allow_large, None)
            .await
    }

    pub async fn review_worktree_with_encoding(
        &self,
        selected: &str,
        allow_large: bool,
        preferred_encoding: Option<&str>,
    ) -> Result<WorktreeSnapshot, String> {
        let path = if Path::new(selected).is_absolute() {
            let absolute = std::fs::canonicalize(selected).map_err(|e| e.to_string())?;
            let relative = absolute
                .strip_prefix(&self.root)
                .map_err(|_| "请选择当前仓库内的文件")?;
            relative.to_string_lossy().replace('\\', "/")
        } else {
            selected.to_owned()
        };
        validate_path(&path)?;
        let (file, repository) = tokio::try_join!(
            self.worktree_snapshot_with_encoding(&path, allow_large, preferred_encoding),
            self.repository(),
        )?;
        Ok(WorktreeSnapshot {
            file,
            branch: repository.branch.unwrap_or_else(|| "detached HEAD".into()),
            head: repository.head,
        })
    }
}

#[cfg(test)]
mod tests;

use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HistoryAction {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MergeMode {
    #[default]
    Auto,
    NoFf,
    FfOnly,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryRequest {
    pub action: HistoryAction,
    pub target: String,
    pub target_hash: String,
    pub expected_head: String,
    pub expected_branch: String,
    #[serde(default)]
    pub merge_mode: MergeMode,
    pub mainline: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchComparison {
    pub base: String,
    pub target: String,
    pub base_name: String,
    pub target_name: String,
    pub base_only: usize,
    pub target_only: usize,
    pub changes: Vec<Change>,
}

impl Git {
    pub(crate) async fn compare_branch(&self, branch: &str) -> Result<BranchComparison, String> {
        let status = self.status().await?;
        let base = status.repository.head.ok_or("当前分支还没有提交")?;
        let target = status
            .branches
            .iter()
            .find(|item| item.full == branch)
            .ok_or("分支已不存在，请刷新后重试")?;
        let changes = self
            .bytes(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--name-status",
                "-z",
                "-M",
                &base,
                &target.hash,
                "--",
            ])
            .await?;
        let range = format!("{base}...{}", target.hash);
        let counts = self
            .text(&["rev-list", "--left-right", "--count", &range, "--"])
            .await?;
        let counts = counts
            .split_whitespace()
            .map(str::parse::<usize>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无法读取分支提交数量")?;
        if counts.len() != 2 {
            return Err("无法读取分支提交数量".into());
        }
        Ok(BranchComparison {
            base_name: status
                .repository
                .branch
                .unwrap_or_else(|| base[..8].to_owned()),
            base,
            target: target.hash.clone(),
            target_name: target.name.clone(),
            base_only: counts[0],
            target_only: counts[1],
            changes: parse_name_status(&changes)?,
        })
    }

    pub(crate) async fn start_history(&self, request: HistoryRequest) -> Result<String, String> {
        validate_hash(&request.expected_head)?;
        validate_hash(&request.target_hash)?;
        let status = self.status().await?;
        if status.repository.head.as_deref() != Some(&request.expected_head)
            || status.repository.branch.as_deref() != Some(&request.expected_branch)
        {
            return Err("当前分支或 HEAD 已改变，请重新打开操作窗口".into());
        }
        if status.repository.operation != "none" {
            return Err("请先继续或中止当前 Git 操作".into());
        }
        if !status.changes.is_empty() {
            return Err("请先提交或保存到 Stash，工作区和暂存区需要保持干净".into());
        }
        let mut args = match request.action {
            HistoryAction::Merge | HistoryAction::Rebase => {
                let branch = status
                    .branches
                    .iter()
                    .find(|branch| branch.full == request.target)
                    .ok_or("目标分支已不存在，请刷新后重试")?;
                if branch.hash != request.target_hash {
                    return Err("目标分支已移动，请重新打开操作窗口".into());
                }
                if request.mainline.is_some() {
                    return Err("分支操作不使用主线父提交".into());
                }
                match request.action {
                    HistoryAction::Merge => vec![
                        "merge",
                        "--no-edit",
                        "--no-autostash",
                        match request.merge_mode {
                            MergeMode::Auto => "--ff",
                            MergeMode::NoFf => "--no-ff",
                            MergeMode::FfOnly => "--ff-only",
                        },
                    ],
                    _ => vec!["-c", "rebase.updateRefs=false", "rebase", "--no-autostash"],
                }
            }
            HistoryAction::CherryPick | HistoryAction::Revert => {
                validate_hash(&request.target)?;
                if request.target != request.target_hash {
                    return Err("目标提交已改变".into());
                }
                let details = self.details(&request.target).await?;
                let parents = details.commit.parents.len();
                if parents > 1 {
                    if request
                        .mainline
                        .is_none_or(|parent| parent == 0 || parent as usize > parents)
                    {
                        return Err("请选择合并提交的主线父提交".into());
                    }
                } else if request.mainline.is_some() {
                    return Err("普通提交不使用主线父提交".into());
                }
                match request.action {
                    HistoryAction::CherryPick => vec!["cherry-pick"],
                    _ => vec!["revert", "--no-edit"],
                }
            }
        };
        let parent = request.mainline.map(|parent| parent.to_string());
        if let Some(parent) = &parent {
            args.extend(["--mainline", parent]);
        }
        args.extend(["--", &request.target_hash]);
        let current = self.repository().await?;
        if current.head.as_deref() != Some(&request.expected_head)
            || current.branch.as_deref() != Some(&request.expected_branch)
            || current.operation != "none"
        {
            return Err("Git 状态已改变，请重新打开操作窗口".into());
        }
        let output = self
            .execute_with_env(
                &args,
                None,
                &[("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", "true")],
            )
            .await?;
        let error_output = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = output.checked()?;
        Ok(format!(
            "{}\n{error_output}",
            String::from_utf8_lossy(&stdout).trim()
        )
        .trim()
        .to_owned())
    }
}

#[cfg(test)]
mod tests;

use super::*;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileHistoryEntry {
    commit: Commit,
    path: String,
    old_path: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileHistory {
    revision: String,
    entries: Vec<FileHistoryEntry>,
    has_more: bool,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BlameLine {
    hash: String,
    original_line: usize,
    line: usize,
    author: String,
    time: i64,
    summary: String,
    path: String,
    pub(super) text: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BlamePage {
    pub(super) lines: Vec<BlameLine>,
    has_more: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevisionTreeEntry {
    pub path: String,
    pub mode: String,
    pub object_hash: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevisionTree {
    pub revision: String,
    pub entries: Vec<RevisionTreeEntry>,
    pub truncated: bool,
}

#[derive(Clone, Debug, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InMemoryCommitEditRequest {
    pub revision: String,
    pub action: String,
    pub paths: Vec<String>,
    pub message: Option<String>,
}

impl Git {
    pub(crate) async fn file_history(
        &self,
        path: &str,
        revision: Option<&str>,
        offset: usize,
    ) -> Result<FileHistory, String> {
        validate_path(path)?;
        let revision = self.resolve_commit(revision.unwrap_or("HEAD")).await?;
        let count = offset.checked_add(101).ok_or("分页位置无效")?;
        let format = format!("--format=%x00{LOG_FORMAT}");
        let text = self
            .text(&[
                "--literal-pathspecs",
                "log",
                "--follow",
                "--name-status",
                "-M",
                "-z",
                &format,
                &format!("--max-count={count}"),
                &revision,
                "--",
                path,
            ])
            .await?;
        let fields: Vec<_> = text.split_terminator('\0').collect();
        let mut cursor = 0;
        let mut current_path = path.to_owned();
        let mut entries = Vec::new();
        while cursor < fields.len() {
            while cursor < fields.len() && fields[cursor].is_empty() {
                cursor += 1;
            }
            if cursor == fields.len() {
                break;
            }
            let commit = parse_commit(fields.get(cursor..cursor + 7).ok_or("文件历史记录不完整")?)?;
            cursor += 7;
            while cursor < fields.len() && fields[cursor].is_empty() {
                cursor += 1;
            }
            let mut old_path = None;
            let mut commit_path = current_path.clone();
            while cursor < fields.len() && !fields[cursor].is_empty() {
                let kind = fields[cursor]
                    .trim_start_matches('\n')
                    .chars()
                    .next()
                    .ok_or("文件状态无效")?;
                cursor += 1;
                let first = fields.get(cursor).ok_or("缺少文件路径")?;
                cursor += 1;
                if matches!(kind, 'R' | 'C') {
                    let next = fields.get(cursor).ok_or("缺少重命名路径")?;
                    cursor += 1;
                    if *next == current_path {
                        commit_path = (*next).into();
                        old_path = Some((*first).into());
                        if kind == 'R' {
                            current_path = (*first).into();
                        }
                    }
                }
            }
            entries.push(FileHistoryEntry {
                commit,
                path: commit_path,
                old_path,
            });
        }
        let has_more = entries.len() > offset.saturating_add(100);
        Ok(FileHistory {
            revision,
            entries: entries.into_iter().skip(offset).take(100).collect(),
            has_more,
        })
    }

    pub(crate) async fn blame(
        &self,
        path: &str,
        revision: Option<&str>,
        offset: usize,
    ) -> Result<BlamePage, String> {
        validate_path(path)?;
        let revision = match revision {
            Some(value) => Some(self.resolve_commit(value).await?),
            None => None,
        };
        let file = if let Some(revision) = &revision {
            self.blob_snapshot(Some(revision), path, true).await?
        } else {
            self.worktree_snapshot(path, true).await?
        };
        if file.state != content::SnapshotState::Text {
            return Err("此版本不是可读取的文本文件".into());
        }
        let line_count = file.text.lines().count();
        if offset >= line_count {
            return Ok(BlamePage {
                lines: vec![],
                has_more: false,
            });
        }
        let end = offset.saturating_add(200).min(line_count);
        let range = format!("{},{}", offset + 1, end);
        let mut args = vec![
            "--literal-pathspecs",
            "blame",
            "--line-porcelain",
            "-L",
            &range,
        ];
        if let Some(revision) = &revision {
            args.push(revision);
        }
        args.extend(["--", path]);
        let output = self.bytes(&args).await?;
        let mut lines = Vec::new();
        let mut entry = BlameLine::default();
        for raw_line in output.split(|&b| b == b'\n') {
            let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
            if raw_line.is_empty() && entry.hash.is_empty() {
                continue;
            }
            if let Some(text_bytes) = raw_line.strip_prefix(b"\t") {
                entry.text = super::encoding::decode_lossy_with_hint(text_bytes, Some(&file.encoding));
                lines.push(entry);
                entry = BlameLine::default();
                continue;
            }
            let line = String::from_utf8_lossy(raw_line);
            if let Some(author) = line.strip_prefix("author ") {
                entry.author = author.into();
            } else if let Some(time) = line.strip_prefix("author-time ") {
                entry.time = time.parse().map_err(|_| "Blame 时间无效")?;
            } else if let Some(summary) = line.strip_prefix("summary ") {
                entry.summary = summary.into();
            } else if let Some(path) = line.strip_prefix("filename ") {
                entry.path = decode_path(path)?;
            } else if line
                .split_whitespace()
                .next()
                .is_some_and(|hash| validate_hash(hash).is_ok())
            {
                let fields: Vec<_> = line.split_whitespace().collect();
                entry.hash = fields[0].into();
                entry.original_line = fields
                    .get(1)
                    .ok_or("Blame 行号缺失")?
                    .parse()
                    .map_err(|_| "Blame 行号无效")?;
                entry.line = fields
                    .get(2)
                    .ok_or("Blame 行号缺失")?
                    .parse()
                    .map_err(|_| "Blame 行号无效")?;
            }
        }
        Ok(BlamePage {
            lines,
            has_more: end < line_count,
        })
    }

    pub(crate) async fn selection_history(
        &self,
        path: &str,
        start_line: usize,
        end_line: usize,
        revision: Option<&str>,
    ) -> Result<FileHistory, String> {
        validate_path(path)?;
        if start_line == 0 || end_line < start_line {
            return Err("代码选区行号范围无效".into());
        }
        let revision = self.resolve_commit(revision.unwrap_or("HEAD")).await?;
        let format = format!("--format=%x00{LOG_FORMAT}%x00");
        let range_spec = format!("{start_line},{end_line}:{path}");
        let text = self
            .text(&[
                "--literal-pathspecs",
                "log",
                "--no-patch",
                "--max-count=100",
                &format,
                "-L",
                &range_spec,
                &revision,
            ])
            .await?;
        let fields: Vec<_> = text
            .split('\0')
            .map(|s| s.trim_matches(['\r', '\n']))
            .filter(|s| !s.is_empty())
            .collect();
        let mut entries = Vec::new();
        let mut cursor = 0;
        while cursor + 7 <= fields.len() {
            if validate_hash(fields[cursor]).is_ok() {
                let commit = parse_commit(&fields[cursor..cursor + 7])?;
                entries.push(FileHistoryEntry {
                    commit,
                    path: path.to_owned(),
                    old_path: None,
                });
                cursor += 7;
            } else {
                cursor += 1;
            }
        }
        Ok(FileHistory {
            revision,
            entries,
            has_more: false,
        })
    }

    pub(crate) async fn revision_tree(&self, revision: &str) -> Result<RevisionTree, String> {
        let target = if revision.trim().is_empty() {
            "HEAD"
        } else {
            revision.trim()
        };
        let resolved = self.resolve_commit(target).await?;
        let output = self
            .text(&["ls-tree", "-r", "-l", "-z", &resolved])
            .await?;
        let mut entries = Vec::new();
        let mut truncated = false;
        for record in output.split_terminator('\0') {
            let Some((meta, path)) = record.split_once('\t') else {
                continue;
            };
            let mut parts = meta.split_whitespace();
            let mode = parts.next().unwrap_or_default();
            let kind = parts.next().unwrap_or_default();
            let object_hash = parts.next().unwrap_or_default();
            let size_str = parts.next().unwrap_or("0");
            if kind != "blob" {
                continue;
            }
            if entries.len() >= 10_000 {
                truncated = true;
                break;
            }
            entries.push(RevisionTreeEntry {
                path: path.to_owned(),
                mode: mode.to_owned(),
                object_hash: object_hash.to_owned(),
                size: size_str.parse().unwrap_or(0),
            });
        }
        Ok(RevisionTree {
            revision: resolved,
            entries,
            truncated,
        })
    }

    pub(crate) async fn edit_commit_changes_in_memory(
        &self,
        request: InMemoryCommitEditRequest,
    ) -> Result<String, String> {
        if request.paths.is_empty() {
            return Err("请至少勾选一个要拆分或剔除的文件".into());
        }
        for path in &request.paths {
            validate_path(path)?;
        }
        let repository = self.repository().await?;
        if repository.operation != "none" {
            return Err("请先完成当前合并或变基操作".into());
        }
        let branch = repository.branch.ok_or("请先签出本地分支")?;
        let head = repository.head.ok_or("当前仓库尚无提交")?;
        let target = self.resolve_commit(&request.revision).await?;
        if self
            .execute(&["merge-base", "--is-ancestor", &target, &head], None)
            .await?
            .code
            != 0
        {
            return Err("所选提交不是当前分支 HEAD 的祖先提交".into());
        }
        let target_details = self.details(&target).await?;
        if target_details.commit.parents.len() != 1 {
            return Err("仅支持对具有单个父提交的非合并提交执行内存级变更拆分或剔除".into());
        }
        let parent_hash = &target_details.commit.parents[0];
        let range = format!("{target}..{head}");
        let merge_count: usize = self
            .text(&["rev-list", "--count", "--merges", &range, "--"])
            .await?
            .trim()
            .parse()
            .unwrap_or(0);
        if merge_count > 0 {
            return Err("目标提交与 HEAD 之间包含合并提交，无法直接线性重写".into());
        }
        let status = self.status().await?;
        if status.changes.iter().any(|change| {
            request.paths.contains(&change.path)
                || change
                    .old_path
                    .as_ref()
                    .is_some_and(|old| request.paths.contains(old))
        }) {
            return Err("所选文件在当前工作区中存在未提交更改，请先 Shelve 或提交该文件（其他无关文件的未提交修改不受影响）".into());
        }

        // Build reduced_tree (target tree with selected paths reverted to parent_hash state)
        let temp_dir = tempfile::Builder::new()
            .prefix("ideagittool-inmem-idx-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let temp_index = temp_dir.path().join("index");
        let temp_index_str = temp_index.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", temp_index_str.as_str())];

        self.execute_with_env(&["read-tree", &target], None, &env)
            .await?
            .checked()?;

        let mut candidate_paths = request.paths.clone();
        for change in &target_details.changes {
            if request.paths.contains(&change.path) {
                if let Some(old) = &change.old_path {
                    if !candidate_paths.contains(old) {
                        candidate_paths.push(old.clone());
                    }
                }
            }
        }

        for path in &candidate_paths {
            let ls = self
                .text(&["ls-tree", "-z", parent_hash, "--", path])
                .await?;
            let record = ls.split_terminator('\0').next().unwrap_or_default();
            if let Some((meta, listed_path)) = record.split_once('\t') {
                let mut parts = meta.split_whitespace();
                let mode = parts.next().unwrap_or_default();
                let _kind = parts.next().unwrap_or_default();
                let sha = parts.next().unwrap_or_default();
                let cacheinfo = format!("{mode},{sha},{listed_path}");
                self.execute_with_env(
                    &["update-index", "--add", "--cacheinfo", &cacheinfo],
                    None,
                    &env,
                )
                .await?
                .checked()?;
            } else {
                self.execute_with_env(&["update-index", "--force-remove", "--", path], None, &env)
                    .await?
                    .checked()?;
            }
        }

        let reduced_tree_bytes = self
            .execute_with_env(&["write-tree"], None, &env)
            .await?
            .checked()?;
        let reduced_tree = String::from_utf8_lossy(&reduced_tree_bytes)
            .trim()
            .to_owned();
        let parent_tree = self
            .text(&["rev-parse", &format!("{parent_hash}^{{tree}}")])
            .await?
            .trim()
            .to_owned();
        let target_tree = self
            .text(&["rev-parse", &format!("{target}^{{tree}}")])
            .await?
            .trim()
            .to_owned();

        if reduced_tree == target_tree {
            return Err("所选文件在该提交中没有变更".into());
        }

        let orig_message = if target_details.body.trim().is_empty() {
            target_details.commit.subject.clone()
        } else {
            format!(
                "{}\n\n{}",
                target_details.commit.subject,
                target_details.body.trim()
            )
        };

        let mut new_tip = match request.action.as_str() {
            "drop-changes" => {
                if reduced_tree == parent_tree {
                    parent_hash.clone()
                } else {
                    self.text(&[
                        "commit-tree",
                        &reduced_tree,
                        "-p",
                        parent_hash,
                        "-m",
                        &orig_message,
                    ])
                    .await?
                    .trim()
                    .to_owned()
                }
            }
            "extract-changes" => {
                let extract_msg = request
                    .message
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Extracted changes");
                if reduced_tree == parent_tree {
                    self.text(&[
                        "commit-tree",
                        &target_tree,
                        "-p",
                        parent_hash,
                        "-m",
                        extract_msg,
                    ])
                    .await?
                    .trim()
                    .to_owned()
                } else {
                    let first = self
                        .text(&[
                            "commit-tree",
                            &reduced_tree,
                            "-p",
                            parent_hash,
                            "-m",
                            &orig_message,
                        ])
                        .await?
                        .trim()
                        .to_owned();
                    self.text(&[
                        "commit-tree",
                        &target_tree,
                        "-p",
                        &first,
                        "-m",
                        extract_msg,
                    ])
                    .await?
                    .trim()
                    .to_owned()
                }
            }
            _ => return Err("不支持的内存提交编辑动作".into()),
        };

        let descendants: Vec<String> = self
            .text(&["rev-list", "--reverse", &range, "--"])
            .await?
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        let mut prev_old = target.clone();
        for desc in descendants {
            let merge_base_arg = format!("--merge-base={prev_old}");
            let merged = self
                .execute(
                    &[
                        "merge-tree",
                        "--write-tree",
                        &merge_base_arg,
                        &new_tip,
                        &desc,
                    ],
                    None,
                )
                .await?;
            if merged.code != 0 {
                return Err("后续提交依赖于被修改的同一文件区域，无法在内存中无冲突改写".into());
            }
            let merged_tree = String::from_utf8_lossy(&merged.stdout)
                .lines()
                .next()
                .unwrap_or_default()
                .trim()
                .to_owned();
            let desc_details = self.details(&desc).await?;
            let desc_msg = if desc_details.body.trim().is_empty() {
                desc_details.commit.subject
            } else {
                format!(
                    "{}\n\n{}",
                    desc_details.commit.subject,
                    desc_details.body.trim()
                )
            };
            new_tip = self
                .text(&[
                    "commit-tree",
                    &merged_tree,
                    "-p",
                    &new_tip,
                    "-m",
                    &desc_msg,
                ])
                .await?
                .trim()
                .to_owned();
            prev_old = desc;
        }

        let head_diff = self
            .text(&["diff", "--name-only", "-z", &head, &new_tip])
            .await?;
        let head_changed_paths: Vec<String> = head_diff
            .split_terminator('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        for changed in &head_changed_paths {
            if status.changes.iter().any(|c| {
                c.path == *changed || c.old_path.as_deref() == Some(changed.as_str())
            }) {
                return Err(format!(
                    "重写结果将影响当前工作区中有未提交更改的文件：{changed}"
                ));
            }
        }

        self.bytes(&[
            "update-ref",
            "-m",
            "ideagittool: in-memory commit edit",
            &format!("refs/heads/{branch}"),
            &new_tip,
            &head,
        ])
        .await?;

        for changed in &head_changed_paths {
            let exists_in_new = self
                .execute(
                    &["cat-file", "-e", &format!("{new_tip}:{changed}")],
                    None,
                )
                .await?
                .code
                == 0;
            if exists_in_new {
                self.bytes(&["checkout", &new_tip, "--", changed]).await?;
            } else {
                self.bytes(&["rm", "-f", "--quiet", "--", changed]).await?;
            }
        }

        Ok(new_tip)
    }
}

fn decode_path(path: &str) -> Result<String, String> {
    if !path.starts_with('"') {
        return Ok(path.into());
    }
    let bytes = path
        .strip_prefix('"')
        .and_then(|path| path.strip_suffix('"'))
        .ok_or("文件名引号无效")?
        .as_bytes();
    let mut result = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            result.push(bytes[index]);
            index += 1;
            continue;
        }
        index += 1;
        let byte = *bytes.get(index).ok_or("文件名转义无效")?;
        if matches!(byte, b'0'..=b'7') {
            let octal = bytes.get(index..index + 3).ok_or("文件名转义无效")?;
            let octal = std::str::from_utf8(octal).map_err(|_| "文件名转义无效")?;
            result.push(u8::from_str_radix(octal, 8).map_err(|_| "文件名转义无效")?);
            index += 3;
        } else {
            result.push(match byte {
                b'a' => 7,
                b'b' => 8,
                b't' => 9,
                b'n' => 10,
                b'v' => 11,
                b'f' => 12,
                b'r' => 13,
                b'"' => b'"',
                b'\\' => b'\\',
                _ => return Err("文件名转义无效".into()),
            });
            index += 1;
        }
    }
    String::from_utf8(result).map_err(|_| "文件名不是 UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    #[tokio::test]
    async fn file_history_follows_renames_and_blame_reports_source_commits() {
        let directory = fixture();
        std::fs::write(directory.path().join("before.txt"), "first\nsecond\n").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "first"]);
        let first = run(directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        run(directory.path(), &["mv", "before.txt", "空 格.txt"]);
        run(directory.path(), &["commit", "-m", "rename"]);
        std::fs::write(directory.path().join("空 格.txt"), "first\nchanged\n").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "change"]);
        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();
        let history = git.file_history("空 格.txt", None, 0).await.unwrap();
        assert_eq!(history.entries.len(), 3);
        assert_eq!(history.entries[1].old_path.as_deref(), Some("before.txt"));
        assert_eq!(history.entries[2].path, "before.txt");
        let blame = git.blame("空 格.txt", None, 0).await.unwrap();
        assert_eq!(blame.lines.len(), 2);
        assert_eq!(blame.lines[0].hash, first);
        assert_eq!(blame.lines[0].path, "before.txt");
        assert_eq!(blame.lines[1].summary, "change");

        // Selection history (git log -L 2,2) and Revision Tree
        let sel = git.selection_history("空 格.txt", 2, 2, None).await.unwrap();
        assert!(!sel.entries.is_empty());
        assert_eq!(sel.entries[0].commit.subject, "change");

        let tree = git.revision_tree(&first).await.unwrap();
        assert_eq!(tree.entries.len(), 1);
        assert_eq!(tree.entries[0].path, "before.txt");
    }

    #[tokio::test]
    async fn in_memory_commit_edit_extracts_and_drops_changes_while_preserving_unrelated_dirty_worktree() {
        let directory = fixture();
        std::fs::write(directory.path().join("base.txt"), "base\n").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "initial"]);

        // Commit 2 touches two files: a.txt and b.txt
        std::fs::write(directory.path().join("a.txt"), "feature a\n").unwrap();
        std::fs::write(directory.path().join("b.txt"), "feature b\n").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "bundle commit"]);
        let bundle_sha = run(directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();

        // Commit 3 touches c.txt
        std::fs::write(directory.path().join("c.txt"), "later c\n").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "later commit"]);

        // Dirty worktree on unrelated file dirty.txt
        std::fs::write(directory.path().join("dirty.txt"), "unrelated work in progress\n").unwrap();

        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();

        // 1. Extract b.txt from bundle_sha into a separate commit in memory!
        let new_head = git
            .edit_commit_changes_in_memory(InMemoryCommitEditRequest {
                revision: bundle_sha,
                action: "extract-changes".into(),
                paths: vec!["b.txt".into()],
                message: Some("extracted b.txt".into()),
            })
            .await
            .unwrap();
        assert!(!new_head.is_empty());

        // Verify commit log now has 4 commits: "later commit", "extracted b.txt", "bundle commit", "initial"
        let log = git
            .log(LogQuery {
                offset: 0,
                search: String::new(),
                branch: String::new(),
                author: String::new(),
                since: String::new(),
                until: String::new(),
                path: String::new(),
                content: String::new(),
                content_regex: false,
                first_parent: false,
                revision: String::new(),
                merge: "all".into(),
            })
            .await
            .unwrap();
        let subjects: Vec<_> = log.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(
            subjects,
            vec!["later commit", "extracted b.txt", "bundle commit", "initial"]
        );

        // Unrelated dirty worktree file is untouched!
        assert_eq!(
            std::fs::read_to_string(directory.path().join("dirty.txt")).unwrap(),
            "unrelated work in progress\n"
        );

        // 2. Drop b.txt from the "extracted b.txt" commit in memory
        let extracted_sha = log.commits[1].hash.clone();
        git.edit_commit_changes_in_memory(InMemoryCommitEditRequest {
            revision: extracted_sha,
            action: "drop-changes".into(),
            paths: vec!["b.txt".into()],
            message: None,
        })
        .await
        .unwrap();

        // b.txt is removed from HEAD and worktree, while dirty.txt is STILL intact!
        assert!(!directory.path().join("b.txt").exists());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("dirty.txt")).unwrap(),
            "unrelated work in progress\n"
        );
    }
}

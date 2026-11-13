use super::content::{FileSnapshot, SnapshotState, MAX_LARGE_FILE, MAX_LARGE_LINES};
use super::{validate_path, Git, MAX_FILE, MAX_LINES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::NamedTempFile;

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct Entry {
    mode: String,
    hash: String,
    stage: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictFile {
    path: String,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MergeOverview {
    operation: String,
    operation_id: String,
    files: Vec<ConflictFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangeState {
    start: usize,
    end: usize,
    resolved_left: bool,
    resolved_right: bool,
    oneside: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    lines: Vec<String>,
    states: Vec<ChangeState>,
    content_modified: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct Draft {
    entries: Vec<Entry>,
    operation_id: String,
    worktree: String,
    progress: Progress,
}

#[derive(Clone)]
pub(super) struct MergeSession {
    id: String,
    path: String,
    entries: Vec<Entry>,
    operation_id: String,
    worktree: String,
    crlf: bool,
    marker_size: usize,
    draft_path: PathBuf,
    allow_large: bool,
    editable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MergeDocument {
    id: String,
    path: String,
    base: String,
    left: String,
    right: String,
    working: Option<String>,
    left_title: String,
    right_title: String,
    left_stage: usize,
    left_present: bool,
    right_present: bool,
    editable: bool,
    can_load: bool,
    large: bool,
    reason: String,
    marker_size: usize,
    progress: Option<Progress>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveMerge {
    pub id: String,
    // result keeps Git's unmerged entries. finish clears them after writing.
    pub finish: bool,
    pub choice: String,
    pub progress: Option<Progress>,
}

impl Git {
    async fn unmerged(&self, path: Option<&str>) -> Result<BTreeMap<String, Vec<Entry>>, String> {
        let mut args = vec!["--literal-pathspecs", "ls-files", "--unmerged", "-z", "--"];
        if let Some(path) = path {
            validate_path(path)?;
            args.push(path);
        }
        let bytes = self.bytes(&args).await?;
        let text = std::str::from_utf8(&bytes).map_err(|_| "冲突文件名不是 UTF-8")?;
        let mut files: BTreeMap<String, Vec<Entry>> = BTreeMap::new();
        for record in text.split_terminator('\0') {
            let (header, path) = record.split_once('\t').ok_or("Git 冲突索引格式错误")?;
            let fields: Vec<_> = header.split_whitespace().collect();
            if fields.len() != 3 {
                return Err("Git 冲突索引格式错误".into());
            }
            files.entry(path.into()).or_default().push(Entry {
                mode: fields[0].into(),
                hash: fields[1].into(),
                stage: fields[2].parse().map_err(|_| "Git 冲突索引阶段错误")?,
            });
        }
        Ok(files)
    }

    async fn operation_id(&self) -> Result<String, String> {
        let repo = self.repository().await?;
        let git_dir = self.text(&["rev-parse", "--absolute-git-dir"]).await?;
        let mut hash = Sha256::new();
        hash.update(repo.head.unwrap_or_default());
        hash.update(repo.operation);
        for name in [
            "HEAD",
            "MERGE_HEAD",
            "REBASE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "rebase-merge/head-name",
            "rebase-merge/onto",
            "rebase-apply/head-name",
            "rebase-apply/onto",
        ] {
            hash.update(name);
            match File::open(Path::new(git_dir.trim()).join(name)) {
                Ok(file) => {
                    let mut bytes = Vec::new();
                    file.take(65537)
                        .read_to_end(&mut bytes)
                        .map_err(|e| e.to_string())?;
                    if bytes.len() > 65536 {
                        return Err("Git 操作元数据过大".into());
                    }
                    hash.update(bytes);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(format!("{:x}", hash.finalize()))
    }

    pub(crate) async fn merge_overview(&self) -> Result<MergeOverview, String> {
        let operation = self.repository().await?.operation;
        let files = self
            .unmerged(None)
            .await?
            .into_iter()
            .map(|(path, entries)| {
                let ours = entries.iter().any(|e| e.stage == 2);
                let theirs = entries.iter().any(|e| e.stage == 3);
                let base = entries.iter().any(|e| e.stage == 1);
                let kind = if !ours || !theirs {
                    "修改 / 删除"
                } else if !base {
                    "双方新增"
                } else {
                    "双方修改"
                };
                ConflictFile {
                    path,
                    kind: kind.into(),
                }
            })
            .collect();
        Ok(MergeOverview {
            operation,
            operation_id: self.operation_id().await?,
            files,
        })
    }

    async fn merge_blob(
        &self,
        entry: Option<&Entry>,
        path: &str,
        binary: bool,
        allow_large: bool,
    ) -> Result<FileSnapshot, String> {
        let Some(entry) = entry else {
            return Ok(FileSnapshot::new(path, None, SnapshotState::Missing, &[]));
        };
        self.blob_content(path, None, &entry.hash, binary, allow_large)
            .await
    }

    pub(crate) async fn open_merge(&mut self, path: String) -> Result<MergeDocument, String> {
        self.open_merge_with_options(path, false).await
    }

    pub(crate) async fn open_merge_with_options(
        &mut self,
        path: String,
        allow_large: bool,
    ) -> Result<MergeDocument, String> {
        validate_path(&path)?;
        let worktree_path = checked_path(&self.root, &path)?;
        let worktree = stamp(&worktree_path)?;
        let entries = self
            .unmerged(Some(&path))
            .await?
            .remove(&path)
            .ok_or("该文件已经没有冲突，请刷新列表")?;
        let operation_id = self.operation_id().await?;
        let repo = self.repository().await?;
        let rebase = repo.operation == "rebase";
        let left_stage = if rebase { 3 } else { 2 };
        let right_stage = if rebase { 2 } else { 3 };
        let base_entry = entries.iter().find(|e| e.stage == 1);
        let left_entry = entries.iter().find(|e| e.stage == left_stage);
        let right_entry = entries.iter().find(|e| e.stage == right_stage);
        let modes_supported = entries
            .iter()
            .all(|e| matches!(e.mode.as_str(), "100644" | "100755"));
        let binary = !modes_supported || self.binary_path(&path, None).await?;
        let base = self
            .merge_blob(base_entry, &path, binary, allow_large)
            .await?;
        let left = self
            .merge_blob(left_entry, &path, binary, allow_large)
            .await?;
        let right = self
            .merge_blob(right_entry, &path, binary, allow_large)
            .await?;
        let working_snapshot = self.worktree_snapshot(&path, allow_large).await?;
        let snapshots = [&base, &left, &right, &working_snapshot];
        let editable = modes_supported
            && snapshots
                .iter()
                .all(|file| matches!(file.state, SnapshotState::Text | SnapshotState::Missing));
        let can_load = modes_supported
            && !editable
            && snapshots.iter().all(|file| {
                matches!(file.state, SnapshotState::Text | SnapshotState::Missing) || file.can_load
            });
        let large = snapshots.iter().any(|file| file.large);
        let working = matches!(
            working_snapshot.state,
            SnapshotState::Text | SnapshotState::Missing
        )
        .then_some(working_snapshot.text);
        let reason = if !modes_supported {
            "符号链接或子模块冲突请在外部工具处理"
        } else if can_load {
            "大文件可按需加载，支持 10 MiB / 200,000 行以内的文本合并"
        } else if !editable {
            "二进制、非 UTF-8 或超出 10 MiB / 200,000 行的文件，可以选择保留一侧"
        } else {
            ""
        }
        .to_owned();
        let marker_data = self
            .text(&[
                "--literal-pathspecs",
                "check-attr",
                "-z",
                "conflict-marker-size",
                "--",
                &path,
            ])
            .await?;
        let marker_size = marker_data
            .split_terminator('\0')
            .nth(2)
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|size| (3..=1024).contains(size))
            .unwrap_or(7);
        let directory = PathBuf::from(
            self.text(&["rev-parse", "--absolute-git-dir"])
                .await?
                .trim(),
        )
        .join("ideagittool-merge-drafts");
        let draft_path = directory.join(format!("{:x}.json", Sha256::digest(path.as_bytes())));
        let progress = if let Ok(file) = File::open(&draft_path) {
            let mut bytes = Vec::new();
            file.take((MAX_LARGE_FILE * 8 + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            serde_json::from_slice::<Draft>(&bytes)
                .ok()
                .filter(|draft| {
                    draft.entries == entries
                        && draft.operation_id == operation_id
                        && draft.worktree == worktree
                        && validate_progress(&draft.progress, allow_large).is_ok()
                })
                .map(|draft| draft.progress)
        } else {
            None
        };
        if self.operation_id().await? != operation_id
            || self.unmerged(Some(&path)).await?.get(&path) != Some(&entries)
            || stamp(&worktree_path)? != worktree
        {
            return Err("读取时仓库或文件发生变化，请重试".into());
        }
        let git_directory = self.text(&["rev-parse", "--absolute-git-dir"]).await?;
        let revision = |name: &str| {
            fs::read_to_string(Path::new(git_directory.trim()).join(name))
                .ok()
                .map(|value| value.trim().chars().take(8).collect::<String>())
                .unwrap_or_default()
        };
        let head = repo
            .head
            .as_deref()
            .unwrap_or_default()
            .chars()
            .take(8)
            .collect::<String>();
        let other = match repo.operation.as_str() {
            "rebase" => revision("REBASE_HEAD"),
            "merge" => revision("MERGE_HEAD"),
            "cherry-pick" => revision("CHERRY_PICK_HEAD"),
            "revert" => revision("REVERT_HEAD"),
            _ => String::new(),
        };
        let left_present = left_entry.is_some();
        let right_present = right_entry.is_some();
        let id = format!("merge-{}", NEXT_SESSION.fetch_add(1, Ordering::Relaxed));
        self.merge_session = Some(MergeSession {
            id: id.clone(),
            path: path.clone(),
            entries,
            operation_id,
            worktree,
            crlf: working.as_ref().is_some_and(|text| text.contains("\r\n")),
            marker_size,
            draft_path,
            allow_large,
            editable,
        });
        Ok(MergeDocument {
            id,
            path,
            base: base.text,
            left: left.text,
            right: right.text,
            working,
            left_title: if rebase {
                format!("正在重放的提交 · {other}")
            } else {
                format!("本地版本 {} · {head}", repo.branch.unwrap_or_default())
            },
            right_title: if rebase {
                format!("目标分支及已重放提交 · {head}")
            } else {
                format!("合入的版本 · {other}")
            },
            left_stage,
            left_present,
            right_present,
            editable,
            can_load,
            large,
            reason,
            marker_size,
            progress,
        })
    }

    pub(crate) async fn save_merge(&mut self, request: SaveMerge) -> Result<(), String> {
        let mut session = self
            .merge_session
            .as_ref()
            .filter(|session| session.id == request.id)
            .cloned()
            .ok_or("合并会话已失效，请重新打开文件")?;
        let result = self.write_merge(&mut session, &request).await;
        self.merge_session = if request.finish && result.is_ok() {
            None
        } else {
            Some(session)
        };
        result
    }

    async fn write_merge(
        &self,
        session: &mut MergeSession,
        request: &SaveMerge,
    ) -> Result<(), String> {
        let index_path = self.root.join(
            self.text(&["rev-parse", "--git-path", "index"])
                .await?
                .trim(),
        );
        let transaction = IndexTransaction::new(&index_path)?;
        let path = checked_path(&self.root, &session.path)?;
        if self.operation_id().await? != session.operation_id
            || self.unmerged(Some(&session.path)).await?.get(&session.path)
                != Some(&session.entries)
            || stamp(&path)? != session.worktree
        {
            return Err(
                "文件、冲突索引或 Git 操作已在外部改变，已保留当前编辑内容。请重新读取后处理。"
                    .into(),
            );
        }
        let supported = session
            .entries
            .iter()
            .all(|e| matches!(e.mode.as_str(), "100644" | "100755"));
        if !supported {
            return Err("符号链接或子模块冲突请在外部工具处理".into());
        }
        let mut selected_mode = None;
        match request.choice.as_str() {
            "result" => {
                if !session.editable {
                    return Err("请先加载可编辑的文本合并内容".into());
                }
                let progress = request.progress.as_ref().ok_or("缺少合并结果")?;
                let content = validate_progress(progress, session.allow_large)?;
                if request.finish
                    && (progress
                        .states
                        .iter()
                        .any(|s| !s.resolved_left || !s.resolved_right)
                        || has_markers(&content, session.marker_size))
                {
                    return Err("仍有未确认的冲突块或 Git 冲突标记，请处理完后再暂存".into());
                }
                let content = if session.crlf {
                    content.replace('\n', "\r\n")
                } else {
                    content
                };
                let limit = if session.allow_large {
                    MAX_LARGE_FILE
                } else {
                    MAX_FILE
                };
                if content.len() > limit {
                    return Err("合并结果超过文件大小限制".into());
                }
                atomic_write(&path, content.as_bytes(), Some(&session.worktree))?;
            }
            "left" | "right" if request.finish => {
                let rebase = self.repository().await?.operation == "rebase";
                let stage = match (request.choice.as_str(), rebase) {
                    ("left", false) | ("right", true) => 2,
                    _ => 3,
                };
                if let Some(entry) = session.entries.iter().find(|entry| entry.stage == stage) {
                    selected_mode = Some(entry.mode.clone());
                    // checkout-index applies Git's worktree filters, encoding and file mode.
                    let directory = tempfile::tempdir_in(path.parent().ok_or("文件路径错误")?)
                        .map_err(|e| e.to_string())?;
                    let prefix = format!("--prefix={}/", super::git_path(directory.path()));
                    let stage = format!("--stage={stage}");
                    self.execute_with_env(
                        &[
                            "--literal-pathspecs",
                            "checkout-index",
                            "--force",
                            &prefix,
                            &stage,
                            "--",
                            &session.path,
                        ],
                        None,
                        &[("GIT_INDEX_FILE", transaction.temporary_path())],
                    )
                    .await?
                    .checked()?;
                    if stamp(&path)? != session.worktree
                        || self.operation_id().await? != session.operation_id
                    {
                        return Err("读取版本期间文件或 Git 操作发生变化，请重新读取".into());
                    }
                    fs::rename(directory.path().join(&session.path), &path)
                        .map_err(|e| e.to_string())?;
                } else if path.exists() {
                    fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
            }
            _ => return Err("未知的合并保存操作".into()),
        }
        // Preserve saved work even if filters or staging fail. The original
        // unmerged index remains intact until the index transaction commits.
        session.worktree = stamp(&path)?;
        if request.choice == "result" {
            let draft = Draft {
                entries: session.entries.clone(),
                operation_id: session.operation_id.clone(),
                worktree: session.worktree.clone(),
                progress: request.progress.clone().ok_or("缺少合并结果")?,
            };
            fs::create_dir_all(session.draft_path.parent().ok_or("草稿路径错误")?)
                .map_err(|e| e.to_string())?;
            atomic_write(
                &session.draft_path,
                &serde_json::to_vec(&draft).map_err(|e| e.to_string())?,
                None,
            )?;
        }
        if request.finish {
            self.execute_with_env(
                &["--literal-pathspecs", "add", "-A", "--", &session.path],
                None,
                &[("GIT_INDEX_FILE", transaction.temporary_path())],
            )
            .await?
            .checked()?;
            if let Some(mode) = selected_mode {
                let option = if mode == "100755" {
                    "--chmod=+x"
                } else {
                    "--chmod=-x"
                };
                self.execute_with_env(
                    &[
                        "--literal-pathspecs",
                        "update-index",
                        option,
                        "--",
                        &session.path,
                    ],
                    None,
                    &[("GIT_INDEX_FILE", transaction.temporary_path())],
                )
                .await?
                .checked()?;
            }
            if stamp(&path)? != session.worktree
                || self.operation_id().await? != session.operation_id
            {
                return Err(
                    "暂存期间文件或 Git 操作发生变化，合并结果已保存，请重新读取后确认".into(),
                );
            }
            transaction.commit()?;
            let _ = fs::remove_file(&session.draft_path);
        }
        Ok(())
    }

    pub(crate) async fn merge_operation(
        &mut self,
        operation_id: String,
        action: String,
    ) -> Result<(), String> {
        if self.operation_id().await? != operation_id {
            return Err("Git 操作已改变，请刷新后重试".into());
        }
        let operation = self.repository().await?.operation;
        if !matches!(
            operation.as_str(),
            "merge" | "rebase" | "cherry-pick" | "revert"
        ) || !matches!(action.as_str(), "continue" | "abort" | "skip")
            || (action == "skip" && operation == "merge")
        {
            return Err("当前没有支持继续或中止的 Git 操作".into());
        }
        if action == "continue" && !self.unmerged(None).await?.is_empty() {
            return Err("请先解决并暂存所有冲突文件".into());
        }
        let option = format!("--{action}");
        let environment = if operation == "rebase" {
            self.interactive_environment().await?
        } else {
            vec![("GIT_EDITOR".into(), "true".into())]
        };
        let environment: Vec<_> = environment
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        self.execute_with_env(&[&operation, &option], None, &environment)
            .await?
            .checked()?;
        self.merge_session = None;
        Ok(())
    }
}

fn checked_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    validate_path(relative)?;
    let path = root.join(relative);
    let parent = path
        .parent()
        .ok_or("文件路径错误")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(root) {
        return Err("文件目录位于仓库之外".into());
    }
    Ok(path)
}

fn stamp(path: &Path) -> Result<String, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok("missing".into()),
        Err(e) => return Err(e.to_string()),
    };
    if !metadata.file_type().is_file() {
        return Err("合并目标需要是普通文件".into());
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 16384];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!(
        "{:x}:{:?}",
        hash.finalize(),
        metadata.permissions()
    ))
}

fn atomic_write(path: &Path, bytes: &[u8], expected: Option<&str>) -> Result<(), String> {
    let mut temp =
        NamedTempFile::new_in(path.parent().ok_or("文件路径错误")?).map_err(|e| e.to_string())?;
    if let Ok(metadata) = fs::metadata(path) {
        temp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|e| e.to_string())?;
    }
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    if let Some(expected) = expected {
        if stamp(path)? != expected {
            return Err("写入前文件发生变化，当前编辑内容已保留".into());
        }
    }
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn validate_progress(progress: &Progress, allow_large: bool) -> Result<String, String> {
    let line_limit = if allow_large {
        MAX_LARGE_LINES
    } else {
        MAX_LINES
    };
    let byte_limit = if allow_large {
        MAX_LARGE_FILE
    } else {
        MAX_FILE
    };
    if progress.lines.is_empty()
        || progress.lines.len() > line_limit
        || progress.states.len() > line_limit
        || progress
            .lines
            .iter()
            .any(|line| line.contains(['\n', '\r', '\0']))
        || progress
            .states
            .iter()
            .any(|s| s.start > s.end || s.end > progress.lines.len())
    {
        return Err("合并进度格式错误或行数过多".into());
    }
    let bytes = progress.lines.iter().map(String::len).sum::<usize>() + progress.lines.len() - 1;
    if bytes > byte_limit {
        return Err("合并结果超过文件大小限制".into());
    }
    Ok(progress.lines.join("\n"))
}

fn has_markers(text: &str, size: usize) -> bool {
    let marker = "<".repeat(size);
    text.lines().any(|line| {
        line == marker
            || line
                .strip_prefix(&marker)
                .is_some_and(|rest| rest.starts_with(' '))
    })
}

// Match Git's own index.lock protocol. The temporary index retains all other
// staged files. Git filters operate on it before a single atomic index replace.
pub(super) struct IndexTransaction {
    index: PathBuf,
    lock: PathBuf,
    temporary: NamedTempFile,
    temporary_name: String,
}

impl IndexTransaction {
    pub(super) fn new(index: &Path) -> Result<Self, String> {
        let lock = index.with_file_name(format!(
            "{}.lock",
            index.file_name().ok_or("索引路径错误")?.to_string_lossy()
        ));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .map_err(|e| {
                format!(
                    "无法锁定 Git 文件 {}，请等待其他 Git 操作完成。{e}",
                    index.display()
                )
            })?;
        let temporary = match NamedTempFile::new_in(index.parent().ok_or("索引路径错误")?) {
            Ok(file) => file,
            Err(e) => {
                let _ = fs::remove_file(&lock);
                return Err(e.to_string());
            }
        };
        let transaction = Self {
            index: index.into(),
            lock,
            temporary_name: super::git_path(temporary.path()),
            temporary,
        };
        match fs::copy(index, transaction.temporary.path()) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        Ok(transaction)
    }

    pub(super) fn temporary_path(&self) -> &str {
        &self.temporary_name
    }

    pub(super) fn commit(self) -> Result<(), String> {
        fs::copy(self.temporary.path(), &self.lock).map_err(|e| e.to_string())?;
        OpenOptions::new()
            .write(true)
            .open(&self.lock)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(&self.lock, &self.index).map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl Drop for IndexTransaction {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.lock);
        let _ = fs::remove_file(format!("{}.lock", self.temporary_name));
    }
}

#[cfg(test)]
mod tests;

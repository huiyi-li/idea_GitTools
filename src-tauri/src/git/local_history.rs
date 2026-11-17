use super::Git;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_SNAPSHOT: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalHistoryEntry {
    pub id: String,
    pub path: String,
    pub timestamp: u64,
    pub reason: String,
    pub size: usize,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalHistorySnapshot {
    pub entry: LocalHistoryEntry,
    pub content: String,
}

#[derive(Serialize)]
pub struct RestorePreview {
    pub stamp: String,
}

async fn history_dir(git: &Git) -> Result<PathBuf, String> {
    let directory = git.local_history_directory.get_or_try_init(|| async {
        Ok::<PathBuf, String>(git.root.join(git.text(&["rev-parse", "--git-path", "ideagittool-local-history"]).await?.trim()))
    }).await?.clone();
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err("本地历史目录不能是符号链接或普通文件".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(directory)
}

fn path_key(path: &str) -> String {
    format!("{:x}", Sha256::digest(path.as_bytes()))
}

fn safe_path(git: &Git, path: &str) -> Result<PathBuf, String> {
    super::validate_path(path)?;
    let mut ancestor = git.root.clone();
    for component in Path::new(path).components() {
        let name = component.as_os_str().to_string_lossy();
        let normalized = name.trim_end_matches(['.', ' ']);
        if normalized.eq_ignore_ascii_case(".git")
            || cfg!(windows) && (name.contains(':') || normalized.eq_ignore_ascii_case("git~1"))
        {
            return Err("本地历史不能操作 Git 元数据路径".into());
        }
        ancestor.push(component);
        if fs::symlink_metadata(&ancestor).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err("本地历史路径不能包含符号链接或目录链接".into());
        }
    }
    let file = super::discard::checked_path(&git.root, path)?;
    match fs::symlink_metadata(&file) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err("本地历史仅支持普通文件，不能操作目录或符号链接".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(file)
}

fn read_bounded(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_file() {
        return Err("本地历史目标必须是普通文件".into());
    }
    if metadata.len() > limit as u64 {
        return Err("文件超过本地历史大小限制，无法安全保存或恢复".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("文件超过本地历史大小限制".into());
    }
    Ok(Some(bytes))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

async fn read_index(git: &Git, path: &str) -> Result<Vec<LocalHistoryEntry>, String> {
    let index = history_dir(git)
        .await?
        .join(format!("{}.json", path_key(path)));
    let Some(bytes) = read_bounded(&index, 1024 * 1024)? else {
        return Ok(Vec::new());
    };
    let entries: Vec<LocalHistoryEntry> =
        serde_json::from_slice(&bytes).map_err(|e| format!("读取本地历史失败。{e}"))?;
    if entries.len() > 100
        || entries
            .iter()
            .any(|entry| !valid_id(&entry.id) || entry.path != path || entry.size > MAX_SNAPSHOT)
    {
        return Err("本地历史索引无效".into());
    }
    Ok(entries)
}

async fn write_index(git: &Git, path: &str, entries: &[LocalHistoryEntry]) -> Result<(), String> {
    let directory = history_dir(git).await?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let index = directory.join(format!("{}.json", path_key(path)));
    let bytes = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
    super::merge::atomic_write(&index, &bytes, None)
}

fn preview_stamp(
    git: &Git,
    id: &str,
    path: &str,
    worktree: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let mut hash = Sha256::new();
    hash.update(
        serde_json::to_vec(&(git.root_string(), id, path, worktree)).map_err(|e| e.to_string())?,
    );
    hash.update(bytes);
    Ok(format!("{:x}", hash.finalize()))
}

impl Git {
    pub(crate) async fn local_history_list(
        &self,
        path: &str,
    ) -> Result<Vec<LocalHistoryEntry>, String> {
        safe_path(self, path)?;
        let mut entries = read_index(self, path).await?;
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.timestamp));
        Ok(entries)
    }

    pub(crate) async fn local_history_capture(
        &self,
        path: &str,
        reason: &str,
    ) -> Result<(), String> {
        let file = safe_path(self, path)?;
        let Some(bytes) = read_bounded(&file, MAX_SNAPSHOT)? else {
            return Ok(());
        };
        let mut entries = read_index(self, path).await?;
        let directory = history_dir(self).await?;
        if let Some(latest) = entries.first() {
            if read_bounded(
                &directory.join(format!("{}.snapshot", latest.id)),
                MAX_SNAPSHOT,
            )?
            .as_deref()
                == Some(bytes.as_slice())
            {
                return Ok(());
            }
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as u64;
        let id = format!("{timestamp}-{:x}", Sha256::digest(&bytes));
        let entry = LocalHistoryEntry {
            id: id.clone(),
            path: path.into(),
            timestamp,
            reason: if reason.is_empty() {
                "工作区刷新".into()
            } else {
                reason.chars().take(512).collect()
            },
            size: bytes.len(),
            binary: bytes.contains(&0) || std::str::from_utf8(&bytes).is_err(),
        };
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        super::merge::atomic_write(&directory.join(format!("{id}.snapshot")), &bytes, None)?;
        entries.insert(0, entry);
        entries.truncate(100);
        write_index(self, path, &entries).await
    }

    pub(crate) async fn local_history_read(
        &self,
        id: &str,
        path: &str,
    ) -> Result<LocalHistorySnapshot, String> {
        safe_path(self, path)?;
        if !valid_id(id) {
            return Err("本地历史快照标识无效".into());
        }
        let entries = read_index(self, path).await?;
        let entry = entries
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or("本地历史快照不存在")?;
        let bytes = read_bounded(
            &history_dir(self).await?.join(format!("{id}.snapshot")),
            MAX_SNAPSHOT,
        )?
        .ok_or("本地历史快照文件不存在")?;
        let content = if entry.binary {
            base64::engine::general_purpose::STANDARD.encode(bytes)
        } else {
            String::from_utf8(bytes).map_err(|e| format!("本地历史快照不是 UTF-8。{e}"))?
        };
        Ok(LocalHistorySnapshot { entry, content })
    }

    async fn restore_data(
        &self,
        id: &str,
        path: &str,
    ) -> Result<(PathBuf, Vec<u8>, String), String> {
        let file = safe_path(self, path)?;
        let snapshot = self.local_history_read(id, path).await?;
        let bytes = if snapshot.entry.binary {
            base64::engine::general_purpose::STANDARD
                .decode(snapshot.content)
                .map_err(|e| e.to_string())?
        } else {
            snapshot.content.into_bytes()
        };
        read_bounded(&file, MAX_SNAPSHOT)?;
        let stamp = super::merge::stamp(&file)?;
        Ok((file, bytes, stamp))
    }

    pub(crate) async fn local_history_preview_restore(
        &self,
        id: &str,
        path: &str,
    ) -> Result<RestorePreview, String> {
        let (_, bytes, worktree) = self.restore_data(id, path).await?;
        Ok(RestorePreview {
            stamp: preview_stamp(self, id, path, &worktree, &bytes)?,
        })
    }

    pub(crate) async fn local_history_restore(
        &self,
        id: &str,
        path: &str,
        expected_stamp: &str,
    ) -> Result<(), String> {
        let (file, bytes, worktree) = self.restore_data(id, path).await?;
        if expected_stamp != preview_stamp(self, id, path, &worktree, &bytes)? {
            return Err("文件或快照已改变，请重新预览后恢复".into());
        }
        self.local_history_capture(path, "恢复前自动备份").await?;
        fs::create_dir_all(file.parent().ok_or("文件路径无效")?).map_err(|e| e.to_string())?;
        safe_path(self, path)?;
        super::merge::atomic_write(&file, &bytes, Some(&worktree))
    }
}

#[cfg(test)]
#[path = "local_history_tests.rs"]
mod tests;

use super::Git;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
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

fn history_dir(git: &Git) -> PathBuf {
    git.root.join(".git").join("ideagittool-local-history")
}

fn path_key(path: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(path.as_bytes());
    format!("{:x}", hash.finalize())
}

fn safe_path(git: &Git, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("路径必须是仓库内的相对路径".into());
    }
    Ok(git.root.join(relative))
}

async fn read_index(git: &Git, path: &str) -> Result<Vec<LocalHistoryEntry>, String> {
    let index = history_dir(git).join(format!("{}.json", path_key(path)));
    match tokio::fs::read(index).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("读取本地历史失败。{e}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("读取本地历史失败。{error}")),
    }
}

async fn write_index(git: &Git, path: &str, entries: &[LocalHistoryEntry]) -> Result<(), String> {
    let directory = history_dir(git);
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|e| format!("创建本地历史目录失败。{e}"))?;
    let index = directory.join(format!("{}.json", path_key(path)));
    let bytes = serde_json::to_vec_pretty(entries).map_err(|e| format!("保存本地历史失败。{e}"))?;
    tokio::fs::write(index, bytes)
        .await
        .map_err(|e| format!("保存本地历史失败。{e}"))
}

fn snapshot_path(git: &Git, id: &str) -> PathBuf {
    history_dir(git).join(format!("{id}.snapshot"))
}

impl Git {
    pub(crate) async fn local_history_list(&self, path: &str) -> Result<Vec<LocalHistoryEntry>, String> {
        safe_path(self, path)?;
        let mut entries = read_index(self, path).await?;
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.timestamp));
        Ok(entries)
    }

    pub(crate) async fn local_history_capture(&self, path: &str, reason: &str) -> Result<(), String> {
        let file = safe_path(self, path)?;
        let bytes = match tokio::fs::read(&file).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("读取文件失败。{error}")),
        };
        if bytes.len() > MAX_SNAPSHOT {
            return Ok(());
        }
        let binary = std::str::from_utf8(&bytes).is_err();
        let content = if binary {
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        } else {
            String::from_utf8(bytes.clone()).map_err(|e| e.to_string())?
        };
        let mut entries = read_index(self, path).await?;
        if let Some(latest) = entries.first() {
            let latest_path = snapshot_path(self, &latest.id);
            if let Ok(previous) = tokio::fs::read(&latest_path).await {
                if previous == bytes {
                    return Ok(());
                }
            }
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as u64;
        let id = format!("{}-{}", timestamp, path_key(&content)[..12].to_owned());
        let entry = LocalHistoryEntry {
            id: id.clone(),
            path: path.to_owned(),
            timestamp,
            reason: if reason.is_empty() { "工作区刷新".into() } else { reason.into() },
            size: bytes.len(),
            binary,
        };
        tokio::fs::create_dir_all(history_dir(self))
            .await
            .map_err(|e| format!("创建本地历史目录失败。{e}"))?;
        tokio::fs::write(snapshot_path(self, &id), bytes)
            .await
            .map_err(|e| format!("保存本地历史失败。{e}"))?;
        entries.insert(0, entry);
        entries.truncate(100);
        write_index(self, path, &entries).await
    }

    pub(crate) async fn local_history_read(&self, id: &str, path: &str) -> Result<LocalHistorySnapshot, String> {
        safe_path(self, path)?;
        let entries = read_index(self, path).await?;
        let entry = entries.into_iter().find(|entry| entry.id == id).ok_or_else(|| "本地历史快照不存在".to_owned())?;
        let bytes = tokio::fs::read(snapshot_path(self, id)).await.map_err(|e| format!("读取本地历史快照失败。{e}"))?;
        let content = if entry.binary {
            base64::engine::general_purpose::STANDARD.encode(bytes)
        } else {
            String::from_utf8(bytes).map_err(|e| format!("本地历史快照不是 UTF-8。{e}"))?
        };
        Ok(LocalHistorySnapshot { entry, content })
    }

    pub(crate) async fn local_history_restore(&self, id: &str, path: &str) -> Result<(), String> {
        let file = safe_path(self, path)?;
        let snapshot = self.local_history_read(id, path).await?;
        let bytes = if snapshot.entry.binary {
            base64::engine::general_purpose::STANDARD
                .decode(snapshot.content)
                .map_err(|e| format!("解码本地历史快照失败。{e}"))?
        } else {
            snapshot.content.into_bytes()
        };
        if let Some(parent) = file.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| format!("创建文件目录失败。{e}"))?;
        }
        tokio::fs::write(file, bytes).await.map_err(|e| format!("恢复本地历史失败。{e}"))
    }
}


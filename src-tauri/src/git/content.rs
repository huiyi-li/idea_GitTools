use super::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;

pub(super) const MAX_LARGE_FILE: usize = 10 * 1024 * 1024;
pub(super) const MAX_LARGE_LINES: usize = 200_000;
const PROBE_SIZE: usize = 8192;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotState {
    Text,
    Missing,
    Binary,
    TooLarge,
    Encoding,
    Submodule,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub path: String,
    pub revision: Option<String>,
    pub state: SnapshotState,
    pub text: String,
    pub fingerprint: String,
    pub reason: String,
    pub size: u64,
    pub large: bool,
    pub can_load: bool,
}

impl FileSnapshot {
    pub(super) fn new(
        path: &str,
        revision: Option<&str>,
        state: SnapshotState,
        bytes: &[u8],
    ) -> Self {
        Self {
            path: path.into(),
            revision: revision.map(str::to_owned),
            fingerprint: format!("{state:?}:{:x}", Sha256::digest(bytes)),
            state,
            text: String::new(),
            reason: String::new(),
            size: bytes.len() as u64,
            large: false,
            can_load: false,
        }
    }

    fn from_bytes(path: &str, revision: Option<&str>, bytes: &[u8], allow_large: bool) -> Self {
        let mut file = Self::new(path, revision, SnapshotState::Text, bytes);
        if binary_bytes(bytes) {
            file.state = SnapshotState::Binary;
            return file;
        }
        let Ok(text) = std::str::from_utf8(bytes) else {
            file.state = SnapshotState::Encoding;
            return file;
        };
        let lines = bytes.iter().filter(|&&b| b == b'\n').count() + 1;
        file.large = bytes.len() > MAX_FILE || lines > MAX_LINES;
        if bytes.len() > MAX_LARGE_FILE || lines > MAX_LARGE_LINES {
            file.state = SnapshotState::TooLarge;
            file.reason = "文件超过 10 MiB 或 200,000 行，请使用外部工具处理".into();
        } else if file.large && !allow_large {
            file.state = SnapshotState::TooLarge;
            file.can_load = true;
            file.reason = "文件超过自动加载阈值，可按需加载大文件".into();
        } else {
            file.text = text.into();
        }
        file
    }
}

fn binary_bytes(bytes: &[u8]) -> bool {
    bytes.contains(&0)
        || bytes.starts_with(b"MZ")
        || bytes.starts_with(b"\x7fELF")
        || bytes.starts_with(b"!<arch>\n")
        || bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
}

fn binary_extension(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "exe"
            | "dll"
            | "lib"
            | "a"
            | "o"
            | "obj"
            | "pdb"
            | "so"
            | "dylib"
            | "zip"
            | "7z"
            | "gz"
            | "rar"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "ico"
            | "pdf"
            | "woff"
            | "woff2"
            | "ttf"
            | "mp3"
            | "mp4"
            | "wasm"
    )
}

impl Git {
    pub(super) async fn index_snapshot(
        &self,
        path: &str,
        allow_large: bool,
    ) -> Result<FileSnapshot, String> {
        let data = self
            .text(&[
                "--literal-pathspecs",
                "ls-files",
                "--stage",
                "-z",
                "--",
                path,
            ])
            .await?;
        if data.is_empty() {
            return Ok(FileSnapshot::new(path, None, SnapshotState::Missing, &[]));
        }
        let header = data.split('\t').next().ok_or("Git 暂存区条目无效")?;
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 3 || fields[2] != "0" {
            return Err("请在合并管理器中查看冲突文件".into());
        }
        if fields[0] == "160000" {
            return Ok(FileSnapshot::new(
                path,
                None,
                SnapshotState::Submodule,
                fields[1].as_bytes(),
            ));
        }
        self.blob_content(
            path,
            None,
            fields[1],
            self.binary_path(path, None).await?,
            allow_large,
        )
        .await
    }

    // A Git attribute explicitly selects the display policy before extension detection.
    pub(super) async fn binary_path(
        &self,
        path: &str,
        revision: Option<&str>,
    ) -> Result<bool, String> {
        let source = revision.map(|value| format!("--source={value}"));
        let mut args = vec!["--literal-pathspecs", "check-attr", "-z"];
        if let Some(source) = &source {
            args.push(source);
        }
        args.extend(["diff", "--", path]);
        let output = self.text(&args).await?;
        let value = output
            .split_terminator('\0')
            .nth(2)
            .ok_or("Git 文件属性格式错误")?;
        match value {
            "unset" => Ok(true),
            "set" => Ok(false),
            "unspecified" => Ok(binary_extension(path)),
            driver => {
                let key = format!("diff.{driver}.binary");
                let result = self
                    .execute(&["config", "--bool", "--get", &key], None)
                    .await?;
                match result.code {
                    0 => Ok(result.stdout.starts_with(b"true")),
                    1 => Ok(false),
                    _ => Err("Git diff 驱动的 binary 配置无效".into()),
                }
            }
        }
    }

    async fn blob_probe(&self, hash: &str) -> Result<Vec<u8>, String> {
        let mut command = Command::new("git");
        command
            .args(["cat-file", "blob", hash])
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            child
                .stdout
                .take()
                .ok_or("Git stdout is unavailable")?
                .take(PROBE_SIZE as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|error| error.to_string())
        })
        .await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        result.map_err(|_| "读取文件头超时")??;
        Ok(bytes)
    }

    pub(super) async fn blob_snapshot(
        &self,
        revision: Option<&str>,
        path: &str,
        allow_large: bool,
    ) -> Result<FileSnapshot, String> {
        let Some(revision) = revision else {
            return Ok(FileSnapshot::new(path, None, SnapshotState::Missing, &[]));
        };
        let tree = self
            .text(&["--literal-pathspecs", "ls-tree", "-z", revision, "--", path])
            .await?;
        if tree.is_empty() {
            return Ok(FileSnapshot::new(
                path,
                Some(revision),
                SnapshotState::Missing,
                &[],
            ));
        }
        let header = tree.split('\t').next().ok_or("Git 文件条目无效")?;
        let fields: Vec<_> = header.split(' ').collect();
        if fields.len() != 3 {
            return Err("Git 文件条目无效".into());
        }
        if fields[1] == "commit" {
            return Ok(FileSnapshot::new(
                path,
                Some(revision),
                SnapshotState::Submodule,
                fields[2].as_bytes(),
            ));
        }
        if fields[1] != "blob" {
            return Err("请选择提交中的文件".into());
        }
        let binary = self.binary_path(path, Some(revision)).await?;
        self.blob_content(path, Some(revision), fields[2], binary, allow_large)
            .await
    }

    pub(super) async fn blob_content(
        &self,
        path: &str,
        revision: Option<&str>,
        hash: &str,
        binary: bool,
        allow_large: bool,
    ) -> Result<FileSnapshot, String> {
        let size = self
            .text(&["cat-file", "-s", hash])
            .await?
            .trim()
            .parse::<u64>()
            .map_err(|error| error.to_string())?;
        let mut file = FileSnapshot::new(path, revision, SnapshotState::Binary, hash.as_bytes());
        file.size = size;
        if binary {
            return Ok(file);
        }
        if size > MAX_FILE as u64 {
            if binary_bytes(&self.blob_probe(hash).await?) {
                return Ok(file);
            }
            file.large = true;
            if size > MAX_LARGE_FILE as u64 || !allow_large {
                file.state = SnapshotState::TooLarge;
                file.can_load = size <= MAX_LARGE_FILE as u64;
                file.reason = if file.can_load {
                    "文件超过自动加载阈值，可按需加载大文件"
                } else {
                    "文件超过 10 MiB，请使用外部工具处理"
                }
                .into();
                return Ok(file);
            }
        }
        let bytes = self.bytes(&["cat-file", "blob", hash]).await?;
        Ok(FileSnapshot::from_bytes(
            path,
            revision,
            &bytes,
            allow_large,
        ))
    }

    pub(super) async fn worktree_snapshot(
        &self,
        path: &str,
        allow_large: bool,
    ) -> Result<FileSnapshot, String> {
        validate_path(path)?;
        let absolute = self.root.join(path);
        if let Some(parent) = absolute.parent() {
            match parent.canonicalize() {
                Ok(parent) if !parent.starts_with(&self.root) => {
                    return Err("File is outside the repository.".into())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(FileSnapshot::new(path, None, SnapshotState::Missing, &[]))
                }
                Err(error) => return Err(error.to_string()),
                _ => {}
            }
        }
        let metadata = match std::fs::symlink_metadata(&absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(FileSnapshot::new(path, None, SnapshotState::Missing, &[]))
            }
            Err(error) => return Err(error.to_string()),
        };
        if metadata.file_type().is_symlink() {
            let link = std::fs::read_link(absolute).map_err(|error| error.to_string())?;
            return Ok(FileSnapshot::from_bytes(
                path,
                None,
                link.to_string_lossy().as_bytes(),
                allow_large,
            ));
        }
        if metadata.is_dir() {
            return Ok(FileSnapshot::new(path, None, SnapshotState::Submodule, &[]));
        }
        let mut file = FileSnapshot::new(path, None, SnapshotState::Binary, &[]);
        file.size = metadata.len();
        if self.binary_path(path, None).await? {
            return Ok(file);
        }
        let mut reader = std::fs::File::open(&absolute).map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut reader)
            .take(PROBE_SIZE as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if binary_bytes(&bytes) {
            return Ok(file);
        }
        if metadata.len() > MAX_LARGE_FILE as u64
            || (metadata.len() > MAX_FILE as u64 && !allow_large)
        {
            file.state = SnapshotState::TooLarge;
            file.large = true;
            file.can_load = metadata.len() <= MAX_LARGE_FILE as u64;
            file.reason = if file.can_load {
                "文件超过自动加载阈值，可按需加载大文件"
            } else {
                "文件超过 10 MiB，请使用外部工具处理"
            }
            .into();
            return Ok(file);
        }
        Read::by_ref(&mut reader)
            .take(MAX_LARGE_FILE as u64 + 1 - bytes.len() as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(FileSnapshot::from_bytes(path, None, &bytes, allow_large))
    }
}

#[cfg(test)]
mod tests;

use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DiscardMode {
    Unstaged,
    All,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscardFile {
    pub path: String,
    pub delete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscardPreview {
    pub root: String,
    pub mode: DiscardMode,
    pub paths: Vec<String>,
    pub files: Vec<DiscardFile>,
    pub fingerprint: String,
}

fn entries(bytes: &[u8]) -> Result<BTreeMap<String, String>, String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let text = std::str::from_utf8(entry).map_err(|_| "文件名不是 UTF-8")?;
            let (header, path) = text.split_once('\t').ok_or("Git 文件条目无效")?;
            Ok((
                path.into(),
                header
                    .split_whitespace()
                    .next()
                    .ok_or("Git 文件模式无效")?
                    .into(),
            ))
        })
        .collect()
}

fn checked_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    validate_path(path)?;
    let absolute = root.join(path);
    let mut parent = absolute.parent();
    while let Some(directory) = parent {
        match directory.canonicalize() {
            Ok(resolved) if !resolved.starts_with(root) => {
                return Err("文件目录位于仓库之外".into())
            }
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                parent = directory.parent()
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    match fs::symlink_metadata(&absolute) {
        Ok(metadata) if !metadata.is_file() && !metadata.file_type().is_symlink() => {
            return Err("目录和子模块请通过对应仓库处理".into())
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
        _ => {}
    }
    Ok(absolute)
}

enum SavedContent {
    Missing,
    File(PathBuf, fs::Permissions),
    Symlink(PathBuf, bool),
}

fn directory_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x10 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

fn remove_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() && directory_link(&metadata) => {
            fs::remove_dir(path)
        }
        Ok(metadata) if metadata.is_dir() => return Err("目标已变为目录，请重新获取预览".into()),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    }
    .map_err(|error| error.to_string())
}

struct WorktreeBackup {
    directory: tempfile::TempDir,
    files: Vec<(PathBuf, SavedContent)>,
}

impl WorktreeBackup {
    fn new(root: &Path, directory: &Path, files: &[DiscardFile]) -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("ideagittool-discard-")
            .tempdir_in(directory)
            .map_err(|error| error.to_string())?;
        let mut saved = Vec::new();
        for (index, file) in files.iter().enumerate() {
            let path = checked_path(root, &file.path)?;
            let content = match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => SavedContent::Symlink(
                    fs::read_link(&path).map_err(|error| error.to_string())?,
                    directory_link(&metadata),
                ),
                Ok(metadata) => {
                    let target = directory.path().join(index.to_string());
                    fs::copy(&path, &target).map_err(|error| error.to_string())?;
                    SavedContent::File(target, metadata.permissions())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => SavedContent::Missing,
                Err(error) => return Err(error.to_string()),
            };
            saved.push((path, content));
        }
        Ok(Self {
            directory,
            files: saved,
        })
    }

    fn restore(&self, root: &Path) -> Result<(), String> {
        for (path, content) in &self.files {
            let relative = path.strip_prefix(root).map_err(|_| "备份路径无效")?;
            checked_path(root, &relative.to_string_lossy())?;
            match content {
                SavedContent::Missing => remove_file(path)?,
                SavedContent::File(source, permissions) => {
                    fs::create_dir_all(path.parent().ok_or("文件路径无效")?)
                        .map_err(|error| error.to_string())?;
                    let temporary =
                        tempfile::NamedTempFile::new_in(path.parent().ok_or("文件路径无效")?)
                            .map_err(|error| error.to_string())?;
                    fs::copy(source, temporary.path()).map_err(|error| error.to_string())?;
                    temporary
                        .as_file()
                        .set_permissions(permissions.clone())
                        .map_err(|error| error.to_string())?;
                    temporary.persist(path).map_err(|error| error.to_string())?;
                }
                SavedContent::Symlink(target, is_directory) => {
                    remove_file(path)?;
                    #[cfg(windows)]
                    {
                        if *is_directory {
                            std::os::windows::fs::symlink_dir(target, path)
                        } else {
                            std::os::windows::fs::symlink_file(target, path)
                        }
                        .map_err(|error| error.to_string())?;
                    }
                    #[cfg(unix)]
                    {
                        let _ = is_directory;
                        std::os::unix::fs::symlink(target, path)
                            .map_err(|error| error.to_string())?;
                    }
                }
            }
        }
        Ok(())
    }
}

impl Git {
    pub(crate) async fn preview_discard(
        &self,
        paths: Vec<String>,
        mode: DiscardMode,
    ) -> Result<DiscardPreview, String> {
        if paths.is_empty() || paths.len() > 10_000 {
            return Err("请选择 1 到 10,000 个文件".into());
        }
        let status = self.status().await?;
        let index = self.bytes(&["ls-files", "--stage", "-z"]).await?;
        let indexed = entries(&index)?;
        let head_files = match &status.repository.head {
            Some(head) => entries(&self.bytes(&["ls-tree", "-r", "-z", head]).await?)?,
            None => BTreeMap::new(),
        };
        let mut selected = BTreeSet::new();
        for path in paths {
            validate_path(&path)?;
            let change = status
                .changes
                .iter()
                .find(|change| {
                    change.path == path
                        && (mode == DiscardMode::All
                            || change.work_tree != ' '
                            || change.index == '?')
                })
                .ok_or("文件状态已改变，请重新选择")?;
            if change.conflict {
                return Err("请先在合并管理器中处理冲突文件".into());
            }
            if mode == DiscardMode::Unstaged && change.work_tree == ' ' && change.index != '?' {
                return Err("该文件没有未暂存更改".into());
            }
            if mode == DiscardMode::All && change.index == 'R' {
                if let Some(old) = &change.old_path {
                    selected.insert(old.clone());
                }
            }
            selected.insert(path);
        }
        let mut hash = Sha256::new();
        hash.update(self.root_string());
        hash.update(serde_json::to_vec(&status.repository).map_err(|error| error.to_string())?);
        hash.update(&index);
        let mut files = Vec::new();
        for path in &selected {
            let absolute = checked_path(&self.root, path)?;
            if indexed.get(path).is_some_and(|mode| mode == "160000")
                || head_files.get(path).is_some_and(|mode| mode == "160000")
            {
                return Err("子模块请通过对应仓库处理".into());
            }
            hash.update(path.as_bytes());
            hash.update([0]);
            super::navigation::hash_path(&mut hash, &absolute)?;
            if let Ok(metadata) = fs::symlink_metadata(&absolute) {
                hash.update(format!("{:?}", metadata.permissions()));
            }
            let delete = match mode {
                DiscardMode::Unstaged => !indexed.contains_key(path),
                DiscardMode::All => !head_files.contains_key(path),
            };
            files.push(DiscardFile {
                path: path.clone(),
                delete,
            });
        }
        Ok(DiscardPreview {
            root: self.root_string(),
            mode,
            paths: selected
                .into_iter()
                .filter(|path| status.changes.iter().any(|change| &change.path == path))
                .collect(),
            files,
            fingerprint: format!("{:x}", hash.finalize()),
        })
    }

    pub(crate) async fn discard_changes(&self, request: DiscardPreview) -> Result<(), String> {
        if request.root != self.root_string() {
            return Err("仓库已改变，请重新获取预览".into());
        }
        let index_path = self.root.join(
            self.text(&["rev-parse", "--git-path", "index"])
                .await?
                .trim(),
        );
        let transaction = super::merge::IndexTransaction::new(&index_path)?;
        let fresh = self
            .preview_discard(request.paths.clone(), request.mode)
            .await?;
        if fresh != request {
            return Err("文件或暂存区已改变，请重新获取预览".into());
        }
        let git_dir = PathBuf::from(
            self.text(&["rev-parse", "--absolute-git-dir"])
                .await?
                .trim(),
        );
        let backup = WorktreeBackup::new(&self.root, &git_dir, &fresh.files)?;
        if self.preview_discard(request.paths, request.mode).await? != fresh {
            return Err("文件在备份期间发生变化，请重新获取预览".into());
        }
        let indexed = entries(&self.bytes(&["ls-files", "--stage", "-z"]).await?)?;
        let restore: Vec<_> = fresh
            .files
            .iter()
            .filter(|file| indexed.contains_key(&file.path) || !file.delete)
            .map(|file| file.path.clone())
            .collect();
        let result = async {
            if !restore.is_empty() {
                let mut args = vec!["--literal-pathspecs", "restore", "--worktree"];
                let head = self.head().await?;
                let source;
                if fresh.mode == DiscardMode::All {
                    source = match head {
                        Some(head) => head,
                        None => self
                            .execute(&["hash-object", "-t", "tree", "-w", "--stdin"], Some(&[]))
                            .await?
                            .checked()
                            .and_then(|bytes| {
                                String::from_utf8(bytes)
                                    .map(|value| value.trim().to_owned())
                                    .map_err(|error| error.to_string())
                            })?,
                    };
                    args.extend(["--staged", "--source", &source]);
                }
                if !index_path.exists() {
                    self.execute_with_env(
                        &["read-tree", "--empty"],
                        None,
                        &[("GIT_INDEX_FILE", transaction.temporary_path())],
                    )
                    .await?
                    .checked()?;
                }
                let pathspec = restore
                    .iter()
                    .flat_map(|path| format!("{path}\0").into_bytes())
                    .collect::<Vec<_>>();
                args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
                self.execute_with_env(
                    &args,
                    Some(&pathspec),
                    &[("GIT_INDEX_FILE", transaction.temporary_path())],
                )
                .await?
                .checked()?;
            }
            for file in &fresh.files {
                if file.delete {
                    remove_file(&checked_path(&self.root, &file.path)?)?;
                }
            }
            if fresh.mode == DiscardMode::All && !restore.is_empty() {
                transaction.commit()?;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            if let Err(recovery) = backup.restore(&self.root) {
                let directory = backup.directory.keep();
                return Err(format!(
                    "放弃更改失败：{error}。恢复文件失败：{recovery}。备份保存在 {}",
                    git_path(&directory)
                ));
            }
            return Err(format!("放弃更改失败，已恢复原文件：{error}"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

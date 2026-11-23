use super::content::SnapshotState;
use super::discard::DiscardMode;
use super::Git;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_SHELF_PATCH: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: char,
    pub before: String,
    pub after: String,
    pub binary: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfEntry {
    pub id: String,
    pub name: String,
    pub timestamp: u64,
    pub deleted: bool,
    pub files: Vec<ShelfFile>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShelfApplyResult {
    pub conflicts: bool,
    pub message: String,
}

async fn shelf_dir(git: &Git) -> Result<PathBuf, String> {
    let raw = git
        .text(&["rev-parse", "--git-path", "ideagittool-shelf"])
        .await?;
    let directory = git.root.join(raw.trim());
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err("Shelf 存储目录不能是符号链接或普通文件".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(directory)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

async fn read_entries(git: &Git) -> Result<Vec<ShelfEntry>, String> {
    let index = shelf_dir(git).await?.join("shelf.json");
    match fs::read(&index) {
        Ok(bytes) => {
            if bytes.len() > MAX_SHELF_PATCH {
                return Err("Shelf 索引文件过大".into());
            }
            let entries: Vec<ShelfEntry> =
                serde_json::from_slice(&bytes).map_err(|e| format!("读取 Shelf 索引失败：{e}"))?;
            if entries.iter().any(|e| !valid_id(&e.id)) {
                return Err("Shelf 索引包含无效记录 ID".into());
            }
            Ok(entries)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

async fn write_entries(git: &Git, entries: &[ShelfEntry]) -> Result<(), String> {
    let dir = shelf_dir(git).await?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let index = dir.join("shelf.json");
    let bytes = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
    super::merge::atomic_write(&index, &bytes, None)
}

async fn patch_path(git: &Git, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("无效的 Shelf ID".into());
    }
    Ok(shelf_dir(git).await?.join(format!("{id}.patch")))
}

fn unquote_git_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if !trimmed.starts_with('"') || !trimmed.ends_with('"') || trimmed.len() < 2 {
        return trimmed.to_owned();
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    let bytes = inner.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 1;
            let b = bytes[i];
            if matches!(b, b'0'..=b'7') && i + 2 < bytes.len() {
                if let Ok(oct) = std::str::from_utf8(&bytes[i..i + 3]) {
                    if let Ok(val) = u8::from_str_radix(oct, 8) {
                        out.push(val);
                        i += 3;
                        continue;
                    }
                }
            }
            out.push(match b {
                b'n' => b'\n',
                b'r' => b'\r',
                b't' => b'\t',
                b'"' => b'"',
                b'\\' => b'\\',
                other => other,
            });
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_header_b_path(header: &str) -> Option<String> {
    let rest = header.strip_prefix("diff --git ")?.trim();
    if rest.ends_with('"') {
        if let Some(idx) = rest.rfind(" \"b/") {
            let quoted = &rest[idx + 1..];
            let unquoted = unquote_git_path(quoted);
            return unquoted.strip_prefix("b/").map(str::to_owned);
        }
    }
    if let Some(idx) = rest.rfind(" b/") {
        return Some(rest[idx + 3..].to_owned());
    }
    None
}

pub fn split_patch_sections(patch: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let mut current_path: Option<String> = None;
    let mut current_section = String::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            if let Some(path) = current_path.take() {
                map.insert(path, std::mem::take(&mut current_section));
            }
            current_path = parse_header_b_path(line.trim_end_matches(['\r', '\n']));
        }
        if current_path.is_some() {
            current_section.push_str(line);
        }
    }
    if let Some(path) = current_path {
        map.insert(path, current_section);
    }
    map
}

fn parse_imported_section(path: &str, section: &str) -> ShelfFile {
    let mut status = 'M';
    let mut old_path = None;
    let mut binary = false;
    let mut before = String::new();
    let mut after = String::new();
    let mut in_hunk = false;
    for raw_line in section.lines() {
        if !in_hunk {
            if raw_line.starts_with("new file mode ") {
                status = 'A';
            } else if raw_line.starts_with("deleted file mode ") {
                status = 'D';
            } else if let Some(from) = raw_line.strip_prefix("rename from ") {
                status = 'R';
                old_path = Some(unquote_git_path(from));
            } else if raw_line.starts_with("GIT binary patch")
                || raw_line.starts_with("Binary files ")
            {
                binary = true;
            } else if raw_line.starts_with("@@ ") {
                in_hunk = true;
            }
        } else if raw_line.starts_with("@@ ") {
            continue;
        } else if let Some(deleted) = raw_line.strip_prefix('-') {
            before.push_str(deleted);
            before.push('\n');
        } else if let Some(added) = raw_line.strip_prefix('+') {
            after.push_str(added);
            after.push('\n');
        } else if let Some(context) = raw_line.strip_prefix(' ') {
            before.push_str(context);
            before.push('\n');
            after.push_str(context);
            after.push('\n');
        }
    }
    ShelfFile {
        path: path.to_owned(),
        old_path,
        status,
        before,
        after,
        binary,
    }
}

impl Git {
    /// Generates a Git binary patch for the selected local changes against HEAD (or empty tree)
    /// using an isolated temporary index so the real `.git/index` is never mutated.
    pub async fn build_local_patch(
        &self,
        requested_paths: &[String],
    ) -> Result<(String, Vec<ShelfFile>), String> {
        let status = self.status().await?;
        if status.changes.iter().any(|c| c.conflict) {
            return Err("存在未解决的合并冲突，请先解决冲突后再生成补丁或 Shelf".into());
        }
        let target_changes: Vec<_> = if requested_paths.is_empty() {
            status.changes.iter().collect()
        } else {
            for p in requested_paths {
                super::validate_path(p)?;
            }
            status
                .changes
                .iter()
                .filter(|c| requested_paths.contains(&c.path))
                .collect()
        };
        if target_changes.is_empty() {
            return Err("没有可打包的本地文件更改".into());
        }
        let mut all_paths = Vec::new();
        for c in &target_changes {
            super::validate_path(&c.path)?;
            all_paths.push(c.path.clone());
            if let Some(old) = &c.old_path {
                super::validate_path(old)?;
                all_paths.push(old.clone());
            }
        }
        all_paths.sort_unstable();
        all_paths.dedup();

        let temp_dir = tempfile::Builder::new()
            .prefix("ideagittool-shelf-idx-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let temp_index = temp_dir.path().join("index");
        let temp_index_str = temp_index.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", temp_index_str.as_str())];

        let head = self.head().await?;
        let base_tree = head.as_deref().unwrap_or(EMPTY_TREE);
        if head.is_some() {
            self.execute_with_env(&["read-tree", "HEAD"], None, &env)
                .await?
                .checked()?;
        } else {
            self.execute_with_env(&["read-tree", "--empty"], None, &env)
                .await?
                .checked()?;
        }

        let mut add_args = vec!["--literal-pathspecs", "add", "-A", "-f", "--"];
        add_args.extend(all_paths.iter().map(String::as_str));
        self.execute_with_env(&add_args, None, &env)
            .await?
            .checked()?;

        let mut diff_args = vec![
            "--literal-pathspecs",
            "diff",
            "--cached",
            "--binary",
            "-M",
            "--full-index",
            base_tree,
            "--",
        ];
        diff_args.extend(all_paths.iter().map(String::as_str));
        let patch_bytes = self
            .execute_with_env(&diff_args, None, &env)
            .await?
            .checked()?;
        let patch = String::from_utf8_lossy(&patch_bytes).into_owned();
        if patch.trim().is_empty() {
            return Err("所选更改未包含有效的文件内容差异".into());
        }

        let mut shelf_files = Vec::with_capacity(target_changes.len());
        for change in target_changes {
            let old_path = change.old_path.as_deref().unwrap_or(&change.path);
            let before_snap = if let Some(head_sha) = head.as_deref() {
                self.blob_snapshot(Some(head_sha), old_path, false).await?
            } else {
                super::content::FileSnapshot::new(old_path, None, SnapshotState::Missing, &[])
            };
            let after_snap = self.worktree_snapshot(&change.path, false).await?;
            let binary = matches!(
                before_snap.state,
                SnapshotState::Binary | SnapshotState::Submodule
            ) || matches!(
                after_snap.state,
                SnapshotState::Binary | SnapshotState::Submodule
            );
            let status_char = if change.index != ' ' && change.index != '?' {
                change.index
            } else if change.work_tree == '?' {
                'A'
            } else {
                change.work_tree
            };
            shelf_files.push(ShelfFile {
                path: change.path.clone(),
                old_path: change.old_path.clone(),
                status: status_char,
                before: if binary {
                    String::new()
                } else {
                    before_snap.text
                },
                after: if binary {
                    String::new()
                } else {
                    after_snap.text
                },
                binary,
            });
        }
        Ok((patch, shelf_files))
    }

    pub async fn shelf_list(&self) -> Result<Vec<ShelfEntry>, String> {
        let mut entries = read_entries(self).await?;
        entries.sort_by_key(|e| std::cmp::Reverse(e.timestamp));
        Ok(entries)
    }

    pub async fn shelf_save(
        &self,
        name: &str,
        paths: Vec<String>,
        rollback: bool,
    ) -> Result<ShelfEntry, String> {
        if name.len() > 1024 {
            return Err("Shelf 名称过长".into());
        }
        let (patch, files) = self.build_local_patch(&paths).await?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as u64;
        let digest = format!("{:x}", Sha256::digest(patch.as_bytes()));
        let id = format!("{timestamp}-{}", &digest[..12]);
        let entry = ShelfEntry {
            id: id.clone(),
            name: if name.trim().is_empty() {
                "Work in progress".into()
            } else {
                name.trim().to_owned()
            },
            timestamp,
            deleted: false,
            files: files.clone(),
        };
        let dir = shelf_dir(self).await?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file_path = patch_path(self, &id).await?;
        super::merge::atomic_write(&file_path, patch.as_bytes(), None)?;
        let mut entries = read_entries(self).await?;
        entries.insert(0, entry.clone());
        write_entries(self, &entries).await?;

        if rollback {
            let discard_paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
            let preview = self
                .preview_discard(discard_paths, DiscardMode::All)
                .await?;
            self.discard_changes(preview).await?;
        }
        Ok(entry)
    }

    pub async fn shelf_apply(
        &self,
        id: &str,
        paths: Vec<String>,
        remove_applied: bool,
    ) -> Result<ShelfApplyResult, String> {
        let mut entries = read_entries(self).await?;
        let index = entries
            .iter()
            .position(|e| e.id == id)
            .ok_or("所选 Shelf 已不存在，请刷新列表")?;
        let entry = entries[index].clone();
        let full_patch_path = patch_path(self, id).await?;
        let full_patch = fs::read_to_string(&full_patch_path)
            .map_err(|_| "Shelf 补丁文件丢失或不是有效 UTF-8 文本".to_string())?;
        let sections = split_patch_sections(&full_patch);

        let selected_files: Vec<ShelfFile> = if paths.is_empty() {
            entry.files.clone()
        } else {
            entry
                .files
                .iter()
                .filter(|f| paths.contains(&f.path))
                .cloned()
                .collect()
        };
        if selected_files.is_empty() {
            return Err("请选择至少一个要恢复的 Shelf 文件".into());
        }

        let target_patch = if paths.is_empty() || selected_files.len() == entry.files.len() {
            full_patch.clone()
        } else {
            let mut combined = String::new();
            for f in &selected_files {
                if let Some(sec) = sections.get(&f.path) {
                    combined.push_str(sec);
                }
            }
            if combined.trim().is_empty() {
                return Err("无法在补丁中定位所选文件的差异片段".into());
            }
            combined
        };

        let result = self.apply_patch_content(&target_patch).await?;
        if remove_applied && !result.conflicts {
            let remaining: Vec<ShelfFile> = entry
                .files
                .iter()
                .filter(|f| !selected_files.iter().any(|s| s.path == f.path))
                .cloned()
                .collect();
            if remaining.is_empty() {
                entries[index].deleted = true;
            } else {
                let applied_id = format!("{}-applied-{}", entry.id, entries.len() + 1);
                let applied_patch_path = patch_path(self, &applied_id).await?;
                super::merge::atomic_write(&applied_patch_path, target_patch.as_bytes(), None)?;
                let remaining_patch: String = remaining
                    .iter()
                    .filter_map(|f| sections.get(&f.path).map(String::as_str))
                    .collect();
                super::merge::atomic_write(&full_patch_path, remaining_patch.as_bytes(), None)?;
                entries[index].files = remaining;
                entries.push(ShelfEntry {
                    id: applied_id,
                    name: entry.name.clone(),
                    timestamp: entry.timestamp,
                    deleted: true,
                    files: selected_files,
                });
            }
            write_entries(self, &entries).await?;
        }
        Ok(result)
    }

    pub async fn apply_patch_content(&self, patch: &str) -> Result<ShelfApplyResult, String> {
        if patch.trim().is_empty() {
            return Err("补丁内容为空".into());
        }
        let temp_dir = tempfile::Builder::new()
            .prefix("ideagittool-apply-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let temp_patch = temp_dir.path().join("changes.patch");
        fs::write(&temp_patch, patch.as_bytes()).map_err(|e| e.to_string())?;
        let patch_arg = temp_patch.to_string_lossy().into_owned();

        let direct = self
            .execute(
                &["apply", "--binary", "--whitespace=nowarn", &patch_arg],
                None,
            )
            .await?;
        if direct.code == 0 {
            return Ok(ShelfApplyResult {
                conflicts: false,
                message: "补丁已应用到工作区".into(),
            });
        }
        let three_way = self
            .execute(
                &[
                    "apply",
                    "--binary",
                    "--3way",
                    "--whitespace=nowarn",
                    &patch_arg,
                ],
                None,
            )
            .await?;
        let stderr = String::from_utf8_lossy(&three_way.stderr).into_owned();
        let stdout = String::from_utf8_lossy(&three_way.stdout).into_owned();
        let status = self.status().await?;
        let has_conflicts = status.changes.iter().any(|c| c.conflict);
        if three_way.code != 0 && !has_conflicts {
            let direct_err = String::from_utf8_lossy(&direct.stderr).trim().to_owned();
            let err_msg = stderr.trim();
            return Err(if !err_msg.is_empty() {
                format!("应用补丁失败：{err_msg}")
            } else if !direct_err.is_empty() {
                format!("应用补丁失败：{direct_err}")
            } else {
                "应用补丁失败".into()
            });
        }
        Ok(ShelfApplyResult {
            conflicts: has_conflicts,
            message: if has_conflicts {
                "补丁应用存在冲突，请打开合并管理器处理".into()
            } else if !stdout.trim().is_empty() {
                stdout.trim().to_owned()
            } else {
                "补丁已通过三方合并应用到工作区".into()
            },
        })
    }

    pub async fn shelf_rename(&self, id: &str, name: &str) -> Result<(), String> {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed.len() > 1024 {
            return Err("请输入有效的 Shelf 名称".into());
        }
        let mut entries = read_entries(self).await?;
        let entry = entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or("所选 Shelf 已不存在")?;
        entry.name = trimmed.to_owned();
        write_entries(self, &entries).await
    }

    pub async fn shelf_restore(&self, id: &str) -> Result<(), String> {
        let mut entries = read_entries(self).await?;
        let entry = entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or("所选 Shelf 已不存在")?;
        entry.deleted = false;
        write_entries(self, &entries).await
    }

    pub async fn shelf_delete(&self, id: &str, permanent: bool) -> Result<(), String> {
        let mut entries = read_entries(self).await?;
        let pos = entries
            .iter()
            .position(|e| e.id == id)
            .ok_or("所选 Shelf 已不存在")?;
        if entries[pos].deleted || permanent {
            entries.remove(pos);
            let file = patch_path(self, id).await?;
            let _ = fs::remove_file(file);
        } else {
            entries[pos].deleted = true;
        }
        write_entries(self, &entries).await
    }

    pub async fn shelf_clean_deleted(&self) -> Result<(), String> {
        let mut entries = read_entries(self).await?;
        let mut removed_ids = Vec::new();
        entries.retain(|entry| {
            if entry.deleted {
                removed_ids.push(entry.id.clone());
                false
            } else {
                true
            }
        });
        for id in removed_ids {
            if let Ok(file) = patch_path(self, &id).await {
                let _ = fs::remove_file(file);
            }
        }
        write_entries(self, &entries).await
    }

    pub async fn shelf_export_patch(
        &self,
        id: &str,
        paths: Vec<String>,
        destination: Option<String>,
    ) -> Result<String, String> {
        let full_patch_path = patch_path(self, id).await?;
        let full_patch =
            fs::read_to_string(&full_patch_path).map_err(|_| "无法读取 Shelf 补丁文件".to_string())?;
        let output = if paths.is_empty() {
            full_patch
        } else {
            let sections = split_patch_sections(&full_patch);
            let mut selected = String::new();
            for p in &paths {
                if let Some(sec) = sections.get(p) {
                    selected.push_str(sec);
                }
            }
            if selected.trim().is_empty() {
                return Err("所选文件在 Shelf 补丁中无内容".into());
            }
            selected
        };
        if let Some(dest) = destination.filter(|d| !d.trim().is_empty()) {
            let dest_path = Path::new(&dest);
            if dest_path.as_os_str().is_empty() || dest_path.file_name().is_none() {
                return Err("Patch 保存路径无效".into());
            }
            fs::write(dest_path, output.as_bytes()).map_err(|e| format!("保存 Patch 失败：{e}"))?;
        }
        Ok(output)
    }

    pub async fn shelf_import_patch(&self, source_path: &str) -> Result<ShelfEntry, String> {
        let source = Path::new(source_path);
        let bytes = fs::read(source).map_err(|e| format!("读取 Patch 文件失败：{e}"))?;
        if bytes.len() > MAX_SHELF_PATCH {
            return Err("Patch 文件超过 16 MiB 限制".into());
        }
        let patch = String::from_utf8(bytes).map_err(|_| "Patch 文件不是 UTF-8 文本".to_string())?;
        let sections = split_patch_sections(&patch);
        if sections.is_empty() {
            return Err("文件中未找到有效的 Git diff 补丁片段".into());
        }
        let mut files = Vec::with_capacity(sections.len());
        for (path, section) in &sections {
            super::validate_path(path)?;
            files.push(parse_imported_section(path, section));
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as u64;
        let digest = format!("{:x}", Sha256::digest(patch.as_bytes()));
        let id = format!("{timestamp}-{}", &digest[..12]);
        let name = source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("导入的 Patch")
            .to_owned();
        let entry = ShelfEntry {
            id: id.clone(),
            name,
            timestamp,
            deleted: false,
            files,
        };
        let dir = shelf_dir(self).await?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file_path = patch_path(self, &id).await?;
        super::merge::atomic_write(&file_path, patch.as_bytes(), None)?;
        let mut entries = read_entries(self).await?;
        entries.insert(0, entry.clone());
        write_entries(self, &entries).await?;
        Ok(entry)
    }

    pub async fn create_worktree_patch(
        &self,
        paths: Vec<String>,
        destination: Option<String>,
    ) -> Result<String, String> {
        let (patch, _) = self.build_local_patch(&paths).await?;
        if let Some(dest) = destination.filter(|d| !d.trim().is_empty()) {
            let dest_path = Path::new(&dest);
            if dest_path.as_os_str().is_empty() || dest_path.file_name().is_none() {
                return Err("Patch 保存路径无效".into());
            }
            fs::write(dest_path, patch.as_bytes()).map_err(|e| format!("保存 Patch 失败：{e}"))?;
        }
        Ok(patch)
    }

    pub async fn apply_worktree_patch(&self, source_path: &str) -> Result<ShelfApplyResult, String> {
        let bytes = fs::read(Path::new(source_path))
            .map_err(|e| format!("读取 Patch 文件失败：{e}"))?;
        if bytes.len() > MAX_SHELF_PATCH {
            return Err("Patch 文件超过 16 MiB 限制".into());
        }
        let patch = String::from_utf8(bytes).map_err(|_| "Patch 文件不是 UTF-8 文本".to_string())?;
        self.apply_patch_content(&patch).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    #[tokio::test]
    async fn patch_shelf_supports_partial_file_unshelve_recycle_bin_and_patch_import_export() {
        let directory = fixture();
        fs::write(directory.path().join("a.txt"), "base a\n").unwrap();
        fs::write(directory.path().join("b.txt"), "base b\n").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "initial"]);

        fs::write(directory.path().join("a.txt"), "changed a\n").unwrap();
        fs::write(directory.path().join("b.txt"), "changed b\n").unwrap();
        fs::write(directory.path().join("untracked.txt"), "new untracked\n").unwrap();

        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();

        // Shelve all 3 files with rollback = true -> working tree becomes clean, stashes stay empty!
        let entry = git.shelf_save("Feature WIP", vec![], true).await.unwrap();
        assert_eq!(entry.files.len(), 3);
        let status = git.status().await.unwrap();
        assert!(status.changes.is_empty(), "worktree should be clean after shelve");
        assert!(status.stashes.is_empty(), "git stash must not be polluted by shelf");

        // Partial unshelve: apply only "a.txt" with remove_applied = true
        let apply_a = git
            .shelf_apply(&entry.id, vec!["a.txt".into()], true)
            .await
            .unwrap();
        assert!(!apply_a.conflicts);
        assert_eq!(
            fs::read_to_string(directory.path().join("a.txt")).unwrap(),
            "changed a\n"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join("b.txt")).unwrap(),
            "base b\n"
        );
        assert!(!directory.path().join("untracked.txt").exists());

        // Check shelf list: original shelf now has 2 remaining files, and 1 recycled entry exists
        let list = git.shelf_list().await.unwrap();
        assert_eq!(list.len(), 2);
        let active = list.iter().find(|e| !e.deleted).unwrap();
        let recycled = list.iter().find(|e| e.deleted).unwrap();
        assert_eq!(active.files.len(), 2);
        assert_eq!(recycled.files.len(), 1);
        assert_eq!(recycled.files[0].path, "a.txt");

        // Unshelve remaining files -> active shelf moves to deleted (Recently Deleted)
        git.shelf_apply(&active.id, vec![], true).await.unwrap();
        assert_eq!(
            fs::read_to_string(directory.path().join("b.txt")).unwrap(),
            "changed b\n"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join("untracked.txt")).unwrap(),
            "new untracked\n"
        );

        // Restore from recycle bin, export patch, and import patch
        git.shelf_restore(&active.id).await.unwrap();
        let restored = git
            .shelf_list()
            .await
            .unwrap()
            .into_iter()
            .find(|e| e.id == active.id)
            .unwrap();
        assert!(!restored.deleted);

        let exported_file = directory.path().join("exported.patch");
        let patch_text = git
            .shelf_export_patch(
                &restored.id,
                vec![],
                Some(exported_file.to_string_lossy().into_owned()),
            )
            .await
            .unwrap();
        assert!(patch_text.contains("diff --git"));
        assert!(exported_file.exists());

        let imported = git
            .shelf_import_patch(&exported_file.to_string_lossy())
            .await
            .unwrap();
        assert_eq!(imported.name, "exported");
        assert_eq!(imported.files.len(), 2);
    }
}

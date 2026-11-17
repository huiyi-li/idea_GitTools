use crate::git::{git_path, Git};
use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 8;
const MAX_DIRECTORIES: usize = 10_000;
const MAX_REPOSITORIES: usize = 64;
const MAX_WARNINGS: usize = 20;
const SKIP_DIRECTORIES: &[&str] = &[".git", "node_modules", "target", "dist", ".venv", "venv"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepositories {
    pub root: String,
    pub repositories: Vec<WorkspaceRepository>,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepository {
    pub root: String,
    pub name: String,
    pub relative_path: String,
}

impl WorkspaceRepositories {
    fn warn(&mut self, warning: String) {
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(warning.chars().take(1024).collect());
        } else {
            self.truncated = true;
            self.warnings[MAX_WARNINGS - 1] =
                "Additional workspace warnings omitted (20 warning limit).".into();
        }
    }

    fn truncate(&mut self, warning: String) {
        self.truncated = true;
        self.warn(warning);
    }
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and all other reparse points must not be traversed either.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn directory(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if is_link(&metadata) || !metadata.is_dir() {
        return Err("Select a directory, not a symbolic link or reparse point.".into());
    }
    path.canonicalize().map_err(|e| e.to_string())
}

struct DirectoryScan {
    candidate: bool,
    children: Vec<PathBuf>,
    warnings: Vec<String>,
    warnings_limited: bool,
    depth_limited: bool,
    directory_limited: bool,
}

impl DirectoryScan {
    fn warn(&mut self, warning: String) {
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(warning);
        } else {
            self.warnings_limited = true;
        }
    }
}

fn is_skipped_directory(path: &std::ffi::OsStr) -> bool {
    let name = path.to_string_lossy();
    SKIP_DIRECTORIES.iter().any(|skip| {
        #[cfg(windows)]
        {
            name.eq_ignore_ascii_case(skip)
        }
        #[cfg(not(windows))]
        {
            name == *skip
        }
    })
}

// Only filesystem reads run on the blocking pool. Never recurse through Git's
// administrative directory; a gitfile may legitimately point outside the workspace.
fn inspect_directory(
    path: &Path,
    workspace: &Path,
    at_depth_limit: bool,
    remaining_directories: usize,
) -> Result<DirectoryScan, String> {
    let canonical = directory(path)?;
    if canonical != path || !canonical.starts_with(workspace) {
        return Err("Directory changed or resolves outside the workspace.".into());
    }
    let mut scan = DirectoryScan {
        candidate: false,
        children: Vec::new(),
        warnings: Vec::new(),
        warnings_limited: false,
        depth_limited: false,
        directory_limited: false,
    };
    match fs::symlink_metadata(path.join(".git")) {
        Ok(metadata) if is_link(&metadata) => {
            scan.warn("Skipped linked/reparse .git marker.".into());
        }
        Ok(metadata) => scan.candidate = metadata.is_dir() || metadata.is_file(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => scan.warn(format!("Cannot inspect .git: {error}")),
    }
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => {
            scan.warn(format!("Cannot read directory: {error}"));
            return Ok(scan);
        }
    };
    for entry in entries {
        let child = match entry {
            Ok(entry) => entry.path(),
            Err(error) => {
                scan.warn(format!("Cannot read directory entry: {error}"));
                continue;
            }
        };
        if child.file_name().is_some_and(is_skipped_directory) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&child) {
            Ok(metadata) => metadata,
            Err(error) => {
                scan.warn(format!("Cannot inspect {}: {error}", git_path(&child)));
                continue;
            }
        };
        if is_link(&metadata) || !metadata.is_dir() {
            continue;
        }
        if at_depth_limit {
            scan.depth_limited = true;
            break;
        }
        if scan.children.len() >= remaining_directories {
            scan.directory_limited = true;
            break;
        }
        scan.children.push(child);
    }
    scan.children.sort();
    Ok(scan)
}

/// Discover only repository roots at or below the requested directory.
/// The requested directory is depth zero; callers normally choose depth four.
/// Depth must be 0..=8. Limits and unreadable/invalid candidates are explicit
/// partial results; an invalid workspace path is an error. No repository is modified.
pub async fn discover(path: &str, max_depth: usize) -> Result<WorkspaceRepositories, String> {
    if max_depth > MAX_DEPTH {
        return Err("Workspace discovery depth must be between 0 and 8.".into());
    }
    if path.is_empty() {
        return Err("Select a workspace directory.".into());
    }
    let requested = PathBuf::from(path);
    let root = tokio::task::spawn_blocking(move || directory(&requested))
        .await
        .map_err(|error| format!("Cannot inspect workspace: {error}"))??;
    let mut result = WorkspaceRepositories {
        root: git_path(&root),
        repositories: Vec::new(),
        truncated: false,
        warnings: Vec::new(),
    };
    let mut queue = VecDeque::from([(root.clone(), 0)]);
    let mut admitted_directories = 1;
    let mut depth_warned = false;
    let mut directory_warned = false;
    while let Some((path, depth)) = queue.pop_front() {
        let scan_path = path.clone();
        let scan_root = root.clone();
        let remaining = MAX_DIRECTORIES - admitted_directories;
        let scan = tokio::task::spawn_blocking(move || {
            inspect_directory(&scan_path, &scan_root, depth == max_depth, remaining)
        })
        .await
        .map_err(|error| format!("Workspace discovery task failed: {error}"))?;
        let scan = match scan {
            Ok(scan) => scan,
            Err(error) => {
                result.warn(format!("Skipped {}: {error}", git_path(&path)));
                continue;
            }
        };
        let DirectoryScan {
            candidate,
            children,
            warnings,
            warnings_limited,
            depth_limited,
            directory_limited,
        } = scan;
        for warning in warnings {
            result.warn(format!("{}: {warning}", git_path(&path)));
        }
        if warnings_limited {
            result.truncate(format!(
                "Workspace warning limit ({MAX_WARNINGS}) reached; additional warnings omitted."
            ));
        }
        if depth_limited && !depth_warned {
            result.truncate(format!(
                "Workspace depth limit ({max_depth}) reached; deeper directories omitted."
            ));
            depth_warned = true;
        }
        if directory_limited && !directory_warned {
            result.truncate(format!(
                "Workspace directory limit ({MAX_DIRECTORIES}) reached."
            ));
            directory_warned = true;
        }
        admitted_directories += children.len();
        queue.extend(children.into_iter().map(|child| (child, depth + 1)));
        if !candidate {
            continue;
        }
        // Git::open alone searches ancestors: only call it for an explicit .git
        // marker, and still reject a root different from the directory scanned.
        match Git::open(&git_path(&path), None).await {
            Ok(git) if git.root == path && git.root.starts_with(&root) => {
                let relative = path.strip_prefix(&root).map_err(|e| e.to_string())?;
                result.repositories.push(WorkspaceRepository {
                    root: git.root_string(),
                    name: path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| git.root_string()),
                    relative_path: if relative.as_os_str().is_empty() {
                        ".".into()
                    } else {
                        git_path(relative)
                    },
                });
                if result.repositories.len() == MAX_REPOSITORIES && !queue.is_empty() {
                    result.truncate(format!(
                        "Workspace repository limit ({MAX_REPOSITORIES}) reached."
                    ));
                    break;
                }
            }
            Ok(_) => result.truncate(format!(
                "Skipped {}: Git root does not match this workspace directory.",
                git_path(&path)
            )),
            Err(error) => result.truncate(format!(
                "Cannot open repository {}: {error}",
                git_path(&path)
            )),
        }
    }
    result
        .repositories
        .sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(result)
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;

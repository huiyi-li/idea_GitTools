use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::watch;

pub struct RepositoryWatcher {
    _watcher: RecommendedWatcher,
    task: tauri::async_runtime::JoinHandle<()>,
}

fn components(path: &Path) -> Vec<String> {
    path.components().filter_map(|component| match component {
        std::path::Component::Normal(name) => Some(if cfg!(windows) { name.to_string_lossy().to_lowercase() } else { name.to_string_lossy().into_owned() }),
        std::path::Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().replace("\\\\?\\", "").to_lowercase()),
        _ => None,
    }).collect()
}

fn relevant_path(path: &Path, metadata_roots: &[Vec<String>]) -> bool {
    let parts = components(path);
    let metadata_start = metadata_roots.iter().filter(|root| parts.starts_with(root)).map(Vec::len).max()
        .or_else(|| parts.iter().position(|part| part == ".git").map(|index| index + 1));
    let Some(start) = metadata_start else { return true; };
    let relative = &parts[start..];
    if relative.first().is_some_and(|part| part == "ideagittool-local-history")
        || relative.first().is_some_and(|part| part == "worktrees") && relative.get(2).is_some_and(|part| part == "ideagittool-local-history") { return false; }
    if relative.last().is_some_and(|part| part.ends_with(".lock") || part.starts_with(".tmp")) { return false; }
    !relative.first().is_some_and(|part| matches!(part.as_str(), "objects" | "logs"))
}

fn relevant(event: &notify::Event, metadata_roots: &[Vec<String>]) -> bool {
    !matches!(event.kind, EventKind::Access(_)) && event.paths.iter().any(|path| relevant_path(path, metadata_roots))
}

impl RepositoryWatcher {
    pub fn new(paths: Vec<PathBuf>, root: String, app: tauri::AppHandle) -> Result<Self, String> {
        let (sender, mut receiver) = watch::channel(());
        let metadata_roots: Vec<_> = paths.iter().skip(1).map(|path| components(path)).collect();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            if result.as_ref().map(|event| relevant(event, &metadata_roots)).unwrap_or(true) { sender.send_replace(()); }
        }).map_err(|error| error.to_string())?;
        for path in paths {
            watcher.watch(&path, RecursiveMode::Recursive).map_err(|error| error.to_string())?;
        }
        let task = tauri::async_runtime::spawn(async move {
            while receiver.changed().await.is_ok() {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep_until(deadline) => break,
                        _ = tokio::time::sleep(Duration::from_millis(600)) => break,
                        result = receiver.changed() => if result.is_err() { return; },
                    }
                }
                let _ = app.emit("repository-changed", &root);
            }
        });
        Ok(Self { _watcher: watcher, task })
    }
}

impl Drop for RepositoryWatcher {
    fn drop(&mut self) { self.task.abort(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, ModifyKind};

    #[test]
    fn history_and_temporary_metadata_writes_do_not_trigger_refresh() {
        for path in ["/repo/.git/ideagittool-local-history/file.snapshot", "/repo/.git/ideagittool-local-history/file.json", "/repo/.git/index.lock", "/repo/.git/.tmp123", "/repo/.git/objects/aa/blob", "/repo/.git/logs/HEAD"] {
            assert!(!relevant_path(Path::new(path), &[]), "{path}");
        }
        for path in ["/repo/file.txt", "/repo/ideagittool-local-history/source.ts", "/repo/.git/index", "/repo/.git/HEAD", "/repo/.git/refs/heads/logs"] {
            assert!(relevant_path(Path::new(path), &[]), "{path}");
        }
    }

    #[test]
    fn external_worktree_metadata_is_filtered_without_hiding_real_changes() {
        let roots = vec![components(Path::new("/metadata/custom.git/worktrees/test")), components(Path::new("/metadata/custom.git"))];
        for path in ["/metadata/custom.git/worktrees/test/ideagittool-local-history/a.json", "/metadata/custom.git/worktrees/test/logs/HEAD", "/metadata/custom.git/worktrees/test/index.lock"] {
            assert!(!relevant_path(Path::new(path), &roots), "{path}");
        }
        assert!(relevant_path(Path::new("/metadata/custom.git/worktrees/test/index"), &roots));
        assert!(relevant_path(Path::new("/metadata/custom.git/refs/heads/main"), &roots));
        let renamed = notify::Event::new(EventKind::Modify(ModifyKind::Any)).add_path(PathBuf::from("/repo/.git/index.lock")).add_path(PathBuf::from("/repo/.git/index"));
        assert!(relevant(&renamed, &[]));
        let accessed = notify::Event::new(EventKind::Access(AccessKind::Any)).add_path(PathBuf::from("/repo/file.txt"));
        assert!(!relevant(&accessed, &[]));
    }
}

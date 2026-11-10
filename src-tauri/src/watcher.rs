use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::watch;

pub struct RepositoryWatcher {
    _watcher: RecommendedWatcher,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl RepositoryWatcher {
    pub fn new(paths: Vec<PathBuf>, root: String, app: tauri::AppHandle) -> Result<Self, String> {
        let (sender, mut receiver) = watch::channel(());
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let relevant = match result {
                    Ok(event) => {
                        !matches!(event.kind, EventKind::Access(_))
                            && event.paths.iter().any(|path| {
                                let parts: Vec<_> = path
                                    .components()
                                    .map(|c| c.as_os_str().to_string_lossy())
                                    .collect();
                                let inside_git = parts.iter().position(|p| p == ".git");
                                match inside_git {
                                    Some(index) => {
                                        let next =
                                            parts.get(index + 1).map(|s| s.as_ref()).unwrap_or("");
                                        !matches!(next, "objects" | "logs")
                                            && !path.to_string_lossy().ends_with(".lock")
                                    }
                                    None => true,
                                }
                            })
                    }
                    Err(_) => true,
                };
                if relevant {
                    sender.send_replace(());
                }
            })
            .map_err(|e| e.to_string())?;
        for path in paths {
            watcher
                .watch(&path, RecursiveMode::Recursive)
                .map_err(|e| e.to_string())?;
        }
        let task = tauri::async_runtime::spawn(async move {
            while receiver.changed().await.is_ok() {
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(600)) => break,
                        result = receiver.changed() => if result.is_err() { return; },
                    }
                }
                let _ = app.emit("repository-changed", &root);
            }
        });
        Ok(Self {
            _watcher: watcher,
            task,
        })
    }
}

impl Drop for RepositoryWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

use super::*;

fn init(path: &std::path::Path) {
    std::fs::create_dir_all(path).unwrap();
    let output = std::process::Command::new("git").args(["init", "-b", "main"]).current_dir(path).output().unwrap();
    assert!(output.status.success());
}

#[tokio::test]
async fn background_history_skips_busy_repositories_without_joining_the_write_queue() {
    let state = AppState::default();
    let guard = state.0.lock().await;
    for _ in 0..100 {
        let result = tokio::time::timeout(std::time::Duration::from_millis(100), capture_history_when_idle(&state, "root", "file")).await.unwrap().unwrap();
        assert!(!result);
    }
    drop(guard);
    assert!(!capture_history_when_idle(&state, "root", "file").await.unwrap());
    assert!(state.0.try_lock().is_ok());
}

#[tokio::test]
async fn workspace_batch_roots_are_exact_deduplicated_and_cannot_redirect_stale_writes() {
    let workspace = tempfile::tempdir().unwrap();
    let a = workspace.path().join("a");
    let b = workspace.path().join("b");
    init(&a); init(&b);
    let a_root = git::git_path(&a.canonicalize().unwrap());
    let b_root = git::git_path(&b.canonicalize().unwrap());
    let repositories = checked_repositories(vec![a_root.clone(), b_root.clone(), a_root.clone()]).await.unwrap();
    assert_eq!(repositories.len(), 2);
    let current = Some(Git::open_exact(&b_root, None).await.unwrap());
    assert!(active(&current, &a_root).is_err());
    assert_eq!(active(&current, &b_root).unwrap().root_string(), b_root);
    let subdirectory = a.join("not-a-repository");
    std::fs::create_dir(&subdirectory).unwrap();
    assert!(checked_repositories(vec![git::git_path(&subdirectory)]).await.is_err());
    assert!(checked_repositories(vec![]).await.is_err());
    std::fs::rename(b.join(".git"), b.join("git-backup")).unwrap();
    assert!(active(&current, &b_root).is_err());
}

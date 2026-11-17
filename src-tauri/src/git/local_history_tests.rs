use super::*;
use crate::git::tests::{fixture, run};

#[tokio::test]
async fn local_history_restore_preserves_current_contents_and_index() {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let file = dir.path().join("file.txt");
    fs::write(&file, "old\n").unwrap();
    git.local_history_capture("file.txt", "old snapshot")
        .await
        .unwrap();
    let id = git.local_history_list("file.txt").await.unwrap()[0]
        .id
        .clone();
    fs::write(&file, "staged\n").unwrap();
    run(dir.path(), &["add", "."]);
    let index = fs::read(dir.path().join(".git/index")).unwrap();
    fs::write(&file, "current edits\n").unwrap();
    let preview = git
        .local_history_preview_restore(&id, "file.txt")
        .await
        .unwrap();
    git.local_history_restore(&id, "file.txt", &preview.stamp)
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "old\n");
    assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(), index);
    let entries = git.local_history_list("file.txt").await.unwrap();
    let backup = entries
        .iter()
        .find(|entry| entry.reason == "恢复前自动备份")
        .unwrap();
    assert_eq!(
        git.local_history_read(&backup.id, "file.txt")
            .await
            .unwrap()
            .content,
        "current edits\n"
    );
}

#[tokio::test]
async fn local_history_rejects_stale_files_and_changed_snapshots() {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let file = dir.path().join("file.txt");
    fs::write(&file, "old").unwrap();
    git.local_history_capture("file.txt", "saved")
        .await
        .unwrap();
    let id = git.local_history_list("file.txt").await.unwrap()[0]
        .id
        .clone();
    fs::write(&file, "current").unwrap();
    let preview = git
        .local_history_preview_restore(&id, "file.txt")
        .await
        .unwrap();
    fs::write(&file, "external edits").unwrap();
    assert!(git
        .local_history_restore(&id, "file.txt", &preview.stamp)
        .await
        .is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), "external edits");
    let preview = git
        .local_history_preview_restore(&id, "file.txt")
        .await
        .unwrap();
    fs::write(
        history_dir(&git)
            .await
            .unwrap()
            .join(format!("{id}.snapshot")),
        "modified snapshot",
    )
    .unwrap();
    assert!(git
        .local_history_restore(&id, "file.txt", &preview.stamp)
        .await
        .is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), "external edits");
    fs::write(&file, vec![b'x'; MAX_SNAPSHOT + 1]).unwrap();
    assert!(git
        .local_history_preview_restore(&id, "file.txt")
        .await
        .is_err());
}

#[tokio::test]
async fn local_history_works_in_linked_worktrees_and_restores_missing_binary_files() {
    let dir = fixture();
    fs::write(dir.path().join("base.txt"), "base").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["commit", "-m", "base"]);
    let linked = dir.path().join("linked");
    run(
        dir.path(),
        &[
            "worktree",
            "add",
            "--detach",
            linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    let git = Git::open(linked.to_str().unwrap(), None).await.unwrap();
    let bytes = vec![0, 1, 255, 2];
    fs::write(linked.join("binary.bin"), &bytes).unwrap();
    git.local_history_capture("binary.bin", "binary")
        .await
        .unwrap();
    let entries = git.local_history_list("binary.bin").await.unwrap();
    assert!(entries[0].binary);
    assert!(linked.join(".git").is_file());
    fs::remove_file(linked.join("binary.bin")).unwrap();
    let preview = git
        .local_history_preview_restore(&entries[0].id, "binary.bin")
        .await
        .unwrap();
    git.local_history_restore(&entries[0].id, "binary.bin", &preview.stamp)
        .await
        .unwrap();
    assert_eq!(fs::read(linked.join("binary.bin")).unwrap(), bytes);
}

#[tokio::test]
async fn local_history_refuses_metadata_paths_and_links_outside_the_repository() {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    for path in ["", ".git/config", "../outside", "C:/outside"] {
        assert!(
            git.local_history_capture(path, "unsafe").await.is_err(),
            "{path}"
        );
        assert!(git.local_history_list(path).await.is_err(), "{path}");
    }
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "outside").unwrap();
    let link = dir.path().join("outside-link");
    #[cfg(windows)]
    {
        let result = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), &link).unwrap();
    assert!(git
        .local_history_capture("outside-link/secret.txt", "unsafe")
        .await
        .is_err());
    assert!(git.local_history_read("../bad", "file.txt").await.is_err());
    assert_eq!(
        fs::read_to_string(outside.path().join("secret.txt")).unwrap(),
        "outside"
    );
}

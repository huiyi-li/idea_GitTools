use super::*;
use crate::git::tests::{fixture, run};
use std::fs;

async fn commit(git: &Git, path: &str, text: &str, message: &str) -> String {
    fs::write(git.root.join(path), text).unwrap();
    git.stage(vec![path.into()], false).await.unwrap();
    git.commit(message).await.unwrap();
    git.repository().await.unwrap().head.unwrap()
}

#[tokio::test]
async fn review_reads_three_distinct_snapshots_and_worktree_refresh_keeps_history_fixed() {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let parent = commit(&git, "file.txt", "before\n", "Before").await;
    let selected = commit(&git, "file.txt", "after\n", "After").await;
    fs::write(dir.path().join("file.txt"), "current\n").unwrap();
    let review = git.commit_review(&selected, "file.txt").await.unwrap();
    assert_eq!(review.parent.as_deref(), Some(parent.as_str()));
    assert_eq!(review.before.text, "before\n");
    assert_eq!(review.after.text, "after\n");
    assert_eq!(review.current.file.text, "current\n");
    fs::write(dir.path().join("file.txt"), "new current\n").unwrap();
    let current = git.review_worktree("file.txt").await.unwrap();
    assert_ne!(current.file.fingerprint, review.current.file.fingerprint);
    assert_eq!(current.file.text, "new current\n");
    assert_eq!(review.after.text, "after\n");
    assert_eq!(run(dir.path(), &["diff", "--cached"]), "");
    assert_eq!(
        git.repository().await.unwrap().head.as_deref(),
        Some(selected.as_str())
    );
}

#[tokio::test]
async fn initial_empty_and_deleted_files_have_distinct_states() {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let first = commit(&git, "empty.txt", "", "Empty file").await;
    let review = git.commit_review(&first, "empty.txt").await.unwrap();
    assert!(review.parent.is_none());
    assert_eq!(review.before.state, SnapshotState::Missing);
    assert_eq!(review.after.state, SnapshotState::Text);
    fs::remove_file(dir.path().join("empty.txt")).unwrap();
    git.stage(vec!["empty.txt".into()], false).await.unwrap();
    git.commit("Delete").await.unwrap();
    let head = git.repository().await.unwrap().head.unwrap();
    let deleted = git.commit_review(&head, "empty.txt").await.unwrap();
    assert_eq!(deleted.before.state, SnapshotState::Text);
    assert_eq!(deleted.after.state, SnapshotState::Missing);
    assert_eq!(deleted.current.file.state, SnapshotState::Missing);
}

#[tokio::test]
async fn renames_use_old_historical_path_and_allow_associating_a_current_file() {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    commit(&git, "old.txt", "one\ntwo\nthree\n", "Before").await;
    run(dir.path(), &["mv", "old.txt", "new.txt"]);
    git.commit("Rename").await.unwrap();
    let selected = git.repository().await.unwrap().head.unwrap();
    fs::rename(dir.path().join("new.txt"), dir.path().join("latest.txt")).unwrap();
    let review = git.commit_review(&selected, "new.txt").await.unwrap();
    assert_eq!(review.before.path, "old.txt");
    assert_eq!(review.after.path, "new.txt");
    assert_eq!(review.before.text, review.after.text);
    assert_eq!(review.current.file.state, SnapshotState::Missing);
    let linked = git
        .review_worktree(dir.path().join("latest.txt").to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(linked.file.path, "latest.txt");
    assert_eq!(linked.file.text, "one\ntwo\nthree\n");
    let outside = tempfile::NamedTempFile::new().unwrap();
    assert!(git
        .review_worktree(outside.path().to_str().unwrap())
        .await
        .is_err());
    assert!(git.review_worktree("../outside").await.is_err());
    assert!(git
        .commit_review(&selected, "not-changed.txt")
        .await
        .is_err());
}

#[tokio::test]
async fn unsupported_snapshots_do_not_prevent_reading_the_other_sides() {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    commit(&git, "file.txt", "before\n", "Before").await;
    let selected = commit(&git, "file.txt", "after\n", "After").await;
    for (bytes, state) in [
        (vec![0, 1, 2], SnapshotState::Binary),
        (vec![0xff, 0xfe], SnapshotState::Encoding),
        (vec![b'x'; MAX_FILE + 1], SnapshotState::TooLarge),
        (
            "line\n".repeat(MAX_LINES + 1).into_bytes(),
            SnapshotState::TooLarge,
        ),
    ] {
        fs::write(dir.path().join("file.txt"), bytes).unwrap();
        let review = git.commit_review(&selected, "file.txt").await.unwrap();
        assert_eq!(review.before.text, "before\n");
        assert_eq!(review.after.text, "after\n");
        assert_eq!(review.current.file.state, state);
        assert!(review.current.file.text.is_empty());
    }
}

#[tokio::test]
async fn merge_reviews_use_the_first_parent_consistently_with_the_file_list() {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let first = commit(&git, "file.txt", "base\n", "Base").await;
    git.create_branch("feature").await.unwrap();
    commit(&git, "file.txt", "feature\n", "Feature").await;
    git.checkout("refs/heads/main").await.unwrap();
    run(dir.path(), &["merge", "--no-ff", "feature", "-m", "Merge"]);
    let head = git.repository().await.unwrap().head.unwrap();
    let review = git.commit_review(&head, "file.txt").await.unwrap();
    assert_eq!(review.parent.as_deref(), Some(first.as_str()));
    assert_eq!(review.before.text, "base\n");
    assert_eq!(review.after.text, "feature\n");
}

#[tokio::test]
async fn review_preserves_staged_and_unstaged_versions() {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    commit(&git, "file.txt", "before\n", "Before").await;
    let selected = commit(&git, "file.txt", "after\n", "After").await;
    fs::write(dir.path().join("file.txt"), "staged\n").unwrap();
    git.stage(vec!["file.txt".into()], false).await.unwrap();
    fs::write(dir.path().join("file.txt"), "unstaged\n").unwrap();
    let index = fs::read(dir.path().join(".git/index")).unwrap();
    let review = git.commit_review(&selected, "file.txt").await.unwrap();
    assert_eq!(review.current.file.text, "unstaged\n");
    assert_eq!(run(dir.path(), &["show", ":file.txt"]), "staged\n");
    assert_eq!(fs::read(dir.path().join(".git/index")).unwrap(), index);
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        "unstaged\n"
    );
}

#[tokio::test]
async fn unreadable_worktree_paths_still_allow_historical_review() {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();
    let selected = commit(&git, "sub/file.txt", "historical\n", "File").await;
    fs::remove_file(dir.path().join("sub/file.txt")).unwrap();
    fs::remove_dir(dir.path().join("sub")).unwrap();
    fs::write(dir.path().join("sub"), "replaced directory").unwrap();
    let review = git.commit_review(&selected, "sub/file.txt").await.unwrap();
    assert_eq!(review.after.text, "historical\n");
    assert!(matches!(
        review.current.file.state,
        SnapshotState::Missing | SnapshotState::Unavailable
    ));
}

#[cfg(windows)]
#[tokio::test]
async fn locked_worktree_files_do_not_hide_historical_contents() {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let selected = commit(&git, "file.txt", "historical\n", "File").await;
    let _lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(dir.path().join("file.txt"))
        .unwrap();
    let review = git.commit_review(&selected, "file.txt").await.unwrap();
    assert_eq!(review.after.text, "historical\n");
    assert_eq!(review.current.file.state, SnapshotState::Unavailable);
    assert!(!review.current.file.reason.is_empty());
}

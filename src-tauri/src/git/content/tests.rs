use super::*;
use crate::git::tests::{fixture, request, run};
use std::fs;

#[test]
fn text_limits_distinguish_opt_in_from_hard_limits_and_preserve_empty_files() {
    for (bytes, allowed, expected, can_load) in [
        (vec![], false, SnapshotState::Text, false),
        (vec![b'x'; MAX_FILE], false, SnapshotState::Text, false),
        (
            vec![b'x'; MAX_FILE + 1],
            false,
            SnapshotState::TooLarge,
            true,
        ),
        (vec![b'x'; MAX_FILE + 1], true, SnapshotState::Text, false),
        (vec![b'\n'; MAX_LINES], false, SnapshotState::TooLarge, true),
        (
            vec![b'\n'; MAX_LARGE_LINES - 1],
            true,
            SnapshotState::Text,
            false,
        ),
        (
            vec![b'\n'; MAX_LARGE_LINES],
            true,
            SnapshotState::TooLarge,
            false,
        ),
        (vec![b'x'; MAX_LARGE_FILE], true, SnapshotState::Text, false),
        (
            vec![b'x'; MAX_LARGE_FILE + 1],
            true,
            SnapshotState::TooLarge,
            false,
        ),
    ] {
        let file = FileSnapshot::from_bytes("code.txt", None, &bytes, allowed);
        assert_eq!(file.state, expected);
        assert_eq!(file.can_load, can_load);
        if expected == SnapshotState::Text {
            assert_eq!(file.text.len(), bytes.len());
        } else {
            assert!(file.text.is_empty());
        }
    }
}

#[tokio::test]
async fn binaries_are_classified_before_the_size_gate_and_keep_file_level_operations() {
    let directory = fixture();
    let git = Git::open(directory.path().to_str().unwrap(), None)
        .await
        .unwrap();
    for path in ["program.EXE", "vendor.lib"] {
        let file = fs::File::create(directory.path().join(path)).unwrap();
        file.set_len((MAX_LARGE_FILE + 1) as u64).unwrap();
        let diff = git.diff_with_options(request(path), true).await.unwrap();
        assert!(diff.binary);
        assert!(!diff.too_large);
        assert!(diff.before.is_empty() && diff.after.is_empty());
        git.stage(vec![path.into()], false).await.unwrap();
    }
    git.commit("binary artifacts").await.unwrap();
    let head = run(directory.path(), &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    let review = git
        .commit_review_with_options(&head, "vendor.lib", true)
        .await
        .unwrap();
    assert_eq!(review.after.state, SnapshotState::Binary);
    assert_eq!(review.current.file.state, SnapshotState::Binary);
    fs::write(
        directory.path().join("unknown.data"),
        b"!<arch>\nplain archive data",
    )
    .unwrap();
    assert!(git.diff(request("unknown.data")).await.unwrap().binary);
}

#[tokio::test]
async fn attributes_apply_to_the_selected_revision_and_override_extensions() {
    let directory = fixture();
    let git = Git::open(directory.path().to_str().unwrap(), None)
        .await
        .unwrap();
    fs::write(
        directory.path().join(".gitattributes"),
        "*.dat -diff\n*.lib diff\n",
    )
    .unwrap();
    fs::write(directory.path().join("opaque.dat"), "plain text\n").unwrap();
    fs::write(directory.path().join("script.lib"), "source code\n").unwrap();
    git.stage(
        vec![
            ".gitattributes".into(),
            "opaque.dat".into(),
            "script.lib".into(),
        ],
        false,
    )
    .await
    .unwrap();
    git.commit("attributes").await.unwrap();
    let first = run(directory.path(), &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    fs::write(directory.path().join(".gitattributes"), "*.dat diff\n").unwrap();
    assert_eq!(
        git.review_worktree("opaque.dat").await.unwrap().file.state,
        SnapshotState::Text
    );
    assert_eq!(
        git.commit_review(&first, "opaque.dat")
            .await
            .unwrap()
            .after
            .state,
        SnapshotState::Binary
    );
    assert_eq!(
        git.commit_review(&first, "script.lib")
            .await
            .unwrap()
            .after
            .text,
        "source code\n"
    );
    fs::write(
        directory.path().join(".gitattributes"),
        "*.dat diff=opaque\n",
    )
    .unwrap();
    run(directory.path(), &["config", "diff.opaque.binary", "true"]);
    assert_eq!(
        git.review_worktree("opaque.dat").await.unwrap().file.state,
        SnapshotState::Binary
    );
}

#[tokio::test]
async fn blobs_over_eight_mib_and_worktree_snapshots_load_only_after_opt_in() {
    let directory = fixture();
    let git = Git::open(directory.path().to_str().unwrap(), None)
        .await
        .unwrap();
    let original = "x".repeat(9 * 1024 * 1024);
    fs::write(directory.path().join("large.txt"), &original).unwrap();
    git.stage(vec!["large.txt".into()], false).await.unwrap();
    git.commit("large source").await.unwrap();
    let head = run(directory.path(), &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    let blocked = git.commit_review(&head, "large.txt").await.unwrap();
    assert!(blocked.after.can_load);
    assert!(blocked.after.text.is_empty());
    let loaded = git
        .commit_review_with_options(&head, "large.txt", true)
        .await
        .unwrap();
    assert_eq!(loaded.after.text, original);
    assert_eq!(loaded.current.file.text, original);
    assert!(loaded.after.large);
    fs::write(directory.path().join("large.txt"), "y").unwrap();
    let diff = git
        .diff_with_options(request("large.txt"), true)
        .await
        .unwrap();
    assert_eq!(diff.before.len(), original.len());
    assert_eq!(diff.after, "y");
    assert!(!diff.too_large);
}

#[tokio::test]
async fn a_hundred_thousand_lines_can_be_reviewed_and_refreshed() {
    let directory = fixture();
    let git = Git::open(directory.path().to_str().unwrap(), None)
        .await
        .unwrap();
    let original = "line\n".repeat(99_999);
    fs::write(directory.path().join("many.txt"), &original).unwrap();
    git.stage(vec!["many.txt".into()], false).await.unwrap();
    git.commit("many lines").await.unwrap();
    let head = run(directory.path(), &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    assert!(
        git.commit_review(&head, "many.txt")
            .await
            .unwrap()
            .after
            .can_load
    );
    let review = git
        .commit_review_with_options(&head, "many.txt", true)
        .await
        .unwrap();
    assert_eq!(review.after.text, original);
    fs::write(
        directory.path().join("many.txt"),
        original.replace("line", "edit"),
    )
    .unwrap();
    let current = git
        .review_worktree_with_options("many.txt", true)
        .await
        .unwrap();
    assert!(current.file.text.starts_with("edit\n"));
    assert_ne!(review.current.file.fingerprint, current.file.fingerprint);
}

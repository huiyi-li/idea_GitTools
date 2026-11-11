use super::*;
use crate::git::tests::{fixture, run};

async fn tracked() -> (tempfile::TempDir, Git) {
    let directory = fixture();
    let git = Git::open(directory.path().to_str().unwrap(), None)
        .await
        .unwrap();
    for path in ["one.txt", "two.txt"] {
        fs::write(directory.path().join(path), "base\n").unwrap();
    }
    git.stage(vec!["one.txt".into(), "two.txt".into()], false)
        .await
        .unwrap();
    git.commit("base").await.unwrap();
    (directory, git)
}

#[tokio::test]
async fn unstaged_discard_restores_from_index_and_preserves_its_exact_contents() {
    let directory = fixture();
    let git = Git::open(directory.path().to_str().unwrap(), None)
        .await
        .unwrap();
    fs::write(directory.path().join("file.txt"), "base\n").unwrap();
    git.stage(vec!["file.txt".into()], false).await.unwrap();
    git.commit("base").await.unwrap();
    fs::write(directory.path().join("file.txt"), "staged\n").unwrap();
    git.stage(vec!["file.txt".into()], false).await.unwrap();
    fs::write(directory.path().join("file.txt"), "working\n").unwrap();
    let index = fs::read(directory.path().join(".git/index")).unwrap();
    let mut request = crate::git::tests::request("file.txt");
    request.area = Some(DiffArea::Staged);
    let staged = git.diff(request.clone()).await.unwrap();
    assert_eq!(
        (staged.before.as_str(), staged.after.as_str()),
        ("base\n", "staged\n")
    );
    request.area = Some(DiffArea::Unstaged);
    let working = git.diff(request).await.unwrap();
    assert_eq!(
        (working.before.as_str(), working.after.as_str()),
        ("staged\n", "working\n")
    );
    let preview = git
        .preview_discard(vec!["file.txt".into()], DiscardMode::Unstaged)
        .await
        .unwrap();
    git.discard_changes(preview).await.unwrap();
    assert_eq!(
        fs::read_to_string(directory.path().join("file.txt")).unwrap(),
        "staged\n"
    );
    assert_eq!(
        fs::read(directory.path().join(".git/index")).unwrap(),
        index
    );
}

#[tokio::test]
async fn all_file_changes_restore_head_and_preserve_other_staged_and_unstaged_files() {
    let (directory, git) = tracked().await;
    for path in ["one.txt", "two.txt"] {
        fs::write(directory.path().join(path), "staged\n").unwrap();
    }
    git.stage(vec!["one.txt".into(), "two.txt".into()], false)
        .await
        .unwrap();
    for path in ["one.txt", "two.txt"] {
        fs::write(directory.path().join(path), "working\n").unwrap();
    }
    fs::write(directory.path().join("keep.txt"), "untracked").unwrap();
    let preview = git
        .preview_discard(vec!["one.txt".into()], DiscardMode::All)
        .await
        .unwrap();
    git.discard_changes(preview).await.unwrap();
    assert_eq!(
        fs::read_to_string(directory.path().join("one.txt")).unwrap(),
        "base\n"
    );
    assert_eq!(run(directory.path(), &["show", ":one.txt"]), "base\n");
    assert_eq!(
        fs::read_to_string(directory.path().join("two.txt")).unwrap(),
        "working\n"
    );
    assert_eq!(run(directory.path(), &["show", ":two.txt"]), "staged\n");
    assert_eq!(
        fs::read_to_string(directory.path().join("keep.txt")).unwrap(),
        "untracked"
    );
}

#[tokio::test]
async fn new_files_can_be_deleted_and_partial_first_commit_staging_can_be_cancelled() {
    let directory = fixture();
    let git = Git::open(directory.path().to_str().unwrap(), None)
        .await
        .unwrap();
    fs::write(directory.path().join("new.txt"), "untracked").unwrap();
    let preview = git
        .preview_discard(vec!["new.txt".into()], DiscardMode::Unstaged)
        .await
        .unwrap();
    assert!(preview.files[0].delete);
    git.discard_changes(preview).await.unwrap();
    assert!(!directory.path().join("new.txt").exists());
    assert!(!directory.path().join(".git/index").exists());
    fs::write(directory.path().join("new.txt"), "staged").unwrap();
    git.stage(vec!["new.txt".into()], false).await.unwrap();
    fs::write(directory.path().join("new.txt"), "working").unwrap();
    git.stage(vec!["new.txt".into()], true).await.unwrap();
    assert!(run(directory.path(), &["ls-files"]).is_empty());
    assert_eq!(
        fs::read_to_string(directory.path().join("new.txt")).unwrap(),
        "working"
    );
    git.stage(vec!["new.txt".into()], false).await.unwrap();
    let preview = git
        .preview_discard(vec!["new.txt".into()], DiscardMode::All)
        .await
        .unwrap();
    git.discard_changes(preview).await.unwrap();
    assert!(!directory.path().join("new.txt").exists());
    assert!(run(directory.path(), &["ls-files"]).is_empty());
}

#[tokio::test]
async fn stale_previews_and_locked_indexes_leave_files_intact() {
    let (directory, git) = tracked().await;
    fs::write(directory.path().join("one.txt"), "working").unwrap();
    let preview = git
        .preview_discard(vec!["one.txt".into()], DiscardMode::All)
        .await
        .unwrap();
    fs::write(directory.path().join("one.txt"), "external edit").unwrap();
    assert!(git
        .discard_changes(preview)
        .await
        .unwrap_err()
        .contains("改变"));
    assert_eq!(
        fs::read_to_string(directory.path().join("one.txt")).unwrap(),
        "external edit"
    );
    let preview = git
        .preview_discard(vec!["one.txt".into()], DiscardMode::Unstaged)
        .await
        .unwrap();
    fs::write(directory.path().join(".git/index.lock"), "other git").unwrap();
    assert!(git
        .discard_changes(preview)
        .await
        .unwrap_err()
        .contains("锁定"));
    assert_eq!(
        fs::read_to_string(directory.path().join("one.txt")).unwrap(),
        "external edit"
    );
    fs::remove_file(directory.path().join(".git/index.lock")).unwrap();
    let preview = git
        .preview_discard(vec!["one.txt".into()], DiscardMode::All)
        .await
        .unwrap();
    git.stage(vec!["one.txt".into()], false).await.unwrap();
    assert!(git.discard_changes(preview).await.is_err());
    assert_eq!(
        fs::read_to_string(directory.path().join("one.txt")).unwrap(),
        "external edit"
    );
}

#[tokio::test]
async fn a_failed_smudge_filter_rolls_back_partial_worktree_writes_and_the_original_index() {
    let (directory, git) = tracked().await;
    fs::write(
        directory.path().join(".gitattributes"),
        "two.txt filter=broken\n",
    )
    .unwrap();
    git.stage(vec![".gitattributes".into()], false)
        .await
        .unwrap();
    git.commit("attributes").await.unwrap();
    run(
        directory.path(),
        &["config", "filter.broken.smudge", "false"],
    );
    run(directory.path(), &["config", "filter.broken.clean", "cat"]);
    run(
        directory.path(),
        &["config", "filter.broken.required", "true"],
    );
    for path in ["one.txt", "two.txt"] {
        fs::write(directory.path().join(path), "manual work\n").unwrap();
    }
    let index = fs::read(directory.path().join(".git/index")).unwrap();
    let preview = git
        .preview_discard(vec!["one.txt".into(), "two.txt".into()], DiscardMode::All)
        .await
        .unwrap();
    let error = git.discard_changes(preview).await.unwrap_err();
    assert!(error.contains("已恢复原文件"), "{error}");
    for path in ["one.txt", "two.txt"] {
        assert_eq!(
            fs::read_to_string(directory.path().join(path)).unwrap(),
            "manual work\n"
        );
    }
    assert_eq!(
        fs::read(directory.path().join(".git/index")).unwrap(),
        index
    );
    assert!(!directory.path().join(".git/index.lock").exists());
}

#[tokio::test]
async fn staged_renames_restore_both_paths_and_unstaged_diff_uses_the_new_index_path() {
    let (directory, git) = tracked().await;
    run(directory.path(), &["mv", "one.txt", "renamed.txt"]);
    fs::write(directory.path().join("renamed.txt"), "working rename\n").unwrap();
    let mut request = crate::git::tests::request("renamed.txt");
    request.old_path = Some("one.txt".into());
    request.area = Some(DiffArea::Unstaged);
    assert_eq!(git.diff(request).await.unwrap().before, "base\n");
    let preview = git
        .preview_discard(vec!["renamed.txt".into()], DiscardMode::All)
        .await
        .unwrap();
    assert_eq!(preview.files.len(), 2);
    git.discard_changes(preview).await.unwrap();
    assert_eq!(
        fs::read_to_string(directory.path().join("one.txt")).unwrap(),
        "base\n"
    );
    assert!(!directory.path().join("renamed.txt").exists());
    assert!(git.status().await.unwrap().changes.is_empty());
}

#[tokio::test]
async fn literal_unicode_and_binary_paths_restore_without_text_parsing() {
    let directory = fixture();
    let git = Git::open(directory.path().to_str().unwrap(), None)
        .await
        .unwrap();
    let path = "空 格 [x].exe";
    fs::write(directory.path().join(path), [0, 1, 2]).unwrap();
    git.stage(vec![path.into()], false).await.unwrap();
    git.commit("binary").await.unwrap();
    fs::write(directory.path().join(path), [0, 3, 4]).unwrap();
    let preview = git
        .preview_discard(vec![path.into()], DiscardMode::Unstaged)
        .await
        .unwrap();
    git.discard_changes(preview).await.unwrap();
    assert_eq!(fs::read(directory.path().join(path)).unwrap(), [0, 1, 2]);
    for path in ["../outside", ".git/config", "missing.txt"] {
        assert!(git
            .preview_discard(vec![path.into()], DiscardMode::All)
            .await
            .is_err());
    }
}

#[tokio::test]
async fn deleted_files_and_staged_additions_restore_to_the_correct_source() {
    let (directory, git) = tracked().await;
    fs::remove_file(directory.path().join("one.txt")).unwrap();
    let preview = git
        .preview_discard(vec!["one.txt".into()], DiscardMode::Unstaged)
        .await
        .unwrap();
    git.discard_changes(preview).await.unwrap();
    assert_eq!(
        fs::read_to_string(directory.path().join("one.txt")).unwrap(),
        "base\n"
    );
    fs::write(directory.path().join("new.txt"), "staged new\n").unwrap();
    git.stage(vec!["new.txt".into()], false).await.unwrap();
    fs::write(directory.path().join("new.txt"), "working new\n").unwrap();
    let preview = git
        .preview_discard(vec!["new.txt".into()], DiscardMode::Unstaged)
        .await
        .unwrap();
    git.discard_changes(preview).await.unwrap();
    assert_eq!(
        fs::read_to_string(directory.path().join("new.txt")).unwrap(),
        "staged new\n"
    );
    let preview = git
        .preview_discard(vec!["new.txt".into()], DiscardMode::All)
        .await
        .unwrap();
    git.discard_changes(preview).await.unwrap();
    assert!(!directory.path().join("new.txt").exists());
}

#[tokio::test]
async fn staged_deletion_with_a_recreated_file_discards_only_the_untracked_copy() {
    let (directory, git) = tracked().await;
    run(directory.path(), &["rm", "one.txt"]);
    fs::write(directory.path().join("one.txt"), "recreated\n").unwrap();
    let index = fs::read(directory.path().join(".git/index")).unwrap();
    let preview = git
        .preview_discard(vec!["one.txt".into()], DiscardMode::Unstaged)
        .await
        .unwrap();
    assert!(preview.files[0].delete);
    git.discard_changes(preview).await.unwrap();
    assert!(!directory.path().join("one.txt").exists());
    assert_eq!(
        fs::read(directory.path().join(".git/index")).unwrap(),
        index
    );
    let changes = git.status().await.unwrap().changes;
    assert!(changes
        .iter()
        .any(|change| change.path == "one.txt" && change.index == 'D'));
    let preview = git
        .preview_discard(vec!["one.txt".into()], DiscardMode::All)
        .await
        .unwrap();
    git.discard_changes(preview).await.unwrap();
    assert_eq!(
        fs::read_to_string(directory.path().join("one.txt")).unwrap(),
        "base\n"
    );
    assert!(git.status().await.unwrap().changes.is_empty());
}

use super::*;
use crate::git::tests::{fixture, run};
use tempfile::TempDir;

async fn conflict() -> (TempDir, Git) {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    fs::write(dir.path().join("conflict.txt"), "start\nbase\nend\n").unwrap();
    git.stage(vec!["conflict.txt".into()], false).await.unwrap();
    git.commit("initial").await.unwrap();
    git.create_branch("feature").await.unwrap();
    fs::write(dir.path().join("conflict.txt"), "start\nfeature\nend\n").unwrap();
    git.stage(vec!["conflict.txt".into()], false).await.unwrap();
    git.commit("feature edit").await.unwrap();
    git.checkout("refs/heads/main").await.unwrap();
    fs::write(dir.path().join("conflict.txt"), "start\nmain\nend\n").unwrap();
    git.stage(vec!["conflict.txt".into()], false).await.unwrap();
    git.commit("main edit").await.unwrap();
    assert_ne!(
        git.execute(&["merge", "feature"], None).await.unwrap().code,
        0
    );
    (dir, git)
}

fn result(id: &str, text: &str, finish: bool) -> SaveMerge {
    SaveMerge {
        id: id.into(),
        finish,
        choice: "result".into(),
        progress: Some(Progress {
            lines: text.split('\n').map(str::to_owned).collect(),
            states: vec![],
            content_modified: true,
        }),
    }
}

#[tokio::test]
async fn large_merge_results_save_restore_drafts_and_finish_without_truncation() {
    let (dir, mut git) = conflict().await;
    let context = "context line\n".repeat(99_990);
    let mut index = Vec::new();
    for (stage, middle) in [(1, "base"), (2, "main"), (3, "feature")] {
        let text = format!("{context}{middle}\nend\n");
        let hash = git
            .execute(&["hash-object", "-w", "--stdin"], Some(text.as_bytes()))
            .await
            .unwrap()
            .checked()
            .unwrap();
        index.extend_from_slice(
            format!(
                "100644 {} {stage}\tconflict.txt\0",
                String::from_utf8(hash).unwrap().trim()
            )
            .as_bytes(),
        );
    }
    git.execute(&["update-index", "-z", "--index-info"], Some(&index))
        .await
        .unwrap()
        .checked()
        .unwrap();
    fs::write(
        dir.path().join("conflict.txt"),
        format!("{context}<<<<<<< HEAD\nmain\n=======\nfeature\n>>>>>>> feature\nend\n"),
    )
    .unwrap();
    let blocked = git.open_merge("conflict.txt".into()).await.unwrap();
    assert!(!blocked.editable);
    assert!(blocked.can_load);
    assert!(git
        .save_merge(result(&blocked.id, "replacement", false))
        .await
        .is_err());
    let loaded = git
        .open_merge_with_options("conflict.txt".into(), true)
        .await
        .unwrap();
    assert!(loaded.editable && loaded.large);
    let resolved = format!("{context}resolved\nend\n");
    git.save_merge(result(&loaded.id, &resolved, false))
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("conflict.txt")).unwrap(),
        resolved
    );
    drop(git);
    let mut git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let reopened = git
        .open_merge_with_options("conflict.txt".into(), true)
        .await
        .unwrap();
    assert_eq!(
        reopened.progress.as_ref().unwrap().lines.join("\n"),
        resolved
    );
    let original = fs::read(dir.path().join("conflict.txt")).unwrap();
    assert!(git
        .save_merge(result(&reopened.id, &"x".repeat(MAX_LARGE_FILE + 1), true))
        .await
        .is_err());
    assert_eq!(fs::read(dir.path().join("conflict.txt")).unwrap(), original);
    git.save_merge(result(&reopened.id, &resolved, true))
        .await
        .unwrap();
    assert!(git.merge_overview().await.unwrap().files.is_empty());
    assert_eq!(run(dir.path(), &["show", ":conflict.txt"]), resolved);
}

#[test]
fn merge_result_validation_enforces_large_line_and_byte_budgets() {
    let progress = |lines: Vec<String>| Progress {
        lines,
        states: vec![],
        content_modified: true,
    };
    assert!(validate_progress(&progress(vec![String::new(); MAX_LARGE_LINES]), true).is_ok());
    assert!(validate_progress(&progress(vec![String::new(); MAX_LARGE_LINES + 1]), true).is_err());
    assert!(validate_progress(&progress(vec!["x".repeat(MAX_FILE + 1)]), false).is_err());
    assert!(validate_progress(&progress(vec!["x".repeat(MAX_FILE + 1)]), true).is_ok());
}

#[tokio::test]
async fn draft_survives_restart_and_finish_preserves_other_staged_files() {
    let (dir, mut git) = conflict().await;
    fs::write(dir.path().join("other.txt"), "staged other\n").unwrap();
    git.stage(vec!["other.txt".into()], false).await.unwrap();
    fs::write(dir.path().join("other.txt"), "unstaged other\n").unwrap();
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    assert_eq!(document.base, "start\nbase\nend\n");
    assert_eq!(document.left, "start\nmain\nend\n");
    assert_eq!(document.right, "start\nfeature\nend\n");
    assert!(document.editable);
    git.save_merge(result(&document.id, "start\nresolved\nend\n", false))
        .await
        .unwrap();
    assert_eq!(git.merge_overview().await.unwrap().files.len(), 1);
    assert!(run(dir.path(), &["diff", "--cached", "--name-only"]).contains("other.txt"));
    drop(git);
    let mut git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let reopened = git.open_merge("conflict.txt".into()).await.unwrap();
    assert_eq!(reopened.progress.as_ref().unwrap().lines[1], "resolved");
    assert!(git
        .save_merge(result(&document.id, "wrong", true))
        .await
        .is_err());
    git.save_merge(result(&reopened.id, "start\nresolved\nend\n", true))
        .await
        .unwrap();
    assert!(git.merge_overview().await.unwrap().files.is_empty());
    assert_eq!(run(dir.path(), &["show", ":other.txt"]), "staged other\n");
    assert_eq!(
        fs::read_to_string(dir.path().join("other.txt")).unwrap(),
        "unstaged other\n"
    );
    assert_eq!(
        run(dir.path(), &["show", ":conflict.txt"]),
        "start\nresolved\nend\n"
    );
}

#[tokio::test]
async fn refuses_stale_worktree_and_index_and_existing_lock() {
    let (dir, mut git) = conflict().await;
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    let original = fs::read(dir.path().join("conflict.txt")).unwrap();
    fs::write(dir.path().join(".git/index.lock"), "another Git process").unwrap();
    assert!(git
        .save_merge(result(&document.id, "resolved", true))
        .await
        .unwrap_err()
        .contains("锁定"));
    assert_eq!(fs::read(dir.path().join("conflict.txt")).unwrap(), original);
    assert_eq!(
        fs::read_to_string(dir.path().join(".git/index.lock")).unwrap(),
        "another Git process"
    );
    fs::remove_file(dir.path().join(".git/index.lock")).unwrap();
    fs::write(dir.path().join("conflict.txt"), "external edit\n").unwrap();
    assert!(git
        .save_merge(result(&document.id, "overwrite", true))
        .await
        .unwrap_err()
        .contains("外部改变"));
    assert_eq!(
        fs::read_to_string(dir.path().join("conflict.txt")).unwrap(),
        "external edit\n"
    );
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    git.stage(vec!["conflict.txt".into()], false).await.unwrap();
    assert!(git
        .save_merge(result(&document.id, "overwrite", true))
        .await
        .is_err());
    assert_eq!(
        run(dir.path(), &["show", ":conflict.txt"]),
        "external edit\n"
    );
}

#[tokio::test]
async fn rejects_unconfirmed_blocks_and_markers_without_writing() {
    let (dir, mut git) = conflict().await;
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    let original = fs::read(dir.path().join("conflict.txt")).unwrap();
    assert!(git
        .save_merge(result(
            &document.id,
            "<<<<<<< local\nleft\n=======\nright\n>>>>>>> incoming\n",
            true
        ))
        .await
        .is_err());
    let mut request = result(&document.id, "manual result\n", true);
    request.progress.as_mut().unwrap().states.push(ChangeState {
        start: 0,
        end: 1,
        resolved_left: false,
        resolved_right: false,
        oneside: false,
    });
    assert!(git.save_merge(request).await.is_err());
    assert_eq!(fs::read(dir.path().join("conflict.txt")).unwrap(), original);
    assert_eq!(git.merge_overview().await.unwrap().files.len(), 1);
}

#[tokio::test]
async fn failed_clean_filter_keeps_unmerged_index_and_saved_result_for_retry() {
    let (dir, mut git) = conflict().await;
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    fs::write(
        dir.path().join(".gitattributes"),
        "conflict.txt filter=fail\n",
    )
    .unwrap();
    run(dir.path(), &["config", "filter.fail.clean", "false"]);
    run(dir.path(), &["config", "filter.fail.required", "true"]);
    assert!(git
        .save_merge(result(&document.id, "resolved\n", true))
        .await
        .is_err());
    assert_eq!(git.merge_overview().await.unwrap().files.len(), 1);
    assert_eq!(
        fs::read_to_string(dir.path().join("conflict.txt")).unwrap(),
        "resolved\n"
    );
    assert!(!dir.path().join(".git/index.lock").exists());
    run(dir.path(), &["config", "--unset", "filter.fail.required"]);
    run(dir.path(), &["config", "--unset", "filter.fail.clean"]);
    git.save_merge(result(&document.id, "resolved\n", true))
        .await
        .unwrap();
    assert!(git.merge_overview().await.unwrap().files.is_empty());
}

#[tokio::test]
async fn side_checkout_filter_failure_keeps_original_worktree() {
    let (dir, mut git) = conflict().await;
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    let original = fs::read(dir.path().join("conflict.txt")).unwrap();
    fs::write(
        dir.path().join(".gitattributes"),
        "conflict.txt filter=fail\n",
    )
    .unwrap();
    run(dir.path(), &["config", "filter.fail.smudge", "false"]);
    run(dir.path(), &["config", "filter.fail.required", "true"]);
    assert!(git
        .save_merge(SaveMerge {
            id: document.id,
            finish: true,
            choice: "left".into(),
            progress: None
        })
        .await
        .is_err());
    assert_eq!(fs::read(dir.path().join("conflict.txt")).unwrap(), original);
    assert_eq!(git.merge_overview().await.unwrap().files.len(), 1);
    assert!(!dir.path().join(".git/index.lock").exists());
}

#[tokio::test]
async fn continues_merge_only_after_all_files_resolved() {
    let (_dir, mut git) = conflict().await;
    let overview = git.merge_overview().await.unwrap();
    assert!(git
        .merge_operation(overview.operation_id.clone(), "continue".into())
        .await
        .is_err());
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    git.save_merge(result(&document.id, "resolved\n", true))
        .await
        .unwrap();
    git.merge_operation(overview.operation_id, "continue".into())
        .await
        .unwrap();
    assert_eq!(git.repository().await.unwrap().operation, "none");
    let head = git.repository().await.unwrap().head.unwrap();
    assert_eq!(git.details(&head).await.unwrap().commit.parents.len(), 2);
}

#[tokio::test]
async fn continue_hook_failure_preserves_resolved_files_and_can_be_retried() {
    let (dir, mut git) = conflict().await;
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    git.save_merge(result(&document.id, "resolved\n", true))
        .await
        .unwrap();
    let overview = git.merge_overview().await.unwrap();
    fs::write(
        dir.path().join(".git/hooks/pre-commit"),
        "#!/bin/sh\necho stop >&2\nexit 1\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            dir.path().join(".git/hooks/pre-commit"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    assert!(git
        .merge_operation(overview.operation_id.clone(), "continue".into())
        .await
        .is_err());
    assert_eq!(git.repository().await.unwrap().operation, "merge");
    assert!(git.merge_overview().await.unwrap().files.is_empty());
    assert_eq!(run(dir.path(), &["show", ":conflict.txt"]), "resolved\n");
    fs::remove_file(dir.path().join(".git/hooks/pre-commit")).unwrap();
    git.merge_operation(overview.operation_id, "continue".into())
        .await
        .unwrap();
    assert_eq!(git.repository().await.unwrap().operation, "none");
}

#[tokio::test]
async fn rebase_swaps_display_sides_and_can_continue() {
    let (dir, git) = conflict().await;
    run(dir.path(), &["merge", "--abort"]);
    git.checkout("refs/heads/feature").await.unwrap();
    assert_ne!(
        git.execute(&["rebase", "main"], None).await.unwrap().code,
        0
    );
    let mut git = git;
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    assert_eq!(document.left_stage, 3);
    assert!(document.left.contains("feature"));
    assert!(document.right.contains("main"));
    assert!(document.left_title.contains("重放"));
    git.save_merge(result(&document.id, "both changes\n", true))
        .await
        .unwrap();
    let overview = git.merge_overview().await.unwrap();
    git.merge_operation(overview.operation_id, "continue".into())
        .await
        .unwrap();
    assert_eq!(git.repository().await.unwrap().operation, "none");
    assert_eq!(
        git.repository().await.unwrap().branch.as_deref(),
        Some("feature")
    );
}

#[tokio::test]
async fn side_selection_resolves_delete_and_binary_conflicts() {
    let (dir, git) = conflict().await;
    run(dir.path(), &["merge", "--abort"]);
    run(dir.path(), &["rm", "conflict.txt"]);
    git.commit("delete main file").await.unwrap();
    assert_ne!(
        git.execute(&["merge", "feature"], None).await.unwrap().code,
        0
    );
    let mut git = git;
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    assert!(!document.left_present);
    git.save_merge(SaveMerge {
        id: document.id,
        finish: true,
        choice: "left".into(),
        progress: None,
    })
    .await
    .unwrap();
    assert!(!dir.path().join("conflict.txt").exists());
    assert!(git.merge_overview().await.unwrap().files.is_empty());
    run(dir.path(), &["merge", "--abort"]);
    // A regular binary conflict still offers whole-side selection.
    fs::write(dir.path().join("binary.bin"), [0, 1, 2]).unwrap();
    git.stage(vec!["binary.bin".into()], false).await.unwrap();
    git.commit("binary base").await.unwrap();
    git.create_branch("binary-feature").await.unwrap();
    fs::write(dir.path().join("binary.bin"), [0, 3, 4]).unwrap();
    git.stage(vec!["binary.bin".into()], false).await.unwrap();
    run(
        dir.path(),
        &["update-index", "--chmod=+x", "--", "binary.bin"],
    );
    git.commit("binary feature").await.unwrap();
    git.checkout("refs/heads/main").await.unwrap();
    fs::write(dir.path().join("binary.bin"), [0, 5, 6]).unwrap();
    git.stage(vec!["binary.bin".into()], false).await.unwrap();
    git.commit("binary main").await.unwrap();
    assert_ne!(
        git.execute(&["merge", "binary-feature"], None)
            .await
            .unwrap()
            .code,
        0
    );
    let document = git.open_merge("binary.bin".into()).await.unwrap();
    assert!(!document.editable);
    git.save_merge(SaveMerge {
        id: document.id,
        finish: true,
        choice: "right".into(),
        progress: None,
    })
    .await
    .unwrap();
    assert_eq!(fs::read(dir.path().join("binary.bin")).unwrap(), [0, 3, 4]);
    assert!(run(dir.path(), &["ls-files", "--stage", "--", "binary.bin"]).starts_with("100755"));
    assert!(git.merge_overview().await.unwrap().files.is_empty());
}

#[tokio::test]
async fn preserves_crlf_and_custom_conflict_marker_size() {
    let (dir, mut git) = conflict().await;
    fs::write(
        dir.path().join("conflict.txt"),
        "<<<<<<< HEAD\r\nmain\r\n=======\r\nfeature\r\n>>>>>>> feature\r\n",
    )
    .unwrap();
    fs::write(
        dir.path().join(".gitattributes"),
        "conflict.txt conflict-marker-size=9\n",
    )
    .unwrap();
    let document = git.open_merge("conflict.txt".into()).await.unwrap();
    assert_eq!(document.marker_size, 9);
    assert!(git
        .save_merge(result(&document.id, "<<<<<<<<< HEAD\nleft", true))
        .await
        .is_err());
    git.save_merge(result(&document.id, "resolved\n", true))
        .await
        .unwrap();
    assert_eq!(
        fs::read(dir.path().join("conflict.txt")).unwrap(),
        b"resolved\r\n"
    );
}

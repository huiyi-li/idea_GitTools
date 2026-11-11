use super::*;
use crate::git::merge::SaveMerge;
use crate::git::tests::{fixture, run};
use std::fs;
use tempfile::TempDir;

#[test]
fn diff_requests_from_older_frontends_keep_their_existing_behavior() {
    let request: DiffRequest = serde_json::from_value(serde_json::json!({
        "path": "example.txt", "oldPath": null, "revision": null
    }))
    .unwrap();
    assert!(request.before_revision.is_none());
}

async fn setup() -> (TempDir, Git) {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    write_commit(&git, "shared.txt", "base\n", "base").await;
    (dir, git)
}

async fn write_commit(git: &Git, path: &str, text: &str, message: &str) -> String {
    fs::write(git.root.join(path), text).unwrap();
    git.stage(vec![path.into()], false).await.unwrap();
    git.commit(message).await.unwrap();
    git.repository().await.unwrap().head.unwrap()
}

async fn request(git: &Git, action: HistoryAction, target: &str) -> HistoryRequest {
    let status = git.status().await.unwrap();
    let target_hash = if matches!(action, HistoryAction::Merge | HistoryAction::Rebase) {
        status
            .branches
            .iter()
            .find(|branch| branch.full == target)
            .unwrap()
            .hash
            .clone()
    } else {
        target.into()
    };
    HistoryRequest {
        action,
        target: target.into(),
        target_hash,
        expected_head: status.repository.head.unwrap(),
        expected_branch: status.repository.branch.unwrap(),
        merge_mode: MergeMode::Auto,
        mainline: None,
    }
}

async fn diverge(git: &Git, conflict: bool) -> String {
    git.create_branch("feature").await.unwrap();
    let feature = write_commit(
        git,
        if conflict {
            "shared.txt"
        } else {
            "feature.txt"
        },
        "feature\n",
        "feature change",
    )
    .await;
    git.checkout("refs/heads/main").await.unwrap();
    write_commit(
        git,
        if conflict { "shared.txt" } else { "main.txt" },
        "main\n",
        "main change",
    )
    .await;
    feature
}

async fn operation_id(git: &Git) -> String {
    serde_json::to_value(git.merge_overview().await.unwrap()).unwrap()["operationId"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn cherry_pick_and_revert_create_commits_with_the_expected_contents() {
    let (dir, git) = setup().await;
    git.create_branch("feature").await.unwrap();
    let target = write_commit(&git, "feature.txt", "feature\n", "selected change").await;
    git.checkout("refs/heads/main").await.unwrap();
    git.start_history(request(&git, HistoryAction::CherryPick, &target).await)
        .await
        .unwrap();
    assert_eq!(run(dir.path(), &["show", "HEAD:feature.txt"]), "feature\n");
    assert_eq!(
        run(dir.path(), &["log", "-1", "--format=%s"]).trim(),
        "selected change"
    );
    assert!(git.status().await.unwrap().changes.is_empty());
    let picked = git.repository().await.unwrap().head.unwrap();
    git.start_history(request(&git, HistoryAction::Revert, &picked).await)
        .await
        .unwrap();
    assert!(!dir.path().join("feature.txt").exists());
    assert!(run(dir.path(), &["log", "-1", "--format=%s"]).starts_with("Revert"));
    assert_eq!(
        run(dir.path(), &["rev-list", "--count", "main"]).trim(),
        "3"
    );
}

#[tokio::test]
async fn rejects_dirty_or_stale_requests_without_changing_the_repository() {
    let (dir, git) = setup().await;
    let target = diverge(&git, false).await;
    let merge = request(&git, HistoryAction::Merge, "refs/heads/feature").await;
    for action in [
        HistoryAction::Merge,
        HistoryAction::Rebase,
        HistoryAction::CherryPick,
        HistoryAction::Revert,
    ] {
        let target = if matches!(action, HistoryAction::Merge | HistoryAction::Rebase) {
            "refs/heads/feature"
        } else {
            &target
        };
        let operation = request(&git, action, target).await;
        fs::write(dir.path().join("untracked.txt"), "keep me").unwrap();
        assert!(git
            .start_history(operation.clone())
            .await
            .unwrap_err()
            .contains("Stash"));
        assert_eq!(
            fs::read_to_string(dir.path().join("untracked.txt")).unwrap(),
            "keep me"
        );
        git.stage(vec!["untracked.txt".into()], false)
            .await
            .unwrap();
        assert!(git
            .start_history(operation)
            .await
            .unwrap_err()
            .contains("Stash"));
        git.stage(vec!["untracked.txt".into()], true).await.unwrap();
        fs::remove_file(dir.path().join("untracked.txt")).unwrap();
    }
    assert_eq!(
        git.repository().await.unwrap().head.as_deref(),
        Some(merge.expected_head.as_str())
    );
    run(dir.path(), &["branch", "-f", "feature", "main"]);
    assert!(git
        .start_history(merge.clone())
        .await
        .unwrap_err()
        .contains("目标分支已移动"));
    let mut stale = request(&git, HistoryAction::Merge, "refs/heads/feature").await;
    stale.expected_head = "0".repeat(40);
    assert!(git.start_history(stale).await.unwrap_err().contains("HEAD"));
    let stale = request(&git, HistoryAction::Merge, "refs/heads/feature").await;
    git.create_branch("other").await.unwrap();
    assert!(git.start_history(stale).await.unwrap_err().contains("HEAD"));
    assert!(git.status().await.unwrap().changes.is_empty());
}

#[tokio::test]
async fn merge_supports_fast_forward_forced_merge_commit_and_ff_only_refusal() {
    let (dir, git) = setup().await;
    git.create_branch("feature").await.unwrap();
    let target = write_commit(&git, "feature.txt", "feature\n", "feature").await;
    git.checkout("refs/heads/main").await.unwrap();
    let base = git.repository().await.unwrap().head.unwrap();
    git.start_history(request(&git, HistoryAction::Merge, "refs/heads/feature").await)
        .await
        .unwrap();
    assert_eq!(git.repository().await.unwrap().head.unwrap(), target);
    run(dir.path(), &["reset", "--hard", &base]);
    let mut forced = request(&git, HistoryAction::Merge, "refs/heads/feature").await;
    forced.merge_mode = MergeMode::NoFf;
    git.start_history(forced).await.unwrap();
    let head = git.repository().await.unwrap().head.unwrap();
    assert_eq!(git.details(&head).await.unwrap().commit.parents.len(), 2);
    run(dir.path(), &["reset", "--hard", &base]);
    write_commit(&git, "main.txt", "main\n", "main").await;
    let mut ff = request(&git, HistoryAction::Merge, "refs/heads/feature").await;
    ff.merge_mode = MergeMode::FfOnly;
    let head = ff.expected_head.clone();
    assert!(git.start_history(ff).await.is_err());
    assert_eq!(git.repository().await.unwrap().head.unwrap(), head);
    assert_eq!(git.repository().await.unwrap().operation, "none");
    assert!(git.status().await.unwrap().changes.is_empty());
}

#[tokio::test]
async fn rebase_replays_current_branch_without_moving_other_branches() {
    let (dir, git) = setup().await;
    diverge(&git, false).await;
    let old = git.repository().await.unwrap().head.unwrap();
    run(dir.path(), &["branch", "keep", &old]);
    run(dir.path(), &["config", "rebase.updateRefs", "true"]);
    git.start_history(request(&git, HistoryAction::Rebase, "refs/heads/feature").await)
        .await
        .unwrap();
    assert_ne!(git.repository().await.unwrap().head.unwrap(), old);
    assert_eq!(run(dir.path(), &["rev-parse", "keep"]).trim(), old);
    assert_eq!(run(dir.path(), &["show", "HEAD:feature.txt"]), "feature\n");
    assert_eq!(run(dir.path(), &["show", "HEAD:main.txt"]), "main\n");
    assert_eq!(git.repository().await.unwrap().operation, "none");
}

#[tokio::test]
async fn started_merge_and_rebase_conflicts_use_the_existing_merge_manager() {
    for action in [HistoryAction::Merge, HistoryAction::Rebase] {
        let (dir, mut git) = setup().await;
        diverge(&git, true).await;
        let operation = request(&git, action, "refs/heads/feature").await;
        run(dir.path(), &["config", "rebase.updateRefs", "true"]);
        run(dir.path(), &["branch", "keep", &operation.expected_head]);
        let old_head = operation.expected_head.clone();
        assert!(git.start_history(operation.clone()).await.is_err());
        assert!(
            git.start_history(operation)
                .await
                .unwrap_err()
                .contains("HEAD")
                || git.repository().await.unwrap().operation != "none"
        );
        let overview = serde_json::to_value(git.merge_overview().await.unwrap()).unwrap();
        assert_eq!(overview["files"].as_array().unwrap().len(), 1);
        let document =
            serde_json::to_value(git.open_merge("shared.txt".into()).await.unwrap()).unwrap();
        let choice = if matches!(action, HistoryAction::Rebase) {
            "left"
        } else {
            "right"
        };
        let expected = document[choice].as_str().unwrap().to_owned();
        git.save_merge(SaveMerge {
            id: document["id"].as_str().unwrap().to_owned(),
            choice: choice.into(),
            finish: true,
            progress: None,
        })
        .await
        .unwrap();
        let id = operation_id(&git).await;
        git.merge_operation(id, "continue".into()).await.unwrap();
        assert_eq!(git.repository().await.unwrap().operation, "none");
        assert_eq!(
            fs::read_to_string(dir.path().join("shared.txt")).unwrap(),
            expected
        );
        assert!(git.status().await.unwrap().changes.is_empty());
        assert_eq!(run(dir.path(), &["rev-parse", "keep"]).trim(), old_head);
    }
}

#[tokio::test]
async fn cherry_pick_and_revert_conflicts_can_abort_or_resolve_and_continue() {
    for action in [HistoryAction::CherryPick, HistoryAction::Revert] {
        let (dir, mut git) = setup().await;
        let feature = diverge(&git, true).await;
        let target = match action {
            HistoryAction::Revert => {
                let target = git.repository().await.unwrap().head.unwrap();
                write_commit(&git, "shared.txt", "later\n", "later change").await;
                target
            }
            _ => feature,
        };
        let operation = request(&git, action, &target).await;
        let before = fs::read(dir.path().join("shared.txt")).unwrap();
        assert!(git.start_history(operation.clone()).await.is_err());
        let id = operation_id(&git).await;
        git.merge_operation(id, "abort".into()).await.unwrap();
        assert_eq!(fs::read(dir.path().join("shared.txt")).unwrap(), before);
        assert_eq!(
            git.repository().await.unwrap().head.as_deref(),
            Some(operation.expected_head.as_str())
        );
        assert!(git.start_history(operation).await.is_err());
        let document =
            serde_json::to_value(git.open_merge("shared.txt".into()).await.unwrap()).unwrap();
        git.save_merge(SaveMerge {
            id: document["id"].as_str().unwrap().to_owned(),
            choice: "right".into(),
            finish: true,
            progress: None,
        })
        .await
        .unwrap();
        let id = operation_id(&git).await;
        git.merge_operation(id, "continue".into()).await.unwrap();
        assert_eq!(git.repository().await.unwrap().operation, "none");
        assert!(git.status().await.unwrap().changes.is_empty());
    }
}

#[tokio::test]
async fn merge_commits_require_an_explicit_valid_mainline() {
    let (dir, git) = setup().await;
    let base = git.repository().await.unwrap().head.unwrap();
    diverge(&git, false).await;
    git.start_history(request(&git, HistoryAction::Merge, "refs/heads/feature").await)
        .await
        .unwrap();
    let merge = git.repository().await.unwrap().head.unwrap();
    run(dir.path(), &["switch", "-c", "pick-target", &base]);
    let mut pick = request(&git, HistoryAction::CherryPick, &merge).await;
    assert!(git
        .start_history(pick.clone())
        .await
        .unwrap_err()
        .contains("主线"));
    pick.mainline = Some(3);
    assert!(git
        .start_history(pick.clone())
        .await
        .unwrap_err()
        .contains("主线"));
    pick.mainline = Some(1);
    git.start_history(pick).await.unwrap();
    assert_eq!(run(dir.path(), &["show", "HEAD:feature.txt"]), "feature\n");
    let mut revert = request(&git, HistoryAction::Revert, &merge).await;
    revert.mainline = Some(1);
    git.start_history(revert).await.unwrap();
    assert!(!dir.path().join("feature.txt").exists());
}

#[tokio::test]
async fn comparison_is_a_read_only_snapshot_with_renames_deletions_and_binary_files() {
    let (dir, git) = setup().await;
    write_commit(
        &git,
        "old name.txt",
        "renamed content\n",
        "add renamed file",
    )
    .await;
    write_commit(&git, "delete.txt", "delete me\n", "add deleted file").await;
    git.create_branch("feature").await.unwrap();
    run(dir.path(), &["mv", "old name.txt", "new name.txt"]);
    run(dir.path(), &["rm", "delete.txt"]);
    fs::write(dir.path().join("空 格.txt"), "你好\n").unwrap();
    fs::write(dir.path().join("binary.dat"), [0, 1, 2]).unwrap();
    fs::write(dir.path().join("large.txt"), vec![b'x'; MAX_FILE + 1]).unwrap();
    git.stage(
        vec!["空 格.txt".into(), "binary.dat".into(), "large.txt".into()],
        false,
    )
    .await
    .unwrap();
    git.commit("feature changes").await.unwrap();
    git.checkout("refs/heads/main").await.unwrap();
    write_commit(&git, "main.txt", "main\n", "main changes").await;
    let comparison = git.compare_branch("refs/heads/feature").await.unwrap();
    assert_eq!((comparison.base_only, comparison.target_only), (1, 1));
    assert!(comparison
        .changes
        .iter()
        .any(|change| change.old_path.as_deref() == Some("old name.txt")));
    run(dir.path(), &["branch", "-f", "feature", "main"]);
    for change in &comparison.changes {
        let diff = git
            .diff(DiffRequest {
                path: change.path.clone(),
                old_path: change.old_path.clone(),
                revision: Some(comparison.target.clone()),
                before_revision: Some(comparison.base.clone()),
                area: None,
            })
            .await
            .unwrap();
        match change.path.as_str() {
            "new name.txt" => assert_eq!(diff.before, diff.after),
            "delete.txt" => assert_eq!(
                (diff.before.as_str(), diff.after.as_str()),
                ("delete me\n", "")
            ),
            "空 格.txt" => assert_eq!(diff.after, "你好\n"),
            "binary.dat" => assert!(diff.binary),
            "large.txt" => assert!(diff.too_large),
            _ => {}
        }
    }
    assert_eq!(
        git.repository().await.unwrap().head.as_deref(),
        Some(comparison.base.as_str())
    );
    assert!(git.status().await.unwrap().changes.is_empty());
    assert!(git.compare_branch("--all").await.is_err());
}

#[tokio::test]
async fn an_empty_cherry_pick_can_be_skipped_without_changing_head() {
    let (_dir, mut git) = setup().await;
    let target = write_commit(&git, "added.txt", "already present\n", "existing change").await;
    assert!(git
        .start_history(request(&git, HistoryAction::CherryPick, &target).await)
        .await
        .is_err());
    assert_eq!(git.repository().await.unwrap().operation, "cherry-pick");
    git.merge_operation(operation_id(&git).await, "skip".into())
        .await
        .unwrap();
    assert_eq!(git.repository().await.unwrap().head.unwrap(), target);
    assert_eq!(git.repository().await.unwrap().operation, "none");
    assert!(git.status().await.unwrap().changes.is_empty());
}

#[tokio::test]
async fn commit_hook_failure_keeps_cherry_pick_state_for_retry() {
    let (dir, mut git) = setup().await;
    let target = diverge(&git, false).await;
    let hook = dir.path().join(".git/hooks/prepare-commit-msg");
    fs::write(&hook, "#!/bin/sh\necho rejected-by-hook >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let operation = request(&git, HistoryAction::CherryPick, &target).await;
    assert!(git
        .start_history(operation.clone())
        .await
        .unwrap_err()
        .contains("rejected-by-hook"));
    assert_eq!(
        git.repository().await.unwrap().head.as_deref(),
        Some(operation.expected_head.as_str())
    );
    assert_eq!(run(dir.path(), &["show", ":feature.txt"]), "feature\n");
    assert_eq!(git.repository().await.unwrap().operation, "cherry-pick");
    fs::remove_file(hook).unwrap();
    git.merge_operation(operation_id(&git).await, "continue".into())
        .await
        .unwrap();
    assert_eq!(git.repository().await.unwrap().operation, "none");
    assert!(git.status().await.unwrap().changes.is_empty());
}

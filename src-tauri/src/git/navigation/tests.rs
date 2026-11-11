use super::super::tests::{fixture, run};
use super::*;
use tempfile::TempDir;

async fn setup() -> (TempDir, Git, String, String) {
    let dir = fixture();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    fs::write(dir.path().join("shared.txt"), "base\n").unwrap();
    git.stage(vec!["shared.txt".into()], false).await.unwrap();
    git.commit("base").await.unwrap();
    let base = git.head().await.unwrap().unwrap();
    fs::write(dir.path().join("shared.txt"), "head\n").unwrap();
    git.stage(vec!["shared.txt".into()], false).await.unwrap();
    git.commit("head").await.unwrap();
    let head = git.head().await.unwrap().unwrap();
    (dir, git, base, head)
}

fn request(
    preview: NavigationPreview,
    mode: ResetMode,
    strategy: LocalStrategy,
) -> NavigationRequest {
    NavigationRequest {
        preview,
        mode,
        strategy,
        new_branch: None,
    }
}

async fn dirty(git: &Git) {
    fs::write(git.root.join("shared.txt"), "staged\n").unwrap();
    git.stage(vec!["shared.txt".into()], false).await.unwrap();
    fs::write(git.root.join("shared.txt"), "unstaged\n").unwrap();
    fs::write(git.root.join("空 格.txt"), "untracked\n").unwrap();
}

#[tokio::test]
async fn four_reset_modes_follow_native_head_index_and_worktree_semantics() {
    for mode in [
        ResetMode::Soft,
        ResetMode::Mixed,
        ResetMode::Hard,
        ResetMode::Keep,
    ] {
        let (dir, git, base, old) = setup().await;
        dirty(&git).await;
        let preview = git
            .preview_navigation(&base, NavigationAction::Reset)
            .await
            .unwrap();
        assert_eq!(preview.leaving_count, 1);
        assert_eq!(preview.local_changes.len(), 2);
        let result = git
            .execute_navigation(request(preview, mode, LocalStrategy::Normal))
            .await
            .unwrap();
        if matches!(mode, ResetMode::Keep) {
            assert!(!result.completed);
            assert_eq!(git.head().await.unwrap().unwrap(), old);
            assert_eq!(run(dir.path(), &["show", ":shared.txt"]), "staged\n");
            assert_eq!(
                fs::read_to_string(dir.path().join("shared.txt")).unwrap(),
                "unstaged\n"
            );
        } else {
            assert!(result.completed, "{}", result.message);
            assert_eq!(git.head().await.unwrap().unwrap(), base);
            assert_eq!(
                run(dir.path(), &["show", ":shared.txt"]),
                if matches!(mode, ResetMode::Soft) {
                    "staged\n"
                } else {
                    "base\n"
                }
            );
            assert_eq!(
                fs::read_to_string(dir.path().join("shared.txt")).unwrap(),
                if matches!(mode, ResetMode::Hard) {
                    "base\n"
                } else {
                    "unstaged\n"
                }
            );
        }
        assert_eq!(
            fs::read_to_string(dir.path().join("空 格.txt")).unwrap(),
            "untracked\n"
        );
    }
}

#[tokio::test]
async fn keep_preserves_nonoverlapping_local_modifications() {
    let (dir, git, _, _) = setup().await;
    fs::write(dir.path().join("other.txt"), "original\n").unwrap();
    git.stage(vec!["other.txt".into()], false).await.unwrap();
    git.commit("other").await.unwrap();
    let target = git.head().await.unwrap().unwrap();
    fs::write(dir.path().join("branch-only.txt"), "current\n").unwrap();
    git.stage(vec!["branch-only.txt".into()], false)
        .await
        .unwrap();
    git.commit("branch-only").await.unwrap();
    fs::write(dir.path().join("shared.txt"), "keep local\n").unwrap();
    let preview = git
        .preview_navigation(&target, NavigationAction::Reset)
        .await
        .unwrap();
    assert!(
        git.execute_navigation(request(preview, ResetMode::Keep, LocalStrategy::Normal))
            .await
            .unwrap()
            .completed
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("shared.txt")).unwrap(),
        "keep local\n"
    );
}

#[tokio::test]
async fn checkout_supports_detached_tag_sha_and_branch_creation_with_carried_changes() {
    let (dir, git, base, head) = setup().await;
    run(dir.path(), &["tag", "-a", "v1", "-m", "tag", &base]);
    fs::write(dir.path().join("new.txt"), "carry\n").unwrap();
    for target in ["refs/tags/v1", &head[..10]] {
        let preview = git
            .preview_navigation(target, NavigationAction::Checkout)
            .await
            .unwrap();
        assert!(
            git.execute_navigation(request(preview, ResetMode::Mixed, LocalStrategy::Normal))
                .await
                .unwrap()
                .completed
        );
        assert!(git.repository().await.unwrap().branch.is_none());
        assert_eq!(
            fs::read_to_string(dir.path().join("new.txt")).unwrap(),
            "carry\n"
        );
    }
    let preview = git
        .preview_navigation(&base, NavigationAction::Checkout)
        .await
        .unwrap();
    let mut operation = request(preview, ResetMode::Mixed, LocalStrategy::Normal);
    operation.new_branch = Some("feature/from-commit".into());
    assert!(git.execute_navigation(operation).await.unwrap().completed);
    assert_eq!(
        git.repository().await.unwrap().branch.as_deref(),
        Some("feature/from-commit")
    );
}

#[tokio::test]
async fn checkout_reports_overwritten_files_and_force_requires_explicit_strategy() {
    let (dir, git, base, _) = setup().await;
    dirty(&git).await;
    let preview = git
        .preview_navigation(&base, NavigationAction::Checkout)
        .await
        .unwrap();
    let blocked = git
        .execute_navigation(request(
            preview.clone(),
            ResetMode::Mixed,
            LocalStrategy::Normal,
        ))
        .await
        .unwrap();
    assert_eq!(blocked.kind, "overwrite");
    assert!(blocked.blocked_files.contains(&"shared.txt".into()));
    assert_eq!(
        fs::read_to_string(dir.path().join("shared.txt")).unwrap(),
        "unstaged\n"
    );
    assert!(
        git.execute_navigation(request(preview, ResetMode::Mixed, LocalStrategy::Force))
            .await
            .unwrap()
            .completed
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("shared.txt")).unwrap(),
        "base\n"
    );
}

#[tokio::test]
async fn checkout_backup_restores_index_layout_and_untracked_files() {
    let (dir, git, _, head) = setup().await;
    run(dir.path(), &["branch", "other", &head]);
    dirty(&git).await;
    let preview = git
        .preview_navigation("refs/heads/other", NavigationAction::Checkout)
        .await
        .unwrap();
    let result = git
        .execute_navigation(request(preview, ResetMode::Mixed, LocalStrategy::Backup))
        .await
        .unwrap();
    assert!(result.completed, "{}", result.message);
    let record = result.record.unwrap();
    assert_eq!(record.phase, "completed");
    assert!(record.stash_sha.is_some());
    assert_eq!(run(dir.path(), &["show", ":shared.txt"]), "staged\n");
    assert_eq!(
        fs::read_to_string(dir.path().join("shared.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("空 格.txt")).unwrap(),
        "untracked\n"
    );
    assert!(git.recover_navigation(&record.id, "restore").await.is_err());
}

#[tokio::test]
async fn hard_backup_includes_only_threatened_ignored_files_and_recovers_after_restart() {
    let (dir, git, base, _) = setup().await;
    fs::write(dir.path().join("collision.txt"), "target\n").unwrap();
    git.stage(vec!["collision.txt".into()], false)
        .await
        .unwrap();
    git.commit("target").await.unwrap();
    let target = git.head().await.unwrap().unwrap();
    run(dir.path(), &["reset", "--hard", &base]);
    fs::write(
        dir.path().join(".gitignore"),
        "collision.txt\nother-cache.txt\n",
    )
    .unwrap();
    fs::write(dir.path().join("collision.txt"), "ignored original\n").unwrap();
    fs::write(dir.path().join("other-cache.txt"), "untouched\n").unwrap();
    dirty(&git).await;
    let preview = git
        .preview_navigation(&target, NavigationAction::Reset)
        .await
        .unwrap();
    assert_eq!(preview.untracked_overwrites, vec!["collision.txt"]);
    let result = git
        .execute_navigation(request(preview, ResetMode::Hard, LocalStrategy::Backup))
        .await
        .unwrap();
    assert!(result.completed, "{}", result.message);
    let record = result.record.unwrap();
    assert_eq!(record.phase, "backup-ready");
    assert_eq!(
        fs::read_to_string(dir.path().join("collision.txt")).unwrap(),
        "target\n"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("other-cache.txt")).unwrap(),
        "untouched\n"
    );
    let reopened = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    assert_eq!(
        reopened.recovery_overview().await.unwrap().records[0].stash_sha,
        record.stash_sha
    );
    run(dir.path(), &["reset", "--hard", &base]);
    reopened
        .recover_navigation(&record.id, "restore")
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("collision.txt")).unwrap(),
        "ignored original\n"
    );
    assert_eq!(run(dir.path(), &["show", ":shared.txt"]), "staged\n");
    assert_eq!(
        fs::read_to_string(dir.path().join("shared.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("other-cache.txt")).unwrap(),
        "untouched\n"
    );
}

#[tokio::test]
async fn checkout_restore_failure_is_an_independent_persistent_phase() {
    let (dir, git, base, _) = setup().await;
    dirty(&git).await;
    let preview = git
        .preview_navigation(&base, NavigationAction::Checkout)
        .await
        .unwrap();
    let result = git
        .execute_navigation(request(preview, ResetMode::Mixed, LocalStrategy::Backup))
        .await
        .unwrap();
    assert_eq!(result.kind, "restore");
    assert_eq!(git.head().await.unwrap().unwrap(), base);
    let record = result.record.unwrap();
    assert_eq!(record.phase, "restore-blocked");
    let reopened = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let recovered = reopened.recovery_overview().await.unwrap();
    assert_eq!(recovered.records[0].phase, "restore-blocked");
    assert!(recovered.records[0].stash_sha.is_some());
    assert!(reopened
        .status()
        .await
        .unwrap()
        .stashes
        .iter()
        .any(|s| Some(&s.hash) == record.stash_sha.as_ref()));
}

#[tokio::test]
async fn preview_rejects_changes_to_contents_head_target_and_repository() {
    let (dir, git, base, _) = setup().await;
    dirty(&git).await;
    let preview = git
        .preview_navigation(&base, NavigationAction::Reset)
        .await
        .unwrap();
    fs::write(
        dir.path().join("空 格.txt"),
        "same status, different contents\n",
    )
    .unwrap();
    assert!(git
        .execute_navigation(request(preview, ResetMode::Hard, LocalStrategy::Normal))
        .await
        .unwrap_err()
        .contains("重新预览"));
    let mut preview = git
        .preview_navigation(&base, NavigationAction::Reset)
        .await
        .unwrap();
    preview.root = "another repository".into();
    assert!(git
        .execute_navigation(request(preview, ResetMode::Hard, LocalStrategy::Normal))
        .await
        .is_err());
    let preview = git
        .preview_navigation("refs/heads/main", NavigationAction::Reset)
        .await
        .unwrap();
    run(dir.path(), &["update-ref", "refs/heads/main", &base]);
    assert!(git
        .execute_navigation(request(preview, ResetMode::Hard, LocalStrategy::Normal))
        .await
        .is_err());
}

#[tokio::test]
async fn remote_names_are_explicit_and_existing_local_branches_are_selectable() {
    let (dir, git, base, head) = setup().await;
    for remote in ["origin", "upstream"] {
        run(
            dir.path(),
            &["config", &format!("remote.{remote}.url"), "."],
        );
        run(
            dir.path(),
            &[
                "config",
                &format!("remote.{remote}.fetch"),
                &format!("+refs/heads/*:refs/remotes/{remote}/*"),
            ],
        );
        run(
            dir.path(),
            &[
                "update-ref",
                &format!("refs/remotes/{remote}/feature"),
                &base,
            ],
        );
    }
    run(dir.path(), &["branch", "feature", &head]);
    let preview = git
        .preview_navigation("refs/remotes/origin/feature", NavigationAction::Checkout)
        .await
        .unwrap();
    assert_eq!(preview.local_branches, vec!["refs/heads/feature"]);
    assert!(git
        .execute_navigation(request(
            preview.clone(),
            ResetMode::Mixed,
            LocalStrategy::Normal
        ))
        .await
        .is_err());
    let mut operation = request(preview, ResetMode::Mixed, LocalStrategy::Normal);
    operation.new_branch = Some("origin-feature".into());
    assert!(git.execute_navigation(operation).await.unwrap().completed);
    assert_eq!(
        run(
            dir.path(),
            &["rev-parse", "--symbolic-full-name", "@{upstream}"]
        )
        .trim(),
        "refs/remotes/origin/feature"
    );
    let preview = git
        .preview_navigation("refs/heads/feature", NavigationAction::Checkout)
        .await
        .unwrap();
    assert_eq!(preview.target_hash, head);
    assert!(
        git.execute_navigation(request(preview, ResetMode::Mixed, LocalStrategy::Normal))
            .await
            .unwrap()
            .completed
    );
}

#[tokio::test]
async fn occupied_worktree_is_reported_before_any_change() {
    let (dir, git, _, head) = setup().await;
    let other = tempfile::tempdir().unwrap();
    run(
        dir.path(),
        &[
            "worktree",
            "add",
            "-b",
            "occupied",
            other.path().to_str().unwrap(),
            &head,
        ],
    );
    let preview = git
        .preview_navigation("refs/heads/occupied", NavigationAction::Checkout)
        .await
        .unwrap();
    assert!(preview.worktree_path.is_some());
    let result = git
        .execute_navigation(request(preview, ResetMode::Mixed, LocalStrategy::Backup))
        .await
        .unwrap();
    assert_eq!(result.kind, "worktree");
    assert!(result.record.is_none());
    assert_eq!(git.head().await.unwrap().unwrap(), head);
}

#[tokio::test]
async fn interrupted_backup_save_is_rediscovered_by_operation_id_and_not_reapplied() {
    let (dir, git, _, head) = setup().await;
    let mut record = OperationRecord {
        id: "crash-save".into(),
        action: NavigationAction::Checkout,
        original_head: Some(head.clone()),
        original_branch: Some("main".into()),
        target_hash: head,
        phase: "saving".into(),
        stash_sha: None,
        error: None,
        failure_kind: None,
        blocked_files: vec![],
    };
    git.save_record(&record).await.unwrap();
    dirty(&git).await;
    git.save_stash("IdeaGitTool operation crash-save")
        .await
        .unwrap();
    let reopened = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let recovery = reopened.recovery_overview().await.unwrap();
    assert_eq!(recovery.records[0].phase, "interrupted");
    record.stash_sha = recovery.records[0].stash_sha.clone();
    assert!(record.stash_sha.is_some());
    record.phase = "restoring".into();
    reopened.save_record(&record).await.unwrap();
    let recovery = reopened.recovery_overview().await.unwrap();
    assert_eq!(recovery.records[0].phase, "restore-blocked");
    assert!(reopened.status().await.unwrap().changes.is_empty());
}

#[tokio::test]
async fn failed_post_checkout_hook_keeps_original_head_and_backup() {
    let (dir, git, _, head) = setup().await;
    run(dir.path(), &["branch", "other", &head]);
    fs::write(
        dir.path().join(".git/hooks/post-checkout"),
        "#!/bin/sh\necho 'post-checkout hook rejected' >&2\nexit 1\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            dir.path().join(".git/hooks/post-checkout"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    dirty(&git).await;
    let preview = git
        .preview_navigation("refs/heads/other", NavigationAction::Checkout)
        .await
        .unwrap();
    let result = git
        .execute_navigation(request(preview, ResetMode::Mixed, LocalStrategy::Backup))
        .await
        .unwrap();
    assert!(!result.completed);
    assert_eq!(result.kind, "hook");
    let record = result.record.unwrap();
    assert_eq!(record.original_head.as_deref(), Some(head.as_str()));
    assert!(record.stash_sha.is_some());
    assert_eq!(run(dir.path(), &["show", ":shared.txt"]), "staged\n");
}

#[tokio::test]
async fn reflog_and_recovery_branch_find_commits_after_reset() {
    let (dir, git, base, old) = setup().await;
    let preview = git
        .preview_navigation(&base, NavigationAction::Reset)
        .await
        .unwrap();
    git.execute_navigation(request(preview, ResetMode::Hard, LocalStrategy::Normal))
        .await
        .unwrap();
    assert!(git.reflog().await.unwrap().iter().any(|e| e.hash == old));
    git.create_recovery_branch("recovery/original", &old)
        .await
        .unwrap();
    assert_eq!(
        run(dir.path(), &["rev-parse", "recovery/original"]).trim(),
        old
    );
    assert_eq!(git.head().await.unwrap().unwrap(), base);
}

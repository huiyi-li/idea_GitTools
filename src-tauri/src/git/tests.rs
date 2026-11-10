use super::*;
use std::fs;
use std::process::Command as SyncCommand;
use tempfile::TempDir;

fn run(root: &Path, args: &[&str]) -> String {
    let output = SyncCommand::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn fixture() -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    run(dir.path(), &["init", "-b", "main"]);
    run(dir.path(), &["config", "user.name", "Desktop Test"]);
    run(
        dir.path(),
        &["config", "user.email", "desktop@example.test"],
    );
    run(dir.path(), &["config", "commit.gpgSign", "false"]);
    run(dir.path(), &["config", "core.autocrlf", "false"]);
    run(dir.path(), &["config", "core.hooksPath", ".git/hooks"]);
    dir
}

async fn open(dir: &TempDir) -> Git {
    Git::open(dir.path().to_str().unwrap(), None).await.unwrap()
}

fn query() -> LogQuery {
    LogQuery {
        offset: 0,
        search: String::new(),
        branch: String::new(),
    }
}

fn request(path: &str) -> DiffRequest {
    DiffRequest {
        path: path.into(),
        old_path: None,
        revision: None,
    }
}

#[tokio::test]
async fn unborn_repository_stage_unstage_and_first_commit() {
    let dir = fixture();
    let git = open(&dir).await;
    assert!(git.repository().await.unwrap().head.is_none());
    assert!(git.log(query()).await.unwrap().commits.is_empty());
    fs::write(dir.path().join("空 格.txt"), "first\n").unwrap();
    let status = git.status().await.unwrap();
    assert_eq!(status.changes[0].path, "空 格.txt");
    assert_eq!(
        git.diff(request("空 格.txt")).await.unwrap().after,
        "first\n"
    );
    git.stage(vec!["空 格.txt".into()], false).await.unwrap();
    git.stage(vec!["空 格.txt".into()], true).await.unwrap();
    assert_eq!(git.status().await.unwrap().changes[0].index, '?');
    assert!(dir.path().join("空 格.txt").exists());
    git.stage(vec!["空 格.txt".into()], false).await.unwrap();
    git.commit("initial\n\n正文").await.unwrap();
    assert!(git.status().await.unwrap().changes.is_empty());
    let page = git.log(query()).await.unwrap();
    assert_eq!(page.commits.len(), 1);
    assert!(page.commits[0].parents.is_empty());
    let details = git.details(&page.commits[0].hash).await.unwrap();
    assert!(details.body.contains("正文"));
    assert_eq!(details.changes[0].path, "空 格.txt");
}

#[tokio::test]
async fn commit_only_staged_content_and_preserve_unstaged_edits() {
    let dir = fixture();
    let git = open(&dir).await;
    fs::write(dir.path().join("file.txt"), "first\n").unwrap();
    git.stage(vec!["file.txt".into()], false).await.unwrap();
    git.commit("initial").await.unwrap();
    fs::write(dir.path().join("file.txt"), "staged\n").unwrap();
    git.stage(vec!["file.txt".into()], false).await.unwrap();
    fs::write(dir.path().join("file.txt"), "unstaged\n").unwrap();
    fs::write(dir.path().join("other.txt"), "untracked\n").unwrap();
    git.commit("staged only").await.unwrap();
    assert_eq!(run(dir.path(), &["show", "HEAD:file.txt"]), "staged\n");
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(git.status().await.unwrap().changes.len(), 2);
    let diff = git.diff(request("file.txt")).await.unwrap();
    assert_eq!(diff.before, "staged\n");
    assert_eq!(diff.after, "unstaged\n");
    assert!(git
        .commit("no staged changes")
        .await
        .unwrap_err()
        .contains("Stage changes"));
}

#[tokio::test]
async fn rename_and_delete_diffs_include_previous_content() {
    let dir = fixture();
    let git = open(&dir).await;
    fs::write(dir.path().join("old.txt"), "old content\n").unwrap();
    git.stage(vec!["old.txt".into()], false).await.unwrap();
    git.commit("initial").await.unwrap();
    run(dir.path(), &["mv", "old.txt", "new.txt"]);
    let change = git.status().await.unwrap().changes.remove(0);
    assert_eq!(change.old_path.as_deref(), Some("old.txt"));
    let diff = git
        .diff(DiffRequest {
            path: change.path.clone(),
            old_path: change.old_path,
            revision: None,
        })
        .await
        .unwrap();
    assert_eq!(diff.before, diff.after);
    git.commit("rename").await.unwrap();
    let hash = git.repository().await.unwrap().head.unwrap();
    let change = git.details(&hash).await.unwrap().changes.remove(0);
    assert_eq!(change.old_path.as_deref(), Some("old.txt"));
    let historical = git
        .diff(DiffRequest {
            path: change.path,
            old_path: change.old_path,
            revision: Some(hash),
        })
        .await
        .unwrap();
    assert_eq!(historical.before, "old content\n");
    assert_eq!(historical.after, "old content\n");
    fs::remove_file(dir.path().join("new.txt")).unwrap();
    assert!(git.diff(request("new.txt")).await.unwrap().after.is_empty());
    git.stage(vec!["new.txt".into()], false).await.unwrap();
    git.stage(vec!["new.txt".into()], true).await.unwrap();
    assert_eq!(git.status().await.unwrap().changes[0].work_tree, 'D');
}

#[tokio::test]
async fn log_handles_empty_decorations_search_and_detached_head() {
    let dir = fixture();
    let git = open(&dir).await;
    for i in 0..3 {
        fs::write(dir.path().join("file.txt"), format!("{i}\n")).unwrap();
        git.stage(vec!["file.txt".into()], false).await.unwrap();
        git.commit(&format!("message {i}")).await.unwrap();
    }
    let page = git.log(query()).await.unwrap();
    assert_eq!(page.commits.len(), 3);
    assert!(page.commits[1].refs.is_empty());
    assert!(page.commits[2].parents.is_empty());
    let mut search = query();
    search.search = "message 1".into();
    assert_eq!(git.log(search).await.unwrap().commits.len(), 1);
    run(dir.path(), &["switch", "--detach", "HEAD~1"]);
    assert!(git.repository().await.unwrap().branch.is_none());
    assert_eq!(git.log(query()).await.unwrap().commits.len(), 3);
}

#[tokio::test]
async fn branches_and_stash_round_trip() {
    let dir = fixture();
    let git = open(&dir).await;
    fs::write(dir.path().join("file.txt"), "initial\n").unwrap();
    git.stage(vec!["file.txt".into()], false).await.unwrap();
    git.commit("initial").await.unwrap();
    git.create_branch("feature/test").await.unwrap();
    assert_eq!(
        git.repository().await.unwrap().branch.as_deref(),
        Some("feature/test")
    );
    git.checkout("refs/heads/main").await.unwrap();
    assert_eq!(
        git.repository().await.unwrap().branch.as_deref(),
        Some("main")
    );
    assert!(git.create_branch("--bad").await.is_err());
    fs::write(dir.path().join("new file.txt"), "stash me\n").unwrap();
    git.save_stash("saved work").await.unwrap();
    let status = git.status().await.unwrap();
    assert!(status.changes.is_empty(), "{:?}", status.changes);
    assert_eq!(status.stashes.len(), 1);
    assert!(status.stashes[0].message.contains("saved work"));
    git.apply_stash(&status.stashes[0].hash).await.unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("new file.txt")).unwrap(),
        "stash me\n"
    );
    assert_eq!(git.status().await.unwrap().stashes.len(), 1);
}

#[tokio::test]
async fn binary_large_file_and_literal_pathspecs() {
    let dir = fixture();
    let git = open(&dir).await;
    fs::write(dir.path().join("binary.bin"), [0, 1, 2]).unwrap();
    assert!(git.diff(request("binary.bin")).await.unwrap().binary);
    fs::write(dir.path().join("large.txt"), vec![b'x'; MAX_FILE + 1]).unwrap();
    assert!(git.diff(request("large.txt")).await.unwrap().too_large);
    fs::write(
        dir.path().join("many-lines.txt"),
        vec![b'\n'; MAX_LINES + 1],
    )
    .unwrap();
    assert!(git.diff(request("many-lines.txt")).await.unwrap().too_large);
    fs::write(dir.path().join("[test].txt"), "literal\n").unwrap();
    fs::write(dir.path().join("t.txt"), "other\n").unwrap();
    git.stage(vec!["[test].txt".into()], false).await.unwrap();
    let status = git.status().await.unwrap();
    assert_eq!(
        status
            .changes
            .iter()
            .find(|c| c.path == "[test].txt")
            .unwrap()
            .index,
        'A'
    );
    assert_eq!(
        status
            .changes
            .iter()
            .find(|c| c.path == "t.txt")
            .unwrap()
            .index,
        '?'
    );
    assert!(git.diff(request("../outside")).await.is_err());
    assert!(git.diff(request("/absolute")).await.is_err());
    assert!(git.details("--help").await.is_err());
    git.commit("literal filename").await.unwrap();
    fs::write(dir.path().join("[test].txt"), "updated\n").unwrap();
    let literal_diff = git.diff(request("[test].txt")).await.unwrap();
    assert_eq!(literal_diff.before, "literal\n");
    assert_eq!(literal_diff.after, "updated\n");
}

#[tokio::test]
async fn rejected_commit_keeps_index_and_worktree() {
    let dir = fixture();
    let git = open(&dir).await;
    fs::write(dir.path().join("file.txt"), "initial\n").unwrap();
    git.stage(vec!["file.txt".into()], false).await.unwrap();
    fs::write(
        dir.path().join(".git/hooks/pre-commit"),
        "#!/bin/sh\necho rejected >&2\nexit 1\n",
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
        .commit("reject me")
        .await
        .unwrap_err()
        .contains("rejected"));
    assert!(git.repository().await.unwrap().head.is_none());
    assert_eq!(git.status().await.unwrap().changes[0].index, 'A');
    assert_eq!(
        fs::read_to_string(dir.path().join("file.txt")).unwrap(),
        "initial\n"
    );
}

#[tokio::test]
async fn bounded_log_pages_have_no_gaps_or_duplicates() {
    use std::io::Write;
    let dir = fixture();
    let mut input = String::new();
    for index in 0..205 {
        let message = format!("commit {index}");
        input.push_str(&format!(
            "commit refs/heads/main\ncommitter Desktop Test <desktop@example.test> {} +0000\ndata {}\n{}\n\n",
            1_700_000_000 + index, message.len(), message
        ));
    }
    let mut child = SyncCommand::new("git")
        .args(["fast-import", "--quiet"])
        .current_dir(dir.path())
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let git = open(&dir).await;
    let first = git.log(query()).await.unwrap();
    assert_eq!(first.commits.len(), PAGE_SIZE);
    assert!(first.has_more);
    let mut next = query();
    next.offset = PAGE_SIZE;
    let second = git.log(next).await.unwrap();
    assert_eq!(second.commits.len(), 5);
    assert!(!second.has_more);
    assert_eq!(
        first.commits.last().unwrap().parents[0],
        second.commits[0].hash
    );
    assert_eq!(second.commits.last().unwrap().subject, "commit 0");
}

#[tokio::test]
async fn merge_details_compare_to_first_parent() {
    let dir = fixture();
    let git = open(&dir).await;
    fs::write(dir.path().join("main.txt"), "main\n").unwrap();
    git.stage(vec!["main.txt".into()], false).await.unwrap();
    git.commit("initial").await.unwrap();
    git.create_branch("feature").await.unwrap();
    fs::write(dir.path().join("feature.txt"), "feature\n").unwrap();
    git.stage(vec!["feature.txt".into()], false).await.unwrap();
    git.commit("feature").await.unwrap();
    git.checkout("refs/heads/main").await.unwrap();
    run(
        dir.path(),
        &["merge", "--no-ff", "-m", "merge feature", "feature"],
    );
    let head = git.repository().await.unwrap().head.unwrap();
    let details = git.details(&head).await.unwrap();
    assert_eq!(details.commit.parents.len(), 2);
    assert_eq!(details.changes.len(), 1);
    assert_eq!(details.changes[0].path, "feature.txt");
    let diff = git
        .diff(DiffRequest {
            path: "feature.txt".into(),
            old_path: None,
            revision: Some(head),
        })
        .await
        .unwrap();
    assert!(diff.before.is_empty());
    assert_eq!(diff.after, "feature\n");
}

#[tokio::test]
async fn remote_operations_and_tracking_checkout_use_local_remote() {
    let dir = fixture();
    let remote = tempfile::tempdir().unwrap();
    run(remote.path(), &["init", "--bare"]);
    let git = open(&dir).await;
    fs::write(dir.path().join("main.txt"), "main\n").unwrap();
    git.stage(vec!["main.txt".into()], false).await.unwrap();
    git.commit("initial").await.unwrap();
    run(
        dir.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    run(dir.path(), &["push", "-u", "origin", "main"]);
    git.remote_action("fetch").await.unwrap();
    git.remote_action("pull").await.unwrap();
    git.remote_action("push").await.unwrap();
    git.create_branch("tracking-test").await.unwrap();
    run(dir.path(), &["push", "-u", "origin", "tracking-test"]);
    git.checkout("refs/heads/main").await.unwrap();
    run(dir.path(), &["branch", "-D", "tracking-test"]);
    git.checkout("refs/remotes/origin/tracking-test")
        .await
        .unwrap();
    assert_eq!(
        git.repository().await.unwrap().branch.as_deref(),
        Some("tracking-test")
    );
    let status = git.status().await.unwrap();
    assert_eq!(
        status.branches.iter().find(|b| b.current).unwrap().upstream,
        "origin/tracking-test"
    );
}

#[tokio::test]
async fn opens_linked_worktree_from_nested_directory() {
    let dir = fixture();
    let git = open(&dir).await;
    fs::write(dir.path().join("file.txt"), "main\n").unwrap();
    git.stage(vec!["file.txt".into()], false).await.unwrap();
    git.commit("initial").await.unwrap();
    let parent = tempfile::tempdir().unwrap();
    let worktree = parent.path().join("工作 目录");
    run(
        dir.path(),
        &[
            "worktree",
            "add",
            "-b",
            "linked",
            worktree.to_str().unwrap(),
        ],
    );
    let nested = worktree.join("nested");
    fs::create_dir(&nested).unwrap();
    let linked = Git::open(nested.to_str().unwrap(), None).await.unwrap();
    assert_eq!(linked.root, worktree.canonicalize().unwrap());
    assert_eq!(
        linked.repository().await.unwrap().branch.as_deref(),
        Some("linked")
    );
    fs::write(worktree.join("file.txt"), "linked edit\n").unwrap();
    assert_eq!(
        linked.diff(request("file.txt")).await.unwrap().before,
        "main\n"
    );
    assert_eq!(linked.status().await.unwrap().changes.len(), 1);
    assert!(git.status().await.unwrap().changes.is_empty());
}

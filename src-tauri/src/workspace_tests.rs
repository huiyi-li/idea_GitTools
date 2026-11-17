use super::{discover, inspect_directory, WorkspaceRepositories, MAX_REPOSITORIES, MAX_WARNINGS};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tempfile::TempDir;
use tokio::process::Command;

async fn run(mut command: Command) {
    command.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .expect("workspace fixture command timed out")
        .expect("workspace fixture command could not start");
    assert!(output.stdout.len() + output.stderr.len() < 1024 * 1024);
    assert!(
        output.status.success(),
        "fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn git(dir: &Path, args: &[&str]) {
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "user.email=workspace-tests@example.invalid",
            "-c",
            "user.name=Workspace Tests",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0");
    run(command).await;
}

async fn repository(path: &Path) {
    fs::create_dir_all(path).unwrap();
    git(path, &["init", "-q", "--template="]).await;
    // Same filename and different contents must not merge repository identities.
    fs::write(path.join("README"), path.to_string_lossy().as_bytes()).unwrap();
}

fn names(result: &WorkspaceRepositories) -> Vec<String> {
    result
        .repositories
        .iter()
        .map(|repository| repository.relative_path.clone())
        .collect()
}

#[tokio::test]
async fn discovers_siblings_nested_plain_and_spaces() {
    let fixture = TempDir::new().unwrap();
    let first = fixture.path().join("same name");
    let second = fixture.path().join("other").join("same name");
    let nested = fixture.path().join("root").join("nested repo");
    repository(&first).await;
    repository(&second).await;
    repository(&nested).await;
    let before = fs::read(first.join("README")).unwrap();
    let result = discover(fixture.path().to_str().unwrap(), 4).await.unwrap();
    assert_eq!(
        names(&result),
        vec!["other/same name", "root/nested repo", "same name"]
    );
    assert!(result.repositories.iter().all(|repository| {
        PathBuf::from(&repository.root).is_absolute() && !repository.name.is_empty()
    }));
    assert_ne!(result.repositories[0].root, result.repositories[2].root);
    assert_eq!(fs::read(first.join("README")).unwrap(), before);
    assert!(!result.truncated);
    assert!(result.warnings.is_empty());
    let json = serde_json::to_value(result).unwrap();
    assert_eq!(json["repositories"][0]["relativePath"], "other/same name");
    assert!(json["repositories"][0].get("relative_path").is_none());
}

#[tokio::test]
async fn does_not_use_an_enclosing_repository_and_keeps_scanning_inside_it() {
    let fixture = TempDir::new().unwrap();
    repository(fixture.path()).await;
    repository(&fixture.path().join("nested")).await;
    let plain = fixture.path().join("plain");
    fs::create_dir(&plain).unwrap();
    let result = discover(plain.to_str().unwrap(), 4).await.unwrap();
    assert!(result.repositories.is_empty());
    let result = discover(fixture.path().to_str().unwrap(), 4).await.unwrap();
    assert_eq!(names(&result), vec![".", "nested"]);
}

#[tokio::test]
async fn incomplete_nested_git_dir_is_not_mistaken_for_a_second_repository() {
    let fixture = TempDir::new().unwrap();
    repository(fixture.path()).await;
    let nested = fixture.path().join("peripheral_examples");
    fs::create_dir_all(nested.join(".git/objects")).unwrap();
    fs::create_dir_all(nested.join(".git/refs/heads")).unwrap();
    fs::write(nested.join(".git/ORIG_HEAD"), "0".repeat(40)).unwrap();
    let inherited = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&nested)
        .output()
        .unwrap();
    assert!(inherited.status.success());
    assert_eq!(
        std::path::Path::new(std::str::from_utf8(&inherited.stdout).unwrap().trim())
            .canonicalize()
            .unwrap(),
        fixture.path().canonicalize().unwrap()
    );
    let result = discover(fixture.path().to_str().unwrap(), 1).await.unwrap();
    assert_eq!(names(&result), vec!["."]);
    assert!(result.truncated);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("peripheral_examples") && warning.contains("缺少 HEAD")));
    assert!(!nested.join(".git/HEAD").exists());
    assert!(!nested.join(".git/config").exists());
}

#[tokio::test]
async fn discovers_linked_worktree_gitfile_with_external_git_metadata() {
    let fixture = TempDir::new().unwrap();
    let main = TempDir::new().unwrap();
    let linked = fixture.path().join("linked worktree");
    repository(main.path()).await;
    git(main.path(), &["commit", "--allow-empty", "-qm", "fixture"]).await;
    git(
        main.path(),
        &["worktree", "add", "--detach", linked.to_str().unwrap()],
    )
    .await;
    let marker = fs::read_to_string(linked.join(".git")).unwrap();
    assert!(marker.starts_with("gitdir:"));
    let result = discover(fixture.path().to_str().unwrap(), 2).await.unwrap();
    assert_eq!(names(&result), vec!["linked worktree"]);
    assert!(!result.truncated);
}

#[tokio::test]
async fn plain_folder_is_not_a_repository() {
    let fixture = TempDir::new().unwrap();
    fs::create_dir(fixture.path().join("plain")).unwrap();
    let result = discover(fixture.path().to_str().unwrap(), 4).await.unwrap();
    assert!(result.repositories.is_empty());
    assert!(!result.truncated);
    assert!(result.warnings.is_empty());
}

#[tokio::test]
async fn depth_bound_is_reported_as_truncated() {
    let fixture = TempDir::new().unwrap();
    repository(fixture.path()).await;
    repository(&fixture.path().join("one").join("two")).await;
    let result = discover(fixture.path().to_str().unwrap(), 0).await.unwrap();
    assert_eq!(names(&result), vec!["."]);
    assert!(result.truncated);
    let result = discover(fixture.path().to_str().unwrap(), 1).await.unwrap();
    assert_eq!(names(&result), vec!["."]);
    assert!(result.truncated);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("depth limit")));
    let result = discover(fixture.path().to_str().unwrap(), 2).await.unwrap();
    assert_eq!(names(&result), vec![".", "one/two"]);
    assert!(!result.truncated);
}

#[tokio::test]
async fn skips_dependency_directories() {
    let fixture = TempDir::new().unwrap();
    for name in ["node_modules", "target", "dist", ".venv", "venv"] {
        repository(&fixture.path().join(name).join("hidden repository")).await;
    }
    repository(&fixture.path().join("visible")).await;
    let result = discover(fixture.path().to_str().unwrap(), 4).await.unwrap();
    assert_eq!(names(&result), vec!["visible"]);
    assert!(!result.truncated);
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn does_not_traverse_symlink_or_junction_directories() {
    let fixture = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    repository(outside.path()).await;
    let linked = fixture.path().join("linked");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), &linked).unwrap();
    #[cfg(windows)]
    if let Err(error) = std::os::windows::fs::symlink_dir(outside.path(), &linked) {
        assert!(
            matches!(error.raw_os_error(), Some(1314) | Some(5)),
            "{error}"
        );
        // Junctions need no developer-mode/admin privilege, unlike symlinks.
        let mut command = Command::new("cmd");
        command
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&linked)
            .arg(outside.path());
        run(command).await;
    }
    assert!(super::is_link(&fs::symlink_metadata(&linked).unwrap()));
    let result = discover(fixture.path().to_str().unwrap(), 4).await.unwrap();
    assert!(result.repositories.is_empty());
    assert!(discover(linked.to_str().unwrap(), 4).await.is_err());
    #[cfg(unix)]
    fs::remove_file(&linked).unwrap();
    #[cfg(windows)]
    fs::remove_dir(&linked).unwrap();
    assert!(outside.path().join(".git").is_dir());
}

#[tokio::test]
async fn rejects_depth_above_eight_and_non_directory_paths() {
    let fixture = TempDir::new().unwrap();
    let error = discover(fixture.path().to_str().unwrap(), 9)
        .await
        .unwrap_err();
    assert!(error.contains("between 0 and 8"));
    fs::write(fixture.path().join("file"), "not a directory").unwrap();
    assert!(discover(fixture.path().join("file").to_str().unwrap(), 4)
        .await
        .is_err());
    assert!(discover("", 4).await.is_err());
}

#[test]
fn directory_admission_and_warnings_are_bounded() {
    let fixture = TempDir::new().unwrap();
    for index in 0..4 {
        fs::create_dir(fixture.path().join(index.to_string())).unwrap();
    }
    let root = fixture.path().canonicalize().unwrap();
    let scan = inspect_directory(&root, &root, false, 2).unwrap();
    assert_eq!(scan.children.len(), 2);
    assert!(scan.directory_limited);
    let mut result = WorkspaceRepositories {
        root: String::new(),
        repositories: vec![],
        truncated: false,
        warnings: vec![],
    };
    for index in 0..(MAX_WARNINGS + 5) {
        result.warn(format!("warning {index}"));
    }
    assert_eq!(result.warnings.len(), MAX_WARNINGS);
    assert!(result.truncated);
    assert!(result.warnings.last().unwrap().contains("omitted"));
}

#[tokio::test]
async fn repository_limit_is_reported() {
    let fixture = TempDir::new().unwrap();
    for index in 0..(MAX_REPOSITORIES + 1) {
        repository(&fixture.path().join(format!("repo-{index:03}"))).await;
    }
    let result = discover(fixture.path().to_str().unwrap(), 1).await.unwrap();
    assert_eq!(result.repositories.len(), MAX_REPOSITORIES);
    assert!(result.truncated);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("repository limit")));
}

#[tokio::test]
async fn invalid_gitfile_cannot_escape_workspace() {
    let fixture = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    repository(outside.path()).await;
    // An ordinary repo's metadata is not a valid linked worktree for this folder.
    git(
        outside.path(),
        &["config", "core.worktree", outside.path().to_str().unwrap()],
    )
    .await;
    fs::write(
        fixture.path().join(".git"),
        format!(
            "gitdir: {}\n",
            crate::git::git_path(&outside.path().join(".git"))
        ),
    )
    .unwrap();
    let result = discover(fixture.path().to_str().unwrap(), 4).await.unwrap();
    assert!(result.repositories.is_empty());
    assert!(!result.warnings.is_empty());
}

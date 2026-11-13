mod git;
mod hosting;
mod models;
pub mod transport;
#[cfg(test)]
mod update_tests;
mod watcher;

use git::discard::{DiscardMode, DiscardPreview};
use git::history::{BranchComparison, HistoryRequest};
use git::merge::{MergeDocument, MergeOverview, SaveMerge};
use git::navigation::{
    NavigationAction, NavigationPreview, NavigationRequest, NavigationResult, RecoveryOverview,
    ReflogEntry,
};
use git::review::{CommitReview, WorktreeSnapshot};
use git::Git;
use models::*;
use tauri::Manager;
use tauri::State;
use tokio::sync::Mutex;

// One active repository and one operation at a time. A queued request carries its
// repository root, so switching repositories cannot redirect a pending write.
#[derive(Default)]
struct AppState(std::sync::Arc<Mutex<Option<Git>>>);

fn active<'a>(git: &'a Option<Git>, root: &str) -> Result<&'a Git, String> {
    git.as_ref()
        .filter(|g| g.root_string() == root)
        .ok_or_else(|| "Repository changed. Refresh and retry the operation.".into())
}

#[tauri::command]
async fn open_repository(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Status, String> {
    let mut current = state.0.lock().await;
    let mut git = Git::open(&path, Some(app.clone())).await?;
    let status = git.status().await?;
    if let Err(error) = git.start_watching().await {
        use tauri::Emitter;
        let _ = app.emit(
            "git-console",
            format!("File watcher unavailable. Use F5 to refresh. {error}"),
        );
    }
    *current = Some(git);
    Ok(status)
}

#[tauri::command]
fn initial_repository() -> Option<String> {
    std::env::args().nth(1).filter(|p| !p.starts_with('-'))
}

#[tauri::command]
fn open_release_page(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "https://github.com/huiyi-li/idea_GitTools/releases",
            None::<&str>,
        )
        .map_err(|e| format!("打开发布页失败。{e}"))
}

#[tauri::command]
async fn repository_status(root: String, state: State<'_, AppState>) -> Result<Status, String> {
    active(&*state.0.lock().await, &root)?.status().await
}

#[tauri::command]
async fn git_diagnostics(root: String, state: State<'_, AppState>) -> Result<Diagnostics, String> {
    active(&*state.0.lock().await, &root)?.diagnostics().await
}

#[tauri::command]
async fn submodules(root: String, state: State<'_, AppState>) -> Result<Vec<SubmoduleStatus>, String> {
    active(&*state.0.lock().await, &root)?.submodules().await
}

#[tauri::command]
async fn update_submodules(root: String, paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?.update_submodules(paths).await
}

#[tauri::command]
async fn bisect_status(root: String, state: State<'_, AppState>) -> Result<BisectStatus, String> {
    active(&*state.0.lock().await, &root)?.bisect_status().await
}

#[tauri::command]
async fn bisect_start(root: String, bad: String, good: String, state: State<'_, AppState>) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?.bisect_start(&bad, &good).await
}

#[tauri::command]
async fn bisect_step(root: String, action: String, state: State<'_, AppState>) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?.bisect_step(&action).await
}

#[tauri::command]
async fn bisect_reset(root: String, state: State<'_, AppState>) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?.bisect_reset().await
}

#[tauri::command]
async fn read_log(
    root: String,
    query: LogQuery,
    state: State<'_, AppState>,
) -> Result<LogPage, String> {
    active(&*state.0.lock().await, &root)?.log(query).await
}

#[tauri::command]
async fn commit_details(
    root: String,
    revision: String,
    state: State<'_, AppState>,
) -> Result<CommitDetails, String> {
    active(&*state.0.lock().await, &root)?
        .details(&revision)
        .await
}

#[tauri::command]
async fn read_diff(
    root: String,
    request: DiffRequest,
    allow_large: Option<bool>,
    state: State<'_, AppState>,
) -> Result<FileDiff, String> {
    let current = state.0.lock().await;
    let git = active(&current, &root)?;
    if allow_large.unwrap_or(false) {
        git.diff_with_options(request, true).await
    } else {
        git.diff(request).await
    }
}

#[tauri::command]
async fn read_commit_review(
    root: String,
    revision: String,
    path: String,
    allow_large: Option<bool>,
    state: State<'_, AppState>,
) -> Result<CommitReview, String> {
    let current = state.0.lock().await;
    let git = active(&current, &root)?;
    if allow_large.unwrap_or(false) {
        git.commit_review_with_options(&revision, &path, true).await
    } else {
        git.commit_review(&revision, &path).await
    }
}

#[tauri::command]
async fn read_review_worktree(
    root: String,
    path: String,
    allow_large: Option<bool>,
    state: State<'_, AppState>,
) -> Result<WorktreeSnapshot, String> {
    let current = state.0.lock().await;
    let git = active(&current, &root)?;
    if allow_large.unwrap_or(false) {
        git.review_worktree_with_options(&path, true).await
    } else {
        git.review_worktree(&path).await
    }
}

#[tauri::command]
async fn stage_paths(
    root: String,
    paths: Vec<String>,
    unstage: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .stage(paths, unstage)
        .await
}

#[tauri::command]
async fn preview_discard(
    root: String,
    paths: Vec<String>,
    mode: DiscardMode,
    state: State<'_, AppState>,
) -> Result<DiscardPreview, String> {
    active(&*state.0.lock().await, &root)?
        .preview_discard(paths, mode)
        .await
}

#[tauri::command]
async fn discard_changes(
    root: String,
    request: DiscardPreview,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .discard_changes(request)
        .await
}

#[tauri::command]
async fn create_commit(
    root: String,
    message: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    active(&*state.0.lock().await, &root)?
        .commit(&message)
        .await
}

#[tauri::command]
async fn checkout_branch(
    root: String,
    branch: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .checkout(&branch)
        .await
}

#[tauri::command]
async fn create_branch(
    root: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .create_branch(&name)
        .await
}

#[tauri::command]
async fn remote_action(
    root: String,
    action: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    active(&*state.0.lock().await, &root)?
        .remote_action(&action)
        .await
}

#[tauri::command]
async fn save_stash(
    root: String,
    message: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .save_stash(&message)
        .await
}

#[tauri::command]
async fn apply_stash(root: String, hash: String, state: State<'_, AppState>) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .apply_stash(&hash)
        .await
}

#[tauri::command]
async fn compare_branch(
    root: String,
    branch: String,
    state: State<'_, AppState>,
) -> Result<BranchComparison, String> {
    active(&*state.0.lock().await, &root)?
        .compare_branch(&branch)
        .await
}

#[tauri::command]
async fn start_history(
    root: String,
    request: HistoryRequest,
    state: State<'_, AppState>,
) -> Result<String, String> {
    active(&*state.0.lock().await, &root)?
        .start_history(request)
        .await
}

#[tauri::command]
async fn merge_overview(root: String, state: State<'_, AppState>) -> Result<MergeOverview, String> {
    active(&*state.0.lock().await, &root)?
        .merge_overview()
        .await
}

#[tauri::command]
async fn open_merge(
    root: String,
    path: String,
    allow_large: Option<bool>,
    state: State<'_, AppState>,
) -> Result<MergeDocument, String> {
    let mut current = state.0.lock().await;
    active(&current, &root)?;
    let git = current.as_mut().ok_or("请先打开仓库")?;
    if allow_large.unwrap_or(false) {
        git.open_merge_with_options(path, true).await
    } else {
        git.open_merge(path).await
    }
}

#[tauri::command]
async fn save_merge(
    root: String,
    request: SaveMerge,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut current = state.0.lock().await;
    active(&current, &root)?;
    current
        .as_mut()
        .ok_or("请先打开仓库")?
        .save_merge(request)
        .await
}

#[tauri::command]
async fn merge_operation(
    root: String,
    operation_id: String,
    action: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut current = state.0.lock().await;
    active(&current, &root)?;
    current
        .as_mut()
        .ok_or("请先打开仓库")?
        .merge_operation(operation_id, action)
        .await
}

#[tauri::command]
async fn preview_navigation(
    root: String,
    target: String,
    action: NavigationAction,
    state: State<'_, AppState>,
) -> Result<NavigationPreview, String> {
    active(&*state.0.lock().await, &root)?
        .preview_navigation(&target, action)
        .await
}

#[tauri::command]
async fn execute_navigation(
    root: String,
    request: NavigationRequest,
    state: State<'_, AppState>,
) -> Result<NavigationResult, String> {
    active(&*state.0.lock().await, &root)?
        .execute_navigation(request)
        .await
}

#[tauri::command]
async fn recovery_overview(
    root: String,
    state: State<'_, AppState>,
) -> Result<RecoveryOverview, String> {
    active(&*state.0.lock().await, &root)?
        .recovery_overview()
        .await
}

#[tauri::command]
async fn recover_navigation(
    root: String,
    id: String,
    action: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .recover_navigation(&id, &action)
        .await
}

#[tauri::command]
async fn read_reflog(root: String, state: State<'_, AppState>) -> Result<Vec<ReflogEntry>, String> {
    active(&*state.0.lock().await, &root)?.reflog().await
}

#[tauri::command]
async fn create_recovery_branch(
    root: String,
    name: String,
    hash: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .create_recovery_branch(&name, &hash)
        .await
}

#[tauri::command]
async fn transfer_overview(
    root: String,
    state: State<'_, AppState>,
) -> Result<git::remotes::TransferOverview, String> {
    active(&*state.0.lock().await, &root)?
        .transfer_overview()
        .await
}
#[tauri::command]
async fn edit_remote(
    root: String,
    request: git::remotes::RemoteEdit,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .edit_remote(request)
        .await
}
#[tauri::command]
async fn outgoing_commits(
    root: String,
    remote: String,
    branch: String,
    state: State<'_, AppState>,
) -> Result<Vec<Commit>, String> {
    active(&*state.0.lock().await, &root)?
        .outgoing(&remote, &branch)
        .await
}
#[tauri::command]
async fn start_transfer(
    root: String,
    request: git::remotes::TransferRequest,
    state: State<'_, AppState>,
    jobs: State<'_, transport::Jobs>,
) -> Result<String, String> {
    let current = state.0.clone().lock_owned().await;
    let command = active(&current, &root)?.transfer_command(request).await?;
    jobs.start_with_lease(command, root, Some(current))
}

#[tauri::command]
async fn repository_management(
    root: String,
    state: State<'_, AppState>,
) -> Result<git::management::Management, String> {
    active(&*state.0.lock().await, &root)?.management().await
}
#[tauri::command]
async fn edit_ref(
    root: String,
    request: git::management::RefEdit,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .edit_ref(request)
        .await
}
#[tauri::command]
async fn edit_stash(
    root: String,
    request: git::management::StashEdit,
    expected: Option<Vec<Stash>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .edit_stash_snapshot(request, expected)
        .await
}
#[tauri::command]
async fn stash_files(
    root: String,
    hash: String,
    state: State<'_, AppState>,
) -> Result<Vec<git::management::StashFile>, String> {
    active(&*state.0.lock().await, &root)?
        .stash_files(&hash)
        .await
}

#[tauri::command]
async fn clear_stashes(
    root: String,
    request: Vec<Stash>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .clear_stashes(request)
        .await
}

#[tauri::command]
async fn restore_stash_branch(
    root: String,
    request: git::management::StashBranch,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .restore_stash_branch(request)
        .await
}
#[tauri::command]
async fn push_tag(
    root: String,
    name: String,
    hash: String,
    remote: String,
    state: State<'_, AppState>,
    jobs: State<'_, transport::Jobs>,
) -> Result<String, String> {
    let current = state.0.clone().lock_owned().await;
    let command = active(&current, &root)?
        .tag_push_command(&name, &hash, &remote)
        .await?;
    jobs.start_with_lease(command, root, Some(current))
}

#[tauri::command]
async fn delete_remote_ref(
    root: String,
    remote: String,
    name: String,
    kind: String,
    hash: String,
    state: State<'_, AppState>,
    jobs: State<'_, transport::Jobs>,
) -> Result<String, String> {
    let current = state.0.clone().lock_owned().await;
    let command = active(&current, &root)?
        .delete_remote_ref_command(&remote, &name, &kind, &hash)
        .await?;
    jobs.start_with_lease(command, root, Some(current))
}

#[tauri::command]
async fn preview_hunks(
    root: String,
    path: String,
    area: String,
    state: State<'_, AppState>,
) -> Result<git::hunks::HunkPreview, String> {
    active(&*state.0.lock().await, &root)?
        .preview_hunks(&path, &area)
        .await
}

#[tauri::command]
async fn read_worktrees(
    root: String,
    state: State<'_, AppState>,
) -> Result<git::worktrees::WorktreeOverview, String> {
    active(&*state.0.lock().await, &root)?.worktrees().await
}

#[tauri::command]
async fn read_ignore(
    root: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<git::ignore::IgnoreState, String> {
    active(&*state.0.lock().await, &root)?
        .read_ignore(&path)
        .await
}

#[tauri::command]
async fn ignore_files(
    root: String,
    kind: String,
    query: String,
    offset: usize,
    state: State<'_, AppState>,
) -> Result<git::ignore::IgnoreFiles, String> {
    active(&*state.0.lock().await, &root)?
        .ignore_files(&kind, &query, offset)
        .await
}

#[tauri::command]
async fn edit_ignore(
    root: String,
    preview: git::ignore::IgnoreState,
    action: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .edit_ignore(preview, &action, &value)
        .await
}

#[tauri::command]
async fn create_worktree(
    root: String,
    request: git::worktrees::CreateWorktree,
    state: State<'_, AppState>,
) -> Result<String, String> {
    active(&*state.0.lock().await, &root)?
        .create_worktree(request)
        .await
}

#[tauri::command]
async fn edit_worktree(
    root: String,
    entry: git::worktrees::Worktree,
    action: String,
    reason: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .edit_worktree(entry, &action, &reason)
        .await
}

#[tauri::command]
async fn prune_worktrees(
    root: String,
    entries: Vec<git::worktrees::Worktree>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    active(&*state.0.lock().await, &root)?
        .prune_worktrees(entries)
        .await
}
#[tauri::command]
async fn apply_hunk(
    root: String,
    preview: git::hunks::HunkPreview,
    index: usize,
    discard: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .apply_hunk(preview, index, discard)
        .await
}

#[tauri::command]
async fn apply_hunk_lines(
    root: String,
    preview: git::hunks::HunkPreview,
    selections: Vec<git::hunks::lines::LineSelection>,
    discard: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .apply_hunk_lines(preview, selections, discard)
        .await
}
#[tauri::command]
async fn preview_amend(
    root: String,
    state: State<'_, AppState>,
) -> Result<git::hunks::AmendPreview, String> {
    active(&*state.0.lock().await, &root)?.preview_amend().await
}
#[tauri::command]
async fn amend_commit(
    root: String,
    expected_head: String,
    fingerprint: String,
    message: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    active(&*state.0.lock().await, &root)?
        .amend(&expected_head, &fingerprint, &message)
        .await
}

pub fn git_editor_helper() -> bool {
    git::interactive::editor_helper()
}

#[tauri::command]
async fn preview_interactive(
    root: String,
    base: String,
    onto: String,
    state: State<'_, AppState>,
) -> Result<git::interactive::RebasePreview, String> {
    active(&*state.0.lock().await, &root)?
        .preview_interactive(&base, &onto)
        .await
}
#[tauri::command]
async fn start_interactive(
    root: String,
    preview: git::interactive::RebasePreview,
    entries: Vec<git::interactive::RebaseEntry>,
    state: State<'_, AppState>,
    jobs: State<'_, transport::Jobs>,
) -> Result<String, String> {
    let current = state.0.clone().lock_owned().await;
    let command = active(&current, &root)?
        .interactive_command(preview, entries)
        .await?;
    jobs.start_with_lease(command, root, Some(current))
}

#[tauri::command]
async fn file_history(
    root: String,
    path: String,
    revision: Option<String>,
    offset: usize,
    state: State<'_, AppState>,
) -> Result<git::file_history::FileHistory, String> {
    active(&*state.0.lock().await, &root)?
        .file_history(&path, revision.as_deref(), offset)
        .await
}
#[tauri::command]
async fn file_blame(
    root: String,
    path: String,
    revision: Option<String>,
    offset: usize,
    state: State<'_, AppState>,
) -> Result<git::file_history::BlamePage, String> {
    active(&*state.0.lock().await, &root)?
        .blame(&path, revision.as_deref(), offset)
        .await
}

#[derive(serde::Serialize)]
struct ReviewFetch {
    id: String,
    reference: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewFetchRequest {
    account_id: String,
    repository: String,
    number: u64,
    head_sha: String,
    protocol: String,
    ssh_alias: String,
}

#[tauri::command]
async fn fetch_review_branch(
    root: String,
    request: ReviewFetchRequest,
    state: State<'_, AppState>,
    hosting: State<'_, hosting::Hosting>,
    jobs: State<'_, transport::Jobs>,
) -> Result<ReviewFetch, String> {
    let current = state.0.clone().lock_owned().await;
    let git = active(&current, &root)?;
    let (url, source, reference) = hosting::commands::review_fetch_source(
        request.account_id,
        request.repository,
        request.number,
        request.head_sha,
        request.protocol,
        request.ssh_alias,
        hosting,
    )
    .await?;
    let mut command = tokio::process::Command::new("git");
    command.current_dir(&git.root).args([
        "fetch",
        "--progress",
        "--no-tags",
        "--",
        &url,
        &format!("{source}:{reference}"),
    ]);
    let id = jobs.start_with_lease(command, root, Some(current))?;
    Ok(ReviewFetch { id, reference })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            app.manage(hosting::Hosting::new(directory).map_err(std::io::Error::other)?);
            Ok(())
        })
        .manage(AppState::default())
        .manage(transport::Jobs::default())
        .invoke_handler(tauri::generate_handler![
            transport::start_clone,
            transport::transport_progress,
            transport::cancel_transport,
            transport::answer_transport,
            transfer_overview,
            edit_remote,
            outgoing_commits,
            start_transfer,
            repository_management,
            edit_ref,
            edit_stash,
            stash_files,
            clear_stashes,
            restore_stash_branch,
            push_tag,
            delete_remote_ref,
            preview_hunks,
            read_worktrees,
            read_ignore,
            ignore_files,
            edit_ignore,
            create_worktree,
            edit_worktree,
            prune_worktrees,
            apply_hunk,
            apply_hunk_lines,
            preview_amend,
            amend_commit,
            preview_interactive,
            start_interactive,
            file_history,
            file_blame,
            fetch_review_branch,
            initial_repository,
            open_release_page,
            open_repository,
            repository_status,
            git_diagnostics,
            submodules,
            update_submodules,
            bisect_status,
            bisect_start,
            bisect_step,
            bisect_reset,
            read_log,
            commit_details,
            read_diff,
            read_commit_review,
            read_review_worktree,
            stage_paths,
            preview_discard,
            discard_changes,
            create_commit,
            checkout_branch,
            create_branch,
            remote_action,
            save_stash,
            apply_stash,
            compare_branch,
            start_history,
            preview_navigation,
            execute_navigation,
            recovery_overview,
            recover_navigation,
            read_reflog,
            create_recovery_branch,
            merge_overview,
            open_merge,
            save_merge,
            merge_operation,
            hosting::read::hosting_read,
            hosting::read::hosting_cancel_read,
            hosting::commands::hosting_login,
            hosting::oauth::hosting_oauth_start,
            hosting::oauth::hosting_oauth_open,
            hosting::oauth::hosting_oauth_finish,
            hosting::oauth::hosting_oauth_cancel,
            hosting::oauth::hosting_oauth_registration,
            hosting::commands::hosting_logout,
            hosting::commands::hosting_validate,
            hosting::commands::hosting_repository,
            hosting::commands::hosting_create_review,
            hosting::commands::hosting_change_state,
            hosting::commands::hosting_comment,
            hosting::commands::hosting_local_root,
            hosting::commands::hosting_clone,
            hosting::commands::hosting_review_mutation,
            hosting::commands::hosting_start_clone,
            hosting::commands::hosting_open_url
        ])
        .run(tauri::generate_context!())
        .expect("Could not start IdeaGitTool");
}

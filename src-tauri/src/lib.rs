mod git;
mod hosting;
mod models;
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
struct AppState(Mutex<Option<Git>>);

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
async fn repository_status(root: String, state: State<'_, AppState>) -> Result<Status, String> {
    active(&*state.0.lock().await, &root)?.status().await
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            app.manage(hosting::Hosting::new(directory).map_err(std::io::Error::other)?);
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            initial_repository,
            open_repository,
            repository_status,
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
            hosting::commands::hosting_open_url
        ])
        .run(tauri::generate_context!())
        .expect("Could not start IdeaGitTool");
}

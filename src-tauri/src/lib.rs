mod git;
mod models;
mod watcher;

use git::Git;
use models::*;
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
    state: State<'_, AppState>,
) -> Result<FileDiff, String> {
    active(&*state.0.lock().await, &root)?.diff(request).await
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            initial_repository,
            open_repository,
            repository_status,
            read_log,
            commit_details,
            read_diff,
            stage_paths,
            create_commit,
            checkout_branch,
            create_branch,
            remote_action,
            save_stash,
            apply_stash
        ])
        .run(tauri::generate_context!())
        .expect("Could not start IdeaGitTool");
}

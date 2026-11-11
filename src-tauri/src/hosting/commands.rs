use super::*;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn hosting_accounts(state: State<'_, Hosting>) -> Result<Vec<Account>, String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.list())
        .await
        .map_err(|_| "读取账户失败")?
}

#[tauri::command]
pub async fn hosting_login(request: Login, state: State<'_, Hosting>) -> Result<Account, String> {
    let _permit = state.permit().await?;
    let server = api::normalize_server(&request.server)?;
    let token = request.token.trim().to_owned();
    if token.is_empty() || token.len() > 4096 || token.chars().any(char::is_whitespace) {
        return Err("请输入有效的访问令牌".into());
    }
    let api = Api {
        client: state.client.clone(),
        provider: request.provider,
        server,
        token,
    };
    let account = api.identity().await?;
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = store.session_guard()?;
        store.save(account, &api.token)
    })
    .await
    .map_err(|_| "保存账户失败")?
}

#[tauri::command]
pub async fn hosting_logout(account_id: String, state: State<'_, Hosting>) -> Result<(), String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        let _guard = store.session_guard()?;
        store.remove(&account_id)
    })
    .await
    .map_err(|_| "移除账户失败")?
}

#[tauri::command]
pub async fn hosting_validate(
    account_id: String,
    state: State<'_, Hosting>,
) -> Result<Account, String> {
    let _permit = state.permit().await?;
    state.session(account_id).await?.identity().await
}

fn valid_page(page: u32) -> Result<(), String> {
    if page == 0 || page > 10000 {
        Err("页码无效".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn hosting_repositories(
    account_id: String,
    page: u32,
    state: State<'_, Hosting>,
) -> Result<Page<Repository>, String> {
    valid_page(page)?;
    let _permit = state.permit().await?;
    state.session(account_id).await?.repositories(page).await
}

#[tauri::command]
pub async fn hosting_repository(
    account_id: String,
    repository: String,
    state: State<'_, Hosting>,
) -> Result<Repository, String> {
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .repository(&repository)
        .await
}

#[tauri::command]
pub async fn hosting_reviews(
    account_id: String,
    repository: String,
    filter: String,
    page: u32,
    state: State<'_, Hosting>,
) -> Result<Page<ReviewRequest>, String> {
    valid_page(page)?;
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .reviews(&repository, &filter, page)
        .await
}

#[tauri::command]
pub async fn hosting_review(
    account_id: String,
    repository: String,
    number: u64,
    state: State<'_, Hosting>,
) -> Result<ReviewRequest, String> {
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .review(&repository, number)
        .await
}

#[tauri::command]
pub async fn hosting_create_review(
    account_id: String,
    repository: String,
    request: CreateReview,
    state: State<'_, Hosting>,
) -> Result<ReviewRequest, String> {
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .create_review(&repository, request)
        .await
}

#[tauri::command]
pub async fn hosting_change_state(
    account_id: String,
    repository: String,
    number: u64,
    action: String,
    state: State<'_, Hosting>,
) -> Result<ReviewRequest, String> {
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .change_state(&repository, number, &action)
        .await
}

#[tauri::command]
pub async fn hosting_comments(
    account_id: String,
    repository: String,
    number: u64,
    page: u32,
    state: State<'_, Hosting>,
) -> Result<Page<Comment>, String> {
    valid_page(page)?;
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .comments(&repository, number, page)
        .await
}

#[tauri::command]
pub async fn hosting_comment(
    account_id: String,
    repository: String,
    number: u64,
    body: String,
    state: State<'_, Hosting>,
) -> Result<Comment, String> {
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .comment(&repository, number, body)
        .await
}

#[tauri::command]
pub async fn hosting_files(
    account_id: String,
    repository: String,
    number: u64,
    page: u32,
    state: State<'_, Hosting>,
) -> Result<Page<ReviewFile>, String> {
    valid_page(page)?;
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .files(&repository, number, page)
        .await
}

#[tauri::command]
pub async fn hosting_commits(
    account_id: String,
    repository: String,
    number: u64,
    page: u32,
    state: State<'_, Hosting>,
) -> Result<Page<ReviewCommit>, String> {
    valid_page(page)?;
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .commits(&repository, number, page)
        .await
}

#[tauri::command]
pub async fn hosting_checks(
    account_id: String,
    repository: String,
    number: u64,
    state: State<'_, Hosting>,
) -> Result<Vec<Check>, String> {
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .checks(&repository, number)
        .await
}

#[tauri::command]
pub async fn hosting_open_url(
    account_id: String,
    url: String,
    app: tauri::AppHandle,
    state: State<'_, Hosting>,
) -> Result<(), String> {
    let api = state.session(account_id).await?;
    let server = reqwest::Url::parse(&api.server).map_err(|_| "平台地址无效")?;
    let target = reqwest::Url::parse(&url).map_err(|_| "链接无效")?;
    if target.scheme() != "https"
        || !target.username().is_empty()
        || target.password().is_some()
        || target.origin() != server.origin()
    {
        return Err("仅支持打开当前平台的 HTTPS 链接".into());
    }
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|_| "打开浏览器失败".into())
}

#[tauri::command]
pub async fn hosting_clone(
    request: CloneRequest,
    state: State<'_, Hosting>,
) -> Result<String, String> {
    let _permit = state.permit().await?;
    let api = state.session(request.account_id.clone()).await?;
    let repository = api.repository(&request.repository).await?;
    super::clone::clone_repository(repository, request).await
}

#[tauri::command]
pub async fn hosting_file_diff(
    account_id: String,
    repository: String,
    request: RemoteFileRequest,
    state: State<'_, Hosting>,
) -> Result<crate::models::FileDiff, String> {
    let _permit = state.permit().await?;
    state
        .session(account_id)
        .await?
        .file_diff(&repository, request)
        .await
}

#[tauri::command]
pub async fn hosting_local_root(path: String) -> Result<String, String> {
    Ok(crate::git::Git::open(&path, None).await?.root_string())
}

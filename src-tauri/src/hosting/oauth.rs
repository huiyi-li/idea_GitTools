use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;

pub const REDIRECT_URI: &str = "http://127.0.0.1:34171/oauth/callback";
const CREDENTIAL_PREFIX: &str = "ideagittool-oauth-v1:";
const MAX_RESPONSE: usize = 65536;
const WAITING: u8 = 0;
const CANCELLED: u8 = 1;
const SAVING: u8 = 2;
const FINISHED: u8 = 3;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    provider: Provider,
    server: String,
    client_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    id: String,
    url: String,
    user_code: Option<String>,
    expires_at: u64,
}

enum Flow {
    Device {
        code: String,
        interval: u64,
    },
    Pkce {
        listener: TcpListener,
        state: String,
        verifier: String,
    },
}

struct Attempt {
    provider: Provider,
    server: String,
    client_id: String,
    start: LoginStart,
    deadline: Instant,
    flow: Mutex<Option<Flow>>,
    phase: AtomicU8,
    cancel: Notify,
}

#[derive(Default)]
pub struct Logins(Mutex<HashMap<String, Arc<Attempt>>>);

#[derive(Serialize, Deserialize)]
struct Credential {
    provider: Provider,
    server: String,
    client_id: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成登录校验码")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn endpoint(server: &str, provider: Provider, device: bool) -> String {
    match (provider, device) {
        (Provider::Github, true) => format!("{server}/login/device/code"),
        (Provider::Github, false) => format!("{server}/login/oauth/access_token"),
        (Provider::Gitlab, _) => format!("{server}/oauth/token"),
    }
}

async fn post(client: &Client, url: &str, fields: &[(&str, &str)]) -> Result<Value, String> {
    let mut response = client
        .post(url)
        .header("Accept", "application/json")
        .form(fields)
        .send()
        .await
        .map_err(|_| "授权服务器连接失败，请检查网络或重试")?;
    let status = response.status();
    if status.is_redirection() {
        return Err("授权端点发生重定向，请检查服务器地址".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE as u64)
    {
        return Err("授权服务器响应过大".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "无法读取授权响应")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("授权服务器响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "授权服务器响应格式无效")?;
    if !status.is_success() && value["error"].as_str().is_none() {
        return Err(format!("授权服务器返回 HTTP {}", status.as_u16()));
    }
    Ok(value)
}

fn error_message(error: &str) -> String {
    match error {
        "access_denied" => "网页授权已拒绝，请重新登录",
        "expired_token" | "token_expired" => "登录授权已过期，请重新开始",
        "device_flow_disabled" => "请在 GitHub OAuth 应用设置中启用 Device Flow",
        "incorrect_client_credentials" | "invalid_client" => "OAuth Client ID 无效，请检查应用配置",
        "invalid_grant" | "bad_refresh_token" => "授权凭据已失效，请重新登录",
        _ => "平台授权失败，请检查应用配置后重新登录",
    }
    .into()
}

fn required(value: &Value, key: &str) -> Result<String, String> {
    value[key]
        .as_str()
        .filter(|value| {
            !value.is_empty() && value.len() <= 8192 && !value.chars().any(char::is_whitespace)
        })
        .map(str::to_owned)
        .ok_or_else(|| format!("授权响应缺少有效字段 {key}"))
}

fn credential(
    provider: Provider,
    server: &str,
    client_id: &str,
    value: &Value,
) -> Result<Credential, String> {
    if let Some(error) = value["error"].as_str() {
        return Err(error_message(error));
    }
    if !value["token_type"]
        .as_str()
        .is_some_and(|value| value.eq_ignore_ascii_case("bearer"))
    {
        return Err("授权服务器返回了不支持的凭据类型".into());
    }
    let expires_at = if value["expires_in"].is_null() {
        None
    } else {
        let seconds = value["expires_in"]
            .as_u64()
            .filter(|seconds| *seconds > 0)
            .ok_or("授权服务器返回了无效的到期时间")?;
        Some(now().saturating_add(seconds))
    };
    let refresh_token = if value["refresh_token"].is_null() {
        None
    } else {
        Some(required(value, "refresh_token")?)
    };
    if provider == Provider::Gitlab && (expires_at.is_none() || refresh_token.is_none()) {
        return Err("GitLab 授权响应缺少续期信息".into());
    }
    Ok(Credential {
        provider,
        server: server.into(),
        client_id: client_id.into(),
        access_token: required(value, "access_token")?,
        refresh_token,
        expires_at,
    })
}

async fn save(
    store: Arc<AccountStore>,
    account: Account,
    value: Credential,
) -> Result<Account, String> {
    let serialized = format!(
        "{CREDENTIAL_PREFIX}{}",
        serde_json::to_string(&value).map_err(|_| "无法编码授权凭据")?
    );
    tokio::task::spawn_blocking(move || store.save(account, &serialized))
        .await
        .map_err(|_| "保存账户失败")?
}

pub(super) async fn access_token(
    client: &Client,
    store: &Arc<AccountStore>,
    account: &Account,
    stored: String,
) -> Result<String, String> {
    let Some(data) = stored.strip_prefix(CREDENTIAL_PREFIX) else {
        return Ok(stored);
    };
    let current: Credential =
        serde_json::from_str(data).map_err(|_| "网页登录凭据损坏，请重新登录")?;
    if current.provider != account.provider || current.server != account.server {
        return Err("网页登录凭据与平台不匹配，请重新登录".into());
    }
    if current
        .expires_at
        .is_none_or(|expires| expires > now().saturating_add(60))
    {
        return Ok(current.access_token);
    }
    let refresh = current
        .refresh_token
        .as_deref()
        .ok_or("网页登录已过期，请重新登录")?;
    let mut fields = vec![
        ("client_id", current.client_id.as_str()),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
    ];
    if current.provider == Provider::Gitlab {
        fields.push(("redirect_uri", REDIRECT_URI));
    }
    let value = post(
        client,
        &endpoint(&current.server, current.provider, false),
        &fields,
    )
    .await?;
    let updated = credential(
        current.provider,
        &current.server,
        &current.client_id,
        &value,
    )?;
    let token = updated.access_token.clone();
    let serialized = format!(
        "{CREDENTIAL_PREFIX}{}",
        serde_json::to_string(&updated).map_err(|_| "无法编码授权凭据")?
    );
    let store = store.clone();
    let id = account.id.clone();
    tokio::task::spawn_blocking(move || store.replace_token(&id, &stored, &serialized))
        .await
        .map_err(|_| "保存续期凭据失败")??;
    Ok(token)
}

impl Logins {
    async fn get(&self, id: &str) -> Result<Arc<Attempt>, String> {
        self.0
            .lock()
            .await
            .get(id)
            .cloned()
            .filter(|attempt| {
                attempt.phase.load(Ordering::Acquire) == WAITING
                    && Instant::now() < attempt.deadline
            })
            .ok_or_else(|| "网页登录已取消或过期，请重新开始".into())
    }

    async fn start(&self, client: &Client, request: StartRequest) -> Result<LoginStart, String> {
        let server = api::normalize_server(&request.server)?;
        let client_id = request.client_id.trim().to_owned();
        if client_id.is_empty()
            || client_id.len() > 256
            || !client_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        {
            return Err("请先注册 OAuth 应用并填写公开 Client ID".into());
        }
        let mut pending = self.0.lock().await;
        pending.retain(|_, attempt| {
            attempt.phase.load(Ordering::Acquire) == SAVING
                || (attempt.phase.load(Ordering::Acquire) == WAITING
                    && Instant::now() < attempt.deadline)
        });
        if !pending.is_empty() {
            return Err("已有网页登录进行中，请先完成或取消".into());
        }
        let id = random_token()?;
        let (url, user_code, seconds, flow) = match request.provider {
            Provider::Github => {
                let value = post(
                    client,
                    &endpoint(&server, request.provider, true),
                    &[("client_id", &client_id), ("scope", "repo read:user")],
                )
                .await?;
                if let Some(error) = value["error"].as_str() {
                    return Err(error_message(error));
                }
                let url = required(&value, "verification_uri")?;
                let target = Url::parse(&url).map_err(|_| "授权页面地址无效")?;
                if target.scheme() != "https"
                    || target.origin() != Url::parse(&server).map_err(|_| "平台地址无效")?.origin()
                    || !target.username().is_empty()
                    || target.password().is_some()
                {
                    return Err("授权页面与所选平台不匹配".into());
                }
                (
                    url,
                    Some(required(&value, "user_code")?),
                    value["expires_in"].as_u64().unwrap_or(900).clamp(1, 900),
                    Flow::Device {
                        code: required(&value, "device_code")?,
                        interval: value["interval"].as_u64().unwrap_or(5).clamp(1, 60),
                    },
                )
            }
            Provider::Gitlab => {
                let listener = TcpListener::bind("127.0.0.1:34171")
                    .await
                    .map_err(|_| "本机登录回调端口 34171 被占用，请关闭其他登录窗口后重试")?;
                let state = random_token()?;
                let verifier = random_token()?;
                let mut url =
                    Url::parse(&format!("{server}/oauth/authorize")).map_err(|_| "平台地址无效")?;
                url.query_pairs_mut().extend_pairs([
                    ("client_id", client_id.as_str()),
                    ("redirect_uri", REDIRECT_URI),
                    ("response_type", "code"),
                    ("state", state.as_str()),
                    ("code_challenge", challenge(&verifier).as_str()),
                    ("code_challenge_method", "S256"),
                    ("scope", "api read_user"),
                ]);
                (
                    url.to_string(),
                    None,
                    300,
                    Flow::Pkce {
                        listener,
                        state,
                        verifier,
                    },
                )
            }
        };
        let start = LoginStart {
            id: id.clone(),
            url,
            user_code,
            expires_at: now() + seconds,
        };
        pending.insert(
            id,
            Arc::new(Attempt {
                provider: request.provider,
                server,
                client_id,
                start: start.clone(),
                deadline: Instant::now() + Duration::from_secs(seconds),
                flow: Mutex::new(Some(flow)),
                phase: AtomicU8::new(WAITING),
                cancel: Notify::new(),
            }),
        );
        Ok(start)
    }

    async fn cancel(&self, id: &str) -> bool {
        let mut pending = self.0.lock().await;
        if let Some(attempt) = pending.get(id) {
            if attempt
                .phase
                .compare_exchange(WAITING, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return false;
            }
            attempt.cancel.notify_one();
            pending.remove(id);
            return true;
        }
        false
    }
}

impl Attempt {
    async fn token(&self, client: &Client, flow: Flow) -> Result<Credential, String> {
        let value = match flow {
            Flow::Device { code, mut interval } => loop {
                tokio::time::sleep(Duration::from_secs(interval)).await;
                let value = post(
                    client,
                    &endpoint(&self.server, self.provider, false),
                    &[
                        ("client_id", &self.client_id),
                        ("device_code", &code),
                        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ],
                )
                .await?;
                match value["error"].as_str() {
                    Some("authorization_pending") => continue,
                    Some("slow_down") => {
                        interval = value["interval"]
                            .as_u64()
                            .unwrap_or(interval.saturating_add(5))
                            .max(interval.saturating_add(5))
                            .min(900);
                        continue;
                    }
                    _ => break value,
                }
            },
            Flow::Pkce {
                listener,
                state,
                verifier,
            } => {
                let code = callback(&listener, &state).await?;
                post(
                    client,
                    &endpoint(&self.server, self.provider, false),
                    &[
                        ("client_id", &self.client_id),
                        ("grant_type", "authorization_code"),
                        ("code", &code),
                        ("code_verifier", &verifier),
                        ("redirect_uri", REDIRECT_URI),
                    ],
                )
                .await?
            }
        };
        credential(self.provider, &self.server, &self.client_id, &value)
    }
}

async fn request_line(stream: &mut TcpStream) -> Result<(String, String), String> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|_| "无法读取登录回调")?;
        if count == 0 || bytes.len() + count > 16384 {
            return Err("登录回调无效".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            break;
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "登录回调格式无效")?;
    let target = text
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("GET "))
        .and_then(|line| line.strip_suffix(" HTTP/1.1"))
        .ok_or("登录回调方法无效")?;
    let host = text
        .lines()
        .skip(1)
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
                .map(|(_, value)| value.trim())
        })
        .ok_or("登录回调来源无效")?;
    Ok((target.into(), host.into()))
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str, location: bool) {
    let headers = if location {
        "Location: /oauth/complete\r\n"
    } else {
        ""
    };
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\n{headers}Connection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn callback_code(
    target: &str,
    host: &str,
    expected_host: &str,
    state: &str,
) -> Result<Option<String>, String> {
    if host != expected_host || !target.starts_with("/oauth/callback?") {
        return Ok(None);
    }
    let url =
        Url::parse(&format!("http://{expected_host}{target}")).map_err(|_| "登录回调地址无效")?;
    let values = |key: &str| {
        url.query_pairs()
            .filter(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
            .collect::<Vec<_>>()
    };
    if values("state") != [state] {
        return Ok(None);
    }
    if !values("error").is_empty() {
        return Err("网页授权已拒绝，请重新登录".into());
    }
    let codes = values("code");
    if codes.len() != 1 || codes[0].is_empty() || codes[0].len() > 8192 {
        return Err("登录回调缺少有效授权码".into());
    }
    Ok(Some(codes[0].clone()))
}

async fn callback(listener: &TcpListener, state: &str) -> Result<String, String> {
    let host = listener
        .local_addr()
        .map_err(|_| "无法读取回调地址")?
        .to_string();
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|_| "无法接收登录回调")?;
        let result = tokio::time::timeout(Duration::from_secs(2), request_line(&mut stream)).await;
        let Ok(Ok((target, source))) = result else {
            continue;
        };
        match callback_code(&target, &source, &host, state) {
            Ok(None) => {
                respond(
                    &mut stream,
                    "400 Bad Request",
                    "无效的登录回调，请返回应用继续登录。",
                    false,
                )
                .await;
            }
            result => {
                respond(&mut stream, "303 See Other", "", true).await;
                // Serve a code-free landing page before closing the one-shot listener.
                let _ = tokio::time::timeout(Duration::from_secs(1), async {
                    let (mut stream, _) = listener.accept().await.map_err(|_| ())?;
                    if let Ok((target, source)) = request_line(&mut stream).await {
                        if target == "/oauth/complete" && source == host {
                            respond(&mut stream, "200 OK", "<!doctype html><html lang=zh-CN><meta charset=utf-8><title>IdeaGitTool</title><p>授权回调已收到，请返回 IdeaGitTool 查看登录结果。</p></html>", false).await;
                        }
                    }
                    Ok::<(), ()>(())
                }).await;
                return result?.ok_or_else(|| "登录回调无效".into());
            }
        }
    }
}

#[tauri::command]
pub async fn hosting_oauth_start(
    request: StartRequest,
    state: State<'_, Hosting>,
) -> Result<LoginStart, String> {
    state.oauth.start(&state.client, request).await
}

#[tauri::command]
pub async fn hosting_oauth_open(
    session_id: String,
    app: tauri::AppHandle,
    state: State<'_, Hosting>,
) -> Result<(), String> {
    let attempt = state.oauth.get(&session_id).await?;
    app.opener()
        .open_url(&attempt.start.url, None::<&str>)
        .map_err(|_| "浏览器打开失败，可重试打开授权页面".into())
}

#[tauri::command]
pub async fn hosting_oauth_cancel(
    session_id: String,
    state: State<'_, Hosting>,
) -> Result<bool, String> {
    Ok(state.oauth.cancel(&session_id).await)
}

#[tauri::command]
pub async fn hosting_oauth_finish(
    session_id: String,
    state: State<'_, Hosting>,
) -> Result<Account, String> {
    finish(&state.oauth, &state.client, &state.store, session_id).await
}

async fn finish(
    logins: &Logins,
    client: &Client,
    store: &Arc<AccountStore>,
    session_id: String,
) -> Result<Account, String> {
    let attempt = logins.get(&session_id).await?;
    let flow = attempt
        .flow
        .lock()
        .await
        .take()
        .ok_or("此网页登录已在处理")?;
    let result = tokio::select! {
        biased;
        _ = attempt.cancel.notified() => Err("网页登录已取消".into()),
        _ = tokio::time::sleep_until(attempt.deadline) => Err("网页登录已过期，请重新开始".into()),
        result = async {
            let value = attempt.token(client, flow).await?;
            let api = Api { client: client.clone(), provider: attempt.provider, server: attempt.server.clone(), token: value.access_token.clone() };
            let account = api.identity().await?;
            Ok((account, value))
        } => result,
    };
    // Credential persistence is the commit boundary. Cancellation wins before this boundary.
    let result = match result {
        Ok((account, value)) => {
            let account_store = store.clone();
            let saved = async {
                let _guard = tokio::task::spawn_blocking(move || account_store.session_guard())
                    .await
                    .map_err(|_| "读取账户失败")??;
                if Instant::now() >= attempt.deadline
                    || attempt
                        .phase
                        .compare_exchange(WAITING, SAVING, Ordering::AcqRel, Ordering::Acquire)
                        .is_err()
                {
                    return Err("网页登录已取消或过期".into());
                }
                save(store.clone(), account, value).await
            }
            .await;
            saved
        }
        Err(error) => Err(error),
    };
    attempt.phase.store(FINISHED, Ordering::Release);
    logins.0.lock().await.remove(&session_id);
    result
}

#[tauri::command]
pub async fn hosting_oauth_registration(
    provider: Provider,
    server: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let server = api::normalize_server(&server)?;
    let path = match provider {
        Provider::Github => "/settings/applications/new",
        Provider::Gitlab => "/-/user_settings/applications",
    };
    app.opener()
        .open_url(format!("{server}{path}"), None::<&str>)
        .map_err(|_| "浏览器打开失败".into())
}

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::{oneshot, watch};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Prompt {
    id: u64,
    message: String,
    secret: bool,
    confirmation: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub id: String,
    pub state: String,
    pub directory: String,
    pub lines: VecDeque<String>,
    pub error: String,
    pub prompt: Option<Prompt>,
}

struct Job {
    progress: Mutex<Progress>,
    cancel: watch::Sender<bool>,
    answer: Mutex<Option<(u64, oneshot::Sender<String>)>>,
}

#[derive(Default)]
pub(crate) struct Jobs(Mutex<Option<Arc<Job>>>);

fn nonce() -> Result<String, String> {
    let mut bytes = [0; 24];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn safe_line(line: &str) -> String {
    // Remote URLs accepted by this module contain no password or token.
    line.chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .take(2048)
        .collect()
}

impl Job {
    fn log(&self, line: &str) {
        let mut progress = self.progress.lock().unwrap();
        progress.lines.push_back(safe_line(line));
        while progress.lines.len() > 120 {
            progress.lines.pop_front();
        }
    }
}

impl Jobs {
    pub(crate) fn start(&self, command: Command, directory: String) -> Result<String, String> {
        self.start_with_lease(command, directory, None)
    }

    pub(crate) fn start_with_lease(
        &self,
        mut command: Command,
        directory: String,
        lease: Option<tokio::sync::OwnedMutexGuard<Option<crate::git::Git>>>,
    ) -> Result<String, String> {
        let mut current = self.0.lock().map_err(|e| e.to_string())?;
        if current
            .as_ref()
            .is_some_and(|job| job.progress.lock().unwrap().state == "running")
        {
            return Err("已有 Git 传输任务正在执行，请等待或取消".into());
        }
        let id = nonce()?;
        let (cancel, receiver) = watch::channel(false);
        let job = Arc::new(Job {
            progress: Mutex::new(Progress {
                id: id.clone(),
                state: "running".into(),
                directory,
                lines: VecDeque::new(),
                error: String::new(),
                prompt: None,
            }),
            cancel,
            answer: Mutex::new(None),
        });
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        #[cfg(unix)]
        command.process_group(0);
        *current = Some(job.clone());
        tauri::async_runtime::spawn(async move {
            let result = run(command, job.clone(), receiver).await;
            drop(lease);
            *job.answer.lock().unwrap() = None;
            let mut progress = job.progress.lock().unwrap();
            progress.prompt = None;
            progress.state = if *job.cancel.borrow() {
                "cancelled"
            } else if result.is_ok() {
                "done"
            } else {
                "error"
            }
            .into();
            if let Err(error) = result {
                progress.error = error;
            }
        });
        Ok(id)
    }

    fn job(&self, id: &str) -> Result<Arc<Job>, String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .filter(|job| job.progress.lock().unwrap().id == id)
            .cloned()
            .ok_or("Git 任务已结束或不存在".into())
    }

    pub(crate) fn progress(&self, id: &str) -> Result<Progress, String> {
        Ok(self.job(id)?.progress.lock().unwrap().clone())
    }

    pub(crate) fn cancel(&self, id: &str) -> Result<(), String> {
        let job = self.job(id)?;
        job.cancel.send_replace(true);
        Ok(())
    }

    pub(crate) fn answer(&self, id: &str, prompt_id: u64, value: String) -> Result<(), String> {
        if value.len() > 8192 || value.contains(['\r', '\n', '\0']) {
            return Err("认证输入无效".into());
        }
        let job = self.job(id)?;
        let mut answer = job.answer.lock().unwrap();
        if answer.as_ref().is_none_or(|(id, _)| *id != prompt_id) {
            return Err("认证请求已过期".into());
        }
        let (_, sender) = answer.take().unwrap();
        sender.send(value).map_err(|_| "认证请求已结束")?;
        job.progress.lock().unwrap().prompt = None;
        Ok(())
    }
}

async fn log_stream(
    stream: impl tokio::io::AsyncRead + Unpin,
    job: Arc<Job>,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let count = reader.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        for byte in &chunk[..count] {
            if matches!(*byte, b'\r' | b'\n') {
                if !line.is_empty() {
                    job.log(&String::from_utf8_lossy(&line));
                    line.clear();
                }
            } else if line.len() < 8192 {
                line.push(*byte);
            }
        }
    }
    if !line.is_empty() {
        job.log(&String::from_utf8_lossy(&line));
    }
    Ok(())
}

#[derive(Deserialize, Serialize)]
struct AskpassRequest {
    nonce: String,
    prompt: String,
}

async fn authenticate(listener: TcpListener, secret: String, job: Arc<Job>) -> Result<(), String> {
    let mut sequence = 0;
    loop {
        let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(stream);
        let mut input = String::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            (&mut reader).take(16384).read_to_string(&mut input),
        )
        .await
        .map_err(|_| "认证请求超时")?
        .map_err(|e| e.to_string())?;
        let request: AskpassRequest = serde_json::from_str(&input).map_err(|_| "认证请求无效")?;
        if request.nonce != secret {
            continue;
        }
        sequence += 1;
        let lower = request.prompt.to_lowercase();
        let confirmation = lower.contains("yes/no") || lower.contains("authenticity");
        let prompt = Prompt {
            id: sequence,
            message: safe_line(&request.prompt),
            secret: !confirmation && !lower.contains("username"),
            confirmation,
        };
        let (sender, receiver) = oneshot::channel();
        *job.answer.lock().unwrap() = Some((sequence, sender));
        job.progress.lock().unwrap().prompt = Some(prompt);
        let value = receiver.await.map_err(|_| "认证已取消")?;
        reader
            .get_mut()
            .write_all(value.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        reader
            .get_mut()
            .shutdown()
            .await
            .map_err(|e| e.to_string())?;
    }
}

async fn stop(child: &mut tokio::process::Child) {
    if child.try_wait().ok().flatten().is_none() {
        if let Some(pid) = child.id() {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill.exe")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .output()
                    .await;
            }
            #[cfg(unix)]
            {
                let _ = Command::new("kill")
                    .args(["-TERM", "--", &format!("-{pid}")])
                    .output()
                    .await;
            }
        }
        let _ = child.kill().await;
    }
    let _ = child.wait().await;
}

async fn run(
    mut command: Command,
    job: Arc<Job>,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let secret = nonce()?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "auto")
        .env("GIT_ASKPASS", &executable)
        .env("SSH_ASKPASS", &executable)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("DISPLAY", "ideagittool")
        .env("IDEAGITTOOL_ASKPASS_ADDRESS", address.to_string())
        .env("IDEAGITTOOL_ASKPASS_NONCE", &secret);
    if *cancel.borrow() {
        return Err("已取消 Git 任务".into());
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Git，请检查 PATH。{e}"))?;
    let stdout = child.stdout.take().ok_or("Git stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("Git stderr 不可用")?;
    let operation = async {
        let (_, _, status) = tokio::try_join!(
            log_stream(stdout, job.clone()),
            log_stream(stderr, job.clone()),
            async { child.wait().await.map_err(|e| e.to_string()) }
        )?;
        if status.success() {
            Ok(())
        } else {
            let progress = job.progress.lock().unwrap();
            Err(format!(
                "Git 执行失败（{}）。{}",
                status.code().unwrap_or(-1),
                progress
                    .lines
                    .iter()
                    .rev()
                    .take(6)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n")
            ))
        }
    };
    let result = tokio::select! {
        result = operation => result,
        _ = cancel.changed() => Err("已取消 Git 任务。目标目录可能包含未完成的数据".into()),
        result = authenticate(listener, secret, job.clone()) => result,
        _ = tokio::time::sleep(Duration::from_secs(3600)) => Err("Git 任务超过一小时，请检查网络后重试".into()),
    };
    if result.is_err() {
        stop(&mut child).await;
    }
    result
}

pub fn askpass() -> bool {
    if std::env::var_os("IDEAGITTOOL_ASKPASS_NONCE").is_none() {
        return false;
    }
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let address: std::net::SocketAddr =
            std::env::var("IDEAGITTOOL_ASKPASS_ADDRESS")?.parse()?;
        if !address.ip().is_loopback() {
            return Err("Invalid authentication address".into());
        }
        let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
        stream.set_read_timeout(Some(Duration::from_secs(3600)))?;
        let request = AskpassRequest {
            nonce: std::env::var("IDEAGITTOOL_ASKPASS_NONCE")?,
            prompt: std::env::args().nth(1).unwrap_or_default(),
        };
        stream.write_all(&serde_json::to_vec(&request)?)?;
        stream.shutdown(std::net::Shutdown::Write)?;
        let mut response = String::new();
        std::io::BufReader::new(stream)
            .take(8193)
            .read_line(&mut response)?;
        if response.len() > 8192 {
            return Err("Authentication response too long".into());
        }
        writeln!(std::io::stdout(), "{response}")?;
        Ok(())
    })();
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

pub(crate) fn remote_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
        || value.starts_with('-')
    {
        return Err("请输入有效的 SSH、HTTPS 或 HTTP 仓库地址".into());
    }
    if value.contains("://") {
        let url = reqwest::Url::parse(value).map_err(|_| "仓库地址无效")?;
        if !matches!(url.scheme(), "ssh" | "https" | "http")
            || url.host_str().is_none()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || (url.scheme() != "ssh" && !url.username().is_empty())
            || url.username().starts_with('-')
        {
            return Err("地址仅支持 SSH、HTTPS、HTTP，凭据请在认证窗口输入".into());
        }
        return Ok(value.into());
    }
    let (host, path) = value
        .split_once(':')
        .ok_or("SSH 地址格式应为 user@host:path")?;
    let (user, host) = host
        .rsplit_once('@')
        .map_or(("", host), |(user, host)| (user, host));
    if host.is_empty()
        || path.is_empty()
        || path.starts_with(':')
        || user.starts_with('-')
        || !user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        || host.starts_with('-')
        || value.chars().any(char::is_whitespace)
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err("SSH 仓库地址无效".into());
    }
    Ok(value.into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloneRequest {
    pub url: String,
    pub parent: String,
    pub directory: String,
    pub depth: Option<u32>,
}

pub(crate) fn clone_command(request: CloneRequest) -> Result<(Command, String), String> {
    let url = remote_url(&request.url)?;
    let name = Path::new(&request.directory);
    if name.components().count() != 1
        || !matches!(
            name.components().next(),
            Some(std::path::Component::Normal(_))
        )
        || request.directory.contains(['/', '\\', ':'])
        || request.directory.ends_with(['.', ' '])
    {
        return Err("请输入有效的单级目录名称".into());
    }
    let parent = std::fs::canonicalize(&request.parent).map_err(|_| "请选择已存在的父目录")?;
    if !parent.is_dir() {
        return Err("父目录无效".into());
    }
    let destination = parent.join(name);
    if destination.exists()
        && (!destination.is_dir()
            || std::fs::read_dir(&destination)
                .map_err(|e| e.to_string())?
                .next()
                .is_some())
    {
        return Err("目标目录必须为空，请选择其他目录".into());
    }
    if std::fs::symlink_metadata(&destination).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("目标目录不能是符号链接".into());
    }
    let mut command = Command::new("git");
    command.current_dir(&parent).args(["clone", "--progress"]);
    if let Some(depth) = request.depth {
        if depth == 0 {
            return Err("浅克隆深度必须大于零".into());
        }
        command.args(["--depth", &depth.to_string()]);
    }
    let destination = crate::git::git_path(&destination);
    command.arg("--").arg(url).arg(&destination);
    Ok((command, destination))
}

#[tauri::command]
pub(crate) fn start_clone(
    request: CloneRequest,
    state: tauri::State<'_, Jobs>,
) -> Result<String, String> {
    let (command, directory) = clone_command(request)?;
    state.start(command, directory)
}
#[tauri::command]
pub(crate) fn transport_progress(
    id: String,
    state: tauri::State<'_, Jobs>,
) -> Result<Progress, String> {
    state.progress(&id)
}
#[tauri::command]
pub(crate) fn cancel_transport(id: String, state: tauri::State<'_, Jobs>) -> Result<(), String> {
    state.cancel(&id)
}
#[tauri::command]
pub(crate) fn answer_transport(
    id: String,
    prompt_id: u64,
    value: String,
    state: tauri::State<'_, Jobs>,
) -> Result<(), String> {
    state.answer(&id, prompt_id, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn finished(jobs: &Jobs, id: &str) -> Progress {
        for _ in 0..200 {
            let progress = jobs.progress(id).unwrap();
            if progress.state != "running" {
                return progress;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("Git task did not finish");
    }

    #[test]
    fn url_validation_supports_ssh_aliases_ports_and_http_without_inline_credentials() {
        for url in [
            "git@github_ming:owner/repo.git",
            "ssh://git@host:2222/group/repo.git",
            "https://host/repo.git",
            "http://127.0.0.1:8080/group/repo",
        ] {
            assert_eq!(remote_url(url).unwrap(), url);
        }
        for url in [
            "-upload-pack=x",
            "file:///tmp/repo",
            "ext::command",
            "https://user:token@host/repo",
            "https://host/repo?token=x",
            "ssh://host/re\npo",
        ] {
            assert!(remote_url(url).is_err(), "{url}");
        }
    }

    #[tokio::test]
    async fn clone_uses_git_and_preserves_existing_nonempty_directories() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        std::fs::create_dir(&source).unwrap();
        let status = Command::new("git")
            .args(["init", "--bare"])
            .arg(&source)
            .output()
            .await
            .unwrap();
        assert!(status.status.success());
        let request = CloneRequest {
            url: "https://fixture.test/repo.git".into(),
            parent: directory.path().to_string_lossy().into(),
            directory: "空 格".into(),
            depth: None,
        };
        let (mut command, destination) = clone_command(request).unwrap();
        command
            .env("GIT_CONFIG_COUNT", "1")
            .env(
                "GIT_CONFIG_KEY_0",
                format!("url.{}.insteadOf", crate::git::git_path(&source)),
            )
            .env("GIT_CONFIG_VALUE_0", "https://fixture.test/repo.git");
        let jobs = Jobs::default();
        let id = jobs.start(command, destination.clone()).unwrap();
        let progress = finished(&jobs, &id).await;
        assert_eq!(progress.state, "done", "{}", progress.error);
        assert!(Path::new(&destination).join(".git").exists());
        assert!(!progress.lines.is_empty());
        let request = CloneRequest {
            url: "git@host:path".into(),
            parent: directory.path().to_string_lossy().into(),
            directory: "空 格".into(),
            depth: None,
        };
        assert!(clone_command(request).is_err());
    }

    #[tokio::test]
    async fn cancellation_stops_a_live_process_and_releases_the_job_slot() {
        let jobs = Jobs::default();
        let mut command = Command::new("git");
        command.args(["daemon", "--listen=127.0.0.1", "--port=0"]);
        let id = jobs.start(command, String::new()).unwrap();
        assert!(jobs.start(Command::new("git"), String::new()).is_err());
        tokio::time::sleep(Duration::from_millis(100)).await;
        jobs.cancel(&id).unwrap();
        assert_eq!(finished(&jobs, &id).await.state, "cancelled");
        let mut command = Command::new("git");
        command.arg("--version");
        let next = jobs.start(command, String::new()).unwrap();
        assert_eq!(finished(&jobs, &next).await.state, "done");
        assert!(jobs.progress(&id).is_err());
    }

    #[tokio::test]
    async fn askpass_requires_the_nonce_and_keeps_answers_out_of_progress() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (cancel, _) = watch::channel(false);
        let job = Arc::new(Job {
            progress: Mutex::new(Progress {
                id: "test".into(),
                state: "running".into(),
                directory: String::new(),
                lines: VecDeque::new(),
                error: String::new(),
                prompt: None,
            }),
            cancel,
            answer: Mutex::new(None),
        });
        let jobs = Jobs(Mutex::new(Some(job.clone())));
        let auth = tokio::spawn(authenticate(listener, "nonce".into(), job));
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket
            .write_all(br#"{"nonce":"wrong","prompt":"Password"}"#)
            .await
            .unwrap();
        socket.shutdown().await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(jobs.progress("test").unwrap().prompt.is_none());
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket
            .write_all(br#"{"nonce":"nonce","prompt":"Password for test"}"#)
            .await
            .unwrap();
        socket.shutdown().await.unwrap();
        let prompt = loop {
            if let Some(prompt) = jobs.progress("test").unwrap().prompt {
                break prompt;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert!(prompt.secret);
        assert!(jobs.answer("test", prompt.id + 1, "secret".into()).is_err());
        jobs.answer("test", prompt.id, "secret".into()).unwrap();
        let mut answer = String::new();
        socket.read_to_string(&mut answer).await.unwrap();
        assert_eq!(answer, "secret");
        assert!(!serde_json::to_string(&jobs.progress("test").unwrap())
            .unwrap()
            .contains("secret"));
        auth.abort();
    }
}

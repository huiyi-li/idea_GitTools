use super::models::{CloneRequest, Repository};
use std::path::{Component, Path};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

pub fn clone_url(repository: &Repository, protocol: &str, alias: &str) -> Result<String, String> {
    match protocol {
        "https" => {
            let url =
                reqwest::Url::parse(&repository.https_url).map_err(|_| "仓库 HTTPS 地址无效")?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("仓库 HTTPS 地址无效".into());
            }
            Ok(url.to_string())
        }
        "ssh" => {
            if !alias
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                || alias.starts_with('-')
            {
                return Err("SSH Host 别名只能包含字母、数字、点、下划线或短横线".into());
            }
            let source = &repository.ssh_url;
            if source.starts_with("ssh://") {
                let mut url = reqwest::Url::parse(source).map_err(|_| "仓库 SSH 地址无效")?;
                if url.host_str().is_none()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || url.username().starts_with('-')
                {
                    return Err("仓库 SSH 地址无效".into());
                }
                if !alias.is_empty() {
                    url.set_host(Some(alias)).map_err(|_| "SSH Host 别名无效")?;
                    url.set_port(None).map_err(|_| "SSH 地址无效")?;
                }
                Ok(url.to_string())
            } else {
                let (host, path) = source.split_once(':').ok_or("仓库 SSH 地址无效")?;
                let (user, host) = host.split_once('@').ok_or("仓库 SSH 地址无效")?;
                if user.is_empty()
                    || host.is_empty()
                    || path.is_empty()
                    || path.starts_with('-')
                    || !user
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                    || user.starts_with('-')
                    || !host
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
                    || source.chars().any(char::is_whitespace)
                {
                    return Err("仓库 SSH 地址无效".into());
                }
                Ok(format!(
                    "{user}@{}:{path}",
                    if alias.is_empty() { host } else { alias }
                ))
            }
        }
        _ => Err("请选择 SSH 或 HTTPS 克隆方式".into()),
    }
}

pub async fn clone_repository(
    repository: Repository,
    request: CloneRequest,
) -> Result<String, String> {
    clone_with_git(repository, request, Command::new("git")).await
}

async fn clone_with_git(
    repository: Repository,
    request: CloneRequest,
    mut command: Command,
) -> Result<String, String> {
    let directory = Path::new(&request.directory);
    if request.directory.is_empty()
        || directory.components().count() != 1
        || !matches!(directory.components().next(), Some(Component::Normal(_)))
        || request.directory.contains(['/', '\\', ':'])
        || request.directory.starts_with('.')
        || request.directory.ends_with(['.', ' '])
    {
        return Err("请输入有效的单级目录名称".into());
    }
    let parent = std::fs::canonicalize(&request.parent).map_err(|_| "请选择已存在的克隆父目录")?;
    if !parent.is_dir() {
        return Err("克隆父目录无效".into());
    }
    let destination = parent.join(directory);
    let remote = clone_url(&repository, &request.protocol, request.ssh_alias.trim())?;
    // Reserve a new directory. Never clone over an existing working copy.
    std::fs::create_dir(&destination).map_err(|_| "目标目录已存在或无法创建，请更换目录名称")?;
    command
        .args(["clone", "--", &remote])
        .arg(&request.directory)
        .current_dir(&parent)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动 Git，请检查系统 PATH。新建目标目录已保留")?;
    let stdout = child.stdout.take().ok_or("Git stdout 不可用")?;
    let stderr = child.stderr.take().ok_or("Git stderr 不可用")?;
    let operation = async {
        let (_, _, status) = tokio::try_join!(
            crate::git::read_limited(stdout),
            crate::git::read_limited(stderr),
            async { child.wait().await.map_err(|e| e.to_string()) },
        )?;
        if !status.success() {
            return Err("Git 克隆失败，请检查 SSH 密钥或 Git 凭据管理器。目标目录已保留，请检查后更换目录重试".into());
        }
        Ok(crate::git::git_path(&destination))
    };
    let result = match tokio::time::timeout(Duration::from_secs(600), operation).await {
        Ok(result) => result,
        Err(_) => Err("克隆超过 10 分钟，目标目录已保留，请检查网络后更换目录重试".into()),
    };
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(parent: &Path, directory: &str) -> (Repository, CloneRequest) {
        (
            Repository {
                id: "1".into(),
                path: "owner/repo".into(),
                name: "repo".into(),
                description: String::new(),
                default_branch: "main".into(),
                private: false,
                web_url: "https://fixture.example.test/owner/repo".into(),
                ssh_url: "git@fixture.example.test:owner/repo.git".into(),
                https_url: "https://fixture.example.test/owner/repo.git".into(),
            },
            CloneRequest {
                account_id: "test".into(),
                repository: "owner/repo".into(),
                parent: parent.to_string_lossy().into_owned(),
                directory: directory.into(),
                protocol: "https".into(),
                ssh_alias: String::new(),
            },
        )
    }

    #[tokio::test]
    async fn clone_refuses_existing_and_outside_directories_without_modifying_files() {
        let parent = tempfile::tempdir().unwrap();
        std::fs::create_dir(parent.path().join("existing")).unwrap();
        std::fs::write(parent.path().join("existing/keep.txt"), "preserve").unwrap();
        for name in ["existing", "../outside", "C:\\outside", "a/b"] {
            let (repository, request) = fixture(parent.path(), name);
            assert!(clone_repository(repository, request).await.is_err());
        }
        assert_eq!(
            std::fs::read_to_string(parent.path().join("existing/keep.txt")).unwrap(),
            "preserve"
        );
    }

    #[tokio::test]
    async fn clone_runs_system_git_and_returns_an_openable_repository() {
        let parent = tempfile::tempdir().unwrap();
        let source = parent.path().join("source");
        std::fs::create_dir(&source).unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args([
                    "-c",
                    "core.hooksPath=disabled-hooks",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .current_dir(&source)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-b", "main"]);
        std::fs::write(source.join("file.txt"), "source contents\n").unwrap();
        git(&["add", "file.txt"]);
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-m",
            "Fixture",
        ]);
        let (repository, request) = fixture(parent.path(), "cloned");
        let mut command = Command::new("git");
        command.args(["-c", "core.autocrlf=false"]);
        let mapping = format!(
            "url.{}.insteadOf=https://fixture.example.test/owner/repo.git",
            source.to_string_lossy().replace('\\', "/")
        );
        command.args(["-c", &mapping]);
        let path = clone_with_git(repository, request, command).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&path).join("file.txt")).unwrap(),
            "source contents\n"
        );
        let repository = crate::git::Git::open(&path, None).await.unwrap();
        assert_eq!(
            repository
                .status()
                .await
                .unwrap()
                .repository
                .branch
                .as_deref(),
            Some("main")
        );
    }
}

use super::*;
use accounts::Credentials;
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;

#[derive(Default)]
pub(super) struct MemoryCredentials(Mutex<HashMap<String, String>>);

impl Credentials for MemoryCredentials {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    fn set(&self, id: &str, token: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(id.into(), token.into());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

fn account() -> Account {
    Account {
        id: api::account_id(Provider::Github, "https://github.com", "1"),
        provider: Provider::Github,
        server: "https://github.com".into(),
        user_id: "1".into(),
        login: "developer".into(),
    }
}

fn mock(
    provider: Provider,
    status: u16,
    response: serde_json::Value,
) -> (Api, std::thread::JoinHandle<String>) {
    mock_many(provider, vec![(status, response.to_string())])
}

pub(super) fn mock_many(
    provider: Provider,
    responses: Vec<(u16, String)>,
) -> (Api, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let task = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "API did not connect to the mock server"
                        );
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut data = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                data.extend_from_slice(&buffer[..count]);
                if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|v| v.parse().ok())
                        })
                        .unwrap_or(0);
                    if data.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            write!(stream, "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            requests.push(String::from_utf8(data).unwrap());
        }
        requests.join("\n---\n")
    });
    (
        Api {
            client: api::client().unwrap(),
            provider,
            server: format!("http://{address}"),
            token: "fixture-token".into(),
        },
        task,
    )
}

#[test]
fn server_addresses_and_repository_paths_are_validated() {
    assert_eq!(
        api::normalize_server(" https://GITLAB.example.test/team/ ").unwrap(),
        "https://gitlab.example.test/team"
    );
    for server in [
        "http://gitlab.test",
        "https://user:secret@gitlab.test",
        "https://gitlab.test?token=secret",
        "https://gitlab.test/#fragment",
    ] {
        assert!(api::normalize_server(server).is_err(), "{server}");
    }
    assert!(api::repository_path(Provider::Gitlab, "group/sub/project").is_ok());
    for path in [
        "group/../repo",
        "/group/repo",
        "group/repo?token=x",
        "group\\repo",
    ] {
        assert!(
            api::repository_path(Provider::Gitlab, path).is_err(),
            "{path}"
        );
    }
    assert!(api::repository_path(Provider::Github, "group/sub/repo").is_err());
}

#[test]
fn accounts_persist_only_metadata_and_relogin_updates_one_entry() {
    let directory = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let store = AccountStore::new(directory.path().into(), credentials.clone());
    store.save(account(), "first-secret").unwrap();
    store.save(account(), "second-secret").unwrap();
    assert_eq!(store.list().unwrap().len(), 1);
    assert_eq!(store.session(&account().id).unwrap().1, "second-secret");
    let disk = std::fs::read_to_string(directory.path().join("hosting-accounts.json")).unwrap();
    assert!(!disk.contains("secret"));
    store.remove(&account().id).unwrap();
    assert!(store.list().unwrap().is_empty());
    assert!(credentials.get(&account().id).unwrap().is_none());
    assert!(store.session(&account().id).is_err());
}

#[test]
fn failed_account_writes_restore_credentials() {
    struct FailPersistence {
        credentials: MemoryCredentials,
        path: std::path::PathBuf,
    }
    impl Credentials for FailPersistence {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            self.credentials.get(id)
        }
        fn set(&self, id: &str, token: &str) -> Result<(), String> {
            self.credentials.set(id, token)?;
            if token == "new-secret" {
                std::fs::rename(&self.path, self.path.with_extension("backup")).unwrap();
                std::fs::create_dir(&self.path).unwrap();
            }
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.credentials.delete(id)
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let credentials = Arc::new(FailPersistence {
        credentials: MemoryCredentials::default(),
        path: directory.path().join("hosting-accounts.json"),
    });
    let store = AccountStore::new(directory.path().into(), credentials.clone());
    store.save(account(), "old-secret").unwrap();
    assert!(store.save(account(), "new-secret").is_err());
    assert_eq!(
        credentials.get(&account().id).unwrap().as_deref(),
        Some("old-secret")
    );
}

#[tokio::test]
async fn github_identity_uses_authenticated_api_and_stable_user_id() {
    let (api, task) = mock(
        Provider::Github,
        200,
        json!({"id": 42, "login": "developer"}),
    );
    let identity = api.identity().await.unwrap();
    assert_eq!(identity.user_id, "42");
    assert_eq!(identity.login, "developer");
    assert_eq!(identity.id.len(), 64);
    let request = task.join().unwrap();
    assert!(request.starts_with("GET /api/v3/user "));
    assert!(request
        .to_lowercase()
        .contains("authorization: bearer fixture-token"));
}

#[tokio::test]
async fn gitlab_repositories_keep_nested_namespaces() {
    let (api, task) = mock(
        Provider::Gitlab,
        200,
        json!({"id": 5,"name": "project", "path_with_namespace": "group/sub/project", "visibility": "private", "default_branch":"main"}),
    );
    let repo = api.repository("group/sub/project").await.unwrap();
    assert_eq!(repo.path, "group/sub/project");
    assert!(repo.private);
    assert!(task
        .join()
        .unwrap()
        .starts_with("GET /api/v4/projects/group%2Fsub%2Fproject "));
}

#[tokio::test]
async fn github_create_request_preserves_draft_and_explicit_branches() {
    let (api, task) = mock(
        Provider::Github,
        201,
        json!({"number": 7, "title": "Feature", "state": "open", "merged_at":null}),
    );
    let review = api
        .create_review(
            "owner/repo",
            CreateReview {
                title: "Feature".into(),
                body: "Description".into(),
                source_branch: "feature".into(),
                target_branch: "main".into(),
                draft: true,
            },
        )
        .await
        .unwrap();
    assert_eq!(review.number, 7);
    let request = task.join().unwrap();
    assert!(request.starts_with("POST /api/v3/repos/owner/repo/pulls "));
    let body: serde_json::Value =
        serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["draft"], true);
    assert_eq!(body["head"], "feature");
    assert_eq!(body["base"], "main");
}

#[tokio::test]
async fn gitlab_state_and_comment_endpoints_use_iid() {
    let (api, task) = mock(
        Provider::Gitlab,
        200,
        json!({"id": 1234, "iid": 7, "title":"Feature", "state":"closed"}),
    );
    assert_eq!(
        api.change_state("group/project", 7, "close")
            .await
            .unwrap()
            .number,
        7
    );
    let request = task.join().unwrap();
    assert!(request.starts_with("PUT /api/v4/projects/group%2Fproject/merge_requests/7 "));
    assert!(request.contains("\"state_event\":\"close\""));
    let (api, task) = mock(
        Provider::Github,
        201,
        json!({"id": 2,"body":"Comment", "user":{"login":"dev"}}),
    );
    assert_eq!(
        api.comment("owner/repo", 7, "Comment".into())
            .await
            .unwrap()
            .author,
        "dev"
    );
    assert!(task
        .join()
        .unwrap()
        .starts_with("POST /api/v3/repos/owner/repo/issues/7/comments "));
}

#[tokio::test]
async fn api_errors_do_not_expose_tokens_or_response_bodies() {
    for status in [401, 403, 404, 409, 422, 429, 500] {
        let (api, task) = mock(
            Provider::Github,
            status,
            json!({"message":"fixture-token secret response"}),
        );
        let error = api.identity().await.unwrap_err();
        assert!(!error.contains("fixture-token"));
        assert!(!error.contains("secret response"));
        task.join().unwrap();
    }
}

#[test]
fn clone_remote_validation_and_ssh_alias_are_explicit() {
    let api = Api {
        client: api::client().unwrap(),
        provider: Provider::Github,
        server: "https://github.com".into(),
        token: String::new(),
    };
    let mut repo = api.parse_repository(&json!({"id":1,"full_name":"owner/repo","ssh_url":"git@github.com:owner/repo.git","clone_url":"https://github.com/owner/repo.git"})).unwrap();
    assert_eq!(
        clone::clone_url(&repo, "ssh", "github_ming").unwrap(),
        "git@github_ming:owner/repo.git"
    );
    assert!(clone::clone_url(&repo, "ssh", "-oProxyCommand=bad").is_err());
    repo.https_url = "https://token@github.com/owner/repo.git".into();
    assert!(clone::clone_url(&repo, "https", "").is_err());
    repo.ssh_url = "ext::command".into();
    assert!(clone::clone_url(&repo, "ssh", "").is_err());
}

#[tokio::test]
async fn github_diff_uses_merge_base_and_reads_fork_content_at_immutable_shas() {
    let detail = json!({"number":7,"title":"Fork change","state":"open","head":{"sha":"head-sha","repo":{"full_name":"contributor/fork"}},"base":{"sha":"target-sha"}});
    let (api, task) = mock_many(
        Provider::Github,
        vec![
            (200, detail.to_string()),
            (
                200,
                json!({"merge_base_commit":{"sha":"merge-base-sha"}}).to_string(),
            ),
            (200, "old content\n".into()),
            (200, "new content\n".into()),
        ],
    );
    let diff = api
        .file_diff(
            "owner/repo",
            RemoteFileRequest {
                number: 7,
                path: "src/new name.ts".into(),
                old_path: "src/old name.ts".into(),
                status: "renamed".into(),
                head_sha: "head-sha".into(),
                base_sha: "target-sha".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(diff.before, "old content\n");
    assert_eq!(diff.after, "new content\n");
    let requests = task.join().unwrap();
    assert!(requests.contains("GET /api/v3/repos/owner/repo/compare/target-sha...head-sha "));
    assert!(requests
        .contains("GET /api/v3/repos/owner/repo/contents/src/old%20name.ts?ref=merge-base-sha "));
    assert!(requests
        .contains("GET /api/v3/repos/contributor/fork/contents/src/new%20name.ts?ref=head-sha "));
    assert!(requests.contains("application/vnd.github.raw+json"));
}

#[tokio::test]
async fn gitlab_diff_uses_source_project_and_handles_added_binary_and_large_files() {
    for (content, binary, too_large) in [
        ("new content\n".to_owned(), false, false),
        ("binary\0content".to_owned(), true, false),
        ("line\n".repeat(20001), false, true),
        ("x".repeat(1024 * 1024 + 1), false, true),
    ] {
        let detail = json!({"iid":7,"title":"Added file","state":"opened","source_project_id":42,"sha":"head-sha","diff_refs":{"base_sha":"base-sha"}});
        let (api, task) = mock_many(
            Provider::Gitlab,
            vec![(200, detail.to_string()), (200, content.clone())],
        );
        let diff = api
            .file_diff(
                "group/sub/project",
                RemoteFileRequest {
                    number: 7,
                    path: "src/file.ts".into(),
                    old_path: String::new(),
                    status: "added".into(),
                    head_sha: "head-sha".into(),
                    base_sha: "base-sha".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(diff.before, "");
        assert_eq!(diff.binary, binary);
        assert_eq!(diff.too_large, too_large);
        if !binary && !too_large {
            assert_eq!(diff.after, content);
        }
        let requests = task.join().unwrap();
        assert!(requests
            .contains("GET /api/v4/projects/42/repository/files/src%2Ffile.ts/raw?ref=head-sha "));
    }
}

#[tokio::test]
async fn stale_remote_snapshots_are_rejected_before_reading_file_contents() {
    let (api, task) = mock(
        Provider::Github,
        200,
        json!({"number":7,"title":"Updated","state":"open","head":{"sha":"new-sha"},"base":{"sha":"base-sha"}}),
    );
    let error = api
        .file_diff(
            "owner/repo",
            RemoteFileRequest {
                number: 7,
                path: "src/file.ts".into(),
                old_path: String::new(),
                status: "modified".into(),
                head_sha: "old-sha".into(),
                base_sha: "base-sha".into(),
            },
        )
        .await
        .err()
        .unwrap();
    assert!(error.contains("远程提交已更新"));
    assert!(!task.join().unwrap().contains("/contents/"));
}

#[tokio::test]
async fn repository_pagination_and_gitlab_drafts_use_provider_specific_fields() {
    let (api, task) = mock(Provider::Gitlab, 200, json!([]));
    assert!(!api.repositories(2).await.unwrap().has_more);
    let request = task.join().unwrap();
    assert!(request.contains("page=2"));
    assert!(request.contains("membership=true"));
    let (api, task) = mock(
        Provider::Gitlab,
        201,
        json!({"iid":9,"title":"Draft: Feature","state":"opened","draft":true}),
    );
    let review = api
        .create_review(
            "group/sub/project",
            CreateReview {
                title: "Feature".into(),
                body: "Body".into(),
                source_branch: "feature".into(),
                target_branch: "main".into(),
                draft: true,
            },
        )
        .await
        .unwrap();
    assert!(review.draft);
    assert_eq!(review.state, "open");
    let request = task.join().unwrap();
    let body: serde_json::Value =
        serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["title"], "Draft: Feature");
    assert_eq!(body["source_branch"], "feature");
}

#[test]
fn altered_account_servers_cannot_reuse_another_server_credential() {
    let directory = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let store = AccountStore::new(directory.path().into(), credentials);
    store.save(account(), "secret").unwrap();
    let mut altered = account();
    altered.server = "https://other.example.test".into();
    std::fs::write(
        directory.path().join("hosting-accounts.json"),
        serde_json::to_vec(&vec![altered]).unwrap(),
    )
    .unwrap();
    assert!(store.session(&account().id).unwrap_err().contains("不匹配"));
}

#[cfg(windows)]
#[test]
fn windows_native_credentials_round_trip_uses_an_isolated_entry() {
    let directory = tempfile::tempdir().unwrap();
    let id = format!(
        "test-{}",
        directory.path().file_name().unwrap().to_string_lossy()
    );
    let credentials = NativeCredentials;
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = NativeCredentials.delete(&self.0);
        }
    }
    let _cleanup = Cleanup(id.clone());
    credentials.set(&id, "isolated-test-value").unwrap();
    assert_eq!(
        credentials.get(&id).unwrap().as_deref(),
        Some("isolated-test-value")
    );
    credentials.delete(&id).unwrap();
    assert!(credentials.get(&id).unwrap().is_none());
}

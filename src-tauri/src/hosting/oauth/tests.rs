use super::*;
use crate::hosting::tests::{mock_many, MemoryCredentials};
use serde_json::json;

fn fixture(server: &str, provider: Provider) -> (tempfile::TempDir, Arc<AccountStore>, Account) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AccountStore::new(
        directory.path().into(),
        Arc::new(MemoryCredentials::default()),
    ));
    let account = Account {
        id: api::account_id(provider, server, "1"),
        provider,
        server: server.into(),
        user_id: "1".into(),
        login: "ming".into(),
    };
    (directory, store, account)
}

async fn attempt(logins: &Logins, provider: Provider, server: &str, flow: Flow) -> Arc<Attempt> {
    let start = LoginStart {
        id: random_token().unwrap(),
        url: "https://example.test/authorize".into(),
        user_code: None,
        expires_at: now() + 300,
    };
    let value = Arc::new(Attempt {
        provider,
        server: server.into(),
        client_id: "our-public-client-id".into(),
        start,
        deadline: Instant::now() + Duration::from_secs(300),
        flow: Mutex::new(Some(flow)),
        phase: AtomicU8::new(WAITING),
        cancel: Notify::new(),
    });
    logins
        .0
        .lock()
        .await
        .insert(value.start.id.clone(), value.clone());
    value
}

#[test]
fn pkce_matches_the_rfc_vector_and_callback_requires_the_matching_state_and_host() {
    assert_eq!(
        challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    assert_eq!(
        callback_code(
            "/oauth/callback?state=expected&code=accepted",
            "127.0.0.1:1",
            "127.0.0.1:1",
            "expected"
        )
        .unwrap(),
        Some("accepted".into())
    );
    for (target, host) in [
        ("/oauth/callback?state=wrong&code=secret", "127.0.0.1:1"),
        (
            "/oauth/callback?state=expected&state=wrong&code=secret",
            "127.0.0.1:1",
        ),
        ("/oauth/callback?state=expected&code=secret", "other.test"),
        ("/elsewhere?state=expected&code=secret", "127.0.0.1:1"),
    ] {
        assert_eq!(
            callback_code(target, host, "127.0.0.1:1", "expected").unwrap(),
            None
        );
    }
    assert!(callback_code(
        "/oauth/callback?state=expected&error=access_denied&error_description=secret",
        "127.0.0.1:1",
        "127.0.0.1:1",
        "expected"
    )
    .unwrap_err()
    .contains("拒绝"));
}

#[tokio::test]
async fn github_device_login_validates_identity_and_stores_credentials_only_in_the_vault() {
    let token = json!({"access_token":"secret-access", "refresh_token":"secret-refresh", "expires_in":28800,"token_type":"bearer"});
    let (api, server) = mock_many(
        Provider::Github,
        vec![
            (200, token.to_string()),
            (200, json!({"id":1,"login":"ming"}).to_string()),
        ],
    );
    let (directory, store, _) = fixture(&api.server, Provider::Github);
    let logins = Logins::default();
    let value = attempt(
        &logins,
        Provider::Github,
        &api.server,
        Flow::Device {
            code: "private-device-code".into(),
            interval: 0,
        },
    )
    .await;
    let account = finish(&logins, &api.client, &store, value.start.id.clone())
        .await
        .unwrap();
    assert_eq!(account.login, "ming");
    let stored = store.session(&account.id).unwrap().1;
    assert!(stored.starts_with(CREDENTIAL_PREFIX));
    assert_eq!(
        access_token(&api.client, &store, &account, stored)
            .await
            .unwrap(),
        "secret-access"
    );
    let disk = std::fs::read_to_string(directory.path().join("hosting-accounts.json")).unwrap();
    assert!(!disk.contains("secret"));
    let requests = server.join().unwrap();
    assert!(requests.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"));
    assert!(requests.contains("authorization: Bearer secret-access"));
    assert!(!requests.contains("client_secret"));
    assert!(logins.0.lock().await.is_empty());
    assert!(finish(&logins, &api.client, &store, value.start.id.clone())
        .await
        .is_err());
}

#[tokio::test]
async fn loopback_callback_ignores_foreign_states_and_redirects_to_a_code_free_page() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { callback(&listener, "expected-state").await });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let wrong = client
        .get(format!(
            "http://{address}/oauth/callback?state=foreign&code=private-code"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status().as_u16(), 400);
    let response = client
        .get(format!(
            "http://{address}/oauth/callback?state=expected-state&code=private-code"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 303);
    assert_eq!(response.headers()["location"], "/oauth/complete");
    let landing = client
        .get(format!("http://{address}/oauth/complete"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!landing.contains("private-code"));
    assert_eq!(server.await.unwrap().unwrap(), "private-code");
    assert!(TcpListener::bind(address).await.is_ok());
}

#[tokio::test]
async fn gitlab_pkce_exchanges_the_verifier_and_refreshes_rotating_tokens() {
    let first = json!({"access_token":"first-access","refresh_token":"first-refresh","expires_in":1,"token_type":"Bearer"});
    let second = json!({"access_token":"next-access","refresh_token":"next-refresh","expires_in":7200,"token_type":"Bearer"});
    let (api, server) = mock_many(
        Provider::Gitlab,
        vec![
            (200, first.to_string()),
            (200, json!({"id":1,"username":"ming"}).to_string()),
            (200, second.to_string()),
        ],
    );
    let (directory, store, _) = fixture(&api.server, Provider::Gitlab);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let logins = Arc::new(Logins::default());
    let value = attempt(
        &logins,
        Provider::Gitlab,
        &api.server,
        Flow::Pkce {
            listener,
            state: "match".into(),
            verifier: "private-verifier".into(),
        },
    )
    .await;
    let (pending_logins, client, pending_store, id) = (
        logins.clone(),
        api.client.clone(),
        store.clone(),
        value.start.id.clone(),
    );
    let pending =
        tokio::spawn(async move { finish(&pending_logins, &client, &pending_store, id).await });
    let callback_client = reqwest::Client::new();
    callback_client
        .get(format!(
            "http://{address}/oauth/callback?state=match&code=callback-code"
        ))
        .send()
        .await
        .unwrap();
    let account = pending.await.unwrap().unwrap();
    let stored = store.session(&account.id).unwrap().1;
    let refreshed = access_token(&api.client, &store, &account, stored)
        .await
        .unwrap();
    assert_eq!(refreshed, "next-access");
    let stored = store.session(&account.id).unwrap().1;
    assert!(stored.contains("next-refresh"));
    assert!(!stored.contains("first-refresh"));
    let disk = std::fs::read_to_string(directory.path().join("hosting-accounts.json")).unwrap();
    assert!(!disk.contains("refresh"));
    let requests = server.join().unwrap();
    assert!(requests.contains("code_verifier=private-verifier"));
    assert!(requests.contains("refresh_token=first-refresh"));
    assert!(!requests.contains("client_secret"));
}

#[tokio::test]
async fn cancellation_releases_the_callback_port_and_never_saves_an_account() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let logins = Arc::new(Logins::default());
    let (directory, store, _) = fixture("https://gitlab.example.test", Provider::Gitlab);
    let value = attempt(
        &logins,
        Provider::Gitlab,
        "https://gitlab.example.test",
        Flow::Pkce {
            listener,
            state: "state".into(),
            verifier: "verifier".into(),
        },
    )
    .await;
    let (pending_logins, client, pending_store, id) = (
        logins.clone(),
        api::client().unwrap(),
        store.clone(),
        value.start.id.clone(),
    );
    let pending =
        tokio::spawn(async move { finish(&pending_logins, &client, &pending_store, id).await });
    tokio::task::yield_now().await;
    assert!(logins.cancel(&value.start.id).await);
    assert!(pending.await.unwrap().unwrap_err().contains("取消"));
    assert!(store.list().unwrap().is_empty());
    assert!(!directory.path().join("hosting-accounts.json").exists());
    assert!(TcpListener::bind(address).await.is_ok());
}

#[tokio::test]
async fn oauth_failures_are_sanitized_and_legacy_pat_credentials_remain_usable() {
    let (api, server) = mock_many(
        Provider::Github,
        vec![(
            400,
            json!({"error":"access_denied","error_description":"private-token-body"}).to_string(),
        )],
    );
    let (_, store, account) = fixture(&api.server, Provider::Github);
    let logins = Logins::default();
    let value = attempt(
        &logins,
        Provider::Github,
        &api.server,
        Flow::Device {
            code: "secret-device-code".into(),
            interval: 0,
        },
    )
    .await;
    let error = finish(&logins, &api.client, &store, value.start.id.clone())
        .await
        .unwrap_err();
    assert!(error.contains("拒绝"));
    assert!(!error.contains("private-token-body"));
    assert!(!error.contains("secret-device-code"));
    assert!(store.list().unwrap().is_empty());
    assert_eq!(
        access_token(&api.client, &store, &account, "old-personal-token".into())
            .await
            .unwrap(),
        "old-personal-token"
    );
    server.join().unwrap();
}

#[tokio::test]
async fn concurrent_sessions_refresh_rotating_credentials_once() {
    let response = json!({"access_token":"new-access","refresh_token":"new-refresh","expires_in":7200,"token_type":"bearer"});
    let (api, server) = mock_many(Provider::Gitlab, vec![(200, response.to_string())]);
    let (_directory, store, account) = fixture(&api.server, Provider::Gitlab);
    save(
        store.clone(),
        account.clone(),
        Credential {
            provider: Provider::Gitlab,
            server: api.server.clone(),
            client_id: "app".into(),
            access_token: "expired-access".into(),
            refresh_token: Some("old-refresh".into()),
            expires_at: Some(1),
        },
    )
    .await
    .unwrap();
    let session = || {
        let (client, store, account) = (api.client.clone(), store.clone(), account.clone());
        async move {
            let pending_store = store.clone();
            let _guard = tokio::task::spawn_blocking(move || pending_store.session_guard())
                .await
                .unwrap()
                .unwrap();
            let token = store.session(&account.id).unwrap().1;
            access_token(&client, &store, &account, token)
                .await
                .unwrap()
        }
    };
    let (first, second) = tokio::join!(session(), session());
    assert_eq!(first, "new-access");
    assert_eq!(second, "new-access");
    let requests = server.join().unwrap();
    assert_eq!(requests.matches("POST ").count(), 1);
}

#[tokio::test]
async fn invalid_configuration_is_rejected_before_connecting_and_platform_binding_is_checked() {
    let logins = Logins::default();
    let client = api::client().unwrap();
    for (server, client_id) in [
        ("http://github.test", "id"),
        ("https://github.com", ""),
        ("https://github.com", "id with spaces"),
    ] {
        assert!(logins
            .start(
                &client,
                StartRequest {
                    provider: Provider::Github,
                    server: server.into(),
                    client_id: client_id.into()
                }
            )
            .await
            .is_err());
    }
    let (_, store, account) = fixture("https://github.com", Provider::Github);
    let value = Credential {
        provider: Provider::Gitlab,
        server: "https://other.test".into(),
        client_id: "client".into(),
        access_token: "secret".into(),
        refresh_token: None,
        expires_at: None,
    };
    let stored = format!(
        "{CREDENTIAL_PREFIX}{}",
        serde_json::to_string(&value).unwrap()
    );
    assert!(access_token(&client, &store, &account, stored)
        .await
        .unwrap_err()
        .contains("不匹配"));
}

#[test]
fn token_metadata_is_validated_before_persistence() {
    for value in [
        json!({"access_token":"secret","token_type":"bearer","expires_in":0}),
        json!({"access_token":"secret","token_type":"bearer","expires_in":"bad"}),
        json!({"access_token":"secret","token_type":"bearer","refresh_token":"invalid token"}),
        json!({"access_token":"secret","token_type":"other"}),
    ] {
        let error = credential(Provider::Github, "https://github.com", "client", &value)
            .err()
            .unwrap();
        assert!(!error.contains("secret"));
    }
}

#[tokio::test]
async fn refresh_keeps_rotated_credentials_when_account_metadata_cannot_be_rewritten() {
    use crate::hosting::accounts::Credentials;

    struct MetadataFailure {
        vault: MemoryCredentials,
        path: std::path::PathBuf,
    }
    impl Credentials for MetadataFailure {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            self.vault.get(id)
        }
        fn set(&self, id: &str, token: &str) -> Result<(), String> {
            self.vault.set(id, token)?;
            if token.contains("rotated-refresh") {
                std::fs::rename(&self.path, self.path.with_extension("backup")).unwrap();
                std::fs::create_dir(&self.path).unwrap();
            }
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.vault.delete(id)
        }
    }
    let (api, server) = mock_many(
        Provider::Gitlab,
        vec![(
            200,
            json!({"access_token":"rotated-access","refresh_token":"rotated-refresh",
            "expires_in":7200,"token_type":"bearer"})
            .to_string(),
        )],
    );
    let (directory, _, account) = fixture(&api.server, Provider::Gitlab);
    let vault = Arc::new(MetadataFailure {
        vault: MemoryCredentials::default(),
        path: directory.path().join("hosting-accounts.json"),
    });
    let store = Arc::new(AccountStore::new(directory.path().into(), vault.clone()));
    save(
        store.clone(),
        account.clone(),
        Credential {
            provider: Provider::Gitlab,
            server: api.server.clone(),
            client_id: "client".into(),
            access_token: "expired-access".into(),
            refresh_token: Some("expired-refresh".into()),
            expires_at: Some(1),
        },
    )
    .await
    .unwrap();
    let original = store.session(&account.id).unwrap().1;
    assert_eq!(
        access_token(&api.client, &store, &account, original)
            .await
            .unwrap(),
        "rotated-access"
    );
    let persisted = vault.get(&account.id).unwrap().unwrap();
    assert!(persisted.contains("rotated-refresh"));
    assert!(!persisted.contains("expired-refresh"));
    server.join().unwrap();
}

#[test]
fn refreshed_credentials_cannot_restore_removed_accounts_or_overwrite_a_new_login() {
    let (_directory, store, account) = fixture("https://gitlab.example.test", Provider::Gitlab);
    store.save(account.clone(), "old").unwrap();
    store.save(account.clone(), "new-login").unwrap();
    assert!(store
        .replace_token(&account.id, "old", "refreshed")
        .is_err());
    assert_eq!(store.session(&account.id).unwrap().1, "new-login");
    store.remove(&account.id).unwrap();
    assert!(store
        .replace_token(&account.id, "new-login", "refreshed")
        .is_err());
    assert!(store.list().unwrap().is_empty());
}

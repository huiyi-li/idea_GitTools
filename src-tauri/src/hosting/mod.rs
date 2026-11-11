mod accounts;
mod api;
mod clone;
pub mod commands;
mod models;
pub mod oauth;
pub mod read;

use accounts::{AccountStore, NativeCredentials};
use api::{client, Api};
use models::*;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub struct Hosting {
    client: reqwest::Client,
    store: Arc<AccountStore>,
    requests: Arc<Semaphore>,
    reads: read::Reads,
    oauth: oauth::Logins,
}

impl Hosting {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        Ok(Self {
            client: client()?,
            store: Arc::new(AccountStore::new(directory, Arc::new(NativeCredentials))),
            requests: Arc::new(Semaphore::new(4)),
            reads: read::Reads::default(),
            oauth: oauth::Logins::default(),
        })
    }

    async fn permit(&self) -> Result<OwnedSemaphorePermit, String> {
        self.requests
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "平台服务已关闭".into())
    }

    async fn session(&self, account_id: String) -> Result<Api, String> {
        let store = self.store.clone();
        let _guard = tokio::task::spawn_blocking(move || store.session_guard())
            .await
            .map_err(|_| "读取账户失败")??;
        let store = self.store.clone();
        let (account, token) = tokio::task::spawn_blocking(move || store.session(&account_id))
            .await
            .map_err(|_| "读取账户失败")??;
        let server = api::normalize_server(&account.server)?;
        let token = oauth::access_token(&self.client, &self.store, &account, token).await?;
        Ok(Api {
            client: self.client.clone(),
            provider: account.provider,
            server,
            token,
        })
    }
}

#[cfg(test)]
mod tests;

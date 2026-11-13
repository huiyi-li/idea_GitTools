use super::{commands, models::RemoteFileRequest, Hosting};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::State;
use tokio::sync::oneshot;

#[derive(Default)]
pub struct Reads(Arc<Mutex<HashMap<String, Option<oneshot::Sender<()>>>>>);

struct ReadGuard {
    id: String,
    reads: Arc<Mutex<HashMap<String, Option<oneshot::Sender<()>>>>>,
}

impl Drop for ReadGuard {
    fn drop(&mut self) {
        if let Ok(mut reads) = self.reads.lock() {
            reads.remove(&self.id);
        }
    }
}

impl Reads {
    fn register(&self, id: String) -> Result<(ReadGuard, oneshot::Receiver<()>), String> {
        if id.is_empty() || id.len() > 128 {
            return Err("请求标识无效".into());
        }
        let mut reads = self.0.lock().map_err(|_| "平台请求状态不可用")?;
        if reads.len() >= 64 || reads.contains_key(&id) {
            return Err("平台请求过多，请稍后重试".into());
        }
        let (sender, receiver) = oneshot::channel();
        reads.insert(id.clone(), Some(sender));
        Ok((
            ReadGuard {
                id,
                reads: self.0.clone(),
            },
            receiver,
        ))
    }

    fn cancel(&self, id: &str) {
        if let Ok(mut reads) = self.0.lock() {
            if let Some(sender) = reads.get_mut(id).and_then(Option::take) {
                let _ = sender.send(());
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Accounts,
    Repositories,
    Repository,
    Reviews,
    Review,
    Comments,
    Files,
    Commits,
    Checks,
    FileDiff,
    Threads,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadRequest {
    kind: Kind,
    #[serde(default)]
    account_id: String,
    #[serde(default)]
    repository: String,
    #[serde(default)]
    number: u64,
    #[serde(default)]
    page: u32,
    #[serde(default)]
    filter: String,
    request: Option<RemoteFileRequest>,
    #[serde(default)]
    cursor: String,
}

fn value<T: Serialize>(result: Result<T, String>) -> Result<Value, String> {
    serde_json::to_value(result?).map_err(|_| "无法读取平台数据".into())
}

#[tauri::command]
pub async fn hosting_read(
    request_id: String,
    request: ReadRequest,
    state: State<'_, Hosting>,
) -> Result<Value, String> {
    let (_guard, cancelled) = state.reads.register(request_id)?;
    let operation = async {
        let ReadRequest {
            kind,
            account_id,
            repository,
            number,
            page,
            filter,
            request,
            cursor,
        } = request;
        match kind {
            Kind::Threads => value(
                commands::hosting_threads(account_id, repository, number, cursor, state).await,
            ),
            Kind::Accounts => value(commands::hosting_accounts(state).await),
            Kind::Repositories => {
                value(commands::hosting_repositories(account_id, page, state).await)
            }
            Kind::Repository => {
                value(commands::hosting_repository(account_id, repository, state).await)
            }
            Kind::Reviews => {
                value(commands::hosting_reviews(account_id, repository, filter, page, state).await)
            }
            Kind::Review => {
                value(commands::hosting_review(account_id, repository, number, state).await)
            }
            Kind::Comments => {
                value(commands::hosting_comments(account_id, repository, number, page, state).await)
            }
            Kind::Files => {
                value(commands::hosting_files(account_id, repository, number, page, state).await)
            }
            Kind::Commits => {
                value(commands::hosting_commits(account_id, repository, number, page, state).await)
            }
            Kind::Checks => {
                value(commands::hosting_checks(account_id, repository, number, state).await)
            }
            Kind::FileDiff => value(
                commands::hosting_file_diff(
                    account_id,
                    repository,
                    request.ok_or("文件请求无效")?,
                    state,
                )
                .await,
            ),
        }
    };
    tokio::select! {
        result = operation => result,
        _ = cancelled => Err("请求已取消".into()),
    }
}

#[tauri::command]
pub fn hosting_cancel_read(request_id: String, state: State<'_, Hosting>) {
    state.reads.cancel(&request_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelling_reads_releases_registered_requests() {
        let reads = Reads::default();
        let (guard, cancelled) = reads.register("old-account".into()).unwrap();
        assert!(reads.register("old-account".into()).is_err());
        reads.cancel("old-account");
        cancelled.await.unwrap();
        drop(guard);
        assert!(reads.0.lock().unwrap().is_empty());
        let (guard, _) = reads.register("next-account".into()).unwrap();
        drop(guard);
        assert!(reads.0.lock().unwrap().is_empty());
    }
}

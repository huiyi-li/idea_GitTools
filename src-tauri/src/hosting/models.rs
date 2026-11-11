use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Gitlab,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: Provider,
    pub server: String,
    pub user_id: String,
    pub login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    pub provider: Provider,
    pub server: String,
    pub token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub path: String,
    pub name: String,
    pub description: String,
    pub default_branch: String,
    pub private: bool,
    pub web_url: String,
    pub ssh_url: String,
    pub https_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub author: String,
    pub state: String,
    pub draft: bool,
    pub source_branch: String,
    pub source_repository: String,
    pub target_branch: String,
    pub head_sha: String,
    pub base_sha: String,
    pub web_url: String,
    pub updated_at: String,
    pub merge_status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    pub old_path: String,
    pub status: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommit {
    pub sha: String,
    pub title: String,
    pub author: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub state: String,
    pub web_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReview {
    pub title: String,
    pub body: String,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRequest {
    pub account_id: String,
    pub repository: String,
    pub parent: String,
    pub directory: String,
    pub protocol: String,
    pub ssh_alias: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileRequest {
    pub number: u64,
    pub path: String,
    pub old_path: String,
    pub status: String,
    pub head_sha: String,
    pub base_sha: String,
}

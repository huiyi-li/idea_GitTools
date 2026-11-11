use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub root: String,
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub operation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub old_path: Option<String>,
    pub index: char,
    pub work_tree: char,
    pub conflict: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Branch {
    pub name: String,
    pub full: String,
    pub hash: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Stash {
    pub reference: String,
    pub hash: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub repository: Repository,
    pub changes: Vec<Change>,
    pub branches: Vec<Branch>,
    pub stashes: Vec<Stash>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub branch: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    pub refs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<Commit>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct CommitDetails {
    pub commit: Commit,
    pub body: String,
    pub changes: Vec<Change>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffArea {
    Staged,
    Unstaged,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    pub path: String,
    pub old_path: Option<String>,
    pub revision: Option<String>,
    pub before_revision: Option<String>,
    #[serde(default)]
    pub area: Option<DiffArea>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub before: String,
    pub after: String,
    pub binary: bool,
    pub too_large: bool,
    pub can_load: bool,
    pub large: bool,
    pub reason: String,
}

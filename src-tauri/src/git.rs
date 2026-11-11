use crate::models::*;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

mod content;
pub(crate) mod discard;
pub(crate) mod history;
pub(crate) mod merge;
pub(crate) mod navigation;
pub(crate) mod review;

const MAX_OUTPUT: usize = 8 * 1024 * 1024;
const MAX_FILE: usize = 1024 * 1024;
const MAX_LINES: usize = 20_000;
pub const PAGE_SIZE: usize = 200;
const LOG_FORMAT: &str = "%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D%x00";

pub struct Git {
    pub root: PathBuf,
    pub app: Option<tauri::AppHandle>,
    watcher: Option<crate::watcher::RepositoryWatcher>,
    merge_session: Option<merge::MergeSession>,
}

struct Output {
    code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Output {
    fn checked(self) -> Result<Vec<u8>, String> {
        if self.code == 0 {
            Ok(self.stdout)
        } else {
            let error = String::from_utf8_lossy(&self.stderr).trim().to_owned();
            Err(if error.is_empty() {
                format!("Git exited with code {}", self.code)
            } else {
                error
            })
        }
    }
}

pub(crate) async fn read_limited(mut stream: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    read_with_limit(&mut stream, MAX_OUTPUT).await
}

async fn read_with_limit(
    mut stream: impl AsyncRead + Unpin,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(bytes);
        }
        if bytes.len() + count > limit {
            return Err(format!(
                "Git output exceeds {} MiB. Narrow the query and try again.",
                limit / 1024 / 1024
            ));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}

impl Git {
    pub async fn open(path: &str, app: Option<tauri::AppHandle>) -> Result<Self, String> {
        let path = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
        if !path.is_dir() {
            return Err("Select a repository directory.".into());
        }
        let mut git = Self {
            root: path,
            app,
            watcher: None,
            merge_session: None,
        };
        let root = git.text(&["rev-parse", "--show-toplevel"]).await?;
        git.root = Path::new(root.trim())
            .canonicalize()
            .map_err(|e| e.to_string())?;
        Ok(git)
    }

    pub fn root_string(&self) -> String {
        // Git and the UI use ordinary Windows paths, including for canonical paths.
        git_path(&self.root)
    }

    pub async fn start_watching(&mut self) -> Result<(), String> {
        let Some(app) = self.app.clone() else {
            return Ok(());
        };
        let git_dir = PathBuf::from(
            self.text(&["rev-parse", "--absolute-git-dir"])
                .await?
                .trim(),
        );
        let common_dir = self
            .root
            .join(self.text(&["rev-parse", "--git-common-dir"]).await?.trim())
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let mut paths = vec![self.root.clone()];
        if !git_dir.starts_with(&self.root) {
            paths.push(git_dir);
        }
        if !paths.iter().any(|path| common_dir.starts_with(path)) {
            paths.push(common_dir);
        }
        self.watcher = Some(crate::watcher::RepositoryWatcher::new(
            paths,
            self.root_string(),
            app,
        )?);
        Ok(())
    }

    async fn execute(&self, args: &[&str], input: Option<&[u8]>) -> Result<Output, String> {
        self.execute_with_env(args, input, &[]).await
    }

    async fn execute_with_env(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        env: &[(&str, &str)],
    ) -> Result<Output, String> {
        self.execute_with_timeout(args, input, env, Duration::from_secs(120))
            .await
    }

    async fn execute_with_timeout(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        env: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<Output, String> {
        let started = Instant::now();
        let label = format!("git {}", args.join(" "));
        if let Some(app) = &self.app {
            let _ = app.emit("git-console", &label);
        }
        let mut command = Command::new("git");
        command
            .args([
                "-c",
                "core.quotepath=false",
                "-c",
                "color.ui=false",
                "-c",
                "log.showSignature=false",
                "-c",
                "i18n.logOutputEncoding=utf-8",
            ])
            .args(args)
            .current_dir(&self.root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("LC_ALL", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in env {
            command.env(key, value);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start Git. Install Git and add it to PATH. {e}"))?;
        let mut stdin = child.stdin.take().ok_or("Git stdin is unavailable")?;
        let stdout = child.stdout.take().ok_or("Git stdout is unavailable")?;
        let stderr = child.stderr.take().ok_or("Git stderr is unavailable")?;
        let task = async {
            let (stdout, stderr, status, ()) = tokio::try_join!(
                read_with_limit(
                    stdout,
                    if args.starts_with(&["cat-file", "blob"]) {
                        content::MAX_LARGE_FILE
                    } else {
                        MAX_OUTPUT
                    }
                ),
                read_limited(stderr),
                async { child.wait().await.map_err(|e| e.to_string()) },
                async {
                    if let Some(bytes) = input {
                        stdin.write_all(bytes).await.map_err(|e| e.to_string())?;
                    }
                    drop(stdin);
                    Ok::<(), String>(())
                },
            )?;
            Ok::<Output, String>(Output {
                code: status.code().unwrap_or(-1),
                stdout,
                stderr,
            })
        };
        let output = match tokio::time::timeout(timeout, task).await {
            Ok(result) => result,
            Err(_) => Err(
                "Git timed out after 120 seconds. Check the repository or network, then refresh."
                    .into(),
            ),
        };
        if output.is_err() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        if let Some(app) = &self.app {
            let _ = app.emit(
                "git-console",
                format!(
                    "  {} ms · {}",
                    started.elapsed().as_millis(),
                    output
                        .as_ref()
                        .map(|o| o.code.to_string())
                        .unwrap_or_else(|e| e.clone())
                ),
            );
        }
        output
    }

    async fn bytes(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        self.execute(args, None).await?.checked()
    }

    async fn text(&self, args: &[&str]) -> Result<String, String> {
        String::from_utf8(self.bytes(args).await?)
            .map_err(|_| "Git returned non-UTF-8 text.".into())
    }

    async fn head(&self) -> Result<Option<String>, String> {
        let head = self
            .execute(&["rev-parse", "--verify", "HEAD"], None)
            .await?;
        Ok((head.code == 0).then(|| String::from_utf8_lossy(&head.stdout).trim().to_owned()))
    }

    pub async fn repository(&self) -> Result<Repository, String> {
        let head = self.head().await?;
        let branch = self
            .execute(&["symbolic-ref", "--quiet", "--short", "HEAD"], None)
            .await?;
        let branch =
            (branch.code == 0).then(|| String::from_utf8_lossy(&branch.stdout).trim().to_owned());
        let git_dir = self.text(&["rev-parse", "--absolute-git-dir"]).await?;
        let dir = Path::new(git_dir.trim());
        let operation = if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
            "rebase"
        } else if dir.join("MERGE_HEAD").exists() {
            "merge"
        } else if dir.join("CHERRY_PICK_HEAD").exists() {
            "cherry-pick"
        } else if dir.join("REVERT_HEAD").exists() {
            "revert"
        } else {
            "none"
        };
        Ok(Repository {
            root: self.root_string(),
            name: self
                .root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            head,
            branch,
            operation: operation.into(),
        })
    }

    pub async fn status(&self) -> Result<Status, String> {
        let repository = self.repository().await?;
        let changes = parse_status(
            &self
                .bytes(&["status", "--porcelain=v1", "-z", "--untracked-files=all"])
                .await?,
        )?;
        let branch_data = self
            .text(&[
                "for-each-ref",
                "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(symref)",
                "refs/heads",
                "refs/remotes",
            ])
            .await?;
        let branches = branch_data
            .lines()
            .filter_map(|line| {
                let parts: Vec<_> = line.split('\0').collect();
                if parts.len() != 5 || !parts[4].is_empty() {
                    return None;
                }
                let remote = parts[0].starts_with("refs/remotes/");
                Some(Branch {
                    name: parts[0]
                        .trim_start_matches(if remote {
                            "refs/remotes/"
                        } else {
                            "refs/heads/"
                        })
                        .into(),
                    full: parts[0].into(),
                    hash: parts[1].into(),
                    current: parts[2] == "*",
                    remote,
                    upstream: parts[3].into(),
                })
            })
            .collect();
        let stash_data = self
            .text(&["stash", "list", "-z", "--format=%gd%x00%H%x00%gs"])
            .await?;
        let parts: Vec<_> = stash_data.split_terminator('\0').collect();
        let stashes = parts
            .chunks_exact(3)
            .map(|p| Stash {
                reference: p[0].into(),
                hash: p[1].into(),
                message: p[2].into(),
            })
            .collect();
        Ok(Status {
            repository,
            changes,
            branches,
            stashes,
        })
    }

    pub async fn log(&self, query: LogQuery) -> Result<LogPage, String> {
        if query.offset > 10_000_000 || query.search.len() > 4096 {
            return Err("Log query is too large.".into());
        }
        if self.repository().await?.head.is_none() {
            return Ok(LogPage {
                commits: vec![],
                has_more: false,
            });
        }
        let format = format!("--format={LOG_FORMAT}");
        let skip = format!("--skip={}", query.offset);
        let count = format!("--max-count={}", PAGE_SIZE + 1);
        let mut args = vec![
            "log",
            "--topo-order",
            "--decorate=full",
            "--decorate-refs-exclude=refs/ideagittool/*",
            "--decorate-refs-exclude=refs/stash",
            "-z",
            &format,
            &skip,
            &count,
        ];
        let grep = format!("--grep={}", query.search);
        if !query.search.is_empty() {
            args.extend(["--fixed-strings", "--regexp-ignore-case", &grep]);
        }
        if query.branch.is_empty() {
            args.extend(["--branches", "--remotes", "--tags", "HEAD"]);
        } else {
            self.bytes(&[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{}^{{commit}}", query.branch),
            ])
            .await?;
            args.extend(["--end-of-options", &query.branch]);
        }
        args.push("--");
        let bytes = self.bytes(&args).await?;
        let mut commits = parse_commits(&bytes)?;
        let has_more = commits.len() > PAGE_SIZE;
        commits.truncate(PAGE_SIZE);
        Ok(LogPage { commits, has_more })
    }

    pub async fn details(&self, revision: &str) -> Result<CommitDetails, String> {
        validate_hash(revision)?;
        let format = format!("--format={LOG_FORMAT}%b%x00");
        let bytes = self
            .bytes(&["show", "--no-patch", &format, revision, "--"])
            .await?;
        let data = std::str::from_utf8(&bytes).map_err(|_| "Commit message is not UTF-8")?;
        let fields: Vec<_> = data.split('\0').collect();
        let commit = parse_commit(&fields)?;
        let body = fields.get(7).unwrap_or(&"").to_string();
        let changes = self
            .bytes(&[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "-r",
                "-m",
                "--first-parent",
                "--name-status",
                "-z",
                "-M",
                revision,
                "--",
            ])
            .await?;
        Ok(CommitDetails {
            commit,
            body,
            changes: parse_name_status(&changes)?,
        })
    }

    pub async fn diff(&self, request: DiffRequest) -> Result<FileDiff, String> {
        self.diff_with_options(request, false).await
    }

    pub async fn diff_with_options(
        &self,
        request: DiffRequest,
        allow_large: bool,
    ) -> Result<FileDiff, String> {
        use content::{FileSnapshot, SnapshotState};
        validate_path(&request.path)?;
        let old_path = request.old_path.as_deref().unwrap_or(&request.path);
        validate_path(old_path)?;
        if request.area.is_some()
            && (request.revision.is_some() || request.before_revision.is_some())
        {
            return Err("历史文件比较不使用暂存区范围".into());
        }
        let (before, after) = if let Some(before_revision) = request.before_revision {
            validate_hash(&before_revision)?;
            let revision = request.revision.as_deref().ok_or("请选择比较的两个提交")?;
            validate_hash(revision)?;
            (
                self.blob_snapshot(Some(&before_revision), old_path, allow_large)
                    .await?,
                self.blob_snapshot(Some(revision), &request.path, allow_large)
                    .await?,
            )
        } else if let Some(revision) = request.revision {
            validate_hash(&revision)?;
            let ancestry = self
                .text(&["rev-list", "--parents", "--max-count=1", &revision, "--"])
                .await?;
            let mut hashes = ancestry.split_whitespace();
            validate_hash(hashes.next().ok_or("Select a commit to view its diff.")?)?;
            let before = if let Some(parent) = hashes.next() {
                validate_hash(parent)?;
                self.blob_snapshot(Some(parent), old_path, allow_large)
                    .await?
            } else {
                FileSnapshot::new(old_path, None, SnapshotState::Missing, &[])
            };
            (
                before,
                self.blob_snapshot(Some(&revision), &request.path, allow_large)
                    .await?,
            )
        } else {
            let before = if matches!(request.area, Some(DiffArea::Unstaged)) {
                let indexed = self.index_snapshot(&request.path, allow_large).await?;
                if indexed.state == SnapshotState::Missing && old_path != request.path {
                    self.index_snapshot(old_path, allow_large).await?
                } else {
                    indexed
                }
            } else if let Some(head) = self.head().await? {
                self.blob_snapshot(Some(&head), old_path, allow_large)
                    .await?
            } else {
                FileSnapshot::new(old_path, None, SnapshotState::Missing, &[])
            };
            (
                before,
                if matches!(request.area, Some(DiffArea::Staged)) {
                    self.index_snapshot(&request.path, allow_large).await?
                } else {
                    self.worktree_snapshot(&request.path, allow_large).await?
                },
            )
        };
        if before.state == SnapshotState::Encoding || after.state == SnapshotState::Encoding {
            return Err("This file is not UTF-8. Use an external editor to view it.".into());
        }
        let binary = [&before, &after]
            .iter()
            .any(|file| matches!(file.state, SnapshotState::Binary | SnapshotState::Submodule));
        let too_large = !binary
            && [&before, &after]
                .iter()
                .any(|file| file.state == SnapshotState::TooLarge);
        let can_load = too_large
            && [&before, &after]
                .iter()
                .filter(|file| file.state == SnapshotState::TooLarge)
                .all(|file| file.can_load);
        let large = before.large || after.large;
        let reason = if can_load {
            "文件超过自动加载阈值，可按需加载大文件"
        } else {
            "文件超过 10 MiB 或 200,000 行，请使用外部工具处理"
        }
        .into();
        Ok(FileDiff {
            before: if binary || too_large {
                String::new()
            } else {
                before.text
            },
            after: if binary || too_large {
                String::new()
            } else {
                after.text
            },
            binary,
            too_large,
            can_load,
            large,
            reason,
        })
    }

    pub async fn stage(&self, paths: Vec<String>, unstage: bool) -> Result<(), String> {
        if paths.is_empty() || paths.len() > 10_000 {
            return Err("Select between 1 and 10,000 files.".into());
        }
        for path in &paths {
            validate_path(path)?;
        }
        let head = self.repository().await?.head;
        let mut args = if !unstage {
            vec!["--literal-pathspecs", "add", "-A", "--"]
        } else if head.is_some() {
            vec!["--literal-pathspecs", "reset", "--quiet", "HEAD", "--"]
        } else {
            vec![
                "--literal-pathspecs",
                "rm",
                "--cached",
                "--force",
                "--ignore-unmatch",
                "-r",
                "--",
            ]
        };
        args.extend(paths.iter().map(String::as_str));
        self.bytes(&args).await?;
        Ok(())
    }

    pub async fn commit(&self, message: &str) -> Result<String, String> {
        if message.trim().is_empty() || message.len() > MAX_FILE {
            return Err("Enter a commit message of at most 1 MiB.".into());
        }
        let staged = self
            .execute(&["diff", "--cached", "--quiet", "--exit-code"], None)
            .await?;
        if staged.code == 0 {
            return Err("Stage changes before committing.".into());
        }
        if staged.code != 1 {
            staged.checked()?;
        }
        let result = self
            .execute(&["commit", "-F", "-"], Some(message.as_bytes()))
            .await?
            .checked()?;
        Ok(String::from_utf8_lossy(&result).trim().into())
    }

    pub async fn checkout(&self, name: &str) -> Result<(), String> {
        let status = self.status().await?;
        let branch = status
            .branches
            .iter()
            .find(|b| b.full == name)
            .ok_or("Branch no longer exists. Refresh and try again.")?;
        if branch.remote {
            self.bytes(&["switch", "--track", "--no-guess", "--", &branch.name])
                .await?;
        } else {
            self.bytes(&["switch", "--no-guess", "--", &branch.name])
                .await?;
        }
        Ok(())
    }

    pub async fn create_branch(&self, name: &str) -> Result<(), String> {
        if name.is_empty() || name.starts_with('-') || name.len() > 1024 {
            return Err("Enter a valid branch name.".into());
        }
        self.bytes(&["check-ref-format", "--branch", name]).await?;
        self.bytes(&["switch", "-c", name, "--"]).await?;
        Ok(())
    }

    pub async fn remote_action(&self, action: &str) -> Result<String, String> {
        let args: &[&str] = match action {
            "fetch" => &["fetch", "--all"],
            "pull" => &["pull", "--ff-only"],
            "push" => &["push"],
            _ => return Err("Unknown remote action.".into()),
        };
        let result = self.execute(args, None).await?;
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&result.checked()?)
            .trim()
            .to_owned();
        Ok(format!("{stdout}\n{stderr}").trim().into())
    }

    pub async fn save_stash(&self, message: &str) -> Result<(), String> {
        if message.len() > 4096 {
            return Err("Stash message is too long.".into());
        }
        self.bytes(&["stash", "push", "--include-untracked", "-m", message])
            .await?;
        Ok(())
    }

    pub async fn apply_stash(&self, hash: &str) -> Result<(), String> {
        validate_hash(hash)?;
        if !self.status().await?.stashes.iter().any(|s| s.hash == hash) {
            return Err("Stash no longer exists.".into());
        }
        self.bytes(&["stash", "apply", hash]).await?;
        Ok(())
    }
}

fn validate_hash(hash: &str) -> Result<(), String> {
    if (hash.len() == 40 || hash.len() == 64) && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Invalid commit ID.".into())
    }
}

pub(crate) fn git_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        path.strip_prefix(r"\\?\")
            .unwrap_or(&path)
            .replace('\\', "/")
    }
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains('\0')
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        Err("Expected a repository-relative file path.".into())
    } else {
        Ok(())
    }
}

fn parse_status(bytes: &[u8]) -> Result<Vec<Change>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "A filename is not UTF-8.")?;
    let mut records = text.split_terminator('\0');
    let mut changes = vec![];
    while let Some(record) = records.next() {
        if record.len() < 4 {
            return Err("Invalid Git status output.".into());
        }
        let index = record.as_bytes()[0] as char;
        let work_tree = record.as_bytes()[1] as char;
        let old_path = if matches!(index, 'R' | 'C') || matches!(work_tree, 'R' | 'C') {
            Some(records.next().ok_or("Missing rename source")?.to_owned())
        } else {
            None
        };
        changes.push(Change {
            path: record[3..].into(),
            old_path,
            index,
            work_tree,
            conflict: matches!(&record[..2], "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU"),
        });
    }
    Ok(changes)
}

fn parse_name_status(bytes: &[u8]) -> Result<Vec<Change>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "A filename is not UTF-8.")?;
    let mut records = text.split_terminator('\0');
    let mut changes = vec![];
    while let Some(status) = records.next() {
        let kind = status.chars().next().ok_or("Missing change status")?;
        let first = records.next().ok_or("Missing changed path")?;
        let (path, old_path) = if matches!(kind, 'R' | 'C') {
            (
                records.next().ok_or("Missing rename target")?,
                Some(first.to_owned()),
            )
        } else {
            (first, None)
        };
        changes.push(Change {
            path: path.into(),
            old_path,
            index: kind,
            work_tree: ' ',
            conflict: false,
        });
    }
    Ok(changes)
}

fn parse_commit(fields: &[&str]) -> Result<Commit, String> {
    if fields.len() < 7 {
        return Err("Invalid Git log record.".into());
    }
    Ok(Commit {
        hash: fields[0].into(),
        parents: fields[1].split_whitespace().map(str::to_owned).collect(),
        author: fields[2].into(),
        email: fields[3].into(),
        time: fields[4].parse().map_err(|_| "Invalid commit timestamp")?,
        subject: fields[5].into(),
        refs: fields[6]
            .split(", ")
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
    })
}

fn parse_commits(bytes: &[u8]) -> Result<Vec<Commit>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Git log contains non-UTF-8 text.")?;
    // Fixed-width records preserve empty parents and decorations, which also
    // produce adjacent NULs. The eighth field is Git's record separator.
    let fields: Vec<_> = text.split_terminator('\0').collect();
    let records = fields.chunks_exact(8);
    if !records.remainder().is_empty() {
        return Err("Incomplete Git log record.".into());
    }
    records.map(parse_commit).collect()
}

#[cfg(test)]
mod tests;

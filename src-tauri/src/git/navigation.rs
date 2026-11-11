use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NavigationAction {
    Checkout,
    Reset,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ResetMode {
    Soft,
    #[default]
    Mixed,
    Hard,
    Keep,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LocalStrategy {
    #[default]
    Normal,
    Backup,
    Force,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigationPreview {
    pub root: String,
    pub action: NavigationAction,
    pub target: String,
    pub target_hash: String,
    pub expected_head: Option<String>,
    pub expected_branch: Option<String>,
    pub fingerprint: String,
    pub local_branches: Vec<String>,
    pub remote: bool,
    pub local: bool,
    pub suggested_branch: String,
    pub worktree_path: Option<String>,
    pub changes: Vec<ImpactFile>,
    pub local_changes: Vec<String>,
    pub untracked_overwrites: Vec<String>,
    pub leaving: Vec<LeavingCommit>,
    pub leaving_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ImpactFile {
    pub path: String,
    pub status: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct LeavingCommit {
    pub hash: String,
    pub subject: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigationRequest {
    pub preview: NavigationPreview,
    #[serde(default)]
    pub mode: ResetMode,
    #[serde(default)]
    pub strategy: LocalStrategy,
    pub new_branch: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationRecord {
    pub id: String,
    pub action: NavigationAction,
    pub original_head: Option<String>,
    pub original_branch: Option<String>,
    pub target_hash: String,
    pub phase: String,
    pub stash_sha: Option<String>,
    pub error: Option<String>,
    pub failure_kind: Option<String>,
    pub blocked_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigationResult {
    pub completed: bool,
    pub kind: String,
    pub message: String,
    pub blocked_files: Vec<String>,
    pub record: Option<OperationRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryOverview {
    pub records: Vec<OperationRecord>,
    pub operation: String,
    pub original_head: Option<String>,
    pub current: Option<String>,
    pub progress: Option<String>,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReflogEntry {
    pub hash: String,
    pub reference: String,
    pub subject: String,
}

fn paths(bytes: &[u8]) -> Result<Vec<String>, String> {
    bytes
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8(p.to_vec()).map_err(|_| "文件名不是 UTF-8，无法安全预览".into()))
        .collect()
}

fn threatened(path: &str, tree: &BTreeSet<String>) -> bool {
    let key = if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_owned()
    };
    if tree.contains(&key) {
        return true;
    }
    for (index, _) in key.match_indices('/') {
        if tree.contains(&key[..index]) {
            return true;
        }
    }
    let prefix = format!("{key}/");
    tree.range(prefix.clone()..)
        .next()
        .is_some_and(|p| p.starts_with(&prefix))
}

fn failure(error: &str) -> (String, Vec<String>) {
    let kind = if error.contains("would be overwritten") || error.contains("would be removed") {
        "overwrite"
    } else if error.contains("already used by worktree") || error.contains("already checked out at")
    {
        "worktree"
    } else if error.contains("CONFLICT") || error.contains("needs merge") {
        "conflict"
    } else if error.contains("hook") {
        "hook"
    } else {
        "git-error"
    };
    let files = if kind == "overwrite" {
        error
            .lines()
            .filter_map(|line| line.strip_prefix('\t'))
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    (kind.into(), files)
}

pub(super) fn hash_path(hash: &mut Sha256, path: &Path) -> Result<(), String> {
    use std::io::Read;
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            hash.update(b"missing\0");
            return Ok(());
        }
        Err(e) => return Err(e.to_string()),
    };
    if metadata.file_type().is_symlink() {
        hash.update(b"symlink\0");
        hash.update(
            fs::read_link(path)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .as_bytes(),
        );
    } else if metadata.is_dir() {
        hash.update(b"directory\0");
        let mut entries = fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .map(|e| e.map(|e| e.path()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        entries.sort();
        for entry in entries {
            hash.update(
                entry
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .as_bytes(),
            );
            hash.update([0]);
            hash_path(hash, &entry)?;
        }
    } else {
        hash.update(b"file\0");
        hash.update(metadata.len().to_le_bytes());
        let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut buffer = [0; 65536];
        loop {
            let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
    }
    Ok(())
}

impl Git {
    async fn navigation_command(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
    ) -> Result<Output, String> {
        self.execute_with_timeout(args, input, &[], Duration::from_secs(1800))
            .await
    }

    async fn resolve_commit(&self, target: &str) -> Result<String, String> {
        if target.is_empty()
            || target.starts_with('-')
            || target.len() > 1024
            || target.contains(['\0', '\n', '\r'])
        {
            return Err("请输入分支、标签或提交 SHA".into());
        }
        let revision = format!("{target}^{{commit}}");
        Ok(self
            .text(&["rev-parse", "--verify", "--end-of-options", &revision])
            .await?
            .trim()
            .into())
    }

    async fn threatened_untracked(&self, target: &str) -> Result<Vec<String>, String> {
        let tree: BTreeSet<_> = paths(
            &self
                .bytes(&["ls-tree", "-r", "--name-only", "-z", target, "--"])
                .await?,
        )?
        .into_iter()
        .map(|p| if cfg!(windows) { p.to_lowercase() } else { p })
        .collect();
        let untracked = paths(&self.bytes(&["ls-files", "--others", "-z"]).await?)?;
        Ok(untracked
            .into_iter()
            .filter(|p| threatened(p, &tree))
            .collect())
    }

    async fn workspace_fingerprint(&self, target: &str) -> Result<String, String> {
        let mut hash = Sha256::new();
        let status = self
            .bytes(&["status", "--porcelain=v1", "-z", "--untracked-files=all"])
            .await?;
        let changed = parse_status(&status)?;
        for data in [status, self.bytes(&["ls-files", "--stage", "-z"]).await?] {
            hash.update((data.len() as u64).to_le_bytes());
            hash.update(data);
        }
        let mut files: BTreeSet<_> = paths(
            &self
                .bytes(&["ls-files", "--others", "--exclude-standard", "-z"])
                .await?,
        )?
        .into_iter()
        .collect();
        for change in changed {
            files.insert(change.path);
            if let Some(old) = change.old_path {
                files.insert(old);
            }
        }
        files.extend(self.threatened_untracked(target).await?);
        for file in files {
            validate_path(&file)?;
            hash.update(file.as_bytes());
            hash.update([0]);
            hash_path(&mut hash, &self.root.join(&file))?;
        }
        Ok(format!("{:x}", hash.finalize()))
    }

    pub(crate) async fn preview_navigation(
        &self,
        target: &str,
        action: NavigationAction,
    ) -> Result<NavigationPreview, String> {
        let status = self.status().await?;
        if status.repository.operation != "none" || status.changes.iter().any(|c| c.conflict) {
            return Err("请先处理冲突并完成或中止当前 Git 操作".into());
        }
        if action == NavigationAction::Reset && status.repository.branch.is_none() {
            return Err("重置当前分支需要先签出本地分支".into());
        }
        let branch = status
            .branches
            .iter()
            .find(|b| b.full == target || (!b.remote && b.name == target));
        let target = branch.map_or(target, |b| b.full.as_str());
        let target_hash = self.resolve_commit(target).await?;
        let remote = branch.is_some_and(|b| b.remote);
        let local = branch.is_some_and(|b| !b.remote);
        let suggested_branch = branch
            .filter(|b| b.remote)
            .map(|b| {
                b.name
                    .split_once('/')
                    .map_or(b.name.as_str(), |(_, n)| n)
                    .to_owned()
            })
            .unwrap_or_default();
        let local_branches = if remote {
            status
                .branches
                .iter()
                .filter(|b| {
                    !b.remote && (b.name == suggested_branch || b.upstream == branch.unwrap().name)
                })
                .map(|b| b.full.clone())
                .collect()
        } else {
            Vec::new()
        };
        let mut worktree_path = None;
        if local {
            let worktrees = paths(
                &self
                    .bytes(&["worktree", "list", "--porcelain", "-z"])
                    .await?,
            )?;
            let mut directory = String::new();
            for field in worktrees {
                if let Some(value) = field.strip_prefix("worktree ") {
                    directory = value.into();
                }
                if field == format!("branch {target}") {
                    let other = Path::new(&directory)
                        .canonicalize()
                        .map_err(|e| e.to_string())?;
                    if other != self.root {
                        worktree_path = Some(git_path(&other));
                    }
                }
            }
        }
        let mut changes = Vec::new();
        let mut leaving = Vec::new();
        let mut leaving_count = 0;
        if let Some(head) = &status.repository.head {
            changes = parse_name_status(
                &self
                    .bytes(&[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--name-status",
                        "-z",
                        head,
                        &target_hash,
                        "--",
                    ])
                    .await?,
            )?
            .into_iter()
            .map(|c| ImpactFile {
                path: c.path,
                status: c.index.to_string(),
            })
            .collect();
            let range = format!("{target_hash}..{head}");
            leaving_count = self
                .text(&["rev-list", "--count", &range, "--"])
                .await?
                .trim()
                .parse()
                .map_err(|_| "无法读取提交数量")?;
            leaving = self
                .text(&["log", "-100", "--format=%H%x00%s", &range, "--"])
                .await?
                .lines()
                .filter_map(|l| l.split_once('\0'))
                .map(|(h, s)| LeavingCommit {
                    hash: h.into(),
                    subject: s.into(),
                })
                .collect();
        }
        let fingerprint = self.workspace_fingerprint(&target_hash).await?;
        Ok(NavigationPreview {
            root: self.root_string(),
            action,
            target: target.into(),
            target_hash: target_hash.clone(),
            expected_head: status.repository.head,
            expected_branch: status.repository.branch,
            fingerprint,
            local_branches,
            remote,
            local,
            suggested_branch,
            worktree_path,
            changes,
            local_changes: status.changes.into_iter().map(|c| c.path).collect(),
            untracked_overwrites: self.threatened_untracked(&target_hash).await?,
            leaving,
            leaving_count,
        })
    }

    async fn records_path(&self) -> Result<PathBuf, String> {
        Ok(PathBuf::from(
            self.text(&["rev-parse", "--absolute-git-dir"])
                .await?
                .trim(),
        )
        .join("ideagittool-operations.json"))
    }

    async fn operation_records(&self) -> Result<Vec<OperationRecord>, String> {
        let path = self.records_path().await?;
        match fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|e| format!("操作恢复记录读取失败：{e}"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    async fn save_record(&self, record: &OperationRecord) -> Result<(), String> {
        use std::io::Write;
        let path = self.records_path().await?;
        let mut records = self.operation_records().await?;
        records.retain(|r| r.id != record.id);
        records.insert(0, record.clone());
        // Never evict a record with a backup or an unfinished operation.
        let mut finished = 0;
        records.retain(|r| {
            if r.stash_sha.is_none() && matches!(r.phase.as_str(), "completed" | "failed") {
                finished += 1;
                finished <= 50
            } else {
                true
            }
        });
        let bytes = serde_json::to_vec_pretty(&records).map_err(|e| e.to_string())?;
        let mut temporary = tempfile::NamedTempFile::new_in(path.parent().ok_or("Git 目录无效")?)
            .map_err(|e| e.to_string())?;
        temporary.write_all(&bytes).map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary.persist(path).map_err(|e| e.to_string())?;
        if let Some(app) = &self.app {
            let _ = app.emit("git-operation", record);
        }
        Ok(())
    }

    async fn backup_operation(
        &self,
        record: &mut OperationRecord,
        threats: &[String],
    ) -> Result<(), String> {
        record.phase = "saving".into();
        self.save_record(record).await?;
        let status = self.status().await?;
        let marker = format!("IdeaGitTool operation {}", record.id);
        let selected_paths: BTreeSet<_> = status
            .changes
            .iter()
            .map(|c| c.path.clone())
            .chain(threats.iter().cloned())
            .collect();
        let mut args = vec!["stash", "push", "--include-untracked", "-m", &marker];
        let mut input = None;
        let pathspec;
        if !threats.is_empty() {
            // Include only threatened ignored paths, rather than every ignored build artifact.
            let mut selected: BTreeSet<String> = threats.iter().cloned().collect();
            for change in status.changes {
                selected.insert(change.path);
                if let Some(old) = change.old_path {
                    selected.insert(old);
                }
            }
            pathspec = selected
                .into_iter()
                .flat_map(|p| format!(":(top,literal){p}\0").into_bytes())
                .collect::<Vec<_>>();
            args[2] = "--all";
            args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
            input = Some(pathspec.as_slice());
        }
        let result = self.navigation_command(&args, input).await?;
        let saved = self
            .status()
            .await?
            .stashes
            .into_iter()
            .find(|s| s.message.contains(&marker));
        if let Some(stash) = saved {
            record.stash_sha = Some(stash.hash.clone());
            self.bytes(&[
                "update-ref",
                &format!("refs/ideagittool/backups/{}", record.id),
                &stash.hash,
            ])
            .await?;
            record.phase = "saved".into();
            self.save_record(record).await?;
        }
        result.checked()?;
        if record.stash_sha.is_none() {
            return Err("没有创建临时保存，操作已取消".into());
        }
        // Saving .gitignore can expose unchanged caches. Refuse remaining tracked edits
        // or selected paths, while allowing these unrelated untracked files to remain.
        if self
            .status()
            .await?
            .changes
            .iter()
            .any(|c| c.index != '?' || selected_paths.contains(&c.path))
        {
            return Err("仍有无法保存的本地修改，操作已取消；已创建的备份保留在恢复记录中".into());
        }
        Ok(())
    }

    async fn restore_record(&self, record: &mut OperationRecord) -> Result<(), String> {
        let stash = record.stash_sha.clone().ok_or("没有关联的本地修改备份")?;
        record.phase = "restoring".into();
        self.save_record(record).await?;
        match self
            .navigation_command(&["stash", "apply", "--index", &stash], None)
            .await
            .and_then(Output::checked)
        {
            Ok(_) => {
                record.phase = "completed".into();
                record.error = None;
                record.failure_kind = None;
                record.blocked_files.clear();
                self.save_record(record).await?;
                Ok(())
            }
            Err(error) => {
                let (_, files) = failure(&error);
                record.phase = "restore-blocked".into();
                record.error = Some(error.clone());
                record.failure_kind = Some("restore".into());
                record.blocked_files = files;
                record.blocked_files.extend(
                    self.status()
                        .await?
                        .changes
                        .into_iter()
                        .filter(|c| c.conflict)
                        .map(|c| c.path),
                );
                self.save_record(record).await?;
                Err(error)
            }
        }
    }

    pub(crate) async fn execute_navigation(
        &self,
        request: NavigationRequest,
    ) -> Result<NavigationResult, String> {
        let p = request.preview;
        if p.root != self.root_string() {
            return Err("仓库已改变，请重新预览".into());
        }
        let fresh = self.preview_navigation(&p.target, p.action).await?;
        if fresh.expected_head != p.expected_head
            || fresh.expected_branch != p.expected_branch
            || fresh.target_hash != p.target_hash
            || fresh.fingerprint != p.fingerprint
        {
            return Err("HEAD、目标或本地修改已改变，请重新预览后执行".into());
        }
        if let Some(path) = &fresh.worktree_path {
            return Ok(NavigationResult {
                completed: false,
                kind: "worktree".into(),
                message: format!("分支正在其他 worktree 使用：{path}"),
                blocked_files: vec![],
                record: None,
            });
        }
        let new_branch = request.new_branch.filter(|n| !n.is_empty());
        if let Some(name) = &new_branch {
            if p.action != NavigationAction::Checkout || name.starts_with('-') || name.len() > 1024
            {
                return Err("分支名称无效".into());
            }
            self.bytes(&["check-ref-format", "--branch", name]).await?;
            if self
                .status()
                .await?
                .branches
                .iter()
                .any(|b| !b.remote && b.name == *name)
            {
                return Err("本地同名分支已存在，请选择该分支或换一个名称".into());
            }
        }
        if fresh.remote && new_branch.is_none() {
            return Err("请选择对应本地分支，或输入新建跟踪分支名称".into());
        }
        if p.action == NavigationAction::Reset && request.strategy == LocalStrategy::Force {
            return Err("Reset 请通过 Hard 模式明确选择覆盖".into());
        }
        let id = format!(
            "{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        );
        let mut record = OperationRecord {
            id,
            action: p.action,
            original_head: p.expected_head,
            original_branch: p.expected_branch,
            target_hash: p.target_hash.clone(),
            phase: "preparing".into(),
            stash_sha: None,
            error: None,
            failure_kind: None,
            blocked_files: vec![],
        };
        self.save_record(&record).await?;
        if let Some(head) = &record.original_head {
            self.bytes(&[
                "update-ref",
                &format!("refs/ideagittool/originals/{}", record.id),
                head,
            ])
            .await?;
        }
        if request.strategy == LocalStrategy::Backup
            && (!fresh.local_changes.is_empty() || !fresh.untracked_overwrites.is_empty())
        {
            if let Err(error) = self
                .backup_operation(&mut record, &fresh.untracked_overwrites)
                .await
            {
                record.phase = "failed".into();
                record.error = Some(error.clone());
                record.failure_kind = Some("backup".into());
                self.save_record(&record).await?;
                return Ok(NavigationResult {
                    completed: false,
                    kind: "backup".into(),
                    message: error,
                    blocked_files: vec![],
                    record: Some(record),
                });
            }
        }
        // Revalidate refs after saving; stash legitimately changes the working state.
        let repository = self.repository().await?;
        if repository.head != record.original_head
            || repository.branch != record.original_branch
            || repository.operation != "none"
            || self.resolve_commit(&p.target).await? != p.target_hash
        {
            record.phase = "interrupted".into();
            record.error = Some("保存后 Git 状态已改变，请使用恢复入口".into());
            self.save_record(&record).await?;
            return Err(record.error.unwrap());
        }
        record.phase = "executing".into();
        self.save_record(&record).await?;
        let mut args = if p.action == NavigationAction::Reset {
            vec![
                "reset",
                match request.mode {
                    ResetMode::Soft => "--soft",
                    ResetMode::Mixed => "--mixed",
                    ResetMode::Hard => "--hard",
                    ResetMode::Keep => "--keep",
                },
                &p.target_hash,
                "--",
            ]
        } else {
            let mut args = vec!["switch", "--no-guess"];
            if request.strategy == LocalStrategy::Force {
                args.push("--discard-changes");
            }
            if let Some(name) = &new_branch {
                args.extend(["-c", name]);
                if fresh.remote {
                    args.push("--track");
                }
                args.extend([
                    "--",
                    if fresh.remote {
                        &p.target
                    } else {
                        &p.target_hash
                    },
                ]);
            } else if fresh.local {
                args.extend([
                    "--",
                    p.target.strip_prefix("refs/heads/").unwrap_or(&p.target),
                ]);
            } else {
                args.extend(["--detach", "--", &p.target_hash]);
            }
            args
        };
        // Disable implicit autostash supplied by user configuration.
        args.splice(0..0, ["-c", "reset.quiet=false"]);
        let output = match self.navigation_command(&args, None).await {
            Ok(o) => o,
            Err(e) => {
                record.phase = "interrupted".into();
                record.error = Some(e.clone());
                self.save_record(&record).await?;
                return Err(e);
            }
        };
        if output.code != 0 {
            let error = output.checked().unwrap_err();
            let (kind, files) = failure(&error);
            record.phase = "failed".into();
            record.error = Some(error.clone());
            record.failure_kind = Some(kind.clone());
            record.blocked_files = files.clone();
            self.save_record(&record).await?;
            // A checkout hook may fail after HEAD changed. Always retain the backup.
            if record.stash_sha.is_some() && p.action == NavigationAction::Checkout {
                let _ = self.restore_record(&mut record).await;
                if record.phase == "completed" {
                    record.phase = "failed-restored".into();
                    record.error = Some(error.clone());
                    record.failure_kind = Some(kind.clone());
                    self.save_record(&record).await?;
                }
            }
            return Ok(NavigationResult {
                completed: false,
                kind,
                message: error,
                blocked_files: files,
                record: Some(record),
            });
        }
        record.phase = if record.stash_sha.is_some() {
            "backup-ready"
        } else {
            "completed"
        }
        .into();
        self.save_record(&record).await?;
        if p.action == NavigationAction::Checkout && record.stash_sha.is_some() {
            if let Err(error) = self.restore_record(&mut record).await {
                return Ok(NavigationResult {
                    completed: false,
                    kind: "restore".into(),
                    message: format!("签出已完成，恢复本地修改受阻。备份仍保留。\n{error}"),
                    blocked_files: record.blocked_files.clone(),
                    record: Some(record),
                });
            }
        }
        Ok(NavigationResult {
            completed: true,
            kind: "completed".into(),
            message: if record.phase == "backup-ready" {
                "Reset 已完成，本地修改备份保留在操作恢复中"
            } else {
                "操作完成"
            }
            .into(),
            blocked_files: vec![],
            record: Some(record),
        })
    }

    pub(crate) async fn recovery_overview(&self) -> Result<RecoveryOverview, String> {
        let mut records = self.operation_records().await?;
        let status = self.status().await?;
        for record in &mut records {
            if matches!(
                record.phase.as_str(),
                "saving" | "saved" | "preparing" | "executing" | "restoring"
            ) {
                if record.stash_sha.is_none() {
                    record.stash_sha = status
                        .stashes
                        .iter()
                        .find(|s| {
                            s.message
                                .contains(&format!("IdeaGitTool operation {}", record.id))
                        })
                        .map(|s| s.hash.clone());
                }
                if let Some(hash) = &record.stash_sha {
                    self.bytes(&[
                        "update-ref",
                        &format!("refs/ideagittool/backups/{}", record.id),
                        hash,
                    ])
                    .await?;
                }
                // Do not repeat an interrupted stash apply: it may already have applied partially.
                record.phase = if record.phase == "restoring" {
                    "restore-blocked"
                } else {
                    "interrupted"
                }
                .into();
                record.error = Some("应用在操作期间退出，请核对当前 HEAD 和本地修改后恢复".into());
                self.save_record(record).await?;
            }
        }
        let dir = PathBuf::from(
            self.text(&["rev-parse", "--absolute-git-dir"])
                .await?
                .trim(),
        );
        let read = |path: PathBuf| {
            fs::read_to_string(path)
                .ok()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
        };
        let rebase = if dir.join("rebase-merge").exists() {
            dir.join("rebase-merge")
        } else {
            dir.join("rebase-apply")
        };
        let original_head = read(rebase.join("orig-head")).or_else(|| {
            if status.repository.operation != "none" {
                read(dir.join("ORIG_HEAD"))
            } else {
                None
            }
        });
        let progress = read(rebase.join("msgnum"))
            .zip(read(rebase.join("end")))
            .or_else(|| read(rebase.join("next")).zip(read(rebase.join("last"))))
            .map(|(n, total)| format!("{n}/{total}"));
        let current =
            read(rebase.join("stopped-sha")).or_else(|| read(dir.join("CHERRY_PICK_HEAD")));
        let reason = if status.changes.iter().any(|c| c.conflict) {
            "冲突待解决"
        } else if rebase.join("amend").exists() {
            "edit 暂停，等待修改提交"
        } else if status.repository.operation == "rebase" {
            "变基已暂停，请检查提交、空提交或提交消息"
        } else if status.repository.operation != "none" {
            "Git 操作待继续或中止"
        } else {
            ""
        }
        .into();
        Ok(RecoveryOverview {
            records,
            operation: status.repository.operation,
            original_head,
            current,
            progress,
            reason,
        })
    }

    pub(crate) async fn recover_navigation(&self, id: &str, action: &str) -> Result<(), String> {
        let mut record = self
            .operation_records()
            .await?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("恢复记录已不存在")?;
        let status = self.status().await?;
        if status.repository.operation != "none" || status.changes.iter().any(|c| c.conflict) {
            return Err("请先解决冲突并完成当前 Git 操作".into());
        }
        match action {
            "restore" if !matches!(record.phase.as_str(), "completed" | "failed-restored") => {
                if status.changes.iter().any(|c| c.index != '?') {
                    return Err(
                        "恢复备份前请提交或保存当前修改；部分恢复后请手动解决并标记完成".into(),
                    );
                }
                self.restore_record(&mut record).await
            }
            "finish" => {
                record.phase = "completed".into();
                self.save_record(&record).await
            }
            _ => Err("恢复操作无效或备份已经恢复".into()),
        }
    }

    pub(crate) async fn reflog(&self) -> Result<Vec<ReflogEntry>, String> {
        Ok(self
            .text(&[
                "reflog",
                "show",
                "HEAD",
                "-200",
                "--format=%H%x00%gD%x00%gs",
            ])
            .await?
            .lines()
            .filter_map(|l| {
                let mut p = l.splitn(3, '\0');
                Some(ReflogEntry {
                    hash: p.next()?.into(),
                    reference: p.next()?.into(),
                    subject: p.next()?.into(),
                })
            })
            .collect())
    }

    pub(crate) async fn create_recovery_branch(
        &self,
        name: &str,
        hash: &str,
    ) -> Result<(), String> {
        validate_hash(hash)?;
        if name.is_empty() || name.starts_with('-') || name.len() > 1024 {
            return Err("分支名称无效".into());
        }
        self.bytes(&["check-ref-format", "--branch", name]).await?;
        self.resolve_commit(hash).await?;
        self.bytes(&["branch", "--", name, hash]).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;

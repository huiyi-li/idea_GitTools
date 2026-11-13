use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LineSelection {
    pub hunk: usize,
    // Zero-based offsets in the reviewed unified hunk, including its @@ header.
    pub lines: Vec<usize>,
}

struct PatchLine<'a> {
    offset: usize,
    kind: u8,
    text: &'a str,
}

fn patch_lines(hunk: &str) -> Result<Vec<PatchLine<'_>>, String> {
    let mut lines: Vec<PatchLine<'_>> = Vec::new();
    for (offset, line) in hunk.split_inclusive('\n').enumerate().skip(1) {
        if line.starts_with("\\ No newline at end of file") {
            let previous = lines.last_mut().ok_or("补丁末尾换行标记无效")?;
            previous.text = previous
                .text
                .strip_suffix('\n')
                .ok_or("补丁末尾换行标记无效")?;
        } else {
            let kind = *line.as_bytes().first().ok_or("补丁行为空")?;
            if !matches!(kind, b' ' | b'+' | b'-') {
                return Err("补丁行格式无效".into());
            }
            lines.push(PatchLine {
                offset,
                kind,
                text: &line[1..],
            });
        }
    }
    Ok(lines)
}

fn source_start(hunk: &str, reverse: bool) -> Result<usize, String> {
    let header: Vec<_> = hunk
        .lines()
        .next()
        .ok_or("补丁缺少头部")?
        .split_whitespace()
        .collect();
    let range = header
        .get(if reverse { 2 } else { 1 })
        .ok_or("补丁范围无效")?;
    let (start, count) = range[1..].split_once(',').unwrap_or((&range[1..], "1"));
    let start: usize = start.parse().map_err(|_| "补丁范围无效")?;
    let count: usize = count.parse().map_err(|_| "补丁范围无效")?;
    Ok(if count == 0 {
        start
    } else {
        start.saturating_sub(1)
    })
}

fn selected_contents(
    source: &str,
    preview: &HunkPreview,
    selections: &[LineSelection],
    reverse: bool,
) -> Result<String, String> {
    let mut selected = BTreeMap::new();
    for selection in selections {
        let hunk = preview.hunks.get(selection.hunk).ok_or("变化块已不存在")?;
        let lines = patch_lines(hunk)?;
        let chosen: BTreeSet<_> = selection.lines.iter().copied().collect();
        let valid: BTreeSet<_> = lines
            .iter()
            .filter(|line| matches!(line.kind, b'+' | b'-'))
            .map(|line| line.offset)
            .collect();
        if chosen.is_empty()
            || chosen.len() != selection.lines.len()
            || !chosen.is_subset(&valid)
            || selected.insert(selection.hunk, chosen).is_some()
        {
            return Err("请选择有效的新增或删除行".into());
        }
    }
    if selected.is_empty() {
        return Err("请至少选择一个变化行".into());
    }
    let source: Vec<_> = source.split_inclusive('\n').collect();
    let mut result = Vec::new();
    let mut cursor = 0;
    for (index, chosen) in selected {
        let hunk = &preview.hunks[index];
        let start = source_start(hunk, reverse)?;
        if start < cursor || start > source.len() {
            return Err("补丁与文件范围不匹配".into());
        }
        result.extend_from_slice(&source[cursor..start]);
        cursor = start;
        for line in patch_lines(hunk)? {
            let consumes = line.kind == b' ' || line.kind == if reverse { b'+' } else { b'-' };
            if consumes {
                let original = source.get(cursor).ok_or("补丁超出文件范围")?;
                if *original != line.text {
                    return Err("补丁与文件内容不匹配，请重新读取".into());
                }
                cursor += 1;
                if line.kind == b' ' || !chosen.contains(&line.offset) {
                    result.push(*original);
                }
            } else if chosen.contains(&line.offset) {
                result.push(line.text);
            }
        }
    }
    result.extend_from_slice(&source[cursor..]);
    let mut text = String::new();
    for (index, line) in result.iter().enumerate() {
        text.push_str(line);
        // Keeping an unterminated source line while adding a following line
        // requires a separator. Preserve the final line's own newline state.
        if index + 1 < result.len() && !line.ends_with('\n') {
            text.push('\n');
        }
    }
    if text.len() > content::MAX_LARGE_FILE || result.len() > content::MAX_LARGE_LINES {
        return Err("按行操作结果超过文件大小或行数限制".into());
    }
    Ok(text)
}

impl Git {
    pub(crate) async fn apply_hunk_lines(
        &self,
        preview: HunkPreview,
        selections: Vec<LineSelection>,
        discard: bool,
    ) -> Result<(), String> {
        if discard && preview.area != "unstaged" {
            return Err("请在未暂存区域放弃修改".into());
        }
        let index_path = self.root.join(
            self.text(&["rev-parse", "--git-path", "index"])
                .await?
                .trim(),
        );
        let transaction = super::super::merge::IndexTransaction::new(&index_path)?;
        let fresh = self.preview_hunks(&preview.path, &preview.area).await?;
        if fresh != preview {
            return Err("文件或暂存区已改变，请重新读取变化块".into());
        }
        let path = super::super::discard::checked_path(&self.root, &fresh.path)?;
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("符号链接请使用整文件操作".into());
        }
        let entries = self
            .text(&[
                "--literal-pathspecs",
                "ls-files",
                "--stage",
                "-z",
                "--",
                &fresh.path,
            ])
            .await?;
        let mode = entries
            .split_whitespace()
            .next()
            .filter(|mode| matches!(*mode, "100644" | "100755"))
            .or_else(|| {
                fresh.header.lines().find_map(|line| {
                    line.strip_prefix("new file mode ")
                        .or_else(|| line.strip_prefix("deleted file mode "))
                })
            })
            .ok_or("此文件类型请使用整文件操作")?;
        if !matches!(mode, "100644" | "100755") {
            return Err("此文件类型请使用整文件操作".into());
        }
        let expected_stamp = if discard {
            Some(super::super::merge::stamp(&path)?)
        } else {
            None
        };
        let source = if discard {
            if path.exists() {
                let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                if bytes.len() > content::MAX_LARGE_FILE {
                    return Err("文件超过按行操作限制".into());
                }
                let hash = self
                    .execute(
                        &[
                            "hash-object",
                            "-w",
                            &format!("--path={}", fresh.path),
                            "--stdin",
                        ],
                        Some(&bytes),
                    )
                    .await?
                    .checked()?;
                let hash = std::str::from_utf8(&hash)
                    .map_err(|e| e.to_string())?
                    .trim();
                self.text(&["cat-file", "blob", hash]).await?
            } else {
                String::new()
            }
        } else {
            self.index_snapshot(&fresh.path, true).await?.text
        };
        let reverse = discard || fresh.area == "staged";
        let result = selected_contents(&source, &fresh, &selections, reverse)?;
        let missing = result.is_empty()
            && if reverse {
                fresh.header.contains("\nnew file mode ")
            } else {
                fresh.header.contains("\ndeleted file mode ")
            };
        let hash = self
            .execute(&["hash-object", "-w", "--stdin"], Some(result.as_bytes()))
            .await?
            .checked()?;
        let hash = std::str::from_utf8(&hash)
            .map_err(|e| e.to_string())?
            .trim();
        if discard {
            let bytes = if missing {
                Vec::new()
            } else {
                self.bytes(&[
                    "cat-file",
                    "--filters",
                    &format!("--path={}", fresh.path),
                    hash,
                ])
                .await?
            };
            if self.preview_hunks(&fresh.path, &fresh.area).await? != fresh {
                return Err("文件或暂存区已改变，请重新读取变化块".into());
            }
            if missing {
                if super::super::merge::stamp(&path)? != expected_stamp.as_deref().unwrap_or("") {
                    return Err("文件已改变，请重新读取".into());
                }
                std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            } else {
                std::fs::create_dir_all(path.parent().ok_or("文件路径无效")?)
                    .map_err(|e| e.to_string())?;
                super::super::discard::checked_path(&self.root, &fresh.path)?;
                super::super::merge::atomic_write(&path, &bytes, expected_stamp.as_deref())?;
            }
        } else {
            let env = [("GIT_INDEX_FILE", transaction.temporary_path())];
            if !index_path.exists() {
                self.execute_with_env(&["read-tree", "--empty"], None, &env)
                    .await?
                    .checked()?;
            }
            let args = if missing {
                vec!["update-index", "--force-remove", "--", &fresh.path]
            } else {
                vec![
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    mode,
                    hash,
                    &fresh.path,
                ]
            };
            self.execute_with_env(&args, None, &env).await?.checked()?;
            if self.preview_hunks(&fresh.path, &fresh.area).await? != fresh {
                return Err("文件或暂存区已改变，请重新读取变化块".into());
            }
            transaction.commit()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    fn choose(preview: &HunkPreview, texts: &[&str]) -> Vec<LineSelection> {
        preview
            .hunks
            .iter()
            .enumerate()
            .filter_map(|(hunk, text)| {
                let lines: Vec<_> = text
                    .split_inclusive('\n')
                    .enumerate()
                    .filter(|(_, line)| texts.contains(&line.trim_end_matches('\n')))
                    .map(|(offset, _)| offset)
                    .collect();
                (!lines.is_empty()).then_some(LineSelection { hunk, lines })
            })
            .collect()
    }

    #[tokio::test]
    async fn selected_replacements_stage_unstage_and_discard_without_touching_other_lines() {
        let dir = fixture();
        std::fs::write(dir.path().join("file.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-m", "base"]);
        std::fs::write(dir.path().join("file.txt"), "ONE\ntwo\nTHREE\nfour\n").unwrap();
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let preview = git.preview_hunks("file.txt", "unstaged").await.unwrap();
        let selection = choose(&preview, &["-one", "+ONE"]);
        git.apply_hunk_lines(preview.clone(), selection.clone(), false)
            .await
            .unwrap();
        assert_eq!(
            run(dir.path(), &["show", ":file.txt"]),
            "ONE\ntwo\nthree\nfour\n"
        );
        assert!(git
            .apply_hunk_lines(preview, selection, false)
            .await
            .is_err());
        let staged = git.preview_hunks("file.txt", "staged").await.unwrap();
        git.apply_hunk_lines(staged.clone(), choose(&staged, &["-one", "+ONE"]), false)
            .await
            .unwrap();
        assert_eq!(
            run(dir.path(), &["show", ":file.txt"]),
            "one\ntwo\nthree\nfour\n"
        );
        let preview = git.preview_hunks("file.txt", "unstaged").await.unwrap();
        git.apply_hunk_lines(
            preview.clone(),
            choose(&preview, &["-three", "+THREE"]),
            true,
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            "ONE\ntwo\nthree\nfour\n"
        );
        assert_eq!(
            run(dir.path(), &["show", ":file.txt"]),
            "one\ntwo\nthree\nfour\n"
        );
    }

    #[tokio::test]
    async fn new_literal_crlf_files_keep_final_newlines_and_allow_partial_unstage() {
        let dir = fixture();
        run(dir.path(), &["config", "core.autocrlf", "true"]);
        let path = "空 格 [x].txt";
        std::fs::write(dir.path().join(path), "one\r\ntwo").unwrap();
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let preview = git.preview_hunks(path, "unstaged").await.unwrap();
        let selected = choose(&preview, &["+two"]);
        git.apply_hunk_lines(preview, selected, false)
            .await
            .unwrap();
        assert_eq!(run(dir.path(), &["show", &format!(":{path}")]), "two");
        assert_eq!(std::fs::read(dir.path().join(path)).unwrap(), b"one\r\ntwo");
        let preview = git.preview_hunks(path, "unstaged").await.unwrap();
        let lines = patch_lines(&preview.hunks[0])
            .unwrap()
            .iter()
            .filter(|line| matches!(line.kind, b'+' | b'-'))
            .map(|line| line.offset)
            .collect();
        git.apply_hunk_lines(preview, vec![LineSelection { hunk: 0, lines }], false)
            .await
            .unwrap();
        assert_eq!(run(dir.path(), &["show", &format!(":{path}")]), "one\ntwo");
        let preview = git.preview_hunks(path, "staged").await.unwrap();
        let selection = choose(&preview, &["+one"]);
        git.apply_hunk_lines(preview, selection, false)
            .await
            .unwrap();
        assert_eq!(run(dir.path(), &["show", &format!(":{path}")]), "two");
        let preview = git.preview_hunks(path, "unstaged").await.unwrap();
        let selection = choose(&preview, &["+one"]);
        git.apply_hunk_lines(preview, selection, true)
            .await
            .unwrap();
        assert_eq!(std::fs::read(dir.path().join(path)).unwrap(), b"two");
    }

    #[tokio::test]
    async fn partial_deletions_remain_files_and_unstaging_selected_additions_can_remove_the_index_entry(
    ) {
        let dir = fixture();
        std::fs::write(dir.path().join("file.txt"), "one\ntwo\n").unwrap();
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-m", "base"]);
        std::fs::remove_file(dir.path().join("file.txt")).unwrap();
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let preview = git.preview_hunks("file.txt", "unstaged").await.unwrap();
        git.apply_hunk_lines(preview.clone(), choose(&preview, &["-one"]), false)
            .await
            .unwrap();
        assert_eq!(run(dir.path(), &["show", ":file.txt"]), "two\n");
        let preview = git.preview_hunks("file.txt", "unstaged").await.unwrap();
        git.apply_hunk_lines(preview.clone(), choose(&preview, &["-two"]), true)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            "two\n"
        );
        std::fs::write(dir.path().join("new.txt"), "new\n").unwrap();
        git.stage(vec!["new.txt".into()], false).await.unwrap();
        let preview = git.preview_hunks("new.txt", "staged").await.unwrap();
        git.apply_hunk_lines(preview.clone(), choose(&preview, &["+new"]), false)
            .await
            .unwrap();
        assert!(run(dir.path(), &["ls-files", "--", "new.txt"]).is_empty());
        assert!(dir.path().join("new.txt").exists());
    }

    #[tokio::test]
    async fn no_newline_selection_and_invalid_or_locked_requests_preserve_source_state() {
        let dir = fixture();
        std::fs::write(dir.path().join("file.txt"), "old").unwrap();
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-m", "base"]);
        std::fs::write(dir.path().join("file.txt"), "new").unwrap();
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let preview = git.preview_hunks("file.txt", "unstaged").await.unwrap();
        assert!(git
            .apply_hunk_lines(
                preview.clone(),
                vec![LineSelection {
                    hunk: 0,
                    lines: vec![0]
                }],
                false
            )
            .await
            .is_err());
        std::fs::write(dir.path().join(".git/index.lock"), "locked").unwrap();
        assert!(git
            .apply_hunk_lines(preview.clone(), choose(&preview, &["+new"]), false)
            .await
            .is_err());
        std::fs::remove_file(dir.path().join(".git/index.lock")).unwrap();
        git.apply_hunk_lines(preview.clone(), choose(&preview, &["+new"]), false)
            .await
            .unwrap();
        assert_eq!(run(dir.path(), &["show", ":file.txt"]), "old\nnew");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            "new"
        );
    }

    #[tokio::test]
    async fn selecting_separate_hunks_preserves_other_index_entries_and_failed_filters_preserve_worktree(
    ) {
        let dir = fixture();
        let base = (0..40).map(|i| format!("line {i}\n")).collect::<String>();
        std::fs::write(dir.path().join("file.txt"), &base).unwrap();
        std::fs::write(
            dir.path().join(".gitattributes"),
            "file.txt filter=example\n",
        )
        .unwrap();
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-m", "base"]);
        let edited = base
            .replace("line 1\n", "first\n")
            .replace("line 30\n", "second\n");
        std::fs::write(dir.path().join("file.txt"), &edited).unwrap();
        std::fs::write(dir.path().join("other.txt"), "other staged\n").unwrap();
        run(dir.path(), &["add", "other.txt"]);
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let preview = git.preview_hunks("file.txt", "unstaged").await.unwrap();
        assert_eq!(preview.hunks.len(), 2);
        let selected = choose(&preview, &["-line 1", "+first", "-line 30", "+second"]);
        git.apply_hunk_lines(preview, selected, false)
            .await
            .unwrap();
        assert_eq!(run(dir.path(), &["show", ":file.txt"]), edited);
        assert_eq!(run(dir.path(), &["show", ":other.txt"]), "other staged\n");
        std::fs::write(dir.path().join("file.txt"), &base).unwrap();
        run(dir.path(), &["config", "filter.example.clean", "cat"]);
        run(dir.path(), &["config", "filter.example.smudge", "false"]);
        run(dir.path(), &["config", "filter.example.required", "true"]);
        let before = std::fs::read(dir.path().join(".git/index")).unwrap();
        let preview = git.preview_hunks("file.txt", "unstaged").await.unwrap();
        let selected = choose(&preview, &["+line 1", "-first"]);
        assert!(git.apply_hunk_lines(preview, selected, true).await.is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            base
        );
        assert_eq!(
            std::fs::read(dir.path().join(".git/index")).unwrap(),
            before
        );
        assert!(!dir.path().join(".git/index.lock").exists());
    }
}

use super::*;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileHistoryEntry {
    commit: Commit,
    path: String,
    old_path: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileHistory {
    revision: String,
    entries: Vec<FileHistoryEntry>,
    has_more: bool,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BlameLine {
    hash: String,
    original_line: usize,
    line: usize,
    author: String,
    time: i64,
    summary: String,
    path: String,
    text: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BlamePage {
    lines: Vec<BlameLine>,
    has_more: bool,
}

impl Git {
    pub(crate) async fn file_history(
        &self,
        path: &str,
        revision: Option<&str>,
        offset: usize,
    ) -> Result<FileHistory, String> {
        validate_path(path)?;
        let revision = self.resolve_commit(revision.unwrap_or("HEAD")).await?;
        let count = offset.checked_add(101).ok_or("分页位置无效")?;
        let format = format!("--format=%x00{LOG_FORMAT}");
        let text = self
            .text(&[
                "--literal-pathspecs",
                "log",
                "--follow",
                "--name-status",
                "-M",
                "-z",
                &format,
                &format!("--max-count={count}"),
                &revision,
                "--",
                path,
            ])
            .await?;
        let fields: Vec<_> = text.split_terminator('\0').collect();
        let mut cursor = 0;
        let mut current_path = path.to_owned();
        let mut entries = Vec::new();
        while cursor < fields.len() {
            while cursor < fields.len() && fields[cursor].is_empty() {
                cursor += 1;
            }
            if cursor == fields.len() {
                break;
            }
            let commit = parse_commit(fields.get(cursor..cursor + 7).ok_or("文件历史记录不完整")?)?;
            cursor += 7;
            while cursor < fields.len() && fields[cursor].is_empty() {
                cursor += 1;
            }
            let mut old_path = None;
            let mut commit_path = current_path.clone();
            while cursor < fields.len() && !fields[cursor].is_empty() {
                let kind = fields[cursor]
                    .trim_start_matches('\n')
                    .chars()
                    .next()
                    .ok_or("文件状态无效")?;
                cursor += 1;
                let first = fields.get(cursor).ok_or("缺少文件路径")?;
                cursor += 1;
                if matches!(kind, 'R' | 'C') {
                    let next = fields.get(cursor).ok_or("缺少重命名路径")?;
                    cursor += 1;
                    if *next == current_path {
                        commit_path = (*next).into();
                        old_path = Some((*first).into());
                        if kind == 'R' {
                            current_path = (*first).into();
                        }
                    }
                }
            }
            entries.push(FileHistoryEntry {
                commit,
                path: commit_path,
                old_path,
            });
        }
        let has_more = entries.len() > offset.saturating_add(100);
        Ok(FileHistory {
            revision,
            entries: entries.into_iter().skip(offset).take(100).collect(),
            has_more,
        })
    }

    pub(crate) async fn blame(
        &self,
        path: &str,
        revision: Option<&str>,
        offset: usize,
    ) -> Result<BlamePage, String> {
        validate_path(path)?;
        let revision = match revision {
            Some(value) => Some(self.resolve_commit(value).await?),
            None => None,
        };
        let file = if let Some(revision) = &revision {
            self.blob_snapshot(Some(revision), path, true).await?
        } else {
            self.worktree_snapshot(path, true).await?
        };
        if file.state != content::SnapshotState::Text {
            return Err("此版本不是可读取的 UTF-8 文本文件".into());
        }
        let line_count = file.text.lines().count();
        if offset >= line_count {
            return Ok(BlamePage {
                lines: vec![],
                has_more: false,
            });
        }
        let end = offset.saturating_add(200).min(line_count);
        let range = format!("{},{}", offset + 1, end);
        let mut args = vec![
            "--literal-pathspecs",
            "blame",
            "--line-porcelain",
            "-L",
            &range,
        ];
        if let Some(revision) = &revision {
            args.push(revision);
        }
        args.extend(["--", path]);
        let output = self.text(&args).await?;
        let mut lines = Vec::new();
        let mut entry = BlameLine::default();
        for line in output.lines() {
            if let Some(text) = line.strip_prefix('\t') {
                entry.text = text.into();
                lines.push(entry);
                entry = BlameLine::default();
            } else if let Some(author) = line.strip_prefix("author ") {
                entry.author = author.into();
            } else if let Some(time) = line.strip_prefix("author-time ") {
                entry.time = time.parse().map_err(|_| "Blame 时间无效")?;
            } else if let Some(summary) = line.strip_prefix("summary ") {
                entry.summary = summary.into();
            } else if let Some(path) = line.strip_prefix("filename ") {
                entry.path = decode_path(path)?;
            } else if line
                .split_whitespace()
                .next()
                .is_some_and(|hash| validate_hash(hash).is_ok())
            {
                let fields: Vec<_> = line.split_whitespace().collect();
                entry.hash = fields[0].into();
                entry.original_line = fields
                    .get(1)
                    .ok_or("Blame 行号缺失")?
                    .parse()
                    .map_err(|_| "Blame 行号无效")?;
                entry.line = fields
                    .get(2)
                    .ok_or("Blame 行号缺失")?
                    .parse()
                    .map_err(|_| "Blame 行号无效")?;
            }
        }
        Ok(BlamePage {
            lines,
            has_more: end < line_count,
        })
    }
}

fn decode_path(path: &str) -> Result<String, String> {
    if !path.starts_with('"') {
        return Ok(path.into());
    }
    let bytes = path
        .strip_prefix('"')
        .and_then(|path| path.strip_suffix('"'))
        .ok_or("文件名引号无效")?
        .as_bytes();
    let mut result = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            result.push(bytes[index]);
            index += 1;
            continue;
        }
        index += 1;
        let byte = *bytes.get(index).ok_or("文件名转义无效")?;
        if matches!(byte, b'0'..=b'7') {
            let octal = bytes.get(index..index + 3).ok_or("文件名转义无效")?;
            let octal = std::str::from_utf8(octal).map_err(|_| "文件名转义无效")?;
            result.push(u8::from_str_radix(octal, 8).map_err(|_| "文件名转义无效")?);
            index += 3;
        } else {
            result.push(match byte {
                b'a' => 7,
                b'b' => 8,
                b't' => 9,
                b'n' => 10,
                b'v' => 11,
                b'f' => 12,
                b'r' => 13,
                b'"' => b'"',
                b'\\' => b'\\',
                _ => return Err("文件名转义无效".into()),
            });
            index += 1;
        }
    }
    String::from_utf8(result).map_err(|_| "文件名不是 UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    #[tokio::test]
    async fn file_history_follows_renames_and_blame_reports_source_commits() {
        let directory = fixture();
        std::fs::write(directory.path().join("before.txt"), "first\nsecond\n").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "first"]);
        let first = run(directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        run(directory.path(), &["mv", "before.txt", "空 格.txt"]);
        run(directory.path(), &["commit", "-m", "rename"]);
        std::fs::write(directory.path().join("空 格.txt"), "first\nchanged\n").unwrap();
        run(directory.path(), &["add", "."]);
        run(directory.path(), &["commit", "-m", "change"]);
        let git = Git::open(directory.path().to_str().unwrap(), None)
            .await
            .unwrap();
        let history = git.file_history("空 格.txt", None, 0).await.unwrap();
        assert_eq!(history.entries.len(), 3);
        assert_eq!(history.entries[1].old_path.as_deref(), Some("before.txt"));
        assert_eq!(history.entries[2].path, "before.txt");
        let blame = git.blame("空 格.txt", None, 0).await.unwrap();
        assert_eq!(blame.lines.len(), 2);
        assert_eq!(blame.lines[0].hash, first);
        assert_eq!(blame.lines[0].path, "before.txt");
        assert_eq!(blame.lines[1].summary, "change");
    }
}

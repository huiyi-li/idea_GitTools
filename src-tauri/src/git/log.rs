use super::*;

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(i, byte)| i == 4 || i == 7 || byte.is_ascii_digit())
    {
        return false;
    }
    let year = value[..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<usize>().unwrap_or(0);
    let day = value[8..].parse::<u32>().unwrap_or(0);
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = [
        0,
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    year >= 1970 && month < days.len() && day > 0 && day <= days[month]
}

impl Git {
    pub async fn log(&self, query: LogQuery) -> Result<LogPage, String> {
        if query.offset > 10_000_000
            || [&query.search, &query.author, &query.path, &query.branch]
                .iter()
                .any(|s| s.len() > 4096 || s.contains('\0'))
        {
            return Err("提交筛选条件过长或包含无效字符".into());
        }
        for date in [&query.since, &query.until] {
            if !date.is_empty() && !valid_date(date) {
                return Err("请选择有效日期（YYYY-MM-DD）".into());
            }
        }
        if !query.since.is_empty() && !query.until.is_empty() && query.since > query.until {
            return Err("开始日期应早于或等于结束日期".into());
        }
        if !query.path.is_empty() {
            validate_path(&query.path)?;
        }
        if !query.revision.is_empty()
            && (!(4..=64).contains(&query.revision.len())
                || !query.revision.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("请输入至少 4 位的提交 SHA".into());
        }
        if self.repository().await?.head.is_none() {
            return Ok(LogPage {
                commits: vec![],
                has_more: false,
            });
        }
        let branch = if query.branch.is_empty() {
            String::new()
        } else {
            self.resolve_commit(&query.branch).await?
        };
        let revision = if query.revision.is_empty() {
            String::new()
        } else {
            self.resolve_commit(&query.revision).await?
        };
        if !revision.is_empty() && !branch.is_empty() {
            let result = self
                .execute(&["merge-base", "--is-ancestor", &revision, &branch], None)
                .await?;
            if result.code == 1 {
                return Ok(LogPage {
                    commits: vec![],
                    has_more: false,
                });
            }
            result.checked()?;
        }
        let mut args = vec![
            "--literal-pathspecs".into(),
            "log".into(),
            "--decorate=full".into(),
            "--decorate-refs-exclude=refs/ideagittool/*".into(),
            "--decorate-refs-exclude=refs/stash".into(),
            "-z".into(),
            format!("--format={LOG_FORMAT}"),
            format!("--skip={}", query.offset),
            format!("--max-count={}", PAGE_SIZE + 1),
            "--fixed-strings".into(),
            "--regexp-ignore-case".into(),
        ];
        match query.merge.as_str() {
            "merges" => args.push("--merges".into()),
            "non-merges" => args.push("--no-merges".into()),
            _ => {}
        }
        for (option, value) in [("--grep", &query.search), ("--author", &query.author)] {
            if !value.is_empty() {
                args.push(format!("{option}={value}"));
            }
        }
        if !query.since.is_empty() {
            args.push(format!("--since-as-filter={}T00:00:00", query.since));
        }
        if !query.until.is_empty() {
            args.push(format!("--until={}T23:59:59", query.until));
        }
        if !revision.is_empty() {
            args.extend(["--no-walk=unsorted".into(), revision]);
        } else {
            args.push("--topo-order".into());
            if branch.is_empty() {
                args.extend(["--branches", "--remotes", "--tags", "HEAD"].map(String::from));
            } else {
                args.push(branch);
            }
        }
        args.push("--".into());
        if !query.path.is_empty() {
            args.push(query.path);
        }
        let args: Vec<_> = args.iter().map(String::as_str).collect();
        let mut commits = parse_commits(&self.bytes(&args).await?)?;
        let has_more = commits.len() > PAGE_SIZE;
        commits.truncate(PAGE_SIZE);
        Ok(LogPage { commits, has_more })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::tests::{fixture, run};

    #[tokio::test]
    async fn combined_filters_use_literal_paths_authors_dates_and_exact_commit_ids() {
        let dir = fixture();
        let path = "空 格 [x].txt";
        std::fs::write(dir.path().join(path), "base\n").unwrap();
        run(dir.path(), &["add", "."]);
        run(
            dir.path(),
            &[
                "commit",
                "-m",
                "first [literal]",
                "--date=2026-01-10T12:00:00+0800",
            ],
        );
        let first = run(dir.path(), &["rev-parse", "HEAD"]).trim().to_string();
        std::fs::write(dir.path().join("other.txt"), "other\n").unwrap();
        run(dir.path(), &["add", "."]);
        run(
            dir.path(),
            &[
                "commit",
                "-m",
                "second",
                "--author=Other <other@example.test>",
            ],
        );
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        let query = LogQuery {
            author: "desktop@example.test".into(),
            search: "[literal]".into(),
            path: path.into(),
            ..Default::default()
        };
        assert_eq!(git.log(query.clone()).await.unwrap().commits[0].hash, first);
        assert!(git
            .log(LogQuery {
                author: "missing".into(),
                ..query
            })
            .await
            .unwrap()
            .commits
            .is_empty());
        let page = git
            .log(LogQuery {
                revision: first[..8].into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].hash, first);
        run(dir.path(), &["branch", "limited", &first]);
        let head = run(dir.path(), &["rev-parse", "HEAD"]).trim().to_string();
        assert!(git
            .log(LogQuery {
                branch: "limited".into(),
                revision: head,
                ..Default::default()
            })
            .await
            .unwrap()
            .commits
            .is_empty());
        let future = git
            .log(LogQuery {
                since: "2099-01-01".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(future.commits.is_empty());
        let past = git
            .log(LogQuery {
                until: "1970-01-02".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(past.commits.is_empty());
        let old: LogQuery =
            serde_json::from_str(r#"{"offset":0,"search":"","branch":""}"#).unwrap();
        assert_eq!(git.log(old).await.unwrap().commits.len(), 2);
        for invalid in [
            LogQuery {
                since: "2026-02-30".into(),
                ..Default::default()
            },
            LogQuery {
                path: "../outside".into(),
                ..Default::default()
            },
            LogQuery {
                revision: "--all".into(),
                ..Default::default()
            },
        ] {
            assert!(git.log(invalid).await.is_err());
        }
    }

    #[tokio::test]
    async fn date_ranges_include_the_whole_day_and_offset_applies_after_filtering() {
        let dir = fixture();
        for (message, date) in [
            ("january", "2026-01-10T23:59:00+0800"),
            ("february", "2026-02-01T12:00:00+0800"),
        ] {
            let output = std::process::Command::new("git")
                .args(["commit", "--allow-empty", "-m", message])
                .env("GIT_AUTHOR_DATE", date)
                .env("GIT_COMMITTER_DATE", date)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(output.status.success());
        }
        let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
        // Git evaluates date-only controls in the system's local time zone.
        let page = git
            .log(LogQuery {
                since: "2026-01-09".into(),
                until: "2026-01-11".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].subject, "january");
        let page = git
            .log(LogQuery {
                search: "january".into(),
                offset: 1,
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(page.commits.is_empty());
        assert!(git
            .log(LogQuery {
                since: "2026-02-01".into(),
                until: "2026-01-01".into(),
                ..Default::default()
            })
            .await
            .is_err());
    }
}

use super::*;
use crate::git::tests::{fixture, run};
use std::fs;

#[tokio::test]
async fn content_search_distinguishes_literal_counts_from_changed_lines() {
    let dir = fixture();
    let path = "空 格 [x].txt";
    let commit = |text: &str, message: &str| {
        fs::write(dir.path().join(path), text).unwrap();
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-m", message]);
        run(dir.path(), &["rev-parse", "HEAD"]).trim().to_owned()
    };
    let introduced = commit("token[0] = 1;\n", "introduce");
    let edited = commit("token[0] = 2;\n", "edit without changing count");
    let removed = commit("other\n", "remove");
    run(
        dir.path(),
        &["commit", "--allow-empty", "-m", "token[0] only in message"],
    );
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let literal = LogQuery {
        content: "token[0]".into(),
        ..Default::default()
    };
    let page = git.log(literal.clone()).await.unwrap();
    assert_eq!(
        page.commits.iter().map(|c| &c.hash).collect::<Vec<_>>(),
        vec![&removed, &introduced]
    );
    assert!(!page.has_more);
    assert_eq!(
        git.log(LogQuery {
            content: "TOKEN[0]".into(),
            ..literal.clone()
        })
        .await
        .unwrap()
        .commits
        .len(),
        2
    );
    let regex = LogQuery {
        content: r"token\[0\]".into(),
        content_regex: true,
        ..Default::default()
    };
    let page = git.log(regex.clone()).await.unwrap();
    assert_eq!(
        page.commits.iter().map(|c| &c.hash).collect::<Vec<_>>(),
        vec![&removed, &edited, &introduced]
    );
    let combined = LogQuery {
        path: path.into(),
        author: "desktop@example.test".into(),
        search: "edit without".into(),
        ..regex
    };
    assert_eq!(
        git.log(combined.clone()).await.unwrap().commits[0].hash,
        edited
    );
    assert!(git
        .log(LogQuery {
            path: "other.txt".into(),
            ..combined
        })
        .await
        .unwrap()
        .commits
        .is_empty());
    assert_eq!(
        git.log(LogQuery {
            offset: 1,
            ..literal.clone()
        })
        .await
        .unwrap()
        .commits[0]
            .hash,
        introduced
    );
    assert!(git
        .log(LogQuery {
            revision: edited.clone(),
            ..literal.clone()
        })
        .await
        .unwrap()
        .commits
        .is_empty());
    assert_eq!(
        git.log(LogQuery {
            revision: removed.clone(),
            ..literal.clone()
        })
        .await
        .unwrap()
        .commits[0]
            .hash,
        removed
    );
    run(dir.path(), &["branch", "before-removal", &edited]);
    assert_eq!(
        git.log(LogQuery {
            branch: "before-removal".into(),
            ..literal
        })
        .await
        .unwrap()
        .commits[0]
            .hash,
        introduced
    );
}

#[tokio::test]
async fn content_search_treats_option_like_text_literally_and_rejects_invalid_inputs() {
    let dir = fixture();
    fs::write(dir.path().join("file.txt"), "--all\n").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["commit", "-m", "base"]);
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    assert_eq!(
        git.log(LogQuery {
            content: "--all".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .commits
        .len(),
        1
    );
    for query in [
        LogQuery {
            content: "[".into(),
            content_regex: true,
            ..Default::default()
        },
        LogQuery {
            content: "invalid\0value".into(),
            ..Default::default()
        },
        LogQuery {
            content: "a".repeat(4097),
            ..Default::default()
        },
    ] {
        assert!(git.log(query).await.is_err());
    }
    let old: LogQuery = serde_json::from_str(r#"{"offset":0,"search":"","branch":""}"#).unwrap();
    assert!(old.content.is_empty() && !old.content_regex);
    assert_eq!(git.log(old).await.unwrap().commits.len(), 1);
    assert_eq!(
        git.log(LogQuery {
            content_regex: true,
            ..Default::default()
        })
        .await
        .unwrap()
        .commits
        .len(),
        1
    );
    let empty = fixture();
    let git = Git::open(empty.path().to_str().unwrap(), None)
        .await
        .unwrap();
    assert!(git
        .log(LogQuery {
            content: "text".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .commits
        .is_empty());
}

#[tokio::test]
async fn content_search_pages_matches_without_gaps_or_repeated_commits() {
    let dir = fixture();
    fs::write(dir.path().join("file.txt"), "needle\n").unwrap();
    run(dir.path(), &["add", "."]);
    let with_needle = run(dir.path(), &["write-tree"]).trim().to_owned();
    fs::write(dir.path().join("file.txt"), "other\n").unwrap();
    run(dir.path(), &["add", "."]);
    let without_needle = run(dir.path(), &["write-tree"]).trim().to_owned();
    let mut parent = String::new();
    let mut matches = Vec::new();
    for index in 0..(PAGE_SIZE + 3) {
        let tree = if index % 2 == 0 {
            &with_needle
        } else {
            &without_needle
        };
        let mut args = vec!["commit-tree", tree.as_str(), "-m", "content change"];
        if !parent.is_empty() {
            args.extend(["-p", &parent]);
        }
        let hash = run(dir.path(), &args).trim().to_owned();
        matches.push(hash.clone());
        parent = run(
            dir.path(),
            &["commit-tree", tree, "-p", &hash, "-m", "unrelated metadata"],
        )
        .trim()
        .to_owned();
    }
    run(dir.path(), &["update-ref", "refs/heads/main", &parent]);
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let query = LogQuery {
        content: "needle".into(),
        ..Default::default()
    };
    let first = git.log(query.clone()).await.unwrap();
    let second = git
        .log(LogQuery {
            offset: PAGE_SIZE,
            ..query.clone()
        })
        .await
        .unwrap();
    assert_eq!(first.commits.len(), PAGE_SIZE);
    assert!(first.has_more);
    assert_eq!(second.commits.len(), 3);
    assert!(!second.has_more);
    matches.reverse();
    assert_eq!(
        first
            .commits
            .into_iter()
            .chain(second.commits)
            .map(|c| c.hash)
            .collect::<Vec<_>>(),
        matches
    );
    assert!(git
        .log(LogQuery {
            offset: PAGE_SIZE + 3,
            ..query
        })
        .await
        .unwrap()
        .commits
        .is_empty());
}

#[tokio::test]
async fn content_search_case_only_edits_require_changed_line_mode() {
    let dir = fixture();
    fs::write(dir.path().join("file.txt"), "token\n").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["commit", "-m", "introduce"]);
    fs::write(dir.path().join("file.txt"), "TOKEN\n").unwrap();
    run(dir.path(), &["commit", "-am", "case only"]);
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    let query = LogQuery {
        content: "token".into(),
        ..Default::default()
    };
    let literal = git.log(query.clone()).await.unwrap();
    assert_eq!(literal.commits.len(), 1);
    assert_eq!(literal.commits[0].subject, "introduce");
    let regex = git
        .log(LogQuery {
            content_regex: true,
            ..query
        })
        .await
        .unwrap();
    assert_eq!(regex.commits.len(), 2);
    assert_eq!(regex.commits[0].subject, "case only");
}

#[tokio::test]
async fn content_search_compares_merges_to_the_first_parent() {
    let dir = fixture();
    fs::write(dir.path().join("file.txt"), "base\n").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["commit", "-m", "base"]);
    run(dir.path(), &["switch", "-c", "feature"]);
    fs::write(dir.path().join("file.txt"), "needle\n").unwrap();
    run(dir.path(), &["commit", "-am", "feature"]);
    run(dir.path(), &["switch", "main"]);
    run(dir.path(), &["merge", "--no-ff", "feature", "-m", "merge"]);
    let head = run(dir.path(), &["rev-parse", "HEAD"]).trim().to_owned();
    let git = Git::open(dir.path().to_str().unwrap(), None).await.unwrap();
    for regex in [false, true] {
        let query = LogQuery {
            content: "needle".into(),
            content_regex: regex,
            merge: "merges".into(),
            ..Default::default()
        };
        let page = git.log(query.clone()).await.unwrap();
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].hash, head);
        assert_eq!(
            git.log(LogQuery {
                first_parent: true,
                ..query
            })
            .await
            .unwrap()
            .commits[0]
                .hash,
            head
        );
    }
}

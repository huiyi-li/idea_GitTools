use super::api::{repository_path, string, Api};
use super::models::{Comment, Provider};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Thread {
    id: String,
    path: String,
    line: Option<u64>,
    side: String,
    resolved: bool,
    resolvable: bool,
    outdated: bool,
    truncated: bool,
    notes: Vec<Comment>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hosting::tests::mock_many;

    fn review(provider: Provider) -> Value {
        if provider == Provider::Github {
            json!({"number":7,"title":"Review","state":"open","head":{"sha":"a".repeat(40)},"base":{"sha":"b".repeat(40)}})
        } else {
            json!({"iid":7,"title":"Review","state":"opened","sha":"a".repeat(40),"diff_refs":{"base_sha":"b".repeat(40),"head_sha":"a".repeat(40),"start_sha":"c".repeat(40)}})
        }
    }

    #[tokio::test]
    async fn github_approval_is_pinned_and_a_stale_review_never_sends_a_write() {
        let (api, task) = mock_many(
            Provider::Github,
            vec![
                (200, review(Provider::Github).to_string()),
                (200, "{}".into()),
            ],
        );
        api.mutate_review(
            "owner/repo",
            ReviewMutation {
                action: "approve".into(),
                number: 7,
                head_sha: "a".repeat(40),
                body: "approved".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let requests = task.join().unwrap();
        assert!(requests.contains("POST /api/v3/repos/owner/repo/pulls/7/reviews"));
        assert!(requests.contains("\"event\":\"APPROVE\""));
        assert!(requests.contains(&format!("\"commit_id\":\"{}\"", "a".repeat(40))));
        let (api, task) = mock_many(
            Provider::Github,
            vec![(200, review(Provider::Github).to_string())],
        );
        assert!(api
            .mutate_review(
                "owner/repo",
                ReviewMutation {
                    action: "merge".into(),
                    number: 7,
                    head_sha: "d".repeat(40),
                    method: "squash".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap_err()
            .contains("HEAD"));
        assert!(!task.join().unwrap().contains("PUT "));
    }

    #[tokio::test]
    async fn merge_uses_a_sha_guard_and_checks_the_actual_provider_result() {
        for provider in [Provider::Github, Provider::Gitlab] {
            let merged = if provider == Provider::Github {
                json!({"merged":true})
            } else {
                json!({"state":"merged"})
            };
            let (api, task) = mock_many(
                provider,
                vec![
                    (200, review(provider).to_string()),
                    (200, merged.to_string()),
                ],
            );
            api.mutate_review(
                "owner/repo",
                ReviewMutation {
                    action: "merge".into(),
                    number: 7,
                    head_sha: "a".repeat(40),
                    method: "squash".into(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let requests = task.join().unwrap();
            assert!(requests.contains(&format!("\"sha\":\"{}\"", "a".repeat(40))));
            assert!(requests.contains("/7/merge"));
        }
        let (api, task) = mock_many(
            Provider::Github,
            vec![
                (200, review(Provider::Github).to_string()),
                (200, json!({"merged":false}).to_string()),
            ],
        );
        assert!(api
            .mutate_review(
                "owner/repo",
                ReviewMutation {
                    action: "merge".into(),
                    number: 7,
                    head_sha: "a".repeat(40),
                    method: "merge".into(),
                    ..Default::default()
                }
            )
            .await
            .is_err());
        task.join().unwrap();
    }

    #[tokio::test]
    async fn gitlab_inline_comments_use_the_full_diff_position_and_renamed_paths() {
        let (api, task) = mock_many(
            Provider::Gitlab,
            vec![
                (200, review(Provider::Gitlab).to_string()),
                (200, "{}".into()),
            ],
        );
        api.mutate_review(
            "group/sub/repo",
            ReviewMutation {
                action: "inline".into(),
                number: 7,
                head_sha: "a".repeat(40),
                base_sha: "b".repeat(40),
                body: "check this".into(),
                path: "new.txt".into(),
                old_path: "old.txt".into(),
                line: 9,
                side: "LEFT".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let requests = task.join().unwrap();
        assert!(requests.contains("/merge_requests/7/discussions"));
        for expected in [
            "\"old_line\":9",
            "\"old_path\":\"old.txt\"",
            "\"new_path\":\"new.txt\"",
        ] {
            assert!(requests.contains(expected), "{requests}");
        }
        assert!(requests.contains(&format!("\"start_sha\":\"{}\"", "c".repeat(40))));
    }

    #[tokio::test]
    async fn github_threads_are_paginated_and_a_foreign_thread_cannot_be_replied_to() {
        let response = json!({"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":true,"endCursor":"next"},"nodes":[{"id":"thread","path":"file.txt","line":2,"diffSide":"RIGHT","isResolved":false,"viewerCanResolve":true,"comments":{"nodes":[{"id":"note","body":"<script>text</script>","author":{"login":"reviewer"}}]}}]}}}}});
        let (api, task) = mock_many(Provider::Github, vec![(200, response.to_string())]);
        let threads = api.threads("owner/repo", 7, "").await.unwrap();
        assert_eq!(threads.next_cursor.as_deref(), Some("next"));
        assert_eq!(threads.items[0].notes[0].body, "<script>text</script>");
        assert!(task.join().unwrap().contains("POST /api/graphql"));
        let (api,task)=mock_many(Provider::Github,vec![(200,review(Provider::Github).to_string()),(200,json!({"data":{"node":{"pullRequest":{"number":8,"repository":{"nameWithOwner":"owner/repo"}}}}}).to_string())]);
        assert!(api
            .mutate_review(
                "owner/repo",
                ReviewMutation {
                    action: "reply".into(),
                    number: 7,
                    head_sha: "a".repeat(40),
                    thread_id: "foreign".into(),
                    body: "reply".into(),
                    ..Default::default()
                }
            )
            .await
            .unwrap_err()
            .contains("不匹配"));
        assert!(!task
            .join()
            .unwrap()
            .contains("addPullRequestReviewThreadReply"));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Threads {
    items: Vec<Thread>,
    next_cursor: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ReviewMutation {
    pub action: String,
    pub number: u64,
    pub head_sha: String,
    pub base_sha: String,
    pub body: String,
    pub method: String,
    pub path: String,
    pub old_path: String,
    pub line: u64,
    pub side: String,
    pub thread_id: String,
    pub resolved: bool,
}

impl Api {
    async fn graphql(&self, query: &str, variables: Value) -> Result<Value, String> {
        let url = if self.server == "https://github.com" {
            "https://api.github.com/graphql".into()
        } else {
            format!("{}/api/graphql", self.server)
        };
        let response = self
            .request(
                Method::POST,
                Url::parse(&url).map_err(|_| "GraphQL 地址无效")?,
                Some(json!({"query":query,"variables":variables})),
            )
            .await?;
        if response["errors"]
            .as_array()
            .is_some_and(|errors| !errors.is_empty())
        {
            return Err("平台 GraphQL 操作失败，请检查账户权限并刷新远程状态".into());
        }
        Ok(response["data"].clone())
    }

    pub(crate) async fn threads(
        &self,
        path: &str,
        number: u64,
        cursor: &str,
    ) -> Result<Threads, String> {
        repository_path(self.provider, path)?;
        if cursor.len() > 512 || number == 0 {
            return Err("讨论分页参数无效".into());
        }
        if self.provider == Provider::Github {
            let (owner, name) = path.split_once('/').ok_or("仓库路径无效")?;
            let data = self.graphql("query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:30,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id path line originalLine diffSide isResolved isOutdated viewerCanResolve viewerCanUnresolve comments(first:100){pageInfo{hasNextPage}nodes{id body createdAt author{login}}}}}}}}", json!({"owner":owner,"name":name,"number":number,"cursor":if cursor.is_empty(){None}else{Some(cursor)}})).await?;
            let connection = &data["repository"]["pullRequest"]["reviewThreads"];
            let nodes = connection["nodes"]
                .as_array()
                .ok_or("无法读取审查讨论，请检查账户权限")?;
            let items = nodes
                .iter()
                .map(|node| Thread {
                    id: string(node, "id"),
                    path: string(node, "path"),
                    line: node["line"].as_u64().or(node["originalLine"].as_u64()),
                    side: string(node, "diffSide"),
                    resolved: node["isResolved"] == true,
                    outdated: node["isOutdated"] == true,
                    resolvable: node["viewerCanResolve"] == true
                        || node["viewerCanUnresolve"] == true,
                    truncated: node["comments"]["pageInfo"]["hasNextPage"] == true,
                    notes: node["comments"]["nodes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|note| Comment {
                            id: string(note, "id"),
                            author: string(&note["author"], "login"),
                            body: string(note, "body"),
                            created_at: string(note, "createdAt"),
                        })
                        .collect(),
                })
                .collect();
            let next_cursor = if connection["pageInfo"]["hasNextPage"] == true {
                connection["pageInfo"]["endCursor"]
                    .as_str()
                    .map(str::to_owned)
            } else {
                None
            };
            Ok(Threads { items, next_cursor })
        } else {
            let page = if cursor.is_empty() {
                1
            } else {
                cursor.parse::<u32>().map_err(|_| "讨论分页参数无效")?
            };
            if page == 0 {
                return Err("讨论分页参数无效".into());
            }
            let mut url = self.review_url(path, number, &["discussions"])?;
            url.query_pairs_mut()
                .append_pair("per_page", "30")
                .append_pair("page", &page.to_string());
            let value = self.request(Method::GET, url, None).await?;
            let nodes = value.as_array().ok_or("讨论列表格式无效")?;
            let items = nodes
                .iter()
                .map(|node| {
                    let notes: Vec<_> = node["notes"].as_array().into_iter().flatten().collect();
                    let first = notes.first().copied().unwrap_or(&Value::Null);
                    Thread {
                        id: string(node, "id"),
                        path: string(&first["position"], "new_path"),
                        line: first["position"]["new_line"]
                            .as_u64()
                            .or(first["position"]["old_line"].as_u64()),
                        side: if first["position"]["new_line"].is_null() {
                            "LEFT"
                        } else {
                            "RIGHT"
                        }
                        .into(),
                        resolved: first["resolved"] == true,
                        resolvable: first["resolvable"] == true,
                        outdated: false,
                        truncated: false,
                        notes: notes
                            .iter()
                            .map(|note| Comment {
                                id: note["id"].to_string(),
                                author: string(&note["author"], "username"),
                                body: string(note, "body"),
                                created_at: string(note, "created_at"),
                            })
                            .collect(),
                    }
                })
                .collect();
            Ok(Threads {
                items,
                next_cursor: if nodes.len() == 30 {
                    Some(page.checked_add(1).ok_or("讨论分页溢出")?.to_string())
                } else {
                    None
                },
            })
        }
    }

    pub(crate) async fn mutate_review(
        &self,
        path: &str,
        request: ReviewMutation,
    ) -> Result<(), String> {
        if request.body.len() > 65536 || request.thread_id.len() > 512 {
            return Err("审查内容过长".into());
        }
        let raw = self
            .request(
                Method::GET,
                self.review_url(path, request.number, &[])?,
                None,
            )
            .await?;
        let current = self.parse_review(&raw)?;
        if current.head_sha != request.head_sha || request.head_sha.is_empty() {
            return Err("请求的 HEAD 已更新，请刷新后重新审查".into());
        }
        let github = self.provider == Provider::Github;
        let result = match request.action.as_str() {
            "approve" | "request-changes" if github => {
                if request.action == "request-changes" && request.body.trim().is_empty() {
                    return Err("请求修改需要填写审查意见".into());
                }
                self.request(Method::POST,self.review_url(path,request.number,&["reviews"])?,Some(json!({"event":if request.action=="approve"{"APPROVE"}else{"REQUEST_CHANGES"},"commit_id":request.head_sha,"body":request.body}))).await?
            }
            "approve" | "unapprove" if !github => {
                self.request(
                    Method::POST,
                    self.review_url(path, request.number, &[&request.action])?,
                    Some(json!({"sha":request.head_sha})),
                )
                .await?
            }
            "merge" => {
                if current.state != "open" || current.draft {
                    return Err("请先将请求设为可合并的非草稿状态".into());
                }
                let body = if github {
                    if !matches!(request.method.as_str(), "merge" | "squash" | "rebase") {
                        return Err("请选择合并方式".into());
                    }
                    json!({"sha":request.head_sha,"merge_method":request.method})
                } else {
                    if !matches!(request.method.as_str(), "merge" | "squash") {
                        return Err("GitLab 合并方式由项目设置决定，可选择 Squash".into());
                    }
                    json!({"sha":request.head_sha,"squash":request.method=="squash","auto_merge":false})
                };
                let result = self
                    .request(
                        Method::PUT,
                        self.review_url(path, request.number, &["merge"])?,
                        Some(body),
                    )
                    .await?;
                if (github && result["merged"] != true) || (!github && result["state"] != "merged")
                {
                    return Err("平台尚未完成合并，请刷新核对远程状态".into());
                }
                result
            }
            "inline" => {
                if request.body.trim().is_empty()
                    || request.line == 0
                    || !matches!(request.side.as_str(), "LEFT" | "RIGHT")
                    || current.base_sha != request.base_sha
                {
                    return Err("行内评论参数或差异基准已改变，请刷新".into());
                }
                if github {
                    self.request(Method::POST,self.review_url(path,request.number,&["comments"])?,Some(json!({"body":request.body,"commit_id":request.head_sha,"path":request.path,"line":request.line,"side":request.side}))).await?
                } else {
                    let mut position = json!({"position_type":"text","base_sha":current.base_sha,"head_sha":current.head_sha,"start_sha":raw["diff_refs"]["start_sha"],"new_path":request.path,"old_path":if request.old_path.is_empty(){&request.path}else{&request.old_path}});
                    position[if request.side == "LEFT" {
                        "old_line"
                    } else {
                        "new_line"
                    }] = json!(request.line);
                    self.request(
                        Method::POST,
                        self.review_url(path, request.number, &["discussions"])?,
                        Some(json!({"body":request.body,"position":position})),
                    )
                    .await?
                }
            }
            "reply" | "resolve" => {
                if request.thread_id.is_empty()
                    || (request.action == "reply" && request.body.trim().is_empty())
                {
                    return Err("请填写讨论内容".into());
                }
                if github {
                    let data = self.graphql("query($id:ID!){node(id:$id){... on PullRequestReviewThread{pullRequest{number repository{nameWithOwner}}}}}",json!({"id":request.thread_id})).await?;
                    let pull = &data["node"]["pullRequest"];
                    if pull["number"].as_u64() != Some(request.number)
                        || !string(&pull["repository"], "nameWithOwner").eq_ignore_ascii_case(path)
                    {
                        return Err("讨论与当前请求不匹配".into());
                    }
                    if request.action == "reply" {
                        self.graphql("mutation($input:AddPullRequestReviewThreadReplyInput!){addPullRequestReviewThreadReply(input:$input){comment{id}}}",json!({"input":{"pullRequestReviewThreadId":request.thread_id,"body":request.body}})).await?
                    } else {
                        let mutation = if request.resolved {
                            "mutation($input:ResolveReviewThreadInput!){resolveReviewThread(input:$input){thread{id}}}"
                        } else {
                            "mutation($input:UnresolveReviewThreadInput!){unresolveReviewThread(input:$input){thread{id}}}"
                        };
                        self.graphql(mutation, json!({"input":{"threadId":request.thread_id}}))
                            .await?
                    }
                } else {
                    let suffix = if request.action == "reply" {
                        vec!["discussions", request.thread_id.as_str(), "notes"]
                    } else {
                        vec!["discussions", request.thread_id.as_str()]
                    };
                    self.request(
                        if request.action == "reply" {
                            Method::POST
                        } else {
                            Method::PUT
                        },
                        self.review_url(path, request.number, &suffix)?,
                        Some(if request.action == "reply" {
                            json!({"body":request.body})
                        } else {
                            json!({"resolved":request.resolved})
                        }),
                    )
                    .await?
                }
            }
            _ => return Err("此平台不支持所选审查操作".into()),
        };
        let _ = result;
        Ok(())
    }
}

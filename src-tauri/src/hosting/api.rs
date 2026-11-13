use super::models::*;
use reqwest::{Client, Method, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

const PAGE_SIZE: usize = 30;
const MAX_RESPONSE: usize = 8 * 1024 * 1024;

pub struct Api {
    pub client: Client,
    pub provider: Provider,
    pub server: String,
    pub token: String,
}

pub fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("IdeaGitTool/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .https_only(!cfg!(test))
        .build()
        .map_err(|_| "无法初始化平台连接".into())
}

pub fn normalize_server(server: &str) -> Result<String, String> {
    let mut url = Url::parse(server.trim()).map_err(|_| "请输入完整的 HTTPS 平台地址")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("平台地址须为 HTTPS，且不能包含凭据、查询或片段".into());
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub fn account_id(provider: Provider, server: &str, user_id: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{provider:?}\n{server}\n{user_id}").as_bytes())
    )
}

fn api_root(provider: Provider, server: &str) -> String {
    match (provider, server) {
        (Provider::Github, "https://github.com") => "https://api.github.com".into(),
        (Provider::Github, _) => format!("{server}/api/v3"),
        (Provider::Gitlab, _) => format!("{server}/api/v4"),
    }
}

pub fn repository_path(provider: Provider, path: &str) -> Result<(), String> {
    if provider == Provider::Gitlab && !path.is_empty() && path.chars().all(|c| c.is_ascii_digit())
    {
        return Ok(());
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() < 2
        || (provider == Provider::Github && parts.len() != 2)
        || parts.iter().any(|part| {
            part.is_empty()
                || matches!(*part, "." | "..")
                || part
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '\\' | '?' | '#'))
        })
    {
        return Err("仓库路径无效，请使用 owner/repo 或 group/subgroup/project".into());
    }
    Ok(())
}

pub fn string(value: &Value, name: &str) -> String {
    value[name].as_str().unwrap_or_default().to_owned()
}

fn required_string(value: &Value, name: &str) -> Result<String, String> {
    value[name]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("平台响应缺少字段 {name}"))
}

fn id(value: &Value, name: &str) -> Result<String, String> {
    value[name]
        .as_u64()
        .map(|n| n.to_string())
        .ok_or_else(|| format!("平台响应缺少字段 {name}"))
}

fn page<T>(items: Vec<T>) -> Page<T> {
    let has_more = items.len() == PAGE_SIZE;
    Page { items, has_more }
}

impl Api {
    fn url(&self, segments: &[&str]) -> Result<Url, String> {
        let mut url =
            Url::parse(&api_root(self.provider, &self.server)).map_err(|_| "平台地址无效")?;
        url.path_segments_mut()
            .map_err(|_| "平台地址无效")?
            .extend(segments);
        Ok(url)
    }

    pub fn repo_url(&self, path: &str, suffix: &[&str]) -> Result<Url, String> {
        repository_path(self.provider, path)?;
        let mut parts = match self.provider {
            Provider::Github => {
                let mut segments = vec!["repos"];
                segments.extend(path.split('/'));
                segments
            }
            Provider::Gitlab => vec!["projects", path],
        };
        parts.extend(suffix);
        self.url(&parts)
    }

    async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
        accept: &str,
    ) -> Result<reqwest::Response, String> {
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&self.token)
            .header("Accept", accept);
        if self.provider == Provider::Github {
            request = request.header("X-GitHub-Api-Version", "2022-11-28");
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                "平台请求超时，请重试"
            } else {
                "平台连接失败，请检查网络、代理和证书"
            }
            .to_owned()
        })?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 => "令牌已失效，请重新登录".into(),
                403 if response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|v| v == "0") =>
                {
                    "平台 API 请求已限流，请稍后刷新".into()
                }
                403 => "平台拒绝访问，请检查账户权限、令牌权限或组织授权".into(),
                404 => "仓库或请求不存在，或当前账户无访问权限".into(),
                409 => "远程状态已改变，请刷新后重试".into(),
                422 => "平台校验失败，请检查分支、重复请求或输入内容".into(),
                429 => "平台 API 请求已限流，请稍后刷新".into(),
                code => format!("平台请求失败，HTTP {code}"),
            });
        }
        Ok(response)
    }

    pub async fn request(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let response = self.send(method, url, body, "application/json").await?;
        let bytes = read_response(response, MAX_RESPONSE).await?;
        if bytes.len() > MAX_RESPONSE {
            return Err("平台响应超过 8 MiB，请缩小查询范围".into());
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| "平台返回了无效的 JSON 数据".into())
    }

    pub async fn identity(&self) -> Result<Account, String> {
        let value = self
            .request(Method::GET, self.url(&["user"])?, None)
            .await?;
        let user_id = id(&value, "id")?;
        let login = required_string(
            &value,
            if self.provider == Provider::Github {
                "login"
            } else {
                "username"
            },
        )?;
        Ok(Account {
            id: account_id(self.provider, &self.server, &user_id),
            provider: self.provider,
            server: self.server.clone(),
            user_id,
            login,
        })
    }

    pub async fn repositories(&self, page_number: u32) -> Result<Page<Repository>, String> {
        let mut url = self.url(if self.provider == Provider::Github {
            &["user", "repos"]
        } else {
            &["projects"]
        })?;
        url.query_pairs_mut()
            .append_pair("page", &page_number.to_string())
            .append_pair("per_page", "30");
        match self.provider {
            Provider::Github => {
                url.query_pairs_mut()
                    .append_pair("sort", "pushed")
                    .append_pair("affiliation", "owner,collaborator,organization_member");
            }
            Provider::Gitlab => {
                url.query_pairs_mut()
                    .append_pair("membership", "true")
                    .append_pair("order_by", "last_activity_at");
            }
        }
        let value = self.request(Method::GET, url, None).await?;
        let items = value
            .as_array()
            .ok_or("平台仓库列表格式无效")?
            .iter()
            .map(|item| self.parse_repository(item))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(page(items))
    }

    pub fn parse_repository(&self, value: &Value) -> Result<Repository, String> {
        let github = self.provider == Provider::Github;
        Ok(Repository {
            id: id(value, "id")?,
            path: required_string(
                value,
                if github {
                    "full_name"
                } else {
                    "path_with_namespace"
                },
            )?,
            name: string(value, "name"),
            description: string(value, "description"),
            default_branch: string(value, "default_branch"),
            private: if github {
                value["private"].as_bool().unwrap_or(true)
            } else {
                value["visibility"] != "public"
            },
            web_url: string(value, if github { "html_url" } else { "web_url" }),
            ssh_url: string(value, if github { "ssh_url" } else { "ssh_url_to_repo" }),
            https_url: string(
                value,
                if github {
                    "clone_url"
                } else {
                    "http_url_to_repo"
                },
            ),
        })
    }

    pub async fn repository(&self, path: &str) -> Result<Repository, String> {
        let value = self
            .request(Method::GET, self.repo_url(path, &[])?, None)
            .await?;
        self.parse_repository(&value)
    }

    pub fn parse_review(&self, value: &Value) -> Result<ReviewRequest, String> {
        let github = self.provider == Provider::Github;
        let number = value[if github { "number" } else { "iid" }]
            .as_u64()
            .ok_or("平台请求编号无效")?;
        let state = if (github && (!value["merged_at"].is_null() || value["merged"] == true))
            || value["state"] == "merged"
        {
            "merged".to_owned()
        } else {
            string(value, "state").replace("opened", "open")
        };
        Ok(ReviewRequest {
            number,
            title: required_string(value, "title")?,
            body: string(value, if github { "body" } else { "description" }),
            author: string(
                &value[if github { "user" } else { "author" }],
                if github { "login" } else { "username" },
            ),
            state,
            draft: value["draft"].as_bool().unwrap_or(false),
            source_branch: if github {
                string(&value["head"], "label")
            } else {
                string(value, "source_branch")
            },
            source_repository: if github {
                string(&value["head"]["repo"], "full_name")
            } else {
                value["source_project_id"]
                    .as_u64()
                    .map(|id| id.to_string())
                    .unwrap_or_default()
            },
            target_branch: if github {
                string(&value["base"], "ref")
            } else {
                string(value, "target_branch")
            },
            head_sha: if github {
                string(&value["head"], "sha")
            } else {
                string(value, "sha")
            },
            base_sha: if github {
                string(&value["base"], "sha")
            } else {
                string(&value["diff_refs"], "base_sha")
            },
            web_url: string(value, if github { "html_url" } else { "web_url" }),
            updated_at: string(value, "updated_at"),
            merge_status: string(
                value,
                if github {
                    "mergeable_state"
                } else {
                    "detailed_merge_status"
                },
            ),
        })
    }

    pub(super) fn review_url(
        &self,
        path: &str,
        number: u64,
        suffix: &[&str],
    ) -> Result<Url, String> {
        if number == 0 {
            return Err("请求编号无效".into());
        }
        let number = number.to_string();
        let mut segments = vec![
            if self.provider == Provider::Github {
                "pulls"
            } else {
                "merge_requests"
            },
            &number,
        ];
        segments.extend(suffix);
        self.repo_url(path, &segments)
    }

    pub async fn reviews(
        &self,
        path: &str,
        state: &str,
        page_number: u32,
    ) -> Result<Page<ReviewRequest>, String> {
        if !matches!(state, "open" | "closed" | "all") {
            return Err("请求筛选状态无效".into());
        }
        let mut url = self.repo_url(
            path,
            &[if self.provider == Provider::Github {
                "pulls"
            } else {
                "merge_requests"
            }],
        )?;
        let remote_state = if self.provider == Provider::Gitlab && state == "open" {
            "opened"
        } else {
            state
        };
        url.query_pairs_mut()
            .append_pair("state", remote_state)
            .append_pair("page", &page_number.to_string())
            .append_pair("per_page", "30");
        if self.provider == Provider::Gitlab {
            url.query_pairs_mut().append_pair("scope", "all");
        }
        let value = self.request(Method::GET, url, None).await?;
        let items = value
            .as_array()
            .ok_or("平台请求列表格式无效")?
            .iter()
            .map(|item| self.parse_review(item))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(page(items))
    }

    pub async fn review(&self, path: &str, number: u64) -> Result<ReviewRequest, String> {
        let value = self
            .request(Method::GET, self.review_url(path, number, &[])?, None)
            .await?;
        self.parse_review(&value)
    }

    pub async fn create_review(
        &self,
        path: &str,
        request: CreateReview,
    ) -> Result<ReviewRequest, String> {
        if request.title.trim().is_empty()
            || request.source_branch.trim().is_empty()
            || request.target_branch.trim().is_empty()
            || request.title.len() > 512
            || request.body.len() > 65536
        {
            return Err("请填写标题、源分支和目标分支，标题最多 512 字节，说明最多 64 KiB".into());
        }
        let (endpoint, body) = match self.provider {
            Provider::Github => (
                "pulls",
                json!({"title": request.title.trim(), "body": request.body,
                "head": request.source_branch.trim(), "base": request.target_branch.trim(), "draft": request.draft}),
            ),
            Provider::Gitlab => (
                "merge_requests",
                json!({"title": if request.draft { format!("Draft: {}", request.title.trim()) } else { request.title.trim().to_owned() },
                "description": request.body, "source_branch": request.source_branch.trim(), "target_branch": request.target_branch.trim()}),
            ),
        };
        let value = self
            .request(Method::POST, self.repo_url(path, &[endpoint])?, Some(body))
            .await?;
        self.parse_review(&value)
    }

    pub async fn change_state(
        &self,
        path: &str,
        number: u64,
        action: &str,
    ) -> Result<ReviewRequest, String> {
        if !matches!(action, "close" | "reopen") {
            return Err("请求操作无效".into());
        }
        let (method, body) = match self.provider {
            Provider::Github => (
                Method::PATCH,
                json!({"state": if action == "close" { "closed" } else { "open" }}),
            ),
            Provider::Gitlab => (Method::PUT, json!({"state_event": action})),
        };
        let value = self
            .request(method, self.review_url(path, number, &[])?, Some(body))
            .await?;
        self.parse_review(&value)
    }

    pub async fn comments(
        &self,
        path: &str,
        number: u64,
        page_number: u32,
    ) -> Result<Page<Comment>, String> {
        let mut url = self.comment_url(path, number)?;
        url.query_pairs_mut()
            .append_pair("page", &page_number.to_string())
            .append_pair("per_page", "30");
        if self.provider == Provider::Gitlab {
            url.query_pairs_mut().append_pair("sort", "asc");
        }
        let value = self.request(Method::GET, url, None).await?;
        let items = value
            .as_array()
            .ok_or("评论列表格式无效")?
            .iter()
            .map(|item| self.parse_comment(item))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(page(items))
    }

    fn comment_url(&self, path: &str, number: u64) -> Result<Url, String> {
        if number == 0 {
            return Err("请求编号无效".into());
        }
        if self.provider == Provider::Github {
            self.repo_url(path, &["issues", &number.to_string(), "comments"])
        } else {
            self.review_url(path, number, &["notes"])
        }
    }

    fn parse_comment(&self, value: &Value) -> Result<Comment, String> {
        let github = self.provider == Provider::Github;
        Ok(Comment {
            id: id(value, "id")?,
            body: string(value, "body"),
            created_at: string(value, "created_at"),
            author: string(
                &value[if github { "user" } else { "author" }],
                if github { "login" } else { "username" },
            ),
        })
    }

    pub async fn comment(&self, path: &str, number: u64, body: String) -> Result<Comment, String> {
        if body.trim().is_empty() || body.len() > 65536 {
            return Err("评论须为 1 至 65536 字节".into());
        }
        let value = self
            .request(
                Method::POST,
                self.comment_url(path, number)?,
                Some(json!({"body": body})),
            )
            .await?;
        self.parse_comment(&value)
    }

    pub async fn files(
        &self,
        path: &str,
        number: u64,
        page_number: u32,
    ) -> Result<Page<ReviewFile>, String> {
        let mut url = self.review_url(
            path,
            number,
            &[if self.provider == Provider::Github {
                "files"
            } else {
                "diffs"
            }],
        )?;
        url.query_pairs_mut()
            .append_pair("page", &page_number.to_string())
            .append_pair("per_page", "30");
        let value = self.request(Method::GET, url, None).await?;
        let items = value
            .as_array()
            .ok_or("变更文件列表格式无效")?
            .iter()
            .map(|item| {
                let github = self.provider == Provider::Github;
                Ok(ReviewFile {
                    path: required_string(item, if github { "filename" } else { "new_path" })?,
                    old_path: string(
                        item,
                        if github {
                            "previous_filename"
                        } else {
                            "old_path"
                        },
                    ),
                    status: if github {
                        string(item, "status")
                    } else if item["new_file"] == true {
                        "added".into()
                    } else if item["deleted_file"] == true {
                        "removed".into()
                    } else if item["renamed_file"] == true {
                        "renamed".into()
                    } else {
                        "modified".into()
                    },
                    additions: item["additions"].as_u64(),
                    deletions: item["deletions"].as_u64(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(page(items))
    }

    pub async fn commits(
        &self,
        path: &str,
        number: u64,
        page_number: u32,
    ) -> Result<Page<ReviewCommit>, String> {
        let mut url = self.review_url(path, number, &["commits"])?;
        url.query_pairs_mut()
            .append_pair("page", &page_number.to_string())
            .append_pair("per_page", "30");
        let value = self.request(Method::GET, url, None).await?;
        let items = value
            .as_array()
            .ok_or("提交列表格式无效")?
            .iter()
            .map(|item| {
                let github = self.provider == Provider::Github;
                let title = if github {
                    string(&item["commit"], "message")
                } else {
                    string(item, "title")
                };
                Ok(ReviewCommit {
                    sha: required_string(item, if github { "sha" } else { "id" })?,
                    title: title.lines().next().unwrap_or_default().to_owned(),
                    author: if github {
                        string(&item["commit"]["author"], "name")
                    } else {
                        string(item, "author_name")
                    },
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(page(items))
    }

    pub async fn checks(&self, path: &str, number: u64) -> Result<Vec<Check>, String> {
        if self.provider == Provider::Gitlab {
            let value = self
                .request(Method::GET, self.review_url(path, number, &[])?, None)
                .await?;
            let pipeline = &value["head_pipeline"];
            return Ok(if pipeline.is_object() {
                vec![Check {
                    name: "Pipeline".into(),
                    state: string(pipeline, "status"),
                    web_url: string(pipeline, "web_url"),
                }]
            } else {
                vec![]
            });
        }
        let review = self.review(path, number).await?;
        if review.head_sha.is_empty() {
            return Err("请求源分支缺少提交 SHA".into());
        }
        let value = self
            .request(
                Method::GET,
                self.repo_url(path, &["commits", &review.head_sha, "status"])?,
                None,
            )
            .await?;
        let mut checks = Vec::new();
        if let Some(statuses) = value["statuses"].as_array() {
            checks.extend(statuses.iter().map(|item| Check {
                name: string(item, "context"),
                state: string(item, "state"),
                web_url: string(item, "target_url"),
            }));
        }
        // Checks have separate permissions. Surface errors instead of showing a false green status.
        let mut runs_url = self.repo_url(path, &["commits", &review.head_sha, "check-runs"])?;
        runs_url.query_pairs_mut().append_pair("per_page", "100");
        let response = self.request(Method::GET, runs_url, None).await?;
        if let Some(runs) = response["check_runs"].as_array() {
            checks.extend(runs.iter().map(|run| Check {
                name: string(run, "name"),
                state: if run["conclusion"].is_null() {
                    string(run, "status")
                } else {
                    string(run, "conclusion")
                },
                web_url: string(run, "html_url"),
            }));
            if response["total_count"].as_u64().unwrap_or(0) > runs.len() as u64 {
                checks.push(Check {
                    name: "更多检查".into(),
                    state: "已显示前 100 项，请在平台查看完整结果".into(),
                    web_url: review.web_url,
                });
            }
        }
        Ok(checks)
    }

    pub async fn file_diff(
        &self,
        repository: &str,
        request: RemoteFileRequest,
    ) -> Result<crate::models::FileDiff, String> {
        let current = self.review(repository, request.number).await?;
        if current.head_sha != request.head_sha || current.base_sha != request.base_sha {
            return Err("远程提交已更新，请刷新请求详情后重试".into());
        }
        let mut before_sha = request.base_sha;
        let after_sha = request.head_sha;
        if before_sha.is_empty() || after_sha.is_empty() {
            return Err("远程请求尚未生成差异，请稍后刷新".into());
        }
        if self.provider == Provider::Github {
            let range = format!("{before_sha}...{after_sha}");
            let comparison = self
                .request(
                    Method::GET,
                    self.repo_url(repository, &["compare", &range])?,
                    None,
                )
                .await?;
            before_sha = required_string(&comparison["merge_base_commit"], "sha")?;
        }
        let before_path = if request.old_path.is_empty() {
            &request.path
        } else {
            &request.old_path
        };
        let before = if request.status == "added" {
            vec![]
        } else {
            self.file_content(repository, before_path, &before_sha)
                .await?
        };
        let after = if request.status == "removed" {
            vec![]
        } else {
            let source = if current.source_repository.is_empty() {
                repository
            } else {
                &current.source_repository
            };
            self.file_content(source, &request.path, &after_sha).await?
        };
        let too_large = before.len() > 1024 * 1024
            || after.len() > 1024 * 1024
            || before.iter().filter(|b| **b == b'\n').count() > 20000
            || after.iter().filter(|b| **b == b'\n').count() > 20000;
        let binary = before.contains(&0)
            || after.contains(&0)
            || std::str::from_utf8(&before).is_err()
            || std::str::from_utf8(&after).is_err();
        Ok(crate::models::FileDiff {
            before: if binary || too_large {
                String::new()
            } else {
                String::from_utf8(before).map_err(|_| "文件编码无效")?
            },
            after: if binary || too_large {
                String::new()
            } else {
                String::from_utf8(after).map_err(|_| "文件编码无效")?
            },
            binary,
            too_large,
            can_load: false,
            large: too_large,
            reason: "远程文件超过 API 内容加载限制，可克隆仓库后在本地查看".into(),
        })
    }

    async fn file_content(
        &self,
        repository: &str,
        path: &str,
        revision: &str,
    ) -> Result<Vec<u8>, String> {
        if path.is_empty()
            || path
                .split('/')
                .any(|part| part.is_empty() || matches!(part, "." | ".."))
        {
            return Err("远程文件路径无效".into());
        }
        let mut url = if self.provider == Provider::Github {
            let mut segments = vec!["contents"];
            segments.extend(path.split('/'));
            self.repo_url(repository, &segments)?
        } else {
            self.repo_url(repository, &["repository", "files", path, "raw"])?
        };
        url.query_pairs_mut().append_pair("ref", revision);
        let accept = if self.provider == Provider::Github {
            "application/vnd.github.raw+json"
        } else {
            "application/octet-stream"
        };
        let response = self.send(Method::GET, url, None, accept).await?;
        read_response(response, 1024 * 1024).await
    }
}

async fn read_response(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取平台响应失败")? {
        let remaining = (limit + 1).saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if bytes.len() > limit {
            break;
        }
    }
    Ok(bytes)
}

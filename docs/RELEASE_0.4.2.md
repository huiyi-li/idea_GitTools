# IdeaGitTool Desktop 0.4.2

新增 GitHub 和 GitLab 系统浏览器登录，保留访问令牌登录。

- GitHub 使用 Device Flow。首次配置自己的 OAuth App Client ID 并启用 Device Flow；以后点击网页登录，在浏览器中输入验证码并授权。
- GitLab 使用 Authorization Code + PKCE。支持 gitlab.com 与自建实例；应用须取消 Confidential，配置 `api read_user`，回调地址为 `http://127.0.0.1:34171/oauth/callback`。
- Client ID 按平台和服务器保存。授权码、设备码、访问令牌和刷新令牌不会进入浏览器持久化存储。账户凭据保存在系统凭据库。
- 登录支持取消、超时、拒绝授权、浏览器打开失败后的重试；GitLab 回调校验随机 state 和本机地址。
- 过期凭据自动续期。并发读取协调刷新，刷新只更新凭据库，避免回退到已失效的旧令牌。
- 本次构建包含当前已完成的托管仓库浏览、PR / MR、三栏提交比较、大文件查看和文件修改撤销功能。

首次注册步骤见应用的“首次配置 OAuth 应用”与 [网页登录配置](BROWSER_LOGIN.md)。由于尚未注册本应用的 OAuth Client ID，本次使用本地模拟授权服务器验证协议；真实账户的网页登录由用户注册后验证。

版本从 0.4.1 更新为 0.4.2。`release/` 同步 EXE、NSIS 安装包、便携 ZIP 和 SHA-256 清单。

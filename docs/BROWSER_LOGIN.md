# GitHub 与 GitLab 网页登录

从工具栏打开“托管平台 · GitHub / GitLab”，进入“管理账户”，选择平台和服务器。首次输入为 IdeaGitTool 注册的公开 Client ID；之后可直接点击网页登录。注册应用只需做一次。登录在系统浏览器完成，账户身份校验成功后由应用保存。

## GitHub

1. 点击“打开应用注册页面”，创建 OAuth App。应用名填写 `IdeaGitTool`；Homepage URL 可填写项目地址。
2. Authorization callback URL 可填写 `http://127.0.0.1:34171/oauth/callback`。GitHub 当前使用 Device Flow，不依赖此回调。
3. 创建后启用 **Enable Device Flow**。将公开 Client ID 填入应用，点击“使用 GitHub 网页登录”。
4. 在打开的浏览器页面输入应用显示的验证码，确认权限。应用等待授权完成后自动连接账户。

请求权限为 `repo read:user`。本流程不要求 Client Secret。GitHub Enterprise Server 使用相应服务器地址和在该服务器注册的应用；实例需要支持 Device Flow。

## GitLab

1. 选择 GitLab 和服务器地址，点击“打开应用注册页面”。gitlab.com 与自建实例分别注册。
2. 创建 Application，应用名填写 `IdeaGitTool`，取消 **Confidential**。
3. Redirect URI 精确填写 `http://127.0.0.1:34171/oauth/callback`，选中 `api` 和 `read_user`。
4. 将 Application ID 填入应用的 Client ID，点击“使用 GitLab 网页登录”。
5. 在浏览器中授权。浏览器回到本机页面后，返回应用查看账户连接结果。

本机仅监听 `127.0.0.1:34171`。若端口已被占用，界面会提示关闭占用程序再重试。登录使用随机 state、PKCE S256 和一次性授权码；不要求 Client Secret。

## 保存、取消与恢复

- 按平台和服务器记住公开 Client ID。访问令牌、刷新令牌、设备码和授权码不会写入浏览器存储；凭据进入系统凭据库。
- 可以取消等待中的网页登录。窗口关闭时会取消等待；完成保存阶段后以应用最终结果为准。
- 浏览器打开失败时可以点击重新打开。拒绝授权、网络错误和超时会显示错误，可重新开始。
- 过期 OAuth 凭据自动续期，并协调并发请求，避免重复使用已经轮换的刷新令牌。
- 移除账户删除本机凭据；如需撤销平台授权，在 GitHub / GitLab 的授权应用页面操作。
- 访问令牌登录继续可用。克隆操作仍使用系统 Git 的 SSH 或 HTTPS 凭据。

## Rebased 的参考点

GitHub 的 `GHOAuthService.kt` 打开 `account.jetbrains.com/github/oauth/intellij`，`GHOAuthCredentialsAcquier.kt` 再向 JetBrains 中转服务换取令牌。因此本应用采用自己注册的 OAuth App 与 Device Flow。

GitLab 的 `GitLabOAuthService.kt` 可以直接参考：服务器授权端点、随机 state、PKCE、loopback 回调、取消等待、令牌续期、清除授权码的结果页面。`GitLabOAuthSettings.kt` 按服务器保存 Client ID。IdeaGitTool 采用相同流程设计，并使用独立注册的应用身份。

参考源码位于 `rebased/plugins/github/github-core/src/org/jetbrains/plugins/github/authentication/` 和 `rebased/plugins/gitlab/gitlab-core/src/org/jetbrains/plugins/gitlab/authentication/`。

官方文档：

- [GitHub OAuth App / Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitLab OAuth / PKCE](https://docs.gitlab.com/api/oauth2/)

本次验证使用本地模拟授权服务器；当前未配置自己的 OAuth Client ID，真实账户授权仍需注册后验证。

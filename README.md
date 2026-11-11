# IdeaGitTool Desktop

基于 Tauri 2、Rust、Preact 和 CodeMirror 6 的独立 Git 客户端。Rust 调用系统 Git，提交图布局、IntelliJ 差异算法和主题样式均随本项目维护。

源码仓库为 [huiyi-li/idea_GitTools](https://github.com/huiyi-li/idea_GitTools)。本项目由 [PGshen/vs-idea-gittool](https://github.com/PGshen/vs-idea-gittool) 抽离为独立桌面应用。

发布版可从本仓库的 [Releases](https://github.com/huiyi-li/idea_GitTools/releases) 下载。安装版运行 `IdeaGitTool-setup.exe`，便携版解压后双击 `IdeaGitTool.exe`。自行构建后的文件位于项目根目录的 `release/`。

## 项目结构

```text
src/
  App.tsx               桌面界面和仓库操作
  DiffView.tsx          CodeMirror 双栏 diff
  LogTable.tsx          提交历史和提交图
  git/graph.ts          提交图布局
  shared/               差异算法和图形类型
  ui/                   主题及基础样式
src-tauri/
  src/                  Rust Git 后端和文件监听
  src/git/tests.rs      Git 集成测试
  tauri.conf.json       桌面窗口及安装包配置
LICENSE
NOTICE
```

## 当前功能

- 打开本地仓库、最近仓库、深浅色主题。
- GitHub、GitLab 多账户管理，支持自建 GitLab 和 GitHub Enterprise 地址，访问令牌保存在系统凭据库。
- 托管仓库分页浏览、当前页筛选、按路径打开、SSH / HTTPS 克隆与本地目录关联。SSH 克隆可指定 `github_ming` 等 Host 别名。
- PR / MR 分页列表、状态筛选、详情、提交、CI 状态、远程双栏 diff、创建草稿、普通评论、关闭和重新打开。
- 分支筛选、提交说明搜索、提交图、提交详情与变更文件。日志每页 200 条。
- 日志页默认只展示提交和变更文件，可开启并记忆内嵌 diff 预览。双击文件或按 Enter 打开“修改前｜修改后｜当前工作区”的只读三栏查看器，支持变化导航、同步滚动、Minimap、栏宽调整和当前文件关联。
- 工作区与历史提交的双栏只读 diff、行级高亮和同步滚动。差异计算通过后台 Worker 执行，历史文件支持有界缓存，内容未变化的刷新会复用编辑器。
- 双栏 diff 和三栏合并均支持代码缩略图（Minimap），显示变化分布、冲突处理状态和可见范围，支持点击、拖动与键盘定位。
- 逐文件或批量暂存、取消暂存、放弃本地文件更改、提交暂存区。保留 Git hooks、签名和凭据配置。
- 新建并签出分支、签出本地分支或跟踪远程分支。
- Fetch、仅快进 Pull、Push。
- Stash 保存（包含未跟踪文件）、应用并保留 Stash。
- 文件变更自动刷新、F5 刷新、Git Console、中文路径和 worktree 仓库。
- 三栏合并管理器、冲突文件列表、逐块接受一侧或保留双方、手动编辑、自动处理简单冲突、同步滚动、冲突导航与撤销重做。
- 合并进度保存与恢复、完成后暂存、继续或中止 merge / rebase / cherry-pick / revert。
- 分支比较、Merge（自动 / --no-ff / --ff-only）、Rebase，以及日志提交的 Cherry-pick / Revert。冲突自动打开三栏合并管理器，支持继续、中止和跳过当前提交。
- 工作区沿用原插件的紧凑工具栏、分组分支树和图标。日志页的分支、详情和底部 diff 可拖动调整，提交页采用左侧文件与提交说明、右侧 diff。面板尺寸自动保存，双击分隔条复位，Ctrl+L 聚焦日志搜索。

交互式 rebase 的编排界面、Shelf、Changelist、Local History、Blame、AI 提交说明和多仓库同步操作仍需迁移。

## 本地文件更改

进入“提交”页，文件行的“暂存”和“取消暂存”按钮可移动对应更改，分组标题提供批量操作。取消暂存会保留磁盘上的文件内容。

未暂存文件的“操作”菜单提供“放弃未暂存更改…”，文件恢复为暂存区版本。未暂存分组的“全部放弃…”可以批量执行。同一文件已有暂存内容时，这部分内容仍可提交。

文件菜单中的“放弃此文件全部更改…”会将该文件的暂存区和工作区恢复为 HEAD 版本。本地更改标题右侧的“操作”菜单提供“放弃全部本地更改…”。确认窗口逐项列出恢复和删除的路径，未跟踪文件或 HEAD 中不存在的新文件会被删除。冲突文件通过三栏合并管理器处理，子模块进入对应仓库处理。

执行前重新校验文件和暂存区，预览过期时可重新获取。执行失败会恢复操作前的文件，恢复失败时显示保留的备份目录。

选择“已暂存”文件查看 HEAD 与暂存区之间的差异，选择“未暂存”文件查看暂存区与工作区之间的差异。

## 三栏合并

工作区存在冲突时，点击冲突文件或“打开三栏合并管理器”。底部状态栏的“合并管理器”也可进入。

左侧显示本地版本，中间是可编辑的结果，右侧显示合入版本。rebase 时左侧显示正在重放的提交，右侧显示目标分支及已重放的结果，标题带有对应的提交信息。

通过行号旁的箭头接受修改，点击叉号忽略对应一侧，Ctrl+点击箭头直接用该侧解决整个冲突。也可以选择结果栏中的冲突块，用工具栏选择一侧或按指定顺序保留双方。F7 / Shift+F7 跳转冲突。手动修改后确认相应块，撤销会同时恢复文本和处理状态。

“保存进度”将结果写入工作区，并将处理状态保存到该 worktree 的 Git 元数据目录 `ideagittool-merge-drafts`。Git 中的冲突状态会保留，再次打开文件可恢复进度。“完成并暂存”检查所有块已确认且没有遗留的 Git 冲突标记，然后暂存该文件。完成所有文件后可继续当前 Git 操作。

保存时校验冲突索引、文件内容和 Git 操作是否改变。暂存使用 Git 的 `index.lock` 和临时索引，保留其他文件已暂存的内容。Git 过滤器或暂存失败时，已写入的结果仍保留在工作区，冲突索引保持可重试状态。

二进制、非 UTF-8 或超出三栏编辑限制的普通文件，可以保留整个左侧或右侧。修改/删除冲突可选择保留内容或按对应一侧删除。符号链接和子模块冲突需要在外部工具处理。合并编辑器嵌入主窗口，按需加载，关闭时释放 CodeMirror 实例。

合并块分析和字级差异在 Web Worker 后台线程计算。滚动同步与连线绘制合并到编辑器的布局测量阶段，优先处理视口内及穿过视口的连线。快速编辑会丢弃过期的高亮结果，切换或关闭文件会终止对应的后台计算。

## 代码缩略图

文件 diff 工具栏中可勾选“代码缩略图”，三栏合并中可从“合并视图设置”打开同一开关。默认关闭，两处共用配置，即时生效并自动保存，重启后保留。

缩略图使用 Canvas 绘制代码形状，最多抽样 1,000 行。滚动时更新可见范围框，文本或变化范围改变时更新代码图。点击或拖动可以定位，聚焦后支持方向键、Page Up / Page Down、Home / End。定位到合并视图中的折叠区域时会自动展开。开关切换会保留编辑内容和撤销记录。

## 分支与提交操作

分支行右侧的操作菜单提供“与当前分支比较”“Merge 到当前分支”和“Rebase 当前分支到此处”。比较窗口显示两个分支各自独有的提交数量与变更文件，选择文件可查看双栏 diff。比较按打开时的两个提交快照读取，“重新比较”会获取最新快照。

日志右侧的“提交操作”菜单提供 Cherry-pick 和 Revert。对合并提交执行这两项操作时，需要选择主线父提交。Revert 会创建一个反向应用修改的提交。

修改历史的操作要求工作区和暂存区干净，并在执行前展示当前分支、源提交和目标提交。后端会重新校验当前分支、HEAD 与目标分支的位置，拒绝过期请求。Rebase 仅更新当前分支。Git 钩子与签名配置继续生效，失败后显示 Git 实际留下的状态。Cherry-pick、Rebase 或 Revert 暂停时，可在合并管理器中继续、中止或跳过当前提交。

## 提交三栏查看器

日志工具栏的“显示 diff 预览”开关控制内嵌预览，自动保存并跨仓库生效。关闭时，选择提交和单击文件只加载提交信息及变更文件列表。双击变更文件或按 Enter 打开三栏查看器，Esc 返回日志。

左栏显示第一父提交中的文件，中栏显示所选提交中的文件，右栏显示当前工作区的磁盘快照。查看器内可切换同一提交的其他文件，以及“本次提交”和“后续变化”比较范围。工作区状态有更新时显示提示，点击“刷新当前内容”或按 F5 更新右栏，历史两栏保持固定。文件后来再次重命名时，可通过“关联当前文件”选择当前仓库内的文件。

三个版本分别处理文件不存在、空文件、二进制、大小或行数超限、编码不支持和子模块状态。首次提交的左栏显示文件不存在，合并提交默认与第一父提交比较。

## 环境

开发需要 Node.js 22.12 或更高版本、Rust 1.91 或更高版本、Git 2.43 或更高版本。Windows 还需要 MSVC C++ 构建工具、Windows SDK 和 WebView2。

运行发布版需要系统 Git 2.43 或更高版本（可从 PATH 启动）和 WebView2。历史文件的属性判断使用对应提交的 `.gitattributes`。当前打包目标为 Windows x64 NSIS。

## GitHub / GitLab

点击顶部“托管平台”，打开“管理账户”，选择平台并填写 HTTPS 服务器地址。可使用网页登录或访问令牌连接账户。GitLab 可使用 `https://gitlab.com` 或自建实例地址，GitHub 可使用 `https://github.com` 或 Enterprise 地址。

### 首次配置网页登录

网页登录使用为 IdeaGitTool 注册的 OAuth 应用。首次填写公开 Client ID，设置按平台和服务器保存，之后可直接点击“使用 GitHub / GitLab 网页登录”。账户窗口中的“打开应用注册页面”会打开所选服务器的应用设置。

- GitHub 注册 OAuth App，应用名填写 `IdeaGitTool`，Homepage URL 可填写 `https://github.com/huiyi-li/idea_GitTools`，Authorization callback URL 可填写 `http://127.0.0.1:34171/oauth/callback`。创建后启用 **Enable Device Flow**，把 Client ID 填入应用。点击网页登录后，在系统浏览器中输入应用显示的验证码并授权。此流程使用公开 Client ID。[GitHub Device Flow 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
- GitLab 创建应用，应用名填写 `IdeaGitTool`，取消 **Confidential**，选择 `api`、`read_user`，Redirect URI 填写 `http://127.0.0.1:34171/oauth/callback`，将 Application ID 填入应用的 Client ID。系统浏览器授权后会回到本机回调页面，应用自动读取账户身份并保存凭据。自建 GitLab 需要在对应实例注册应用。[GitLab PKCE 文档](https://docs.gitlab.com/api/oauth2/#authorization-code-with-proof-key-for-code-exchange-pkce)

GitLab 回调监听地址为 `127.0.0.1:34171`。端口被其他程序占用时，应用显示原因并允许重试。授权过程中可取消或关闭账户窗口。GitHub 等待授权最多 15 分钟，GitLab 最多 5 分钟，超时后可重新开始。

访问令牌与刷新令牌存入系统凭据库，账户 JSON 记录账户身份，WebView 本地存储记录公开 Client ID。API 请求前自动检查令牌到期时间并续期，凭据轮换按账户会话锁协调。退出账户会移除对应本地凭据，平台的授权撤销可在对应网站的应用设置中完成。

### 使用访问令牌

GitHub 细粒度令牌按需配置 Metadata、Contents、Commit statuses、Checks 读取权限，以及 Pull requests、Issues 读写权限。账户能看到的仓库还取决于令牌的仓库范围和组织授权。GitLab 浏览使用 `read_api`，创建、关闭、重新打开和评论使用 `api` 权限。

仓库和请求每页加载 30 条，搜索框筛选当前页。也可直接输入 `owner/repo` 或 `group/subgroup/project` 路径。选择仓库后可关联已有本地目录或克隆到新目录。API 访问使用平台令牌，Git 传输使用系统 SSH 配置或 Git 凭据管理器。SSH 克隆可填写已有 Host 别名，例如 `github_ming`。

远程 diff 按提交 SHA 读取，复用后台差异计算、同步滚动和 Minimap。GitHub 使用合并基准，GitLab 使用 MR 的差异基准。文件超过 1 MiB 或 20,000 行时提示在平台查看。切换账户、页面或请求会取消旧的读取任务。创建和评论失败时保留输入，结果不明确时先刷新列表核对远程状态。

当前接入支持网页登录、访问令牌登录和普通评论。行内讨论、审批、远程合并和从 PR / MR 检出分支列入后续阶段。

## 开发与验证

在项目根目录执行。

```sh
npm ci
npm run desktop
npm run build
npm test
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## 发布构建

```sh
npm run package
```

打包成功后自动将程序、安装包和许可证整理到项目根目录的 `release/`。双击 `release/IdeaGitTool.exe` 直接启动，或运行 `release/IdeaGitTool-setup.exe` 安装。

安装向导支持选择“当前用户”或“所有用户”。安装到 `C:\Program Files\IdeaGitTool` 时选择“所有用户”，并允许 Windows 管理员授权。双模式安装包启动时可能弹出 UAC 提示，选择“当前用户”时也可能需要授权。

可通过命令行参数直接打开仓库。

```sh
ideagittool-desktop.exe "C:\path\to\repository"
```

## 内存与边界

日志和提交详情按需读取，每页最多 200 条，前端只保留当前页。一般 Git 命令每个输出流上限为 8 MiB，文件 blob 读取上限为 10 MiB。Console 最多 120 条，每条最多 4,096 字符。关闭或切换 diff 时销毁 CodeMirror 实例。

本地 diff、提交三栏查看器和合并管理器在文件超过 1 MiB 或 20,000 行时提供“加载大文件”按钮。按需加载支持每个版本最多 10 MiB、200,000 行，两项限制同时生效，末尾换行后的空行计入行数。大文件模式使用行级比较、纯文本编辑器和可见区域高亮，代码缩略图在普通文件中按保存的偏好启用。大文件合并支持保存进度、恢复草稿和完成暂存。

差异计算在 Worker 中执行，单次预算为 5 秒。只读 diff 超时后显示整块变化及提示，合并准备超时后可重新读取或选择保留一侧。切换文件、关闭查看器可取消当前计算，普通 diff 还提供“取消计算”按钮。历史文件缓存最多 4 项、约 6 MiB，较大文件只保留当前活动内容。

文件类型优先遵循 `.gitattributes` 的 `diff` 属性及 diff 驱动的 `binary` 设置，再结合扩展名、文件头和内容判断。EXE、LIB、DLL、OBJ 等使用二进制文件展示，保留状态、暂存和提交操作。UTF-8 文本支持行级查看与合并，二进制冲突可选择保留一侧。

仓库操作在后端串行执行，前端请求携带仓库根路径，切换仓库后拒绝旧仓库的排队操作。命令失败后重新读取状态，展示 Git 实际留下的工作区和暂存区。Git 命令超时为 120 秒。

界面状态和最近仓库使用 WebView 本地存储。

## 源码与提交范围

仓库保留应用源码、测试、构建与测试脚本、必要图标、依赖锁文件、README、发布说明和许可证。依赖目录、编译输出、安装包、日志、缓存、临时计划与过程文档由 .gitignore 排除。版本说明见 [0.4.0 发布说明](docs/RELEASE_0.4.0.md)。

## 来源与许可证

本项目以 [Apache License 2.0](LICENSE) 发布。提交图布局、IntelliJ 差异算法、合并模型、界面样式和部分图标来自 IdeaGitTool 插件及其引用的上游项目。桌面后端、仓库操作、独立应用界面与性能优化在本仓库维护。

- 原插件为 [PGshen/vs-idea-gittool](https://github.com/PGshen/vs-idea-gittool)。
- 本次抽离使用的本地源码对应 [ZenghuiJIA/vs-idea-gittool](https://github.com/ZenghuiJIA/vs-idea-gittool) 分支仓库。
- 原插件的界面参考 [detachhead/rebased](https://github.com/detachhead/rebased)，相关算法、图标和文案沿用 [JetBrains/intellij-community](https://github.com/JetBrains/intellij-community) 的来源声明。

原插件的 package.json 声明 Apache-2.0，其根 LICENSE 正文为 JetBrains Open-Source Build Terms。本仓库保留该原始正文于 [licenses/UPSTREAM_LICENSE.txt](licenses/UPSTREAM_LICENSE.txt)，保留的版权与第三方署名见 [NOTICE](NOTICE)。这些文件随发布包一同分发，第三方内容适用各自的原始条款。

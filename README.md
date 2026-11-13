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
- 提交图、提交详情与变更文件，以及分支、说明、作者／邮箱、日期、路径和 SHA 组合筛选，支持按仓库保存筛选。日志每页 200 条。
- 日志页默认只展示提交和变更文件，可开启并记忆内嵌 diff 预览。双击文件或按 Enter 打开“修改前｜修改后｜当前工作区”的只读三栏查看器，支持变化导航、同步滚动、Minimap、栏宽调整和当前文件关联。
- 工作区与历史提交的双栏只读 diff、行级高亮和同步滚动。差异计算通过后台 Worker 执行，历史文件支持有界缓存，内容未变化的刷新会复用编辑器。
- 双栏 diff 和三栏合并均支持代码缩略图（Minimap），显示变化分布、冲突处理状态和可见范围，支持点击、拖动与键盘定位。
- 逐文件或批量暂存、取消暂存、放弃本地文件更改、提交暂存区。保留 Git hooks、签名和凭据配置。
- 新建并签出分支、签出本地分支或跟踪远程分支。
- 独立 SSH / HTTP / HTTPS URL 克隆、认证、传输进度、取消和完成后打开。
- Remote 管理、Fetch、仅快进或 Rebase Pull、首次 Push 与 upstream、Force with lease。
- 分支／标签管理、Stash 文件预览、Apply、Pop、Drop 与暂存布局恢复。
- 按块／按行暂存、取消暂存、放弃选中变化与 Amend。
- Worktree 创建、打开、删除、锁定／解锁和失效记录清理。
- 分支列表右键操作、从选中分支新建并签出、重命名／删除本地及远程分支，以及自动／仅快进／创建合并提交／Squash 快速合并入口。
- 忽略规则编辑、匹配来源检查、忽略文件列表，以及停止跟踪并保留磁盘文件。
- 交互式 Rebase、文件历史／Blame，以及 PR / MR 行内评论、讨论与审查操作。
- 文件变更自动刷新、F5 刷新、Git Console、中文路径和 worktree 仓库。
- 三栏合并管理器、冲突文件列表、逐块接受一侧或保留双方、手动编辑、自动处理简单冲突、同步滚动、冲突导航与撤销重做。
- 合并进度保存与恢复、完成后暂存、继续或中止 merge / rebase / cherry-pick / revert。
- 分支比较、Merge（自动 / --no-ff / --ff-only）、Rebase，以及日志提交的 Cherry-pick / Revert。冲突自动打开三栏合并管理器，支持继续、中止和跳过当前提交。
- 工作区沿用原插件的紧凑工具栏、分组分支树和图标。日志页的分支、详情和底部 diff 可拖动调整，提交页采用左侧文件与提交说明、右侧 diff。面板尺寸自动保存，双击分隔条复位，Ctrl+L 聚焦日志搜索。

Shelf、Changelist、Local History、AI 提交说明和多仓库同步操作仍需迁移。

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

工具栏的“全部采用本地版本／全部采用传入版本”将整侧内容放入结果栏，可撤销并继续编辑。底部的“以本地／传入版本覆盖并暂存…”会确认目标文件后直接使用整侧版本并标记已解决。Rebase 中按“正在重放版本／目标分支版本”标注两侧。

保存进度后界面保留已处理状态；仅换行符或文件权限发生变化、逻辑文本一致时也会恢复草稿。实际内容或冲突来源改变时显示提示，并保留当前磁盘文本供核对。

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

## 克隆与仓库管理

欢迎页点击“克隆远程仓库”，或使用主工具栏“克隆”。支持 `git@github_ming:owner/repo.git`、`ssh://git@host:2222/group/repo.git`、HTTPS 和 HTTP 地址。目录名随地址自动推导，手动修改后保留，目标目录需要为空。可指定浅克隆深度，留空读取完整历史。成功后打开仓库并更新最近记录。

SSH 沿用系统配置、Host 别名和 ssh-agent，HTTPS/HTTP 接入系统 Git 凭据管理器。需要时，认证窗口请求用户名、密码、令牌、私钥口令或主机指纹确认。应用认证窗口的输入通过本机回调传给 Git，凭据管理器沿用自身配置。最近地址与父目录保存在本地设置中，密码和令牌通过认证窗口输入。

克隆、Fetch、Pull、Push 和标签推送显示实时 Git 日志并支持取消。失败时保留输入与错误输出，目标目录可能包含未完成的数据，重试前需检查并选择空目录。传输期间固定仓库并串行执行仓库操作。

主工具栏“仓库”菜单提供以下入口。

- “管理远程仓库”可新增、修改、移除 Remote，并单独设置 Push 地址。Push 窗口可选择远程和目标分支、设置 upstream、预览待推送提交。Force with lease 使用预览中的远程跟踪提交，执行前需要 Fetch 并确认。Pull 默认仅快进，也可选择 Rebase。
- “分支、标签与 Stash”可重命名和删除本地分支、删除远程分支、创建附注标签、推送和删除标签。远程引用删除使用精确 lease。Stash 支持文件和 diff 预览、保存选中文件、包含未跟踪文件、保留暂存内容、Apply、Pop、Drop 和恢复暂存布局。Pop 应用失败时保留 Stash。
- “交互式 Rebase”支持上下移动提交，逐项选择 Pick、Reword、Squash、Fixup、Drop、Edit，以及 Autosquash 和 `--onto`。起点填写最后一个保留的提交，留空从根提交开始。采用线性重放，范围含合并提交时预览会显示数量。执行前固定 HEAD、分支和提交范围，并在 `refs/ideagittool/interactive/` 保留原 HEAD 引用。Edit 暂停时可修改文件、提交或 Amend，再从合并管理器继续。冲突复用三栏合并、继续、中止和跳过流程，重启后继续读取保留的编辑计划。
- “文件历史与 Blame”接受仓库相对路径。历史跟随重命名，可查看单次更改或比较两个历史版本。Blame 显示来源提交、作者和代码，点击 SHA 查看对应更改。文件历史每页 100 条，Blame 每页 200 行。

左侧储藏列表支持右键和操作菜单，可弹出、应用并保留、打开恢复选项、查看差异与删除；“管理储藏”直接打开储藏管理页。恢复时还原暂存布局与保存时保留暂存内容分别配置。可从储藏原始基准创建并切换新分支，成功恢复后删除该条储藏，发生冲突时保留储藏并打开合并管理器。

储藏文件可查看保存时的差异、与当前工作区比较或比较基准版本与当前工作区。未跟踪文件按新增文件显示。弹出和删除绑定引用、提交及列表快照；清空需要确认完整列表。列表改变后原选择会失效，取消选择会清除旧的文件预览。

提交页的文件“操作”菜单提供“按块／按行暂存…”和“按块／按行取消暂存…”。可切换变化块，勾选行号旁的复选框，或先选择文本范围再选择其中的变化行；跨块的行选择会保留。替换一行可同时选择对应的删除行和新增行。未暂存变化块和选中行可单独确认放弃。每次操作校验预览并保留其他变化。二进制和纯模式变化使用整文件操作。“Amend 最近提交…”可修改最近提交的说明并包含暂存内容，执行前校验 HEAD 和暂存区。

## 提交筛选、Worktree 与忽略规则

左侧分支列表支持右键或点击常驻的“…”菜单，提供签出、从此分支新建并签出、比较、重命名、删除和 Rebase。分支标题的“管理”打开完整管理器。远程分支可签出并创建本地跟踪分支，远程删除复用认证、进度和取消，并使用精确 lease 校验提交。

合并菜单可直接选择自动、仅快进、创建合并提交和 Squash，确认窗口会预选相应模式。Git 允许携带不受合并影响的本地修改，出现覆盖风险时终止。Squash 将结果放入暂存区，再从提交页创建单个提交；冲突可通过三栏合并管理器处理。本地分支默认采用 Git 的已合并检查，删除未合并分支需要显式勾选；当前分支及 Worktree 占用分支会受到删除保护。

日志工具栏的“高级筛选”支持作者姓名或邮箱、开始／结束日期、仓库相对文件或目录路径，以及至少 4 位的提交 SHA。条件组合取交集，SHA 定位单条提交，日期按提交者时间和本地时区计算。路径按字面匹配，可填写包含空格和方括号的路径。保存的筛选包含分支、提交说明搜索和高级条件，按仓库分别保存。

“仓库 → Worktree 管理”可从当前 HEAD 或分支提交创建新分支工作区、使用已有本地分支或创建 Detached HEAD 工作区。列表显示分支、路径、本地更改、锁定原因与失效状态，可打开工作区、锁定／解锁、确认删除干净的关联工作区，以及清理失效记录。Git 会检查分支占用；删除工作区后分支可继续使用。

“仓库 → 忽略规则管理”与提交页文件“操作 → 忽略规则／停止跟踪…”可检查路径命中的规则、来源文件和行号。支持按路径、父目录、扩展名或自定义规则写入根 `.gitignore`，可编辑根规则。“显示忽略文件”切换忽略文件／目录与已跟踪文件列表，每页 200 项。

已跟踪文件可选择“停止跟踪并保留文件…”，确认后从暂存区移除，提交后生效。暂存内容与 HEAD、磁盘内容都不一致时，Git 会要求先处理暂存状态。此操作支持目录，并校验索引和规则预览。

## PR / MR 审查

请求详情的“审查、合并与签出”提供批准、合并和获取请求分支。GitHub 支持 Request changes 和 Merge / Squash / Rebase 合并，GitLab 支持批准、撤销批准以及按项目设置合并或 Squash。操作固定请求的 HEAD，远程提交改变后需要刷新并重新确认。

在远程 diff 中点击代码行，再选择“评论所选行”。“审查讨论”页按页显示行内讨论，支持回复、解决和重新打开讨论，GitHub 单个讨论显示前 100 条回复。GitLab 行内评论提交完整的差异基准与新旧文件路径，GitHub 讨论操作校验所属仓库和请求。

先关联并打开本地仓库，再获取 PR / MR 分支。传输完成后进入签出预览，可从请求提交创建分支，并使用现有的本地修改保护和恢复流程。

GitHub 审查使用 REST 和 GraphQL API，账户需要相应仓库的 Pull requests 读写权限。GitLab 写操作需要 `api` 权限。平台操作已使用模拟服务器回归，真实账户需按自身服务器权限验收。

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

当前接入支持网页登录、访问令牌登录、普通评论、行内讨论、审批、远程合并和从 PR / MR 检出分支。

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

### 应用内更新

状态栏版本按钮可打开“软件更新”，查看新版本说明、下载进度并执行“安装并重启”。默认启动后检查一次更新，可关闭自动检查，也可开启发现新版本后自动下载。下载完成后验证更新签名，点击安装前保存当前仓库和提交信息草稿，重启后恢复。Git 操作或其他操作窗口仍在运行时，完成并关闭操作窗口后可安装更新。

更新源为本仓库 [GitHub Releases](https://github.com/huiyi-li/idea_GitTools/releases)，使用固定地址 `https://github.com/huiyi-li/idea_GitTools/releases/latest/download/latest.json`。发布 tag 对应版本，客户端从最新正式 Release 读取清单。草稿和预发布版本不进入正式更新通道。此流程参考 [CC Switch](https://github.com/farion1231/cc-switch) 的 Tauri updater 接入，并使用 [Tauri 官方签名更新机制](https://v2.tauri.app/plugin/updater/)。

Windows 更新沿用 NSIS 安装包和 passive 模式，安装到 Program Files 时可触发系统管理员授权。便携版也可检查更新，执行安装会进入 NSIS 安装流程。需要继续便携使用时，可从发布页获取 ZIP。网络超时、清单缺失或签名错误会显示提示并提供重试和发布页入口。

### 签名密钥与本地打包

应用配置只保存更新公钥。本机签名私钥位于 `%USERPROFILE%\.tauri\IdeaGitTool\updater.key`，同目录的 `updater.key.pub` 为公钥。密钥目录已限制为当前 Windows 用户访问。请在安全位置备份私钥，后续版本沿用同一密钥，丢失后现有客户端无法验证新密钥签名的更新。

`npm run package` 优先读取 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，本机未设置环境变量时读取上述文件，密码默认为空。可用 `IDEAGITTOOL_SIGNING_KEY_PATH` 指定其他本地密钥路径，旁边需有匹配的 `.pub` 文件。更换构建机器时恢复已有密钥。派生项目可用 `npx tauri signer generate --ci -p "" -w <本地私钥路径>` 创建自身密钥，并将公钥正文写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。

打包产物包括 `IdeaGitTool-setup.exe`、对应 `.sig`、便携 ZIP、`latest.json` 和哈希清单。清单中的签名为 `.sig` 文件正文。`RELEASE_TAG` 支持与应用版本一致的 `0.4.2` 或 `v0.4.2` 形式，默认使用应用版本。可用 `RELEASE_NOTES_FILE` 指定 UTF-8 发布说明文件。

打包后可验证安装包签名、公钥匹配、篡改拒绝和全部产物哈希。

```sh
cargo test --manifest-path src-tauri/Cargo.toml signed_release_matches_embedded_key_and_rejects_tampering -- --ignored
```

### GitHub 自动构建与发布

在仓库 Settings → Secrets and variables → Actions 添加 `TAURI_SIGNING_PRIVATE_KEY`，值为已有私钥文件正文。私钥有密码时同时添加 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。私钥和密码通过 GitHub Actions secrets 注入构建，保留本地备份。

`.github/workflows/release.yml` 在推送版本 tag 后验证三处版本一致性，执行测试、Clippy、签名打包和产物验签，然后创建带完整资源的 Release 草稿。支持重试上传草稿，已发布版本会拒绝覆盖。核对草稿后点击 Publish release，最新正式版本即可被客户端发现。仓库 Actions 需允许工作流写入仓库内容。

准备发布时同步更新 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 与 `src-tauri/tauri.conf.json` 的应用版本，提交后创建并推送对应 tag。首次使用应用内更新需先安装包含 updater 的构建。当前版本的更新内容见 [0.4.3 发布说明](docs/RELEASE_0.4.3.md)。

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

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
- 分支筛选、提交说明搜索、提交图、提交详情与变更文件。日志每页 200 条。
- 工作区与历史提交的双栏只读 diff、行级高亮和同步滚动。差异计算通过后台 Worker 执行，历史文件支持有界缓存，内容未变化的刷新会复用编辑器。
- 双栏 diff 和三栏合并均支持代码缩略图（Minimap），显示变化分布、冲突处理状态和可见范围，支持点击、拖动与键盘定位。
- 逐文件或批量暂存、取消暂存、提交暂存区。保留 Git hooks、签名和凭据配置。
- 新建并签出分支、签出本地分支或跟踪远程分支。
- Fetch、仅快进 Pull、Push。
- Stash 保存（包含未跟踪文件）、应用并保留 Stash。
- 文件变更自动刷新、F5 刷新、Git Console、中文路径和 worktree 仓库。
- 三栏合并管理器、冲突文件列表、逐块接受一侧或保留双方、手动编辑、自动处理简单冲突、同步滚动、冲突导航与撤销重做。
- 合并进度保存与恢复、完成后暂存、继续或中止 merge / rebase / cherry-pick / revert。
- 分支比较、Merge（自动 / --no-ff / --ff-only）、Rebase，以及日志提交的 Cherry-pick / Revert。冲突自动打开三栏合并管理器，支持继续、中止和跳过当前提交。
- 工作区沿用原插件的紧凑工具栏、分组分支树和图标。日志页的分支、详情和底部 diff 可拖动调整，提交页采用左侧文件与提交说明、右侧 diff。面板尺寸自动保存，双击分隔条复位，Ctrl+L 聚焦日志搜索。

交互式 rebase 的编排界面、Shelf、Changelist、Local History、Blame、AI 提交说明和多仓库同步操作仍需迁移。

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

## 环境

开发需要 Node.js 22.12 或更高版本、Rust 1.91 或更高版本、Git。Windows 还需要 MSVC C++ 构建工具、Windows SDK 和 WebView2。

运行发布版需要系统 Git（可从 PATH 启动）和 WebView2。已在 Windows x64 验证，其他平台尚未验证。当前打包目标为 Windows NSIS。

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

可通过命令行参数直接打开仓库。

```sh
ideagittool-desktop.exe "C:\path\to\repository"
```

## 内存与边界

日志和提交详情按需读取，每页最多 200 条，前端只保留当前页。Git 输出限制为每条命令每个输出流 8 MiB，Console 最多 120 条，每条最多 4,096 字符。单个 diff 文件任一版本超过 1 MiB 或 20,000 个换行时提示使用外部编辑器。关闭或切换 diff 时销毁 CodeMirror 实例。

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

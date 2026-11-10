# IdeaGitTool Desktop 0.4.0

基于 Tauri 2、Rust、Preact 和 CodeMirror 6 的独立 Git 客户端，采用接近 Rebased / IntelliJ 的紧凑界面。当前提供 Windows x64 安装版和便携版。

## 主要功能

- 仓库与历史管理。打开本地仓库、最近仓库、提交关系图、分支筛选、提交搜索、提交详情和文件变更列表。
- 文件差异。工作区与历史提交的双栏 diff、行级高亮、同步滚动和分支快照比较。
- 三栏合并。逐块接受左侧或右侧、按顺序保留双方、手动编辑、简单冲突自动处理、冲突导航、撤销重做和处理状态提示。
- 合并进度。保存与恢复草稿、完成后暂存，支持继续、中止 merge / rebase / cherry-pick / revert，以及适用操作的跳过当前提交。
- 常用 Git 操作。暂存、取消暂存、提交、创建与切换分支、Merge、Rebase、Cherry-pick、Revert、Fetch、仅快进 Pull、Push 和 Stash 保存与应用。
- 可选代码缩略图。双栏 diff 和三栏合并均可显示变化分布、冲突状态和可见范围，支持点击、拖动与键盘定位。默认关闭，开关自动保存。
- 桌面交互。深浅色主题、可拖动面板、中文路径、Git worktree、文件变更自动刷新、F5 刷新和 Git Console。

差异与合并分析通过后台 Worker 执行，同步滚动按帧处理，历史文件采用有界缓存。代码缩略图使用 Canvas 和有界抽样绘制。

## 下载与运行

运行环境需要系统 Git 和 Microsoft Edge WebView2 Runtime。

- 安装版下载并运行 IdeaGitTool-setup.exe。
- 便携版下载并解压 IdeaGitTool_0.4.0_windows-x64.zip，双击其中的 IdeaGitTool.exe。

发布包包含 LICENSE、NOTICE 和上游保留的许可证文件。

## 当前边界

- 本次发布面向 Windows x64。
- 双栏文本 diff 支持 UTF-8，单个版本限制为 1 MiB 和约 20,000 行。二进制文件和超大文件会提示使用外部工具。
- 符号链接和子模块冲突需要外部处理。
- 交互式 rebase 编排、Shelf、Changelist、Local History、Blame 和 AI 提交说明仍待迁移。

## 项目来源

本项目从 [PGshen/vs-idea-gittool](https://github.com/PGshen/vs-idea-gittool) 抽离，本地使用的分支仓库为 [ZenghuiJIA/vs-idea-gittool](https://github.com/ZenghuiJIA/vs-idea-gittool)。界面和部分基础实现源自 [Rebased](https://github.com/detachhead/rebased) 与 [IntelliJ Platform](https://github.com/JetBrains/intellij-community)。

本项目采用 Apache-2.0，来源和第三方条款见仓库 LICENSE、NOTICE 与 licenses/UPSTREAM_LICENSE.txt。

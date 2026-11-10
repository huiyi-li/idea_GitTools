# IdeaGitTool Desktop

基于 Tauri 2、Rust、Preact 和 CodeMirror 6 的独立 Git 客户端。Rust 调用系统 Git，提交图布局、IntelliJ 差异算法和主题样式均随本项目维护。

项目目录为 `C:\ming\source\vscode-git\ideagittool-desktop`。

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
- 工作区与历史提交的双栏只读 diff、行级高亮和同步滚动。
- 逐文件或批量暂存、取消暂存、提交暂存区。保留 Git hooks、签名和凭据配置。
- 新建并签出分支、签出本地分支或跟踪远程分支。
- Fetch、仅快进 Pull、Push。
- Stash 保存（包含未跟踪文件）、应用并保留 Stash。
- 文件变更自动刷新、F5 刷新、Git Console、中文路径和 worktree 仓库。

这是独立版的第一阶段。三栏冲突编辑器、交互式 rebase、Shelf、Changelist、Local History、Blame、AI 提交说明和多仓库同步操作仍需迁移。当前冲突需要在外部编辑器解决，再在工作区暂存。

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

生成的程序位于 `src-tauri/target/release/ideagittool-desktop.exe`，安装包位于 `src-tauri/target/release/bundle/nsis/`。

可通过命令行参数直接打开仓库。

```sh
ideagittool-desktop.exe "C:\path\to\repository"
```

## 内存与边界

日志和提交详情按需读取，每页最多 200 条，前端只保留当前页。Git 输出限制为每条命令每个输出流 8 MiB，Console 最多 120 条，每条最多 4,096 字符。单个 diff 文件任一版本超过 1 MiB 或 20,000 个换行时提示使用外部编辑器。关闭或切换 diff 时销毁 CodeMirror 实例。

仓库操作在后端串行执行，前端请求携带仓库根路径，切换仓库后拒绝旧仓库的排队操作。命令失败后重新读取状态，展示 Git 实际留下的工作区和暂存区。Git 命令超时为 120 秒。

界面状态和最近仓库使用 WebView 本地存储。

## 来源

本项目从 IdeaGitTool 插件的桌面版实现抽离。提交图布局、差异算法和基础样式取自该插件，已纳入本仓库的 `src/git`、`src/shared` 和 `src/ui`。许可证与第三方声明复制自原项目，见本仓库根目录的 `LICENSE` 与 `NOTICE`，随安装包分发。

原项目的 `LICENSE` 正文为 JetBrains Open-Source Build Terms，而 `Cargo.toml` 的许可证字段为 `Apache-2.0`。本次抽离保留这两处原始声明，其对应关系仍待核对。

# IdeaGitTool 0.4.9

本次更新新增 Linux 全平台支持与双平台并行发布流水线，支持 `.deb`、`.rpm`、`.AppImage`、便携 `.tar.gz` 与 Arch Linux 原生打包安装。

## 多仓库工作区

- 保持多标签多仓库工作台与持久化标签状态，Linux 平台完整支持仓库发现、文件监听、终端与外部编辑器联动。
- 补齐 Linux 平台 `keyring`（Secret Service）凭据存储后端，支持 GitHub / GitLab 账号授权与安全保存。

## 提交与本地更改

- 新增 Linux 多格式打包配置与便携支持包脚本，支持 `.deb`、`.rpm`、`.AppImage`（含自动更新签名）及含桌面入口与安装脚本的 `.tar.gz`。
- 新增 Arch Linux AUR 双模板（`ideagittool` 与 `ideagittool-bin`），支持通过 `makepkg -si` 原生安装。

## 日志与提交图

- 新增双平台 `ci.yml` 与并行 `release.yml` 流水线，发布时自动构建 Windows 与 Linux 全套产物并合并 `latest.json` 多平台更新清单。

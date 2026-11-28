# IdeaGitTool 0.4.12

本次更新新增简体中文 / 繁體中文 / English 三语国际化支持、编译前 i18n key 遗漏自动拦截脚本，以及 GitHub Releases 自建 Arch Linux `pacman` 软件源。

## 多仓库工作区

- 新增 `src/i18n/` 三语支持（简体中文、繁體中文、English），可在设置中心「外观与排版」实时切换界面语言并持久化保存。
- 编译与测试流水线新增 `scripts/check-i18n.mjs` 前置门禁，自动校验三语 key 完整性、占位符一致性与源码 `t()` 调用，遗漏 key 时自动拦截构建。

## 提交与本地更改

- 扩展设置中心、命令面板、Git 诊断及三栏合并编辑器菜单的多语言适配。
- 新增 `scripts/build_arch_repo.sh`，随 Release 自动构建 `.pkg.tar.zst` 与 `ideagittool.db.tar.gz` / `ideagittool.db` 自建 `pacman` 仓库。

## 日志与提交图

- 优化双平台 `release.yml` 原子化资产收集与多平台发布校验（覆盖 Windows、Debian/Ubuntu、Fedora/RHEL、AppImage、便携 `.tar.gz` 与 Arch `pacman` 源）。

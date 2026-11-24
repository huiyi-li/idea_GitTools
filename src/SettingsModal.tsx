import { useState } from 'preact/hooks';
import {
  resetAllSettings,
  useSetting,
  type DensityMode,
  type ThemeMode,
  type UpdateAutoClean,
  type UpdateStrategy,
} from './state/settings';
import { Icon, Modal, ToolButton } from './ui/controls';
import { Kbd, SegmentedControl, SettingsRow, Switch } from './ui/primitives';
import './settings.css';

export type SettingsSection = 'appearance' | 'editor' | 'workflow' | 'layout' | 'updates';

const SECTIONS: { id: SettingsSection; label: string; icon: string }[] = [
  { id: 'appearance', label: '外观与排版', icon: 'general/settings' },
  { id: 'editor', label: '差异与编辑器', icon: 'toolwindows/commit' },
  { id: 'workflow', label: 'Git 工作流', icon: 'vcs/update' },
  { id: 'layout', label: '视图与布局', icon: 'nodes/folder' },
  { id: 'updates', label: '更新与快捷键', icon: 'toolwindows/vcs' },
];

const SHORTCUTS: { label: string; keys: string }[] = [
  { label: '打开仓库 / 工作区', keys: 'Ctrl + O' },
  { label: '更新项目 (Pull / Auto-Shelf)', keys: 'Ctrl + T' },
  { label: '打开设置中心', keys: 'Ctrl + ,' },
  { label: '刷新仓库状态与日志', keys: 'F5' },
  { label: '跳至下一处 / 上一处差异', keys: 'F7 / Shift+F7' },
  { label: '轻量编辑保存修改', keys: 'Ctrl + S' },
  { label: '提交暂存内容', keys: 'Ctrl + Enter' },
  { label: '聚焦提交日志搜索框', keys: 'Ctrl + L' },
];

export function SettingsModal({
  initialSection = 'appearance',
  onClose,
}: {
  initialSection?: SettingsSection;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [query, setQuery] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  const [theme, setTheme] = useSetting('theme');
  const [density, setDensity] = useSetting('density');
  const [editorFontSize, setEditorFontSize] = useSetting('editorFontSize');
  const [editorLineHeight, setEditorLineHeight] = useSetting('editorLineHeight');
  const [minimap, setMinimap] = useSetting('minimap');
  const [inlineBlame, setInlineBlame] = useSetting('inlineBlame');
  const [diffSyncScroll, setDiffSyncScroll] = useSetting('diffSyncScroll');
  const [wordDiffHighlights, setWordDiffHighlights] = useSetting('wordDiffHighlights');
  const [externalEditorCommand, setExternalEditorCommand] = useSetting('externalEditorCommand');
  const [updateStrategy, setUpdateStrategy] = useSetting('updateStrategy');
  const [updateAutoClean, setUpdateAutoClean] = useSetting('updateAutoClean');
  const [cloneParent, setCloneParent] = useSetting('cloneParent');
  const [workspaceScanDepth, setWorkspaceScanDepth] = useSetting('workspaceScanDepth');
  const [logDiffPreview, setLogDiffPreview] = useSetting('logDiffPreview');
  const [groupFilesByDir, setGroupFilesByDir] = useSetting('groupFilesByDir');
  const [groupBranchesByDir, setGroupBranchesByDir] = useSetting('groupBranchesByDir');
  const [updaterAutoCheck, setUpdaterAutoCheck] = useSetting('updaterAutoCheck');
  const [updaterAutoDownload, setUpdaterAutoDownload] = useSetting('updaterAutoDownload');

  const q = query.trim().toLowerCase();
  const matches = (...keywords: string[]) =>
    !q || keywords.some((kw) => kw.toLowerCase().includes(q));
  const showSection = (id: SettingsSection) => (q ? true : section === id);

  return (
    <Modal title="设置中心" onClose={onClose} class="settings-modal">
      <header class="settings-header">
        <div class="settings-header-title">
          <Icon name="general/settings" />
          <span>设置中心</span>
          <Kbd>Ctrl + ,</Kbd>
        </div>
        <label class="settings-search">
          <Icon name="general/search" />
          <input
            aria-label="搜索设置项"
            placeholder="搜索设置项（主题、字号、Shelf、Rebase…）"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <ToolButton icon="general/close" label="关闭设置中心" onClick={onClose} />
      </header>
      <div class="settings-body">
        <nav class="settings-nav" aria-label="设置分类">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              class="settings-nav-item"
              aria-current={!q && section === item.id ? 'page' : undefined}
              onClick={() => {
                setQuery('');
                setSection(item.id);
              }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
          <div class="settings-nav-footer">
            {!confirmReset ? (
              <button
                type="button"
                class="settings-nav-item"
                onClick={() => setConfirmReset(true)}
              >
                <Icon name="general/refresh" />
                <span>恢复默认设置</span>
              </button>
            ) : (
              <div class="modal-actions">
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  class="primary"
                  onClick={() => {
                    resetAllSettings();
                    setConfirmReset(false);
                  }}
                >
                  确认重置
                </button>
              </div>
            )}
          </div>
        </nav>

        <main class="settings-content" aria-label="设置项列表">
          {showSection('appearance') &&
            matches('外观', '主题', '深色', '浅色', '系统', '密度', '紧凑', '字体', '字号', '行高', 'theme', 'font') && (
              <section class="settings-section">
                <h3 class="settings-section-heading">外观与排版</h3>
                {matches('主题', '深色', '浅色', '系统', 'theme') && (
                  <SettingsRow
                    title="界面主题"
                    description="选择深色、浅色或自动跟随操作系统外观"
                  >
                    <SegmentedControl<ThemeMode>
                      label="界面主题"
                      value={theme}
                      options={[
                        { value: 'dark', label: '深色' },
                        { value: 'light', label: '浅色' },
                        { value: 'system', label: '跟随系统' },
                      ]}
                      onChange={setTheme}
                    />
                  </SettingsRow>
                )}
                {matches('密度', '紧凑', '舒适', 'density') && (
                  <SettingsRow
                    title="界面紧凑度"
                    description="控制列表行距与控件留白，适合高信息密度审阅"
                  >
                    <SegmentedControl<DensityMode>
                      label="界面紧凑度"
                      value={density}
                      options={[
                        { value: 'comfortable', label: '舒适' },
                        { value: 'compact', label: '紧凑' },
                      ]}
                      onChange={setDensity}
                    />
                  </SettingsRow>
                )}
                {matches('字号', '字体', '代码', 'font') && (
                  <SettingsRow
                    title="代码编辑器字号 (px)"
                    description="应用于双栏 Diff、三栏提交查看器与代码预览（11–18 px）"
                  >
                    <input
                      type="number"
                      class="settings-number-input"
                      aria-label="代码编辑器字号"
                      min={11}
                      max={18}
                      value={editorFontSize}
                      onInput={(event) =>
                        setEditorFontSize(
                          Math.max(11, Math.min(18, Number(event.currentTarget.value) || 12)),
                        )
                      }
                    />
                  </SettingsRow>
                )}
                {matches('行高', '字体', 'lineHeight') && (
                  <SettingsRow
                    title="代码编辑器行高 (px)"
                    description="控制代码行间距（16–28 px）"
                  >
                    <input
                      type="number"
                      class="settings-number-input"
                      aria-label="代码编辑器行高"
                      min={16}
                      max={28}
                      value={editorLineHeight}
                      onInput={(event) =>
                        setEditorLineHeight(
                          Math.max(16, Math.min(28, Number(event.currentTarget.value) || 20)),
                        )
                      }
                    />
                  </SettingsRow>
                )}
              </section>
            )}

          {showSection('editor') &&
            matches('差异', '编辑器', '缩略图', 'minimap', 'blame', '同步滚动', '字级', '外部编辑器') && (
              <section class="settings-section">
                <h3 class="settings-section-heading">差异与编辑器</h3>
                {matches('缩略图', 'minimap', '编辑器') && (
                  <SettingsRow
                    title="显示代码缩略图 (Minimap)"
                    description="在双栏 Diff、三栏查看器与三栏合并器右侧展示全局差异缩略图"
                  >
                    <Switch
                      label="显示代码缩略图"
                      checked={minimap}
                      onChange={setMinimap}
                    />
                  </SettingsRow>
                )}
                {matches('blame', '作者', '行内') && (
                  <SettingsRow
                    title="默认显示 Inline Blame"
                    description="在双栏差异右侧行尾显示最近提交作者与摘要（前 200 行）"
                  >
                    <Switch
                      label="默认显示 Inline Blame"
                      checked={inlineBlame}
                      onChange={setInlineBlame}
                    />
                  </SettingsRow>
                )}
                {matches('同步滚动', '滚动', 'sync') && (
                  <SettingsRow
                    title="默认开启双栏同步滚动"
                    description="浏览左右差异视图时按比例联动滚动位置"
                  >
                    <Switch
                      label="默认开启双栏同步滚动"
                      checked={diffSyncScroll}
                      onChange={setDiffSyncScroll}
                    />
                  </SettingsRow>
                )}
                {matches('字级', '高亮', 'word', '差异') && (
                  <SettingsRow
                    title="行内字级差异高亮 (Word-level)"
                    description="在修改行内精确标出增删的词段"
                  >
                    <Switch
                      label="行内字级差异高亮"
                      checked={wordDiffHighlights}
                      onChange={setWordDiffHighlights}
                    />
                  </SettingsRow>
                )}
                {matches('外部编辑器', 'vscode', 'cursor', 'idea', 'editor') && (
                  <SettingsRow
                    title="自定义外部编辑器命令"
                    description="留空时自动优先使用 VS Code (--goto) 或系统默认程序"
                  >
                    <input
                      class="settings-text-input"
                      aria-label="自定义外部编辑器命令"
                      placeholder="例如 code 或 cursor"
                      value={externalEditorCommand}
                      onInput={(event) => setExternalEditorCommand(event.currentTarget.value)}
                    />
                  </SettingsRow>
                )}
              </section>
            )}

          {showSection('workflow') &&
            matches('工作流', 'pull', 'rebase', 'merge', 'shelf', 'stash', '更新', '克隆', '扫描', '工作区') && (
              <section class="settings-section">
                <h3 class="settings-section-heading">Git 工作流默认值</h3>
                {matches('pull', 'rebase', 'merge', '更新', '策略') && (
                  <SettingsRow
                    title="Update Project (Ctrl+T) 默认整合策略"
                    description="拉取远程更新时默认采用的整合方式"
                  >
                    <SegmentedControl<UpdateStrategy>
                      label="默认拉取整合策略"
                      value={updateStrategy}
                      options={[
                        { value: 'ff-only', label: '仅快进' },
                        { value: 'rebase', label: 'Rebase' },
                        { value: 'merge', label: 'Merge' },
                      ]}
                      onChange={setUpdateStrategy}
                    />
                  </SettingsRow>
                )}
                {matches('shelf', 'stash', '脏工作区', '暂存', '更新') && (
                  <SettingsRow
                    title="更新前脏工作区默认保护方式"
                    description="存在本地未提交修改时拉取更新的自动暂存与恢复策略"
                  >
                    <SegmentedControl<UpdateAutoClean>
                      label="脏工作区默认保护方式"
                      value={updateAutoClean}
                      options={[
                        { value: 'shelf', label: 'Auto-Shelf' },
                        { value: 'stash', label: 'Auto-Stash' },
                        { value: 'none', label: '不自动暂存' },
                      ]}
                      onChange={setUpdateAutoClean}
                    />
                  </SettingsRow>
                )}
                {matches('克隆', '目录', 'clone') && (
                  <SettingsRow
                    title="默认克隆父目录"
                    description="打开“克隆仓库”窗口时自动填充的本地目标父目录"
                  >
                    <input
                      class="settings-text-input"
                      aria-label="默认克隆父目录"
                      placeholder="例如 C:/projects"
                      value={cloneParent}
                      onInput={(event) => setCloneParent(event.currentTarget.value)}
                    />
                  </SettingsRow>
                )}
                {matches('扫描', '深度', '工作区', 'workspace') && (
                  <SettingsRow
                    title="工作区多仓库扫描深度"
                    description="打开包含多个仓库的文件夹时向下递归扫描的目录层数（0–8）"
                  >
                    <input
                      type="number"
                      class="settings-number-input"
                      aria-label="工作区多仓库扫描深度"
                      min={0}
                      max={8}
                      value={workspaceScanDepth}
                      onInput={(event) =>
                        setWorkspaceScanDepth(
                          Math.max(0, Math.min(8, Number(event.currentTarget.value) || 0)),
                        )
                      }
                    />
                  </SettingsRow>
                )}
              </section>
            )}

          {showSection('layout') &&
            matches('布局', '预览', 'diff', '目录', '分组', '分支', '文件') && (
              <section class="settings-section">
                <h3 class="settings-section-heading">视图与布局</h3>
                {matches('预览', 'diff', '日志') && (
                  <SettingsRow
                    title="日志视图默认显示底部 Diff 预览"
                    description="选中提交文件时在日志下方直接展示内联差异"
                  >
                    <Switch
                      label="日志视图默认显示底部 Diff 预览"
                      checked={logDiffPreview}
                      onChange={setLogDiffPreview}
                    />
                  </SettingsRow>
                )}
                {matches('目录', '分组', '文件', '变更') && (
                  <SettingsRow
                    title="变更文件默认按目录树分组"
                    description="将提交页和提交详情中的文件列表折叠为目录层级"
                  >
                    <Switch
                      label="变更文件默认按目录树分组"
                      checked={groupFilesByDir}
                      onChange={setGroupFilesByDir}
                    />
                  </SettingsRow>
                )}
                {matches('目录', '分组', '分支') && (
                  <SettingsRow
                    title="分支栏默认按目录前缀分组"
                    description="按斜杠路径（如 feature/、fix/）折叠本地与远程分支"
                  >
                    <Switch
                      label="分支栏默认按目录前缀分组"
                      checked={groupBranchesByDir}
                      onChange={setGroupBranchesByDir}
                    />
                  </SettingsRow>
                )}
              </section>
            )}

          {showSection('updates') &&
            matches('更新', '自动', '下载', '快捷键', 'shortcut') && (
              <section class="settings-section">
                <h3 class="settings-section-heading">更新与快捷键</h3>
                {matches('更新', '自动', '检查') && (
                  <SettingsRow
                    title="启动时自动检查新版本"
                    description="启动 5 秒后在后台静默检查 GitHub Releases 签名更新"
                  >
                    <Switch
                      label="启动时自动检查新版本"
                      checked={updaterAutoCheck}
                      onChange={setUpdaterAutoCheck}
                    />
                  </SettingsRow>
                )}
                {matches('更新', '自动', '下载') && (
                  <SettingsRow
                    title="发现新版本后自动下载安装包"
                    description="下载完成后仍需手动确认后才会重启安装"
                  >
                    <Switch
                      label="发现新版本后自动下载安装包"
                      checked={updaterAutoDownload}
                      onChange={setUpdaterAutoDownload}
                    />
                  </SettingsRow>
                )}
                {matches('快捷键', 'shortcut', 'ctrl', 'f5', 'f7') && (
                  <div class="settings-section">
                    <h4 class="settings-section-heading">全局快捷键速查</h4>
                    <div class="settings-shortcuts-grid">
                      {SHORTCUTS.map((item) => (
                        <div class="settings-shortcut-item" key={item.keys}>
                          <span>{item.label}</span>
                          <Kbd>{item.keys}</Kbd>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}
        </main>
      </div>
    </Modal>
  );
}

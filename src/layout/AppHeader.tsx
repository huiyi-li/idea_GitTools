import type { Status } from '../api';
import { ActionMenu, Icon, ToolButton } from '../ui/controls';

export function AppHeader({
  root,
  status,
  recent,
  busy,
  showHosting,
  showSettings,
  onChooseRepository,
  onOpenPath,
  onOpenWorkspace,
  onOpenCommandPalette,
  onOpenSettings,
  onToggleHosting,
  onOpenClone,
  onOpenRemotes,
  onOpenManager,
  onOpenWorktrees,
  onOpenIgnore,
  onOpenInteractive,
  onOpenFileHistory,
  onOpenRevisionTree,
  onOpenLocalHistory,
  onOpenMultiRepo,
  onOpenDiagnostics,
  onOpenBisect,
  onOpenSubmodules,
  onOpenRevisionInput,
  onOpenRecovery,
  onOpenTransfer,
  onRefresh,
}: {
  root: string;
  status: Status | null;
  recent: string[];
  busy: boolean;
  showHosting: boolean;
  showSettings: boolean;
  onChooseRepository: () => void;
  onOpenPath: (path: string) => void;
  onOpenWorkspace: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onToggleHosting: () => void;
  onOpenClone: () => void;
  onOpenRemotes: () => void;
  onOpenManager: (tab: 'branches' | 'tags' | 'stashes' | 'shelves') => void;
  onOpenWorktrees: () => void;
  onOpenIgnore: () => void;
  onOpenInteractive: () => void;
  onOpenFileHistory: () => void;
  onOpenRevisionTree: () => void;
  onOpenLocalHistory: () => void;
  onOpenMultiRepo: () => void;
  onOpenDiagnostics: () => void;
  onOpenBisect: () => void;
  onOpenSubmodules: () => void;
  onOpenRevisionInput: () => void;
  onOpenRecovery: () => void;
  onOpenTransfer: (action: 'fetch' | 'pull' | 'push') => void;
  onRefresh: () => void;
}) {
  return (
    <header class="app-header">
      <div class="brand">
        <Icon name="toolwindows/vcs" />
        <strong>IdeaGitTool</strong>
      </div>
      <span class="header-divider" />
      <div class="repository-switcher">
        <button
          class="repository-picker"
          aria-label="选择仓库文件夹"
          onClick={onChooseRepository}
          disabled={busy}
          title={root || '打开仓库 · Ctrl+O'}
        >
          <Icon name="nodes/folder" />
          <span class="ellipsis">{status?.repository.name ?? '打开仓库'}</span>
        </button>
        <ActionMenu label="最近仓库" icon="general/chevronDown" disabled={busy}>
          <div class="menu-caption">最近仓库</div>
          {recent.map((path) => (
            <button
              key={path}
              aria-label={`打开最近仓库 ${path}`}
              disabled={path === root || busy}
              title={path}
              onClick={() => onOpenPath(path)}
            >
              <Icon name="nodes/folder" />
              <span class="recent-repository-label">
                <strong class="ellipsis">{path.replaceAll('\\', '/').split('/').pop()}</strong>
                <small class="ellipsis muted">{path}</small>
              </span>
              {path === root && <span class="muted">当前</span>}
            </button>
          ))}
          {!recent.length && <div class="menu-caption">暂无最近仓库</div>}
          <hr />
          <button disabled={busy} onClick={onChooseRepository}>
            <Icon name="general/open" />
            打开其他仓库…
          </button>
        </ActionMenu>
      </div>
      {status && (
        <span class="current-branch-chip">
          <Icon name="dvcs/branchLabel" />
          <span class="ellipsis">
            {status.repository.branch ?? status.repository.head?.slice(0, 8) ?? '尚无提交'}
          </span>
        </span>
      )}
      <div class="header-actions">
        <ToolButton
          icon="general/search"
          label="命令面板 · Ctrl+K"
          disabled={busy}
          onClick={onOpenCommandPalette}
        >
          <span>命令</span>
        </ToolButton>
        <ToolButton
          icon="nodes/folder"
          label="打开工作区文件夹"
          disabled={busy}
          onClick={onOpenWorkspace}
        >
          <span>工作区</span>
        </ToolButton>
        <ActionMenu label="仓库工具" text="仓库" disabled={!root || busy}>
          <div class="menu-caption">分支、储藏与远程</div>
          <button onClick={onOpenRemotes}>管理远程仓库</button>
          <button onClick={() => onOpenManager('branches')}>分支、标签与 Stash</button>
          <button onClick={() => onOpenManager('stashes')}>储藏管理</button>
          <button onClick={() => onOpenManager('shelves')}>Shelf 管理</button>
          <button onClick={onOpenWorktrees}>Worktree 管理</button>
          <button onClick={onOpenIgnore}>忽略规则管理</button>
          <hr />
          <div class="menu-caption">历史与代码检视</div>
          <button onClick={onOpenInteractive}>交互式 Rebase</button>
          <button onClick={onOpenFileHistory}>文件历史与 Blame</button>
          <button onClick={onOpenRevisionTree}>浏览提交时刻仓库文件树</button>
          <button onClick={onOpenLocalHistory}>Local History</button>
          <hr />
          <div class="menu-caption">多仓库与诊断工具</div>
          <button onClick={onOpenMultiRepo}>批量远程同步与跨仓库记录</button>
          <button onClick={onOpenDiagnostics}>Git 诊断</button>
          <button onClick={onOpenBisect}>Bisect</button>
          <button onClick={onOpenSubmodules}>Submodule 管理</button>
        </ActionMenu>
        <ToolButton
          icon="general/add"
          label="克隆仓库"
          disabled={busy}
          onClick={onOpenClone}
        >
          <span>克隆</span>
        </ToolButton>
        <ToolButton
          icon="vcs/update"
          label="签出标签或提交 SHA"
          disabled={!root || busy}
          onClick={onOpenRevisionInput}
        />
        <ToolButton
          icon="toolwindows/vcs"
          label="操作恢复与 Reflog"
          disabled={!root || busy}
          onClick={onOpenRecovery}
        >
          <span>Reflog</span>
        </ToolButton>
        <ToolButton
          icon="toolwindows/vcs"
          label="托管平台 · GitHub / GitLab"
          active={showHosting}
          onClick={onToggleHosting}
        >
          <span>托管平台</span>
        </ToolButton>
        {(['fetch', 'pull', 'push'] as const).map((action) => (
          <ToolButton
            icon={action === 'fetch' ? 'vcs/fetch' : action === 'pull' ? 'vcs/update' : 'vcs/push'}
            label={
              action === 'fetch'
                ? 'Fetch'
                : action === 'pull'
                  ? 'Pull · 更新项目 (Ctrl+T)'
                  : 'Push'
            }
            disabled={!root || busy}
            key={action}
            onClick={() => onOpenTransfer(action)}
          >
            <span>{action === 'fetch' ? 'Fetch' : action === 'pull' ? 'Pull' : 'Push'}</span>
          </ToolButton>
        ))}
        <span class="toolbar-separator" />
        <ToolButton
          icon="general/refresh"
          label="刷新 · F5"
          disabled={!root || busy}
          onClick={onRefresh}
        />
        <ToolButton
          icon="general/open"
          label="打开仓库 · Ctrl+O"
          disabled={busy}
          onClick={onChooseRepository}
        />
        <ToolButton
          icon="general/settings"
          label="设置中心 · Ctrl+,"
          active={showSettings}
          onClick={onOpenSettings}
        />
      </div>
    </header>
  );
}

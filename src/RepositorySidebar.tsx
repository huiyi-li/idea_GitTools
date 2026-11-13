import { useState } from 'preact/hooks';
import type { Branch, Status } from './api';
import { ActionMenu, Icon, ToolButton } from './ui/controls';

export type BranchAction = 'compare' | 'merge' | 'merge-ff-only' | 'merge-no-ff' | 'merge-squash' | 'rebase';

export function RepositorySidebar({
  status,
  branch,
  busy,
  recent,
  onFilter,
  onCheckout,
  onCreate,
  onFetch,
  onStash,
  onApplyStash,
  onManageStash,
  onOpen,
  onAction,
  onManage,
  onEdit,
}: {
  status: Status;
  branch: string;
  busy: boolean;
  recent: string[];
  onFilter: (branch: string) => void;
  onCheckout: (branch: string) => void;
  onCreate: (branch?: Branch) => void;
  onFetch: () => void;
  onStash: () => void;
  onApplyStash: (stash: Status['stashes'][number], pop?: boolean) => void;
  onManageStash: (stash?: Status['stashes'][number]) => void;
  onOpen: (path: string) => void;
  onAction: (branch: Branch, action: BranchAction) => void;
  onManage: () => void;
  onEdit: (branch: Branch, action: 'rename' | 'delete') => void;
}) {
  const [search, setSearch] = useState('');
  const [context, setContext] = useState<{ branch: string; point: { x: number; y: number } }>();
  const [stashContext, setStashContext] = useState<{ reference: string; point: { x: number; y: number } }>();
  const branches = status.branches.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  const historyDisabled =
    !status.repository.head ||
    !status.repository.branch ||
    status.repository.operation !== 'none' ||
    !!status.changes.length;
  const mergeDisabled = !status.repository.head || !status.repository.branch || status.repository.operation !== 'none' || status.changes.some(change => change.conflict);
  return (
    <aside class="sidebar">
      <div class="panel-heading">
        <span>分支</span>
        <span class="spacer" />
        <button disabled={busy} onClick={onManage}>管理</button>
        <ToolButton icon="general/add" label="新建并切换分支" disabled={busy} onClick={() => onCreate()} />
      </div>
      <div class="branches-panel">
        <div class="branch-tools">
          <ToolButton icon="vcs/fetch" label="Fetch" disabled={busy} onClick={onFetch} />
          <ToolButton icon="general/locate" label="筛选当前分支" onClick={() => onFilter('HEAD')} />
        </div>
        <div class="branches-body">
          <div class="branch-search">
            <label class="search-field">
              <Icon name="general/search" />
              <input
                aria-label="搜索分支"
                placeholder="搜索分支"
                value={search}
                onInput={(event) => setSearch(event.currentTarget.value)}
              />
            </label>
          </div>
          <div class="sidebar-scroll">
            <button class={`branch-item ${!branch ? 'active' : ''}`} onClick={() => onFilter('')}>
              <Icon name="toolwindows/vcs" />
              <span>所有分支</span>
            </button>
            <button
              class={`branch-item ${branch === 'HEAD' ? 'active' : ''}`}
              onClick={() => onFilter('HEAD')}
            >
              <Icon name="dvcs/branchLabel" />
              <span>HEAD</span>
              <span class="tree-hint">当前分支</span>
            </button>
            {[false, true].map((remote) => (
              <details class="tree-group" open key={String(remote)}>
                <summary>
                  <Icon name="general/chevronRight" class="tree-chevron" />
                  <Icon name="nodes/folder" />
                  {remote ? '远程' : '本地'}
                  <span class="tree-hint">{branches.filter((item) => item.remote === remote).length}</span>
                </summary>
                {branches
                  .filter((item) => item.remote === remote)
                  .map((item) => (
                    <div class={`branch-line ${item.current ? 'current-branch' : ''}`} key={item.full}
                      onContextMenu={event => { event.preventDefault(); if (!busy) setContext({ branch: item.full, point: { x: event.clientX, y: event.clientY } }); }}>
                      <button
                        class={`branch-item ${branch === item.full ? 'active' : ''}`}
                        title={`${item.name}${item.upstream ? ` → ${item.upstream}` : ''}\n单击筛选日志，双击签出`}
                        onClick={() => onFilter(item.full)}
                        onKeyDown={event => {
                          if ((event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') && !busy) {
                            event.preventDefault();
                            const bounds = event.currentTarget.getBoundingClientRect();
                            setContext({ branch: item.full, point: { x: bounds.left + 20, y: bounds.bottom } });
                          }
                        }}
                        onDblClick={() => {
                          if (!busy && !item.current) onCheckout(item.full);
                        }}
                      >
                        <Icon name={item.current ? 'general/greenCheckmark' : 'dvcs/branchLabel'} />
                        <span class="ellipsis">{item.name}</span>
                        {!item.remote && (item.ahead > 0 || item.behind > 0) && (
                          <span class="branch-tracking" title={`${item.upstream} · 领先 ${item.ahead}，落后 ${item.behind}`}>
                            {item.ahead > 0 && <span class="branch-ahead">↑{item.ahead}</span>}
                            {item.behind > 0 && <span class="branch-behind">↓{item.behind}</span>}
                          </span>
                        )}
                      </button>
                      <div class="branch-actions">
                        <ActionMenu label={`分支操作 ${item.name}`} disabled={busy} contextPoint={context?.branch === item.full ? context.point : undefined}>
                          <div class="menu-caption">{item.name} · {item.hash.slice(0, 8)}</div>
                          <button disabled={item.current} onClick={() => onCheckout(item.full)}>
                            签出 {item.name}
                          </button>
                          {item.remote && <button onClick={() => onCheckout(item.full)}>签出并创建本地跟踪分支…</button>}
                          <button disabled={!status.repository.head || status.repository.operation !== 'none'} onClick={() => onCreate(item)}>从此分支新建并签出…</button>
                          <button
                            disabled={!status.repository.head}
                            onClick={() => onAction(item, 'compare')}
                          >
                            与当前分支比较
                          </button>
                          <hr />
                          <button
                            disabled={item.current || mergeDisabled}
                            title={status.changes.length ? 'Git 将检查是否会覆盖本地更改' : ''}
                            onClick={() => onAction(item, 'merge')}
                          >
                            Merge 到当前分支…
                          </button>
                          <button disabled={item.current || mergeDisabled} onClick={() => onAction(item, 'merge-ff-only')}>仅快进合并到 {status.repository.branch}…</button>
                          <button disabled={item.current || mergeDisabled} onClick={() => onAction(item, 'merge-no-ff')}>创建合并提交到 {status.repository.branch}…</button>
                          <button disabled={item.current || mergeDisabled} onClick={() => onAction(item, 'merge-squash')}>Squash 合并到 {status.repository.branch}…</button>
                          <button
                            disabled={item.current || historyDisabled}
                            title={status.changes.length ? '先提交或保存到 Stash' : ''}
                            onClick={() => onAction(item, 'rebase')}
                          >
                            Rebase 当前分支到此处…
                          </button>
                          <hr />
                          {!item.remote && <button disabled={status.repository.operation !== 'none'} onClick={() => onEdit(item, 'rename')}>重命名分支…</button>}
                          <button disabled={item.current || status.repository.operation !== 'none'} onClick={() => onEdit(item, 'delete')}>{item.remote ? '删除远程分支…' : '删除本地分支…'}</button>
                        </ActionMenu>
                      </div>
                    </div>
                  ))}
              </details>
            ))}
            {!branches.length && search && <div class="sidebar-hint">没有匹配的分支</div>}
            <div class="panel-heading sidebar-section">
              <Icon name="vcsimpl/stash" />
              <span>Stash</span>
              <span class="tree-hint">{status.stashes.length}</span>
              <span class="spacer" />
              <button disabled={busy} onClick={() => onManageStash()}>管理储藏</button>
              <ToolButton
                icon="general/add"
                label="保存工作区到 Stash"
                disabled={
                  busy ||
                  !status.changes.length ||
                  !status.repository.head ||
                  status.changes.some((change) => change.conflict)
                }
                onClick={onStash}
              />
            </div>
            {status.stashes.map((stash) => (
              <div class="stash-item" key={`${stash.reference}-${stash.hash}-${stash.message}`}
                onContextMenu={event => { event.preventDefault(); if (!busy) setStashContext({ reference: stash.reference, point: { x: event.clientX, y: event.clientY } }); }}>
                <Icon name="vcsimpl/stash" />
                <button class="ellipsis" title={`${stash.reference} · ${stash.message}`} disabled={busy} onClick={() => onManageStash(stash)}>{stash.reference} · {stash.message}</button>
                <ToolButton
                  icon="vcs/update"
                  label={`应用并保留 ${stash.message}`}
                  disabled={busy}
                  onClick={() => onApplyStash(stash)}
                />
                <ActionMenu label={`储藏操作 ${stash.reference}`} disabled={busy} contextPoint={stashContext?.reference === stash.reference ? stashContext.point : undefined}>
                  <div class="menu-caption">{stash.reference} · {stash.message}</div>
                  <button onClick={() => onApplyStash(stash, true)}>弹出储藏</button>
                  <button onClick={() => onApplyStash(stash)}>应用并保留储藏</button>
                  <button onClick={() => onManageStash(stash)}>取消储藏／恢复到新分支…</button>
                  <button onClick={() => onManageStash(stash)}>显示储藏差异／与本地比较…</button>
                  <hr />
                  <button onClick={() => onManageStash(stash)}>删除／清空储藏…</button>
                </ActionMenu>
              </div>
            ))}
            {!status.stashes.length && <div class="sidebar-hint">暂无 Stash</div>}
            {!!recent.length && (
              <details class="tree-group recent-repositories">
                <summary>
                  <Icon name="general/chevronRight" class="tree-chevron" />
                  最近仓库
                </summary>
                {recent.map((path) => (
                  <button
                    class="branch-item"
                    key={path}
                    title={path}
                    disabled={busy}
                    onClick={() => onOpen(path)}
                  >
                    <Icon name="nodes/folder" />
                    <span class="ellipsis">{path.split(/[\\/]/).pop()}</span>
                  </button>
                ))}
              </details>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

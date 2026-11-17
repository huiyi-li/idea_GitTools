import { useEffect, useRef, useState } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-dialog';
import { call, readSaved } from './api';
import { Modal, ToolButton } from './ui/controls';

export interface WorkspaceRepository { root: string; name: string; relativePath: string }
export interface WorkspaceRepositories { root: string; repositories: WorkspaceRepository[]; truncated: boolean; warnings: string[] }

export function RepositoryWorkspaceDialog({ initialPath = '', currentRoot, onClose, onOpen }: {
  initialPath?: string;
  currentRoot: string;
  onClose: () => void;
  onOpen: (workspace: WorkspaceRepositories, repository: WorkspaceRepository, depth: number) => Promise<boolean>;
}) {
  const savedPath = readSaved<unknown>('workspace.lastFolder', '');
  const savedDepth = readSaved<unknown>('workspace.scanDepth', 4);
  const [path, setPath] = useState(initialPath || (typeof savedPath === 'string' ? savedPath : ''));
  const [depth, setDepth] = useState(typeof savedDepth === 'number' && Number.isInteger(savedDepth) && savedDepth >= 0 && savedDepth <= 8 ? savedDepth : 4);
  const [result, setResult] = useState<WorkspaceRepositories>();
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const gate = useRef(false);
  const requestId = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; requestId.current++; }; }, []);

  async function scan(folder = path) {
    if (gate.current || !folder.trim()) return;
    const request = ++requestId.current;
    gate.current = true; setLoading(true); setResult(undefined); setError('');
    try {
      const next = await call<WorkspaceRepositories>('discover_workspace', { path: folder.trim(), maxDepth: depth });
      if (active.current && request === requestId.current) setResult(next);
    } catch (error) { if (active.current && request === requestId.current) setError(String(error)); }
    finally { gate.current = false; if (active.current && request === requestId.current) setLoading(false); }
  }
  async function browse() {
    if (gate.current) return;
    gate.current = true; setLoading(true); setError('');
    try {
      const folder = await open({ directory: true, multiple: false, title: '选择包含多个 Git 仓库的工作区文件夹' });
      if (!active.current || typeof folder !== 'string') return;
      setPath(folder); gate.current = false;
      await scan(folder);
    } catch (error) { if (active.current) setError(String(error)); }
    finally { gate.current = false; if (active.current) setLoading(false); }
  }
  async function choose(repository: WorkspaceRepository) {
    if (!result || gate.current) return;
    gate.current = true; setOpening(true); setError('');
    try {
      const success = await onOpen(result, repository, depth);
      if (success) onClose();
      else if (active.current) setError('无法打开所选仓库。请检查路径并重新扫描，不会改为打开父仓库。');
    } catch (error) { if (active.current) setError(String(error)); }
    finally { gate.current = false; if (active.current) setOpening(false); }
  }
  const busy = loading || opening;
  return <Modal title="工作区仓库" class="utility-dialog repository-workspace-dialog" busy={opening} onClose={onClose}>
    <header class="utility-heading"><div><h2>工作区仓库</h2><p class="muted">发现文件夹中的独立仓库，选择一个仓库进行管理。</p></div><ToolButton icon="general/close" label="关闭工作区仓库" disabled={opening} onClick={onClose} /></header>
    <form class="transport-form workspace-scan-form" onSubmit={event => { event.preventDefault(); void scan(); }}>
      <label>工作区文件夹<input aria-label="工作区文件夹" value={path} disabled={busy} placeholder="例如 C:/projects" onInput={event => { setPath(event.currentTarget.value); setResult(undefined); }} /></label>
      <div class="workspace-scan-options"><label>扫描层级<select aria-label="工作区扫描层级" value={depth} disabled={busy} onChange={event => { setDepth(Number(event.currentTarget.value)); setResult(undefined); }}>{Array.from({ length: 9 }, (_, value) => <option key={value} value={value}>{value === 0 ? '仅当前目录' : `向下 ${value} 层`}</option>)}</select></label>
        <button type="button" disabled={busy} onClick={() => void browse()}>选择文件夹…</button><button type="submit" class="primary" disabled={busy || !path.trim()}>扫描仓库</button>
      </div>
    </form>
    <p class="muted">提交、暂存、Diff 和提交草稿按仓库隔离。扫描不会暂存、提交或修改任何仓库；不会跟随目录链接。</p>
    {loading && <p role="status">正在扫描工作区…</p>}
    {opening && <p role="status">正在打开所选仓库…</p>}
    {error && <p class="error-text" role="alert">{error}</p>}
    {result && <>
      <p class="utility-root mono selectable">{result.root}</p>
      <p>发现 {result.repositories.length} 个仓库，请明确选择一个。{result.truncated && '扫描未覆盖全部目录，请提高层级或选择更小的文件夹。'}</p>
      {!!result.warnings.length && <details class="utility-details"><summary>扫描提示 ({result.warnings.length})</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      {!result.repositories.length && <p class="utility-state">没有发现 Git 仓库。可调整扫描层级，或直接选择仓库根目录。</p>}
      <div class="workspace-repository-list" aria-label="发现的仓库">{result.repositories.map(repository => <button type="button" class="workspace-repository-item" key={repository.root} disabled={busy} aria-label={`管理仓库 ${repository.relativePath}`} onClick={() => void choose(repository)}>
        <span><strong>{repository.relativePath === '.' ? repository.name : repository.relativePath}</strong><small class="mono">{repository.root}</small></span><span>{repository.root === currentRoot ? '当前仓库' : '单独管理 →'}</span>
      </button>)}</div>
    </>}
    <footer class="modal-actions utility-actions"><button disabled={opening} onClick={onClose}>关闭</button></footer>
  </Modal>;
}

export function WorkspaceRepositoryBar({ workspace, root, busy, onSelect, onManage, onClose }: {
  workspace: WorkspaceRepositories;
  root: string;
  busy: boolean;
  onSelect: (root: string) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  return <section class="workspace-repository-bar" aria-label="工作区仓库切换">
    <span class="workspace-folder ellipsis" title={workspace.root}>工作区：{workspace.root}</span>
    <label>当前仓库<select aria-label="选择工作区仓库" value={root} disabled={busy} onChange={event => onSelect(event.currentTarget.value)}>
      {workspace.repositories.map(repository => <option key={repository.root} value={repository.root}>{repository.relativePath === '.' ? `${repository.name}（根仓库）` : repository.relativePath}</option>)}
    </select></label>
    <span class="muted">{workspace.repositories.length} 个独立仓库{workspace.truncated ? ' · 扫描未完整' : ''}</span>
    <button disabled={busy} onClick={onManage}>重新扫描…</button><button disabled={busy} onClick={onClose}>关闭工作区列表</button>
  </section>;
}

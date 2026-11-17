import { type Diagnostics } from './api';
import { Modal, ToolButton } from './ui/controls';
import { useRepositoryRead } from './ui/useRepositoryRead';

export function DiagnosticsDialog({ root, onClose }: { root: string; onClose: () => void }) {
  const { data: diagnostics, loading, error, reload } = useRepositoryRead<Diagnostics>('git_diagnostics', root);
  return (
    <Modal title="Git 诊断" onClose={onClose} class="utility-dialog diagnostics-dialog">
      <header class="utility-heading">
        <div><h2>Git 诊断</h2><p class="muted">只读检查本机 Git 和仓库状态，不发送代码或凭据。</p></div>
        <ToolButton icon="general/close" label="关闭 Git 诊断" onClick={onClose} />
      </header>
      <p class="utility-root mono selectable" title={root}>{root}</p>
      {loading && <p class="utility-state" role="status">正在读取诊断信息…</p>}
      {error && <p class="error-text utility-state" role="alert">读取诊断失败。{error}</p>}
      {diagnostics && <dl class="diagnostics-grid">
        <dt>Git 版本</dt><dd class="mono selectable">{diagnostics.gitVersion}</dd>
        <dt>仓库路径</dt><dd class="mono selectable">{diagnostics.root}</dd>
        <dt>Git 目录</dt><dd class="mono selectable">{diagnostics.gitDir}</dd>
        <dt>分支</dt><dd>{diagnostics.branch ?? (diagnostics.head ? 'Detached HEAD（游离）' : '尚无分支')}</dd>
        <dt>HEAD</dt><dd class="mono selectable">{diagnostics.head ?? '尚无提交'}</dd>
        <dt>当前操作</dt><dd>{diagnostics.operation === 'none' ? '无' : diagnostics.operation}</dd>
        <dt>文件变化</dt><dd>{diagnostics.changedFiles}（暂存 {diagnostics.stagedFiles}，未暂存 {diagnostics.unstagedFiles}）</dd>
        <dt>Remote</dt><dd>{diagnostics.remoteNames.length ? diagnostics.remoteNames.join('、') : '无'}</dd>
        <dt>Worktree</dt><dd>{diagnostics.worktreeCount}</dd>
        <dt>core.autocrlf</dt><dd>{diagnostics.autocrlf}</dd>
        <dt>commit.gpgsign</dt><dd>{diagnostics.commitGpgsign}</dd>
        <dt>Git LFS</dt><dd>{diagnostics.lfsAvailable ? `可用，${diagnostics.lfsFiles} 个文件` : '不可用'}</dd>
      </dl>}
      <footer class="modal-actions utility-actions">
        <button aria-label="重新读取 Git 诊断" disabled={loading} onClick={() => void reload()}>重新读取</button><span class="spacer" />
        <button type="button" onClick={onClose}>关闭</button>
      </footer>
    </Modal>
  );
}

export function diagnosticsSummary(value: Diagnostics): string {
  return [value.gitVersion, value.branch ?? 'detached', value.operation, `${value.changedFiles} files`].join(' · ');
}

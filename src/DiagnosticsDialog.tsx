import { useEffect, useState } from 'preact/hooks';
import { call, type Diagnostics } from './api';
import { Modal, ToolButton } from './ui/controls';

export function DiagnosticsDialog({ root, onClose }: { root: string; onClose: () => void }) {
  const [diagnostics, setDiagnostics] = useState<Diagnostics>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setDiagnostics(await call<Diagnostics>('git_diagnostics', { root }));
    } catch (error) {
      setError(String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [root]);

  const value = (item: string | number | null | undefined) =>
    item === null || item === undefined || item === '' ? '未设置' : String(item);

  return (
    <Modal title="Git 诊断" onClose={onClose} class="history-dialog diagnostics-dialog">
      <div class="panel-heading">
        <h2>Git 诊断</h2>
        <span class="spacer" />
        <ToolButton icon="general/refresh" label="重新读取 Git 诊断" disabled={loading} onClick={() => void load()} />
      </div>
      {loading && <p role="status">正在读取诊断信息…</p>}
      {error && <p class="error-text" role="alert">{error}</p>}
      {diagnostics && (
        <div class="diagnostics-grid">
          <strong>Git 版本</strong><span class="mono selectable">{diagnostics.gitVersion}</span>
          <strong>仓库路径</strong><span class="mono selectable">{diagnostics.root}</span>
          <strong>Git 目录</strong><span class="mono selectable">{diagnostics.gitDir}</span>
          <strong>分支</strong><span>{value(diagnostics.branch)}</span>
          <strong>HEAD</strong><span class="mono selectable">{value(diagnostics.head)}</span>
          <strong>当前操作</strong><span>{diagnostics.operation === 'none' ? '无' : diagnostics.operation}</span>
          <strong>文件变化</strong><span>{diagnostics.changedFiles}（暂存 {diagnostics.stagedFiles}，未暂存 {diagnostics.unstagedFiles}）</span>
          <strong>Remote</strong><span>{diagnostics.remoteNames.length ? diagnostics.remoteNames.join('、') : '无'}</span>
          <strong>Worktree</strong><span>{diagnostics.worktreeCount}</span>
          <strong>core.autocrlf</strong><span>{diagnostics.autocrlf}</span>
          <strong>commit.gpgsign</strong><span>{diagnostics.commitGpgsign}</span>
        </div>
      )}
      <div class="modal-actions">
        <button type="button" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}

export function diagnosticsSummary(value: Diagnostics): string {
  return [value.gitVersion, value.branch ?? 'detached', value.operation, `${value.changedFiles} files`].join(' · ');
}

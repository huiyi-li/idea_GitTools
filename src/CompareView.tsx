import { useEffect, useState } from 'preact/hooks';
import { call, type BranchComparison } from './api';
import { DiffView } from './DiffView';
import { FileIcon, Icon, Modal, Split, ToolButton } from './ui/controls';

export function CompareView({
  root,
  branch,
  onClose,
}: {
  root: string;
  branch: string;
  onClose: () => void;
}) {
  const [comparison, setComparison] = useState<BranchComparison | null>(null);
  const [path, setPath] = useState('');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    setComparison(null);
    void call<BranchComparison>('compare_branch', { root, branch })
      .then((value) => {
        if (current) setComparison(value);
      })
      .catch((error) => {
        if (current) setError(String(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [root, branch, version]);
  const selected = comparison?.changes.find((change) => change.path === path) ?? comparison?.changes[0];
  return (
    <Modal title="比较分支" class="comparison-dialog" onClose={onClose}>
      <header class="compare-header">
        <Icon name="vcs/diff" />
        <h2>比较分支</h2>
        <span class="spacer" />
        <ToolButton
          icon="general/refresh"
          label="重新比较分支"
          disabled={loading}
          onClick={() => setVersion(version + 1)}
        />
        <ToolButton icon="general/close" label="关闭分支比较" onClick={onClose} />
      </header>
      {comparison && (
        <div class="comparison-summary">
          <span>
            {comparison.baseName}
            <small>独有 {comparison.baseOnly} 个提交</small>
          </span>
          <span class="muted">↔</span>
          <span>
            {comparison.targetName}
            <small>独有 {comparison.targetOnly} 个提交</small>
          </span>
          <span class="spacer" />
          <span class="muted">{comparison.changes.length} 个变更文件</span>
        </div>
      )}
      {error ? (
        <div class="empty error-text" role="alert">
          {error}
        </div>
      ) : loading ? (
        <div class="empty">正在比较分支…</div>
      ) : (
        comparison && (
          <Split storageKey="compare-files" initial={270} min={180} label="调整比较文件栏宽度">
            <div class="comparison-files" role="listbox" aria-label="分支变更文件">
              {comparison.changes.map((change) => (
                <button
                  key={change.path}
                  class={'comparison-file ' + (selected?.path === change.path ? 'selected' : '')}
                  role="option"
                  aria-selected={selected?.path === change.path}
                  title={change.oldPath ? change.oldPath + ' → ' + change.path : change.path}
                  onClick={() => setPath(change.path)}
                >
                  <span class="file-status">{change.index}</span>
                  <FileIcon path={change.path} />
                  <span class="ellipsis">{change.path}</span>
                </button>
              ))}
              {!comparison.changes.length && <div class="empty">两个分支的文件内容相同</div>}
            </div>
            <DiffView
              root={root}
              target={
                selected
                  ? {
                      path: selected.path,
                      oldPath: selected.oldPath,
                      revision: comparison.target,
                      beforeRevision: comparison.base,
                    }
                  : null
              }
              version={version}
              labels={[comparison.baseName, comparison.targetName]}
            />
          </Split>
        )
      )}
    </Modal>
  );
}

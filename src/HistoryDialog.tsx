import { useState } from 'preact/hooks';
import type { HistoryRequest } from './api';
import { Modal } from './ui/controls';

export const historyLabels = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
};

export interface OperationPreview {
  request: HistoryRequest;
  label: string;
  parents: string[];
}

export function HistoryDialog({
  preview,
  onClose,
  onRun,
}: {
  preview: OperationPreview;
  onClose: () => void;
  onRun: (request: HistoryRequest) => void;
}) {
  const [request, setRequest] = useState(preview.request);
  const title = historyLabels[request.action];
  const commitAction = request.action === 'cherry-pick' || request.action === 'revert';
  return (
    <Modal title={title} onClose={onClose} class="history-dialog">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onRun(request);
        }}
      >
        <h2>{title}</h2>
        <div class="operation-summary">
          <span class="muted">当前分支</span>
          <span>
            {request.expectedBranch}
            <small class="mono">{request.expectedHead.slice(0, 8)}</small>
          </span>
          <span class="muted">{commitAction ? '选中提交' : '目标分支'}</span>
          <span>
            {preview.label}
            <small class="mono">{request.targetHash.slice(0, 8)}</small>
          </span>
        </div>
        <p class="muted">
          {request.action === 'merge'
            ? '将目标分支合入当前分支。'
            : request.action === 'rebase'
              ? '在目标分支上重放当前分支的提交，重放后的提交 ID 会改变。'
              : request.action === 'cherry-pick'
                ? '将选中提交的修改应用到当前分支，并生成一个提交。'
                : '生成一个提交，反向应用选中提交的修改。原提交仍保留在历史中。'}
        </p>
        {request.action === 'merge' && (
          <label>
            合并方式
            <select
              aria-label="合并方式"
              value={request.mergeMode}
              onChange={(event) =>
                setRequest({
                  ...request,
                  mergeMode: event.currentTarget.value as HistoryRequest['mergeMode'],
                })
              }
            >
              <option value="auto">自动 · 能快进时快进</option>
              <option value="no-ff">始终创建合并提交 · --no-ff</option>
              <option value="ff-only">仅快进 · --ff-only</option>
            </select>
          </label>
        )}
        {commitAction && preview.parents.length > 1 && (
          <label>
            合并提交的主线父节点
            <select
              aria-label="主线父提交"
              value={request.mainline === null ? '' : String(request.mainline)}
              required
              onChange={(event) =>
                setRequest({
                  ...request,
                  mainline: event.currentTarget.value ? Number(event.currentTarget.value) : null,
                })
              }
            >
              <option value="">选择作为比较基准的父提交</option>
              {preview.parents.map((parent, index) => (
                <option value={index + 1} key={parent}>
                  父节点 {index + 1} · {parent.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div class="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            class="primary"
            type="submit"
            disabled={commitAction && preview.parents.length > 1 && request.mainline === null}
          >
            执行 {title}
          </button>
        </div>
      </form>
    </Modal>
  );
}

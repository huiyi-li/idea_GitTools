import { Modal } from './ui/controls';

export type DiscardMode = 'unstaged' | 'all';
export interface DiscardPreview {
  root: string;
  mode: DiscardMode;
  paths: string[];
  files: { path: string; delete: boolean }[];
  fingerprint: string;
}

export function DiscardDialog({
  preview,
  busy,
  error,
  onClose,
  onConfirm,
  onReload,
}: {
  preview: DiscardPreview;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
  onReload: () => void;
}) {
  const title = preview.mode === 'unstaged' ? '放弃未暂存更改' : '放弃文件全部更改';
  return (
    <Modal title={title} busy={busy} onClose={onClose} class="history-dialog">
      <h2>{title}</h2>
      <p>
        {preview.mode === 'unstaged'
          ? '选中文件将恢复为暂存区版本，新建的未跟踪文件将被删除。'
          : '选中文件的暂存区和工作区将恢复为 HEAD 版本，HEAD 中不存在的文件将被删除。'}
      </p>
      <ul class="navigation-files">
        {preview.files.map((file) => (
          <li class="mono" key={file.path}>
            {file.delete ? '删除' : '恢复'} · {file.path}
          </li>
        ))}
      </ul>
      {error && (
        <div class="error-text" role="alert">
          <p>{error}</p>
          <button disabled={busy} onClick={onReload}>重新获取预览</button>
        </div>
      )}
      <div class="modal-actions">
        <button disabled={busy} onClick={onClose}>取消</button>
        <button class="navigation-danger" disabled={busy || !!error} onClick={onConfirm}>
          {busy ? '处理中…' : '确认放弃更改'}
        </button>
      </div>
    </Modal>
  );
}

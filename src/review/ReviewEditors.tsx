import { useEffect, useRef, useState } from 'preact/hooks';
import { Split, ToolButton } from '../ui/controls';
import { useMinimapPreference } from '../ui/editor-preferences';
import { ReviewController } from './controller';
import {
  snapshotMessage,
  type CommitReview,
  type Pane,
  type ReviewDiffs,
  type Scope,
} from './types';

export function ReviewEditors({
  document,
  diffs,
  onSaveCurrent,
}: {
  document: CommitReview;
  diffs: ReviewDiffs;
  onSaveCurrent?: (content: string) => Promise<boolean>;
}) {
  const before = useRef<HTMLDivElement>(null);
  const after = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLDivElement>(null);
  const controller = useRef<ReviewController>();
  const [scope, setScope] = useState<Scope>('commit');
  const [sync, setSync] = useState(true);
  const [minimap, setMinimap] = useMinimapPreference();
  const [index, setIndex] = useState(-1);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const baseTextRef = useRef(document.current.file.text.replace(/\r\n/g, '\n'));
  baseTextRef.current = document.current.file.text.replace(/\r\n/g, '\n');
  const draftRef = useRef(baseTextRef.current);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const savingRef = useRef(false);
  savingRef.current = saving;
  const onSaveRef = useRef(onSaveCurrent);
  onSaveRef.current = onSaveCurrent;
  const canEditCurrent = document.current.file.state === 'text' && !!onSaveCurrent;
  const preferences = useRef({ scope, sync, minimap });
  preferences.current = { scope, sync, minimap };

  async function saveCurrentEdit() {
    if (!onSaveRef.current || !dirtyRef.current || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const ok = await onSaveRef.current(draftRef.current);
      if (ok) {
        dirtyRef.current = false;
        setDirty(false);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function revertCurrentEdit() {
    if (savingRef.current) return;
    controller.current?.resetCurrentText();
  }

  useEffect(() => {
    if (!before.current || !after.current || !current.current) return;
    const view = new ReviewController(
      { before: before.current, after: after.current, current: current.current },
      document,
      diffs,
      preferences.current.scope,
      preferences.current.minimap,
      setIndex,
      (text) => {
        draftRef.current = text;
        const nextDirty = text !== baseTextRef.current;
        dirtyRef.current = nextDirty;
        setDirty(nextDirty);
      },
      () => void saveCurrentEdit(),
    );
    view.setSync(preferences.current.sync);
    view.setCurrentEditable(editing && canEditCurrent);
    controller.current = view;
    return () => {
      view.destroy();
      controller.current = undefined;
    };
  }, [document.before, document.after]);

  useEffect(() => {
    const normalized = document.current.file.text.replace(/\r\n/g, '\n');
    draftRef.current = normalized;
    dirtyRef.current = false;
    setDirty(false);
    if (!canEditCurrent && editing) setEditing(false);
    controller.current?.updateCurrent(document.current.file, diffs);
    controller.current?.setCurrentEditable(editing && canEditCurrent);
  }, [document.current.file, diffs, canEditCurrent]);

  useEffect(() => {
    controller.current?.setCurrentEditable(editing && canEditCurrent);
  }, [editing, canEditCurrent]);
  useEffect(() => {
    controller.current?.setScope(scope);
  }, [scope]);
  useEffect(() => {
    controller.current?.setSync(sync);
  }, [sync]);
  useEffect(() => {
    controller.current?.setMinimap(minimap);
  }, [minimap]);

  const count = diffs[scope]?.changes.length ?? 0;
  const large = !!(document.before.large || document.after.large || document.current.file.large);
  const snapshots = {
    before: document.before,
    after: document.after,
    current: document.current.file,
  };
  const titles = { before: '修改前', after: '修改后', current: '当前工作区' };
  const renderPane = (pane: Pane) => (
    <section class={'review-code-pane review-' + pane} aria-label={titles[pane]}>
      <header>
        <strong>
          {titles[pane]} ·{' '}
          {pane === 'current' && editing && canEditCurrent
            ? dirty
              ? '未保存'
              : '可编辑'
            : '只读'}
        </strong>
        <small class="mono">
          {pane === 'before'
            ? document.parent
              ? '第一父提交 · ' + document.parent.slice(0, 8)
              : '首次提交前'
            : pane === 'after'
              ? document.revision.slice(0, 8)
              : document.current.branch + ' · 磁盘快照'}
        </small>
        <span class="mono ellipsis" title={snapshots[pane].path}>
          {snapshots[pane].path}
        </span>
      </header>
      {snapshots[pane].state !== 'text' && (
        <div class="review-snapshot-note">
          {snapshots[pane].reason || snapshotMessage[snapshots[pane].state]}
        </div>
      )}
      {snapshots[pane].state === 'text' && !snapshots[pane].text && (
        <div class="review-snapshot-note">空文件</div>
      )}
      <div class="review-editor-host" ref={{ before, after, current }[pane]} />
    </section>
  );
  return (
    <section class="review-editors-section">
      <div class="review-toolbar">
        <label>
          比较范围{' '}
          <select
            aria-label="三栏比较范围"
            value={scope}
            onChange={(event) => setScope(event.currentTarget.value as Scope)}
          >
            <option value="commit">本次提交 · 修改前 ↔ 修改后</option>
            <option value="current">后续变化 · 修改后 ↔ 当前工作区</option>
          </select>
        </label>
        <ToolButton
          icon="general/up"
          label="上一处变化"
          disabled={!count}
          onClick={() => controller.current?.navigate(-1)}
        />
        <ToolButton
          icon="general/down"
          label="下一处变化"
          disabled={!count}
          onClick={() => controller.current?.navigate(1)}
        />
        <span class="muted" role="status">
          {count
            ? `${index + 1} / ${count} 处变化`
            : diffs[scope]
              ? '文本内容相同'
              : '此范围包含无法按文本比较的文件'}
        </span>
        <span class="spacer" />
        {(large || diffs[scope]?.simplified) && (
          <span class="muted">
            {diffs[scope]?.simplified ? '差异计算超时，当前显示整块变化' : '大文件模式 · 行级比较'}
          </span>
        )}
        <label>
          <input
            type="checkbox"
            checked={sync}
            onChange={(event) => setSync(event.currentTarget.checked)}
          />
          同步滚动
        </label>
        <label>
          <input
            type="checkbox"
            checked={minimap && !large}
            disabled={large}
            onChange={(event) => setMinimap(event.currentTarget.checked)}
          />
          代码缩略图
        </label>
        {canEditCurrent && (
          <div class="diff-edit-tools">
            <label title="直接在右侧当前工作区栏微调代码并按 Ctrl+S 保存">
              <input
                type="checkbox"
                checked={editing}
                disabled={saving}
                onChange={(event) => {
                  const next = event.currentTarget.checked;
                  setEditing(next);
                  if (next) setScope('current');
                }}
              />
              轻量编辑工作区
            </label>
            {editing && (
              <>
                <button
                  type="button"
                  class="diff-save-btn"
                  disabled={!dirty || saving}
                  title="保存当前工作区修改 · Ctrl+S"
                  onClick={() => void saveCurrentEdit()}
                >
                  {saving ? '保存中…' : '保存修改'}
                </button>
                <button
                  type="button"
                  class="diff-revert-btn"
                  disabled={!dirty || saving}
                  title="放弃当前工作区栏中未保存的修改"
                  onClick={revertCurrentEdit}
                >
                  还原修改
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div class="review-three-panes">
        <Split storageKey="review-before" initial={330} min={150} label="调整修改前栏宽度">
          {renderPane('before')}
          <Split
            storageKey="review-current"
            initial={330}
            min={150}
            second
            label="调整当前工作区栏宽度"
          >
            {renderPane('after')}
            {renderPane('current')}
          </Split>
        </Split>
      </div>
    </section>
  );
}

import { forwardRef } from 'preact/compat';
import { useEffect, useImperativeHandle, useRef, useState } from 'preact/hooks';
import { DEFAULT_MERGE_SETTINGS, type MergeProgress } from '../shared/mergeProtocol';
import { MergeController } from './controller';
import { MergeAnalysis } from './analysis-client';
import type { MergeDocument } from './protocol';
import { ActionMenu, Icon, ToolButton } from '../ui/controls';
import './merge.css';
import { useMinimapPreference } from '../ui/editor-preferences';

export interface MergeEditorHandle {
  progress: () => MergeProgress;
  lock: (locked: boolean) => void;
}

export const MergeEditor = forwardRef<
  MergeEditorHandle,
  {
    document: MergeDocument;
    busy: boolean;
    onChange: () => void;
    onStats: (remaining: number) => void;
  }
>(({ document: data, busy, onChange, onStats }, ref) => {
  const left = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const firstDivider = useRef<SVGSVGElement>(null);
  const secondDivider = useRef<SVGSVGElement>(null);
  const controller = useRef<MergeController>();
  const callbacks = useRef({ onChange, onStats });
  callbacks.current = { onChange, onStats };
  const [stats, setStats] = useState({ changes: 0, conflicts: 0 });
  const [sync, setSync] = useState(true);
  const [minimap, setMinimap] = useMinimapPreference();
  const minimapEnabled = useRef(minimap);
  minimapEnabled.current = minimap;
  useEffect(() => {
    controller.current?.setMinimap(minimap);
  }, [minimap]);
  const [collapse, setCollapse] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(busy);
  locked.current = busy;
  const unavailable = busy || !ready;

  useImperativeHandle(
    ref,
    () => ({
      progress() {
        const value = controller.current;
        if (!value) throw new Error('正在计算合并内容，请稍候');
        return {
          lines: value.resultLines(),
          states: value.states.map((state) => ({ ...state })),
          contentModified: value.contentModified,
        };
      },
      lock(nextLocked) {
        locked.current = nextLocked;
        controller.current?.setLocked(nextLocked);
      },
    }),
    [],
  );

  useEffect(() => {
    let current = true;
    let analysis: MergeAnalysis | undefined;
    let value: MergeController | undefined;
    let unsubscribe: (() => unknown) | undefined;
    setReady(false);
    setError('');
    callbacks.current.onStats(Number.POSITIVE_INFINITY);
    void (async () => {
      try {
        analysis = new MergeAnalysis();
        const prepared = await analysis.prepare(data);
        if (!current) return;
        value = new MergeController(
          {
            path: data.path,
            fileName: data.path.split('/').pop()!,
            base: data.base,
            left: data.left,
            right: data.right,
            titles: {
              left: [{ text: data.leftTitle }],
              result: [{ text: '合并结果' }],
              right: [{ text: data.rightTitle }],
            },
            settings: { ...DEFAULT_MERGE_SETTINGS },
            contextLines: 4,
            iterative: true,
            progress: prepared.progress,
          },
          { ...DEFAULT_MERGE_SETTINGS },
          document.body.classList.contains('ij-dark'),
          {
            analysis,
            onError: (message) => {
              if (current) setError(message);
            },
          },
        );
        controller.current = value;
        value.mount(
          { left: left.current!, result: result.current!, right: right.current! },
          [firstDivider.current!, secondDivider.current!],
          prepared.progress,
          prepared.changes,
        );
        value.setLocked(locked.current);
        value.setMinimap(minimapEnabled.current);
        const update = () => {
          const stats = value!.stats;
          setStats(stats);
          callbacks.current.onStats(stats.changes + stats.conflicts);
        };
        update();
        unsubscribe = value.onChange(() => {
          update();
          callbacks.current.onChange();
        });
        setReady(true);
      } catch (error) {
        if (current) setError(String(error));
      }
    })();
    return () => {
      current = false;
      unsubscribe?.();
      value?.destroy();
      analysis?.close();
      controller.current = undefined;
    };
  }, [data.id]);

  const action = (run: (value: MergeController) => void) => {
    if (!unavailable && controller.current) run(controller.current);
  };
  useEffect(() => {
    controller.current?.setLocked(busy);
  }, [busy, data.id]);
  return (
    <div class="merge-editor mg-root">
      {error && (
        <div class="message error-message" role="alert">
          {error}
        </div>
      )}
      <div class="merge-tools mg-toolbar">
        <ToolButton
          icon="general/up"
          label="上一个冲突 · Shift+F7"
          disabled={unavailable || stats.conflicts + stats.changes === 0}
          onClick={() => action((c) => c.navigate(-1))}
        />
        <ToolButton
          icon="general/down"
          label="下一个冲突 · F7"
          disabled={unavailable || stats.conflicts + stats.changes === 0}
          onClick={() => action((c) => c.navigate(1))}
        />
        <span class="toolbar-separator" />
        <ToolButton
          icon="general/undo"
          label="撤销"
          disabled={unavailable}
          onClick={() => action((c) => c.undo())}
        />
        <ToolButton
          icon="general/redo"
          label="重做"
          disabled={unavailable}
          onClick={() => action((c) => c.redo())}
        />
        <span class="toolbar-separator" />
        <span class="merge-toolbar-label">应用非冲突修改</span>
        {(['left', 'base', 'right'] as const).map((side) => (
          <button
            class="mg-text-action"
            key={side}
            title={
              side === 'left'
                ? '应用左侧的非冲突修改'
                : side === 'right'
                  ? '应用右侧的非冲突修改'
                  : '应用全部非冲突修改'
            }
            disabled={unavailable || !controller.current?.hasNonConflicting(side)}
            onClick={() => action((c) => c.applyNonConflicting(side))}
          >
            <Icon
              name={
                side === 'left'
                  ? 'diff/applyNotConflictsLeft'
                  : side === 'right'
                    ? 'diff/applyNotConflictsRight'
                    : 'diff/applyNotConflicts'
              }
            />
            {side === 'left' ? '左侧' : side === 'right' ? '右侧' : '全部'}
          </button>
        ))}
        <ToolButton
          icon="diff/magicResolveToolbar"
          label="自动解决简单冲突"
          disabled={unavailable || !controller.current?.hasResolvable()}
          onClick={() => action((c) => c.resolveSimpleConflicts())}
        />
        <span class="toolbar-separator" />
        <ActionMenu icon="vcs/merge" label="处理选中块" text="选中块" disabled={unavailable}>
          <div class="menu-caption">对结果栏中选中的块执行</div>
          <button onClick={() => action((c) => c.applySelected('result', 'left', true))}>用左侧解决</button>
          <button onClick={() => action((c) => c.applySelected('result', 'right', true))}>用右侧解决</button>
          <button onClick={() => action((c) => c.acceptBothSelected('left'))}>保留双方 · 先左后右</button>
          <button onClick={() => action((c) => c.acceptBothSelected('right'))}>保留双方 · 先右后左</button>
          <hr />
          <button onClick={() => action((c) => c.ignoreSelected())}>确认手动解决的块</button>
          <button onClick={() => action((c) => c.markAllResolved())}>确认全部手动修改</button>
        </ActionMenu>
        <span class="spacer" />
        <span class={'merge-stat ' + (stats.conflicts + stats.changes === 0 ? 'done' : '')}>
          {!ready ? (
            '正在计算差异…'
          ) : stats.conflicts + stats.changes === 0 ? (
            <>
              <Icon name="general/greenCheckmark" />
              全部修改已处理
            </>
          ) : (
            stats.conflicts + ' 个冲突 · ' + stats.changes + ' 处修改'
          )}
        </span>
        <ActionMenu icon="general/settings" label="合并视图设置" disabled={unavailable}>
          <label>
            <input
              type="checkbox"
              checked={sync}
              onChange={(event) => {
                setSync(event.currentTarget.checked);
                action((c) => {
                  c.settings.syncScroll = event.currentTarget.checked;
                });
              }}
            />
            同步滚动
          </label>
          <label title="同时应用于文件 diff 和三栏合并，自动保存设置">
            <input
              type="checkbox"
              checked={minimap}
              onChange={(event) => setMinimap(event.currentTarget.checked)}
            />
            代码缩略图
          </label>
          <label>
            <input
              type="checkbox"
              checked={collapse}
              onChange={(event) => {
                setCollapse(event.currentTarget.checked);
                action((c) => c.setCollapse(event.currentTarget.checked));
              }}
            />
            折叠相同内容
          </label>
        </ActionMenu>
      </div>
      <div class="mg-titles">
        <div class="mg-title" title={data.leftTitle}>
          <span class="merge-side-label">左侧</span>
          <span class="ellipsis">{data.leftTitle}</span>
        </div>
        <div class="mg-title-gap" />
        <div class="mg-title merge-result-title">
          <strong>合并结果</strong>
          <span class="merge-side-label">可编辑</span>
        </div>
        <div class="mg-title-gap" />
        <div class="mg-title" title={data.rightTitle}>
          <span class="merge-side-label">右侧</span>
          <span class="ellipsis">{data.rightTitle}</span>
        </div>
      </div>
      <div class="mg-panes">
        {!ready && (
          <div class="merge-preparing empty" role="status">
            {error ? '请重新打开文件重试' : '正在计算差异…'}
          </div>
        )}
        <div class="mg-pane mg-left">
          <div class="mg-host" ref={left} />
        </div>
        <svg class="mg-divider" ref={firstDivider} />
        <div class="mg-pane mg-result">
          <div class="mg-host" ref={result} />
        </div>
        <svg class="mg-divider" ref={secondDivider} />
        <div class="mg-pane mg-right">
          <div class="mg-host" ref={right} />
        </div>
      </div>
    </div>
  );
});

import { useMemo } from 'preact/hooks';
import { GraphLayout, graphColor, visualizeRow } from './git/graph';
import type { GraphRow } from './shared/types';
import type { Commit } from './api';

const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

function Graph({
  row,
  width,
  head,
  onJump,
}: {
  row: GraphRow;
  width: number;
  head: boolean;
  onJump?: (hash: string) => void;
}) {
  const x = (lane: number) => 12 + lane * 12;
  const y = (position: number) => position * 13;
  const cx = x(row.lane);
  const nodeColor = graphColor(row.color, 0.55, 0.85);
  return (
    <svg width={width} height="26" class="commit-graph" aria-hidden="true">
      {row.edges.map((edge, i) => {
        const x1 = x(edge.fromLane);
        const y1 = y(edge.fromY);
        const x2 = x(edge.toLane);
        const y2 = y(edge.toY);
        const color = graphColor(edge.color, 0.55, 0.85);
        return (
          <g
            key={i}
            class={edge.jump ? 'graph-jump-edge' : undefined}
            onClick={
              edge.jump && onJump
                ? (event) => {
                    event.stopPropagation();
                    onJump(edge.jump!);
                  }
                : undefined
            }
          >
            <path
              d={`M ${x1} ${y1} L ${x2} ${y2}`}
              stroke={color}
              fill="none"
              stroke-width="1.6"
              stroke-dasharray={edge.dashed ? '2,2' : undefined}
            />
            {edge.arrow === 'down' && (
              <polygon points={`${x2 - 3},${y2 - 4} ${x2 + 3},${y2 - 4} ${x2},${y2 + 1}`} fill={color} />
            )}
            {edge.arrow === 'up' && (
              <polygon points={`${x1 - 3},${y1 + 4} ${x1 + 3},${y1 + 4} ${x1},${y1 - 1}`} fill={color} />
            )}
          </g>
        );
      })}
      {head ? (
        <>
          <circle cx={cx} cy="13" r="4.5" fill="var(--bg)" stroke={nodeColor} stroke-width="2" />
          <circle cx={cx} cy="13" r="1.8" fill={nodeColor} />
        </>
      ) : (
        <circle cx={cx} cy="13" r="3.5" fill={nodeColor} />
      )}
    </svg>
  );
}

export function LogTable({
  commits,
  selected,
  onSelect,
  onContextMenu,
}: {
  commits: Commit[];
  selected: string | null;
  onSelect: (commit: Commit) => void;
  onContextMenu?: (commit: Commit, x: number, y: number) => void;
}) {
  const rows = useMemo(() => {
    const graph = new GraphLayout();
    const raw = commits.map((commit) => graph.add(commit.hash, commit.parents));
    return raw.map((row, index) => visualizeRow(row, index, graph.segments, false));
  }, [commits]);
  const width = Math.min(160, Math.max(32, ...rows.map((row) => row.width * 12 + 20)));
  const selectIndex = (targetIndex: number) => {
    const commit = commits[Math.max(0, Math.min(commits.length - 1, targetIndex))];
    if (commit) onSelect(commit);
  };
  const selectOffset = (offset: number) => {
    const index = commits.findIndex((c) => c.hash === selected);
    selectIndex((index < 0 ? 0 : index) + offset);
  };
  return (
    <div
      class="log-table"
      role="listbox"
      aria-label="提交历史"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          selectOffset(event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'PageDown' || event.key === 'PageUp') {
          event.preventDefault();
          selectOffset(event.key === 'PageDown' ? 15 : -15);
        } else if (event.key === 'Home') {
          event.preventDefault();
          selectIndex(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          selectIndex(commits.length - 1);
        } else if (event.key === 'ArrowRight') {
          const current = commits.find((c) => c.hash === selected);
          const parentHash = current?.parents[0];
          const parent = parentHash ? commits.find((c) => c.hash === parentHash) : undefined;
          if (parent) {
            event.preventDefault();
            onSelect(parent);
          }
        } else if (event.key === 'ArrowLeft') {
          const child = selected ? commits.find((c) => c.parents.includes(selected)) : undefined;
          if (child) {
            event.preventDefault();
            onSelect(child);
          }
        }
      }}
    >
      <div class="log-columns">
        <span>提交</span>
        <span>作者</span>
        <span>时间</span>
        <span>Hash</span>
      </div>
      {commits.map((commit, i) => {
        const isHead = commit.refs.some((ref) => ref === 'HEAD' || ref.startsWith('HEAD -> '));
        return (
          <div
            key={commit.hash}
            role="option"
            aria-selected={selected === commit.hash}
            class={`commit-row ${selected === commit.hash ? 'selected' : ''} ${commit.parents.length > 1 ? 'merge-commit' : ''}`}
            onClick={() => onSelect(commit)}
            onContextMenu={(event) => { if (onContextMenu) { event.preventDefault(); onContextMenu(commit, event.clientX, event.clientY); } }}
          >
            <div class="commit-subject">
              <Graph
                row={rows[i]}
                width={width}
                head={isHead}
                onJump={(hash) => {
                  const target = commits.find((c) => c.hash === hash);
                  if (target) onSelect(target);
                }}
              />
              <div class="ellipsis">
                {commit.refs.map((ref) => {
                  const isRemote = ref.includes('refs/remotes/');
                  const isTag = ref.startsWith('tag: ');
                  const isHeadRef = ref === 'HEAD' || ref.startsWith('HEAD -> ');
                  return (
                    <span
                      class={`ref-label ${isRemote ? 'remote' : ''} ${isTag ? 'tag' : ''} ${isHeadRef ? 'head' : ''}`}
                      key={ref}
                    >
                      {ref
                        .replace('HEAD -> ', '')
                        .replace(/^refs\/(heads|remotes|tags)\//, '')
                        .replace('tag: refs/tags/', '')
                        .replace('tag: ', '')}
                    </span>
                  );
                })}
                <span title={`${commit.subject}\n${commit.hash}`}>{commit.subject}</span>
              </div>
            </div>
            <span class="ellipsis muted" title={`${commit.author} <${commit.email}>`}>
              {commit.author}
            </span>
            <span class="muted">{date.format(commit.time * 1000)}</span>
            <span class="mono muted commit-short-hash">{commit.hash.slice(0, 8)}</span>
          </div>
        );
      })}
      {!commits.length && <div class="empty">没有匹配的提交</div>}
    </div>
  );
}

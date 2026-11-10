import { useMemo } from 'preact/hooks';
import { GraphLayout, graphColor } from './git/graph';
import type { GraphRow } from './shared/types';
import type { Commit } from './api';

const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

function Graph({ row, width }: { row: GraphRow; width: number }) {
  const x = (lane: number) => 12 + lane * 12;
  const y = (position: number) => position * 15;
  return (
    <svg width={width} height="30" class="commit-graph" aria-hidden="true">
      {row.edges.map((edge, i) => (
        <path
          key={i}
          d={`M ${x(edge.fromLane)} ${y(edge.fromY)} L ${x(edge.toLane)} ${y(edge.toY)}`}
          stroke={graphColor(edge.color, 0.55, 0.85)}
          fill="none"
          stroke-width="1.6"
        />
      ))}
      <circle cx={x(row.lane)} cy="15" r="3.8" fill={graphColor(row.color, 0.55, 0.85)} />
    </svg>
  );
}

export function LogTable({
  commits,
  selected,
  onSelect,
}: {
  commits: Commit[];
  selected: string | null;
  onSelect: (commit: Commit) => void;
}) {
  const rows = useMemo(() => {
    const graph = new GraphLayout();
    return commits.map((commit) => graph.add(commit.hash, commit.parents));
  }, [commits]);
  const width = Math.min(140, Math.max(32, ...rows.map((row) => row.width * 12 + 20)));
  const selectOffset = (offset: number) => {
    const index = commits.findIndex((c) => c.hash === selected);
    const commit = commits[Math.max(0, Math.min(commits.length - 1, index + offset))];
    if (commit) onSelect(commit);
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
        }
      }}
    >
      <div class="log-columns">
        <span>提交</span>
        <span>作者</span>
        <span>时间</span>
      </div>
      {commits.map((commit, i) => (
        <div
          key={commit.hash}
          role="option"
          aria-selected={selected === commit.hash}
          class={`commit-row ${selected === commit.hash ? 'selected' : ''}`}
          onClick={() => onSelect(commit)}
        >
          <div class="commit-subject">
            <Graph row={rows[i]} width={width} />
            <div class="ellipsis">
              {commit.refs.map((ref) => (
                <span class={`ref-label ${ref.includes('refs/remotes/') ? 'remote' : ''}`} key={ref}>
                  {ref
                    .replace('HEAD -> ', '')
                    .replace(/^refs\/(heads|remotes|tags)\//, '')
                    .replace('tag: refs/tags/', '')}
                </span>
              ))}
              <span title={`${commit.subject}\n${commit.hash}`}>{commit.subject}</span>
            </div>
          </div>
          <span class="ellipsis muted" title={`${commit.author} <${commit.email}>`}>
            {commit.author}
          </span>
          <span class="muted">{date.format(commit.time * 1000)}</span>
        </div>
      ))}
      {!commits.length && <div class="empty">没有匹配的提交</div>}
    </div>
  );
}

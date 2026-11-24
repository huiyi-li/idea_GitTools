import { useEffect, useRef, useState } from 'preact/hooks';
import { call, type Commit, type DiffTarget } from './api';
import { Modal } from './ui/controls';
import { DiffView } from './DiffView';

interface HistoryEntry {
  commit: Commit;
  path: string;
  oldPath: string | null;
}
interface History {
  revision: string;
  entries: HistoryEntry[];
  hasMore: boolean;
}
interface Blame {
  lines: {
    hash: string;
    originalLine: number;
    line: number;
    author: string;
    time: number;
    summary: string;
    path: string;
    text: string;
  }[];
  hasMore: boolean;
}

interface RevisionTreeEntry {
  path: string;
  mode: string;
  objectHash: string;
  size: number;
}
interface RevisionTree {
  revision: string;
  entries: RevisionTreeEntry[];
  truncated: boolean;
}

export function FileHistoryDialog({
  root,
  initialPath,
  initialRevision,
  initialTab = 'history',
  initialSelection,
  onClose,
}: {
  root: string;
  initialPath: string;
  initialRevision?: string | null;
  initialTab?: 'history' | 'blame' | 'selection' | 'tree';
  initialSelection?: { startLine: number; endLine: number };
  onClose: () => void;
}) {
  const [input, setInput] = useState(initialPath);
  const [path, setPath] = useState(initialPath);
  const [revision, setRevision] = useState(initialRevision ?? null);
  const [treeRevisionInput, setTreeRevisionInput] = useState(initialRevision ?? 'HEAD');
  const [tab, setTab] = useState<'history' | 'blame' | 'selection' | 'tree'>(initialTab);
  const [startLine, setStartLine] = useState(initialSelection?.startLine ?? 1);
  const [endLine, setEndLine] = useState(initialSelection?.endLine ?? 20);
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<History>();
  const [selectionHistory, setSelectionHistory] = useState<History>();
  const [revisionTree, setRevisionTree] = useState<RevisionTree>();
  const [treeFilter, setTreeFilter] = useState('');
  const [blame, setBlame] = useState<Blame>();
  const [target, setTarget] = useState<DiffTarget | null>(null);
  const [before, setBefore] = useState<HistoryEntry>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const anchor = useRef<{ key: string; revision: string }>();
  useEffect(() => {
    if (tab !== 'tree' && !path) return;
    let current = true;
    setBusy(true);
    setError('');
    const key = JSON.stringify([root, path, revision]);
    const pinned = offset > 0 && anchor.current?.key === key ? anchor.current.revision : revision;
    const request =
      tab === 'history'
        ? call<History>('file_history', {
            root,
            path,
            revision: pinned,
            offset,
          }).then((value) => {
            if (current) {
              setHistory(value);
              anchor.current = { key, revision: value.revision };
            }
          })
        : tab === 'blame'
          ? call<Blame>('file_blame', { root, path, revision, offset }).then((value) => {
              if (current) setBlame(value);
            })
          : tab === 'selection'
            ? call<History>('selection_history', {
                root,
                path,
                startLine,
                endLine,
                revision,
              }).then((value) => {
                if (current) setSelectionHistory(value);
              })
            : call<RevisionTree>('revision_tree', {
                root,
                revision: treeRevisionInput || revision || 'HEAD',
              }).then((value) => {
                if (current) setRevisionTree(value);
              });
    void request
      .catch((error) => {
        if (current) setError(String(error));
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [root, path, revision, tab, offset, startLine, endLine, treeRevisionInput]);
  function show(entry: HistoryEntry) {
    setTarget({
      path: entry.path,
      oldPath: entry.oldPath,
      revision: entry.commit.hash,
    });
  }
  const pageSize = tab === 'history' ? 100 : 200;
  const activeHistory = tab === 'selection' ? selectionHistory : history;
  const filteredTreeEntries =
    revisionTree?.entries.filter((item) =>
      item.path.toLowerCase().includes(treeFilter.trim().toLowerCase()),
    ) ?? [];
  return (
    <Modal title="文件历史与 Blame" onClose={onClose} class="history-dialog workflow-dialog">
      <h2>文件历史、选区演变与提交文件树</h2>
      {tab !== 'tree' ? (
        <form
          class="modal-actions"
          onSubmit={(event) => {
            event.preventDefault();
            setPath(input);
            setOffset(0);
            setTarget(null);
            setBefore(undefined);
          }}
        >
          <input
            aria-label="历史文件路径"
            required
            value={input}
            onInput={(event) => setInput(event.currentTarget.value)}
            placeholder="仓库相对路径"
          />
          {tab === 'selection' && (
            <>
              <label>
                起始行
                <input
                  type="number"
                  aria-label="选区起始行"
                  min={1}
                  value={startLine}
                  onInput={(event) =>
                    setStartLine(Math.max(1, Number(event.currentTarget.value) || 1))
                  }
                />
              </label>
              <label>
                结束行
                <input
                  type="number"
                  aria-label="选区结束行"
                  min={startLine}
                  value={endLine}
                  onInput={(event) =>
                    setEndLine(Math.max(startLine, Number(event.currentTarget.value) || startLine))
                  }
                />
              </label>
            </>
          )}
          <button>读取文件</button>
          <button
            type="button"
            onClick={() => {
              setRevision(null);
              setOffset(0);
            }}
          >
            查看当前工作区
          </button>
        </form>
      ) : (
        <div class="modal-actions">
          <label>
            提交 Revision
            <input
              aria-label="文件树提交 Revision"
              value={treeRevisionInput}
              onInput={(event) => setTreeRevisionInput(event.currentTarget.value)}
              placeholder="HEAD、分支名或提交 SHA"
            />
          </label>
          <label>
            过滤文件路径
            <input
              aria-label="过滤提交文件树"
              value={treeFilter}
              onInput={(event) => setTreeFilter(event.currentTarget.value)}
              placeholder="输入文件名或目录筛选…"
            />
          </label>
        </div>
      )}
      <div class="modal-actions modal-tab-bar">
        <div class="ui-segmented" role="tablist" aria-label="文件历史视图">
          <button
            type="button"
            class="ui-segmented-option"
            aria-pressed={tab === 'history'}
            aria-checked={tab === 'history'}
            onClick={() => {
              setTab('history');
              setOffset(0);
            }}
          >
            文件历史
          </button>
          <button
            type="button"
            class="ui-segmented-option"
            aria-pressed={tab === 'blame'}
            aria-checked={tab === 'blame'}
            onClick={() => {
              setTab('blame');
              setOffset(0);
            }}
          >
            Blame
          </button>
          <button
            type="button"
            class="ui-segmented-option"
            aria-pressed={tab === 'selection'}
            aria-checked={tab === 'selection'}
            onClick={() => {
              setTab('selection');
              setOffset(0);
            }}
          >
            代码选区历史 (git log -L)
          </button>
          <button
            type="button"
            class="ui-segmented-option"
            aria-pressed={tab === 'tree'}
            aria-checked={tab === 'tree'}
            onClick={() => {
              setTab('tree');
              setOffset(0);
            }}
          >
            浏览提交文件树
          </button>
        </div>
        {(tab === 'history' || tab === 'blame') && (
          <>
            <button
              disabled={busy || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - pageSize))}
            >
              上一页
            </button>
            <button
              disabled={busy || !(tab === 'history' ? history?.hasMore : blame?.hasMore)}
              onClick={() => setOffset(offset + pageSize)}
            >
              下一页
            </button>
            <span>{busy ? '读取中…' : `第 ${Math.floor(offset / pageSize) + 1} 页`}</span>
          </>
        )}
      </div>
      {error && (
        <p class="error-text" role="alert">
          {error}
        </p>
      )}
      {(tab === 'history' || tab === 'selection') && (
        <div class="hunk-list">
          {before && (
            <p>
              比较起点 · {before.commit.hash.slice(0, 8)} · {before.path}
            </p>
          )}
          {!busy && activeHistory?.entries.length === 0 && <p>此路径或行范围没有提交历史。</p>}
          {activeHistory?.entries.map((entry) => (
            <section class="hunk-item" key={entry.commit.hash}>
              <div>
                <code>{entry.commit.hash.slice(0, 8)}</code> {entry.commit.subject} ·{' '}
                {entry.commit.author}
              </div>
              <small>{entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}</small>
              <div class="modal-actions">
                <button onClick={() => show(entry)}>查看此次更改</button>
                <button onClick={() => setBefore(entry)}>设为比较起点</button>
                <button
                  disabled={!before}
                  onClick={() =>
                    setTarget({
                      path: entry.path,
                      oldPath: before!.path,
                      revision: entry.commit.hash,
                      beforeRevision: before!.commit.hash,
                    })
                  }
                >
                  与起点比较
                </button>
              </div>
            </section>
          ))}
        </div>
      )}
      {tab === 'blame' && (
        <div class="hunk-list">
          <table class="blame-table">
            <tbody>
              {blame?.lines.map((line) => (
                <tr key={line.line}>
                  <td>
                    <button
                      disabled={/^0+$/.test(line.hash)}
                      title={`${line.author} · ${line.summary}`}
                      onClick={() => {
                        setTarget({
                          path: line.path,
                          oldPath: null,
                          revision: line.hash,
                        });
                      }}
                    >
                      {/^0+$/.test(line.hash) ? '未提交' : line.hash.slice(0, 8)}
                    </button>
                  </td>
                  <td>{line.author}</td>
                  <td>{line.line}</td>
                  <td>
                    <pre>{line.text}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'tree' && (
        <div class="hunk-list" aria-label="提交文件树列表">
          <p class="muted">
            提交 <code>{revisionTree?.revision.slice(0, 12) ?? treeRevisionInput}</code> 共{' '}
            {filteredTreeEntries.length} 个匹配文件
            {revisionTree?.truncated ? '（已截断前 10,000 个文件）' : ''}
          </p>
          {filteredTreeEntries.slice(0, 300).map((item) => (
            <section class="hunk-item" key={item.path}>
              <div>
                <strong>{item.path}</strong>{' '}
                <small class="muted">
                  ({item.size} B · {item.objectHash.slice(0, 8)})
                </small>
              </div>
              <div class="modal-actions">
                <button
                  onClick={() =>
                    setTarget({
                      path: item.path,
                      oldPath: null,
                      revision: revisionTree?.revision ?? treeRevisionInput,
                      beforeRevision: revisionTree?.revision ?? treeRevisionInput,
                    })
                  }
                >
                  预览该版本内容
                </button>
                <button
                  onClick={() => {
                    setInput(item.path);
                    setPath(item.path);
                    setRevision(revisionTree?.revision ?? null);
                    setTab('history');
                  }}
                >
                  查看此文件历史
                </button>
              </div>
            </section>
          ))}
        </div>
      )}
      {target && (
        <div style={{ height: 350 }}>
          <DiffView root={root} version={0} target={target} />
        </div>
      )}
      <div class="modal-actions">
        <button onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}

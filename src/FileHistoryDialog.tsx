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

export function FileHistoryDialog({
  root,
  initialPath,
  initialRevision,
  onClose,
}: {
  root: string;
  initialPath: string;
  initialRevision?: string | null;
  onClose: () => void;
}) {
  const [input, setInput] = useState(initialPath);
  const [path, setPath] = useState(initialPath);
  const [revision, setRevision] = useState(initialRevision ?? null);
  const [tab, setTab] = useState<'history' | 'blame'>('history');
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<History>();
  const [blame, setBlame] = useState<Blame>();
  const [target, setTarget] = useState<DiffTarget | null>(null);
  const [before, setBefore] = useState<HistoryEntry>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const anchor = useRef<{ key: string; revision: string }>();
  useEffect(() => {
    if (!path) return;
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
        : call<Blame>('file_blame', { root, path, revision, offset }).then((value) => {
            if (current) setBlame(value);
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
  }, [root, path, revision, tab, offset]);
  function show(entry: HistoryEntry) {
    setTarget({
      path: entry.path,
      oldPath: entry.oldPath,
      revision: entry.commit.hash,
    });
  }
  const pageSize = tab === 'history' ? 100 : 200;
  return (
    <Modal title="文件历史与 Blame" onClose={onClose} class="history-dialog workflow-dialog">
      <h2>文件历史与 Blame</h2>
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
      <div class="modal-actions">
        <button
          aria-pressed={tab === 'history'}
          onClick={() => {
            setTab('history');
            setOffset(0);
          }}
        >
          文件历史
        </button>
        <button
          aria-pressed={tab === 'blame'}
          onClick={() => {
            setTab('blame');
            setOffset(0);
          }}
        >
          Blame
        </button>
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
      </div>
      {error && (
        <p class="error-text" role="alert">
          {error}
        </p>
      )}
      {tab === 'history' && (
        <div class="hunk-list">
          {before && (
            <p>
              比较起点 · {before.commit.hash.slice(0, 8)} · {before.path}
            </p>
          )}
          {!busy && history?.entries.length === 0 && <p>此路径没有提交历史。</p>}
          {history?.entries.map((entry) => (
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

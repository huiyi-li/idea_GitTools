import { useEffect, useRef, useState } from 'preact/hooks';
import { call } from './api';
import { Modal } from './ui/controls';

interface IgnoreState {
  path: string;
  content: string;
  fingerprint: string;
  fileStamp: string;
  matches: { source: string; line: number; pattern: string; negated: boolean }[];
  trackedCount: number;
  trackedPaths: string[];
  directory: boolean;
}
interface FilePage { paths: string[]; total: number; hasMore: boolean }
type PatternKind = 'path' | 'parent' | 'extension' | 'custom';

export function ignorePattern(path: string, kind: PatternKind, directory = false): string {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const escape = (value: string) => value.replace(/[\\*?\[\]#! ]/g, '\\$&');
  if (!clean || clean.includes('\n') || clean.includes('\r')) return '';
  if (kind === 'extension') {
    const name = clean.split('/').pop()!;
    const dot = name.lastIndexOf('.');
    return dot > 0 && dot < name.length - 1 ? `*.${escape(name.slice(dot + 1))}` : '';
  }
  if (kind === 'parent') {
    const slash = clean.lastIndexOf('/');
    return slash > 0 ? `/${escape(clean.slice(0, slash))}/` : '';
  }
  return `/${escape(clean)}${directory ? '/' : ''}`;
}

export function IgnoreDialog({ root, initialPath, onClose, onChanged }: {
  root: string;
  initialPath: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [path, setPath] = useState(initialPath);
  const [data, setData] = useState<IgnoreState>();
  const [patternKind, setPatternKind] = useState<PatternKind>('path');
  const [pattern, setPattern] = useState('');
  const [kind, setKind] = useState<'ignored' | 'tracked'>('ignored');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<FilePage>();
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<{ preview: IgnoreState; content: string }>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reads = useRef(0);
  async function load(path: string) {
    const id = ++reads.current;
    setLoading(true);
    setData(undefined);
    setConfirm(false);
    try {
      const next = await call<IgnoreState>('read_ignore', { root, path: path.replace(/\\/g, '/') });
      if (reads.current !== id) return;
      setData(next);
      setPath(next.path);
      setPatternKind(next.path ? 'path' : 'custom');
      setPattern(ignorePattern(next.path, 'path', next.directory));
    } catch (error) { if (reads.current === id) throw error; }
    finally { if (reads.current === id) setLoading(false); }
  }
  useEffect(() => {
    void load(initialPath).catch(error => setError(String(error)));
    return () => { reads.current++; };
  }, [root, initialPath]);
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(queryInput); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [queryInput]);
  useEffect(() => {
    let current = true;
    setPage(undefined);
    void call<FilePage>('ignore_files', { root, kind, query, offset })
      .then(page => { if (current) setPage(page); })
      .catch(error => { if (current) setError(String(error)); });
    return () => { current = false; };
  }, [root, kind, query, offset, version]);
  async function apply(action: 'append' | 'replace' | 'untrack', preview = data, value = pattern) {
    if (!preview || busy || loading) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await call('edit_ignore', { root, preview, action, value });
      if (action === 'replace') setEditor(undefined);
      setNotice(action === 'untrack' ? `已停止跟踪 ${preview.trackedCount} 个文件` : '已保存 .gitignore');
    } catch (error) { setError(String(error)); }
    finally {
      await load(preview.path).catch(error => setError(String(error)));
      setVersion(version => version + 1);
      await onChanged().catch(error => setError(String(error)));
      setBusy(false);
    }
  }
  const disabled = busy || loading || !data;
  return <Modal title="忽略规则管理" busy={busy || loading} onClose={onClose} class="workflow-dialog">
    <h2>忽略规则管理</h2>
    <form class="ignore-path-form" onSubmit={event => {
      event.preventDefault(); setError(''); void load(path).catch(error => setError(String(error)));
    }}>
      <label>仓库相对路径<input aria-label="检查忽略路径" value={path} disabled={busy || loading} placeholder="例如 build/app.exe" onInput={event => setPath(event.currentTarget.value)} /></label>
      <button disabled={busy || loading}>检查路径</button>
    </form>
    {data && <>
      {data.path && <section class="ignore-reason">
        <p>当前路径 · {data.path}{data.trackedCount ? ` · 已跟踪 ${data.trackedCount} 个文件` : ' · 未跟踪'}</p>
        {data.matches.map(match => <p key={`${match.source}-${match.line}`}>
          {match.negated ? '重新包含规则' : '忽略规则'} · <code>{match.pattern}</code> · {match.source} 第 {match.line} 行
        </p>)}
        {!data.matches.length && <p class="muted">没有匹配的忽略规则</p>}
      </section>}
      <div class="ignore-pattern-form">
        <label>规则范围<select aria-label="忽略规则范围" disabled={disabled} value={patternKind} onChange={event => {
          const kind = event.currentTarget.value as PatternKind;
          setPatternKind(kind);
          if (kind !== 'custom') setPattern(ignorePattern(data.path, kind, data.directory));
        }}>
          <option value="path" disabled={!data.path}>此文件／目录</option>
          <option value="parent" disabled={!ignorePattern(data.path, 'parent')}>父目录</option>
          <option value="extension" disabled={data.directory || !ignorePattern(data.path, 'extension')}>同扩展名文件</option>
          <option value="custom">自定义规则</option>
        </select></label>
        <label>写入根 .gitignore 的规则<input aria-label="忽略规则" value={pattern} disabled={disabled} maxLength={4096} onInput={event => { setPattern(event.currentTarget.value); setPatternKind('custom'); }} /></label>
        <button disabled={disabled || !pattern.trim()} onClick={() => void apply('append')}>添加忽略规则</button>
      </div>
      {!!data.trackedCount && <div class="ignore-untrack">
        <button disabled={disabled} onClick={() => setConfirm(true)}>停止跟踪并保留文件…</button>
        {confirm && <div class="confirmation" aria-label="确认停止跟踪">
          <p>将从暂存区移除 {data.trackedCount} 个文件，提交后生效。磁盘文件会保留。</p>
          <ul>{data.trackedPaths.map(path => <li key={path}>{path}</li>)}</ul>
          {data.trackedCount > data.trackedPaths.length && <p>另有 {data.trackedCount - data.trackedPaths.length} 个文件</p>}
          <button disabled={disabled} onClick={() => void apply('untrack', data, '')}>确认停止跟踪</button>
          <button disabled={busy} onClick={() => setConfirm(false)}>取消</button>
        </div>}
      </div>}
      <details class="ignore-rules">
        <summary>根 .gitignore</summary>
        <pre>{data.content || '（尚无规则）'}</pre>
        <button disabled={disabled} onClick={() => setEditor({ preview: data, content: data.content })}>编辑根忽略规则…</button>
      </details>
    </>}
    {editor && <div class="ignore-rules-editor">
      <label>根 .gitignore 内容<textarea aria-label="根忽略规则内容" value={editor.content} disabled={busy} rows={8}
        onInput={event => setEditor({ ...editor, content: event.currentTarget.value })} /></label>
      <button disabled={disabled || editor.content === editor.preview.content} onClick={() => void apply('replace', editor.preview, editor.content)}>保存根忽略规则</button>
      <button disabled={busy} onClick={() => setEditor(undefined)}>取消编辑</button>
    </div>}
    <section class="ignore-file-browser">
      <div class="filter-actions">
        <label><input type="checkbox" aria-label="显示忽略文件" checked={kind === 'ignored'} disabled={busy} onChange={event => { setKind(event.currentTarget.checked ? 'ignored' : 'tracked'); setOffset(0); }} />显示忽略文件</label>
        <span>{kind === 'ignored' ? '忽略文件与目录' : '已跟踪文件'}</span>
        <input aria-label="筛选忽略管理文件" placeholder="筛选路径或输入目录" disabled={busy} value={queryInput} onInput={event => setQueryInput(event.currentTarget.value)} />
      </div>
      <div class="ignore-file-list" aria-label={kind === 'ignored' ? '忽略文件列表' : '已跟踪文件列表'}>
        {page?.paths.map(path => <button key={path} disabled={busy || loading} title={path} class={data?.path === path ? 'selected' : ''}
          onClick={() => { setError(''); void load(path).catch(error => setError(String(error))); }}>{path}</button>)}
        {page && !page.paths.length && <p class="muted">没有匹配的文件</p>}
        {!page && <p class="muted">正在读取文件…</p>}
      </div>
      <div class="filter-actions">
        <span>共 {page?.total ?? 0} 项</span>
        <button disabled={busy || !offset} onClick={() => setOffset(Math.max(0, offset - 200))}>上一页</button>
        <button disabled={busy || !page?.hasMore} onClick={() => setOffset(offset + 200)}>下一页</button>
      </div>
    </section>
    {notice && <p role="status">{notice}</p>}
    {error && <p class="error-text" role="alert">{error}</p>}
    <div class="modal-actions">
      <button disabled={busy || loading} onClick={() => { setError(''); setVersion(version => version + 1); void load(data?.path ?? path).catch(error => setError(String(error))); }}>重新读取</button>
      <button disabled={busy || loading} onClick={onClose}>关闭</button>
    </div>
  </Modal>;
}

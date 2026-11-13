import { useState } from 'preact/hooks';
import { readSaved, save } from './api';

export interface LogFilters {
  author: string;
  since: string;
  until: string;
  path: string;
  revision: string;
  merge: 'all' | 'merges' | 'non-merges';
}
export const EMPTY_FILTERS: LogFilters = { author: '', since: '', until: '', path: '', revision: '', merge: 'all' };
interface SavedFilter extends LogFilters {
  name: string;
  search: string;
  branch: string;
}

export function LogFilterPanel({ root, filters, search, branch, onApply }: {
  root: string;
  filters: LogFilters;
  search: string;
  branch: string;
  onApply: (filters: LogFilters, search: string, branch: string) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<SavedFilter[]>(() => {
    const value = readSaved<unknown>(`log.filters.${root}`, []);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SavedFilter => item &&
      ['name', 'search', 'branch', ...Object.keys(EMPTY_FILTERS)].every(key => typeof item[key] === 'string')).slice(0, 20);
  });
  function persist(next: SavedFilter[]) {
    try {
      save(`log.filters.${root}`, next);
      setSaved(next);
      setError('');
    } catch (error) { setError(String(error)); }
  }
  function apply() {
    if (draft.since && draft.until && draft.since > draft.until) {
      setError('开始日期应早于或等于结束日期');
      return;
    }
    setError('');
    onApply(draft, search, branch);
  }
  return <section class="log-filter-panel" aria-label="提交高级筛选">
    <form onSubmit={event => { event.preventDefault(); apply(); }}>
      <div class="log-filter-fields">
        {([['author', '作者或邮箱', 'text'], ['since', '开始日期', 'date'], ['until', '结束日期', 'date'],
          ['path', '文件或目录路径', 'text'], ['revision', '提交 SHA', 'text']] as const).map(([key, label, type]) =>
          <label key={key}>{label}<input aria-label={label} type={type} value={draft[key]} maxLength={4096}
            placeholder={key === 'path' ? '仓库相对路径' : key === 'revision' ? '至少 4 位 SHA，定位单条提交' : ''}
            onInput={event => { const value = event.currentTarget.value; setDraft(previous => ({ ...previous, [key]: value })); }} /></label>)}
        <label>提交类型<select aria-label="提交类型" value={draft.merge} onChange={event => setDraft(previous => ({ ...previous, merge: event.currentTarget.value as LogFilters['merge'] }))}>
          <option value="all">全部提交</option><option value="merges">仅合并提交</option><option value="non-merges">排除合并提交</option>
        </select></label>
      </div>
      <div class="filter-actions">
        <button type="submit">应用筛选</button>
        <button type="button" onClick={() => { setDraft(EMPTY_FILTERS); setError(''); onApply(EMPTY_FILTERS, '', ''); }}>清除所有筛选</button>
        <input aria-label="筛选名称" placeholder="保存当前筛选" value={name} maxLength={80} onInput={event => setName(event.currentTarget.value)} />
        <button type="button" disabled={!name.trim()} onClick={() => {
          persist([{ ...draft, search, branch, name: name.trim() }, ...saved.filter(item => item.name !== name.trim())].slice(0, 20));
        }}>保存筛选</button>
      </div>
    </form>
    {!!saved.length && <div class="saved-filters" aria-label="已保存筛选">{saved.map(item => <span key={item.name}>
      <button onClick={() => {
        const filters = { author: item.author, since: item.since, until: item.until, path: item.path, revision: item.revision, merge: item.merge };
        setDraft(filters);
        onApply(filters, item.search, item.branch);
      }}>{item.name}</button>
      <button aria-label={`删除筛选 ${item.name}`} onClick={() => persist(saved.filter(value => value.name !== item.name))}>×</button>
    </span>)}</div>}
    {error && <p class="error-text" role="alert">{error}</p>}
  </section>;
}

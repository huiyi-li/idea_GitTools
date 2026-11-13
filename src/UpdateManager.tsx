import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { version } from '../package.json';
import { call, readSaved, save } from './api';
import { Modal } from './ui/controls';
import './updater.css';

type Phase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing';
export const UPDATE_SESSION = 'updater.session';
export interface UpdateSession { root: string; message: string; savedAt: number }

export function readUpdateSession(): UpdateSession | null {
  const value = readSaved<Partial<UpdateSession> | null>(UPDATE_SESSION, null);
  return value && typeof value.root === 'string' && typeof value.message === 'string' &&
    typeof value.savedAt === 'number' && Date.now() - value.savedAt >= 0 &&
    Date.now() - value.savedAt < 86400000 ? value as UpdateSession : null;
}

export function updateError(error: unknown): string {
  const detail = String(error);
  if (/404|release.*not found/i.test(detail))
    return '发布页暂未提供 latest.json 更新清单，请在 GitHub 发布页获取安装包。';
  if (/could not fetch a valid release JSON/i.test(detail))
    return '无法读取有效的 latest.json 更新清单，请检查 GitHub 连接与发布资源，或打开发布页下载。';
  if (/signature|pubkey|minisign|public key/i.test(detail))
    return '更新包签名校验失败，安装已停止。请重新检查更新或到 GitHub 发布页下载。';
  if (/timed?\s*out|timeout/i.test(detail))
    return '连接 GitHub 超时，请检查网络或系统代理后重试。';
  return `更新失败，请重试或打开 GitHub 发布页。\n${detail.slice(0, 1200)}`;
}

function size(bytes: number) { return `${(bytes / 1048576).toFixed(1)} MiB`; }

export function UpdateManager({ open, onOpenChange, blocked, beforeInstall, onInstallFailed }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blocked: string;
  beforeInstall: () => void;
  onInstallFailed: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [info, setInfo] = useState<{ version: string; notes?: string; date?: string } | null>(null);
  const [error, setError] = useState('');
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState<number>();
  const [autoCheck, setAutoCheck] = useState(() => readSaved<boolean>('updater.autoCheck', true) === true);
  const [autoDownload, setAutoDownload] = useState(() => readSaved<boolean>('updater.autoDownload', false) === true);
  const update = useRef<Update | null>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  const checkedOnce = useRef(false);
  const current = useRef({ blocked, beforeInstall, onInstallFailed, autoDownload });
  current.current = { blocked, beforeInstall, onInstallFailed, autoDownload };

  async function release() {
    const previous = update.current;
    update.current = null;
    await previous?.close().catch(() => {});
  }

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Pending operations release their resources after returning from native code.
      if (!working.current) void release();
    };
  }, []);

  useEffect(() => {
    if (!autoCheck || !('__TAURI_INTERNALS__' in window)) return;
    const timer = setTimeout(() => { if (!checkedOnce.current) void checkUpdate(); }, 5000);
    return () => clearTimeout(timer);
  }, [autoCheck]);

  async function checkUpdate() {
    if (working.current) return;
    checkedOnce.current = true;
    working.current = true;
    setPhase('checking');
    setError('');
    setInfo(null);
    let download = false;
    try {
      await release();
      const found = await check({ timeout: 30000 });
      if (!mounted.current) { await found?.close(); return; }
      update.current = found;
      setInfo(found ? { version: found.version, notes: found.body, date: found.date } : null);
      setPhase(found ? 'available' : 'current');
      download = !!found && current.current.autoDownload;
    } catch (e) {
      if (mounted.current) { setPhase('idle'); setError(updateError(e)); }
    } finally {
      working.current = false;
      if (!mounted.current) await release();
    }
    if (download && mounted.current) await downloadUpdate();
  }

  async function downloadUpdate() {
    if (working.current || !update.current) return;
    working.current = true;
    setPhase('downloading');
    setError('');
    setReceived(0);
    setTotal(undefined);
    let bytes = 0;
    try {
      await update.current.download(event => {
        if (!mounted.current) return;
        if (event.event === 'Started') setTotal(event.data.contentLength);
        if (event.event === 'Progress') { bytes += event.data.chunkLength; setReceived(bytes); }
      }, { timeout: 300000 });
      // The native download promise resolves after signature verification.
      if (mounted.current) setPhase('ready');
    } catch (e) {
      if (mounted.current) { setPhase('available'); setError(updateError(e)); }
    } finally {
      working.current = false;
      if (!mounted.current) await release();
    }
  }

  async function installUpdate() {
    if (working.current || !update.current || phase !== 'ready') return;
    if (current.current.blocked) { setError(current.current.blocked); return; }
    working.current = true;
    setPhase('installing');
    setError('');
    try {
      current.current.beforeInstall();
      await update.current.install({ restartAfterInstall: true });
    } catch (e) {
      try { current.current.onInstallFailed(); } catch { /* Preserve the installation error. */ }
      if (mounted.current) { setPhase('ready'); setError(updateError(e)); }
    } finally {
      working.current = false;
      if (!mounted.current) await release();
    }
  }

  function preference(key: string, value: boolean, setter: (value: boolean) => void) {
    try { save(key, value); setter(value); } catch (e) { setError(`保存更新设置失败。${e}`); }
  }
  const active = phase === 'checking' || phase === 'downloading' || phase === 'installing';
  const label = phase === 'ready' ? '更新已就绪'
    : phase === 'downloading' ? '下载更新中'
    : info ? `新版本 ${info.version}`
    : error ? '检查更新失败' : '检查更新';
  return (
    <>
      <button title="软件更新" class={info ? 'update-available' : ''} onClick={() => onOpenChange(true)}>
        {version} · {label}
      </button>
      {open && createPortal(
        <Modal title="软件更新" busy={phase === 'installing'} onClose={() => onOpenChange(false)} class="update-dialog">
          <h2>软件更新</h2>
          <p>当前版本 {version}{info && ` → ${info.version}`}</p>
          <label class="update-option">
            <input type="checkbox" checked={autoCheck}
              onChange={e => preference('updater.autoCheck', e.currentTarget.checked, setAutoCheck)} />
            启动时检查更新
          </label>
          <label class="update-option">
            <input type="checkbox" checked={autoDownload}
              onChange={e => preference('updater.autoDownload', e.currentTarget.checked, setAutoDownload)} />
            发现新版本后自动下载
          </label>
          {phase === 'checking' && <p role="status">正在检查 GitHub Releases…</p>}
          {phase === 'current' && <p role="status">已是最新版本</p>}
          {info && (
            <section class="update-notes">
              <h3>{info.version} 发布说明</h3>
              {info.date && <p>{info.date}</p>}
              <pre>{info.notes || '此版本未提供发布说明。'}</pre>
            </section>
          )}
          {phase === 'downloading' && (
            <div role="status">
              <progress aria-label="更新下载进度" max={total || 1}
                value={total ? Math.min(received, total) : undefined} />
              <p>已下载 {size(received)}{total ? ` / ${size(total)}` : ''}，完成后校验签名</p>
            </div>
          )}
          {phase === 'ready' && (
            <p role="status">更新包已下载并通过签名校验。安装会关闭应用，完成后自动重启。</p>
          )}
          {phase === 'installing' && <p role="status">正在启动安装程序，请完成 Windows 授权…</p>}
          {blocked && phase === 'ready' && <p class="update-warning">{blocked}</p>}
          {error && <pre class="update-error" role="alert">{error}</pre>}
          <div class="modal-actions">
            <button disabled={active} onClick={() => void checkUpdate()}>检查更新</button>
            {phase === 'available' && (
              <button class="primary" onClick={() => void downloadUpdate()}>下载更新</button>
            )}
            {phase === 'ready' && (
              <button class="primary" disabled={!!blocked} onClick={() => void installUpdate()}>安装并重启</button>
            )}
            <button disabled={phase === 'installing'}
              onClick={() => void call('open_release_page').catch(e => setError(updateError(e)))}>
              GitHub 发布页
            </button>
            <button disabled={phase === 'installing'} onClick={() => onOpenChange(false)}>
              {phase === 'downloading' ? '后台下载' : '关闭'}
            </button>
          </div>
        </Modal>, document.body,
      )}
    </>
  );
}

import { useEffect, useRef, useState } from 'preact/hooks';
import { call, readSaved, save } from '../api';
import type { Account, Provider } from './types';

interface LoginStart {
  id: string;
  url: string;
  userCode: string | null;
  expiresAt: number;
}

function configurationKey(provider: Provider, server: string) {
  try {
    const url = new URL(server.trim());
    return `${provider}:${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return `${provider}:${server.trim()}`;
  }
}

export function BrowserLogin({
  provider,
  server,
  disabled,
  onBusy,
  onChanged,
}: {
  provider: Provider;
  server: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onChanged: (account?: Account) => void;
}) {
  const key = configurationKey(provider, server);
  const [clientId, setClientId] = useState(
    () => readSaved<Record<string, string>>('hosting.oauthApps', {})[key] ?? '',
  );
  const [pending, setPending] = useState<LoginStart>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [remaining, setRemaining] = useState(0);
  const alive = useRef(true);
  const session = useRef<string>();
  const gate = useRef(false);
  const callbacks = useRef({ onBusy, onChanged });
  callbacks.current = { onBusy, onChanged };

  useEffect(
    () => () => {
      alive.current = false;
      if (session.current)
        void call('hosting_oauth_cancel', { sessionId: session.current }).catch(() => {});
      callbacks.current.onBusy(false);
    },
    [],
  );

  useEffect(() => {
    if (!pending) return;
    const update = () =>
      setRemaining(Math.max(0, Math.ceil(pending.expiresAt - Date.now() / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [pending]);

  async function openPage(id: string) {
    try {
      await call('hosting_oauth_open', { sessionId: id });
    } catch (error) {
      if (alive.current) setError(String(error));
    }
  }

  async function login() {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    callbacks.current.onBusy(true);
    setError('');
    setNotice('正在准备网页授权…');
    try {
      const start = await call<LoginStart>('hosting_oauth_start', {
        request: { provider, server, clientId: clientId.trim() },
      });
      if (!alive.current) {
        await call('hosting_oauth_cancel', { sessionId: start.id });
        return;
      }
      session.current = start.id;
      setPending(start);
      setNotice('请在系统浏览器中完成授权，账户会自动连接。');
      try {
        save('hosting.oauthApps', {
          ...readSaved<Record<string, string>>('hosting.oauthApps', {}),
          [key]: clientId.trim(),
        });
      } catch {
        /* The current login can continue when local settings are unavailable. */
      }
      const completion = call<Account>('hosting_oauth_finish', { sessionId: start.id });
      void openPage(start.id);
      const account = await completion;
      if (!alive.current) return;
      callbacks.current.onChanged(account);
      setNotice(`已通过网页连接 ${account.login}`);
      setError('');
    } catch (error) {
      if (alive.current) {
        setError(String(error));
        setNotice('');
      }
    } finally {
      session.current = undefined;
      gate.current = false;
      if (alive.current) {
        setPending(undefined);
        setBusy(false);
        callbacks.current.onBusy(false);
      }
    }
  }

  return (
    <section class="hosting-browser-login" aria-label="网页登录">
      <h3>网页登录</h3>
      <label>
        OAuth Client ID
        <input
          aria-label="OAuth Client ID"
          value={clientId}
          disabled={disabled || busy}
          autoComplete="off"
          onInput={(event) => setClientId(event.currentTarget.value)}
        />
      </label>
      <details open={!clientId}>
        <summary>首次配置 OAuth 应用</summary>
        <p>应用名称填写 IdeaGitTool，将公开的 Client ID 填入上方。此设置会按服务器保存。</p>
        {provider === 'github' ? (
          <p>
            在 GitHub 注册 OAuth App，启用 Enable Device
            Flow。主页可填本项目地址，回调地址可填下方地址。网页登录时输入应用显示的验证码并授权。
          </p>
        ) : (
          <p>
            在 GitLab 应用设置中创建应用，取消 Confidential，勾选 api 和 read_user。Redirect URI
            须与下方完全一致。
          </p>
        )}
        {provider === 'github' && (
          <p>
            Homepage URL <code>https://github.com/huiyi-li/idea_GitTools</code>
          </p>
        )}
        <code class="hosting-oauth-redirect">http://127.0.0.1:34171/oauth/callback</code>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => {
            setError('');
            void call('hosting_oauth_registration', { provider, server }).catch((error) => {
              if (alive.current) setError(String(error));
            });
          }}
        >
          打开应用注册页面
        </button>
      </details>
      {pending && (
        <div class="hosting-oauth-pending">
          {pending.userCode && (
            <label>
              网页验证码
              <input aria-label="网页验证码" readOnly value={pending.userCode} />
            </label>
          )}
          <p>等待授权 · 剩余 {remaining} 秒</p>
          <button type="button" onClick={() => void openPage(pending.id)}>
            重新打开授权页面
          </button>
          <button
            type="button"
            onClick={() =>
              void call<boolean>('hosting_oauth_cancel', { sessionId: pending.id }).then(
                (cancelled) => {
                  if (alive.current && !cancelled) setNotice('授权结果正在保存，请稍候。');
                },
                (error) => {
                  if (alive.current) setError(String(error));
                },
              )
            }
          >
            取消网页登录
          </button>
        </div>
      )}
      {error && (
        <p class="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div class="modal-actions">
        <button
          class="primary"
          type="button"
          aria-label={`使用 ${provider === 'github' ? 'GitHub' : 'GitLab'} 网页登录`}
          disabled={disabled || busy || !clientId.trim() || !server.trim()}
          onClick={() => void login()}
        >
          {busy ? '等待网页授权…' : `使用 ${provider === 'github' ? 'GitHub' : 'GitLab'} 网页登录`}
        </button>
      </div>
    </section>
  );
}

import { useState } from 'preact/hooks';
import { call } from '../api';
import { Modal, ToolButton } from '../ui/controls';
import type { Account, Provider } from './types';
import { providerName } from './types';
import { BrowserLogin } from './BrowserLogin';

export function Accounts({
  accounts,
  onChanged,
  onClose,
}: {
  accounts: Account[];
  onChanged: (account?: Account) => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<Provider>('github');
  const [server, setServer] = useState('https://github.com');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState('');
  const [browserBusy, setBrowserBusy] = useState(false);
  const unavailable = busy || browserBusy;

  async function run(action: () => Promise<void>) {
    if (unavailable) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="托管平台账户" class="hosting-account-dialog" busy={busy} onClose={onClose}>
      <header class="hosting-toolbar">
        <h2>托管平台账户</h2>
        <span class="spacer" />
        <ToolButton icon="general/close" label="关闭账户管理" disabled={busy} onClick={onClose} />
      </header>
      <div class="hosting-account-list">
        {accounts.map((account) => (
          <div class="hosting-account-row" key={account.id}>
            <span>
              <strong>
                {providerName(account.provider)} · {account.login}
              </strong>
              <small>{account.server}</small>
            </span>
            <button
              disabled={unavailable}
              onClick={() =>
                void run(async () => {
                  const identity = await call<Account>('hosting_validate', {
                    accountId: account.id,
                  });
                  setNotice(`账户有效 · ${identity.login}`);
                })
              }
            >
              验证
            </button>
            <button disabled={unavailable} onClick={() => setRemoving(account.id)}>
              移除
            </button>
            {removing === account.id && (
              <>
                <button disabled={unavailable} onClick={() => setRemoving('')}>
                  取消
                </button>
                <button
                  disabled={unavailable}
                  onClick={() =>
                    void run(async () => {
                      await call('hosting_logout', { accountId: account.id });
                      setRemoving('');
                      onChanged();
                    })
                  }
                >
                  确认移除
                </button>
              </>
            )}
          </div>
        ))}
        {!accounts.length && <p class="muted">添加账户后可浏览仓库和管理 PR / MR。</p>}
      </div>
      <div class="hosting-form">
        <h3>添加或更新账户</h3>
        <label>
          平台
          <select
            value={provider}
            disabled={unavailable}
            onChange={(event) => {
              const next = event.currentTarget.value as Provider;
              setProvider(next);
              setServer(next === 'github' ? 'https://github.com' : 'https://gitlab.com');
              setToken('');
            }}
          >
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </label>
        <label>
          服务器地址
          <input
            required
            type="url"
            value={server}
            disabled={unavailable}
            onInput={(event) => setServer(event.currentTarget.value)}
          />
        </label>
        <BrowserLogin
          key={`${provider}:${server}`}
          provider={provider}
          server={server}
          disabled={busy}
          onBusy={setBrowserBusy}
          onChanged={onChanged}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const submittedToken = token;
            setToken('');
            void run(async () => {
              const account = await call<Account>('hosting_login', {
                request: { provider, server, token: submittedToken },
              });
              onChanged(account);
              setNotice(`已连接 ${account.login}`);
            });
          }}
        >
          <h3>使用访问令牌</h3>
          <label>
            访问令牌
            <input
              required
              type="password"
              autoComplete="new-password"
              value={token}
              disabled={unavailable}
              onInput={(event) => setToken(event.currentTarget.value)}
            />
          </label>
          <p class="muted">
            令牌保存在系统凭据库。GitHub 按需授予 Metadata、Contents、Pull requests、Issues、Commit
            statuses 和 Checks 权限。GitLab 浏览使用 read_api，创建和评论使用 api 权限。克隆使用系统
            Git 的 SSH 或 HTTPS 凭据。
          </p>
          {error && (
            <p class="error-text" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <div class="modal-actions">
            <button disabled={unavailable || !token.trim() || !server.trim()} type="submit">
              {busy ? '处理中…' : '验证并保存'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

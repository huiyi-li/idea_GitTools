import { useEffect, useRef, useState } from 'preact/hooks';
import { open } from '@tauri-apps/plugin-dialog';
import { call, readSaved, save } from '../api';
import { Icon, Modal, Split, ToolButton } from '../ui/controls';
import { Accounts } from './Accounts';
import { TransportProgress } from '../TransportDialog';
import { ReviewList } from './Reviews';
import { useRemote, useRemotePage } from './hooks';
import { providerName, type Account, type HostedRepository } from './types';
import './hosting.css';

export function Pagination({
  page,
  loading,
  hasMore,
  previous,
  next,
}: {
  page: number;
  loading: boolean;
  hasMore?: boolean;
  previous: () => void;
  next: () => void;
}) {
  return (
    <div class="hosting-pagination">
      <button disabled={loading || page <= 1} onClick={previous}>
        上一页
      </button>
      <span class="muted">第 {page} 页</span>
      <button disabled={loading || !hasMore} onClick={next}>
        下一页
      </button>
    </div>
  );
}

export function RemoteMessage({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  if (error)
    return (
      <div class="hosting-error" role="alert">
        {error}
        <button onClick={onRetry}>重试</button>
      </div>
    );
  return loading ? (
    <div class="empty" role="status">
      正在加载…
    </div>
  ) : null;
}

export default function HostingView({
  localRoot,
  onOpen,
  onClose,
}: {
  localRoot: string;
  onOpen: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const accounts = useRemote<Account[]>('hosting_accounts', {});
  const [selected, setSelected] = useState(() => readSaved<string>('hosting.account', ''));
  const [managing, setManaging] = useState(false);
  const account = accounts.value?.find((item) => item.id === selected) ?? accounts.value?.[0];
  return (
    <main class="hosting-view">
      <header class="hosting-toolbar">
        <Icon name="toolwindows/vcs" />
        <strong>托管平台</strong>
        <select
          aria-label="托管账户"
          value={account?.id ?? ''}
          onChange={(event) => {
            setSelected(event.currentTarget.value);
            save('hosting.account', event.currentTarget.value);
          }}
        >
          {!accounts.value?.length && <option value="">选择账户</option>}
          {accounts.value?.map((item) => (
            <option key={item.id} value={item.id}>
              {providerName(item.provider)} · {item.login} · {item.server}
            </option>
          ))}
        </select>
        <button onClick={() => setManaging(true)}>管理账户</button>
        <span class="spacer" />
        <ToolButton icon="general/close" label="返回本地工作区" onClick={onClose} />
      </header>
      <RemoteMessage loading={accounts.loading} error={accounts.error} onRetry={accounts.reload} />
      {account && (
        <AccountWorkspace
          key={account.id}
          account={account}
          localRoot={localRoot}
          onOpen={onOpen}
        />
      )}
      {!account && !accounts.loading && !accounts.error && (
        <div class="empty hosting-onboarding">
          <h2>连接 GitHub 或 GitLab</h2>
          <p>浏览远程仓库，克隆项目，查看和管理 PR / MR。</p>
          <button class="primary" onClick={() => setManaging(true)}>
            添加平台账户
          </button>
        </div>
      )}
      {managing && (
        <Accounts
          accounts={accounts.value ?? []}
          onClose={() => setManaging(false)}
          onChanged={(item) => {
            if (item) {
              setSelected(item.id);
              save('hosting.account', item.id);
            }
            accounts.reload();
          }}
        />
      )}
    </main>
  );
}

function AccountWorkspace({
  account,
  localRoot,
  onOpen,
}: {
  account: Account;
  localRoot: string;
  onOpen: (path: string) => Promise<void>;
}) {
  const repositories = useRemotePage<HostedRepository>('hosting_repositories', {
    accountId: account.id,
  });
  const [selected, setSelected] = useState<HostedRepository | null>(null);
  const [search, setSearch] = useState('');
  const [path, setPath] = useState('');
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  return (
    <Split storageKey="hosting-repositories" initial={290} min={220} label="调整远程仓库栏宽度">
      <aside class="hosting-repositories">
        <header class="hosting-toolbar">
          <strong>仓库</strong>
          <span class="spacer" />
          <ToolButton
            icon="general/refresh"
            label="刷新远程仓库"
            disabled={repositories.loading}
            onClick={repositories.reload}
          />
        </header>
        <input
          aria-label="筛选本页仓库"
          placeholder="筛选本页仓库"
          value={search}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
        <form
          class="hosting-repository-path"
          onSubmit={(event) => {
            event.preventDefault();
            if (opening) return;
            setOpening(true);
            setError('');
            void call<HostedRepository>('hosting_repository', {
              accountId: account.id,
              repository: path.trim(),
            })
              .then((value) => {
                if (active.current) setSelected(value);
              })
              .catch((error) => {
                if (active.current) setError(String(error));
              })
              .finally(() => {
                if (active.current) setOpening(false);
              });
          }}
        >
          <input
            aria-label="远程仓库路径"
            placeholder={account.provider === 'github' ? 'owner/repo' : 'group/subgroup/project'}
            value={path}
            onInput={(event) => setPath(event.currentTarget.value)}
          />
          <button disabled={opening || !path.trim()} type="submit">
            打开
          </button>
        </form>
        {error && (
          <p class="hosting-error" role="alert">
            {error}
          </p>
        )}
        <RemoteMessage
          loading={repositories.loading}
          error={repositories.error}
          onRetry={repositories.reload}
        />
        <div class="hosting-list" role="listbox" aria-label="远程仓库">
          {repositories.value?.items
            .filter((item) => item.path.toLowerCase().includes(search.toLowerCase()))
            .map((item) => (
              <button
                key={item.id}
                class={'hosting-repo-row ' + (selected?.id === item.id ? 'selected' : '')}
                role="option"
                aria-selected={selected?.id === item.id}
                onClick={() => setSelected(item)}
              >
                <Icon name="nodes/folder" />
                <span>
                  <strong>{item.path}</strong>
                  <small>
                    {item.private ? '私有' : '公开'} · {item.defaultBranch || '空仓库'}
                  </small>
                </span>
              </button>
            ))}
          {repositories.value?.items.length === 0 && (
            <div class="empty">暂无可访问仓库，可输入路径直接打开。</div>
          )}
        </div>
        <Pagination {...repositories} hasMore={repositories.value?.hasMore} />
      </aside>
      {selected ? (
        <RepositoryWorkspace
          key={selected.id}
          account={account}
          repository={selected}
          localRoot={localRoot}
          onOpen={onOpen}
        />
      ) : (
        <div class="empty">选择仓库查看 PR / MR</div>
      )}
    </Split>
  );
}

function RepositoryWorkspace({
  account,
  repository,
  localRoot,
  onOpen,
}: {
  account: Account;
  repository: HostedRepository;
  localRoot: string;
  onOpen: (path: string) => Promise<void>;
}) {
  const key = `hosting.local.${account.id}.${repository.id}`;
  const [linked, setLinked] = useState(() => readSaved<string>(key, ''));
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState('');
  function link(path: string) {
    save(key, path);
    setLinked(path);
  }
  async function browse() {
    try {
      await call('hosting_open_url', {
        accountId: account.id,
        url: repository.webUrl,
      });
    } catch (error) {
      setError(String(error));
    }
  }
  return (
    <section class="hosting-repository-workspace">
      <header class="hosting-toolbar">
        <strong class="ellipsis" title={repository.path}>
          {repository.path}
        </strong>
        <button onClick={() => setCloning(true)}>克隆</button>
        <button onClick={() => void browse()}>在浏览器打开</button>
        {localRoot && (
          <button title={localRoot} onClick={() => link(localRoot)}>
            关联当前本地仓库
          </button>
        )}
        <button
          onClick={() =>
            void (async () => {
              try {
                const path = await open({
                  directory: true,
                  multiple: false,
                  title: '关联本地 Git 仓库',
                });
                if (typeof path === 'string')
                  link(await call<string>('hosting_local_root', { path }));
              } catch (error) {
                setError(String(error));
              }
            })()
          }
        >
          关联目录
        </button>
      </header>
      {linked && (
        <div class="hosting-toolbar muted">
          <span class="ellipsis" title={linked}>
            本地 · {linked}
          </span>
          <button onClick={() => void onOpen(linked)}>打开本地仓库</button>
          <button onClick={() => link('')}>解除关联</button>
        </div>
      )}
      {error && (
        <div class="hosting-error" role="alert">
          {error}
          <button onClick={() => setError('')}>关闭</button>
        </div>
      )}
      <ReviewList account={account} repository={repository} localRoot={linked === localRoot ? localRoot : ''} onOpen={onOpen} />
      {cloning && (
        <CloneDialog
          account={account}
          repository={repository}
          onClose={() => setCloning(false)}
          onCloned={(path) => {
            link(path);
            setCloning(false);
            void onOpen(path);
          }}
        />
      )}
    </section>
  );
}

function CloneDialog({
  account,
  repository,
  onClose,
  onCloned,
}: {
  account: Account;
  repository: HostedRepository;
  onClose: () => void;
  onCloned: (path: string) => void;
}) {
  const [parent, setParent] = useState('');
  const [directory, setDirectory] = useState(repository.path.split('/').pop() ?? repository.name);
  const [protocol, setProtocol] = useState('ssh');
  const [sshAlias, setSshAlias] = useState(() =>
    readSaved<string>(`hosting.ssh.${account.id}`, ''),
  );
  const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="克隆远程仓库" busy={busy} onClose={onClose}>
      <form
        class="hosting-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          void call<string>('hosting_start_clone', {
            request: {
              accountId: account.id,
              repository: repository.path,
              parent,
              directory,
              protocol,
              sshAlias,
            },
          })
            .then((id) => {
              save(`hosting.ssh.${account.id}`, sshAlias);
              setJobId(id);
            })
            .catch((error) => { setError(String(error)); setBusy(false); });
        }}
      >
        <h2>克隆 {repository.path}</h2>
        <label>
          父目录
          <div class="hosting-toolbar">
            <input required readOnly value={parent} />
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  try {
                    const path = await open({
                      directory: true,
                      multiple: false,
                      title: '选择克隆父目录',
                    });
                    if (typeof path === 'string') setParent(path);
                  } catch (error) {
                    setError(String(error));
                  }
                })()
              }
            >
              选择目录
            </button>
          </div>
        </label>
        <label>
          新目录名称
          <input
            required
            value={directory}
            disabled={busy}
            onInput={(event) => setDirectory(event.currentTarget.value)}
          />
        </label>
        <label>
          传输方式
          <select
            value={protocol}
            disabled={busy}
            onChange={(event) => setProtocol(event.currentTarget.value)}
          >
            <option value="ssh">SSH</option>
            <option value="https">HTTPS</option>
          </select>
        </label>
        {protocol === 'ssh' && (
          <label>
            SSH Host 别名（可选）
            <input
              placeholder="例如 github_ming"
              value={sshAlias}
              disabled={busy}
              onInput={(event) => setSshAlias(event.currentTarget.value)}
            />
          </label>
        )}
        <p class="muted">
          SSH 使用已有密钥配置，HTTPS 使用系统 Git 凭据管理器。需要时将在此窗口请求认证。
        </p>
        {error && (
          <p class="error-text" role="alert">
            {error}
          </p>
        )}
        <div class="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button class="primary" disabled={busy || !parent || !directory.trim()}>
            {busy ? '正在克隆…' : '开始克隆'}
          </button>
        </div>
      </form>
      {jobId && <TransportProgress id={jobId} onIdle={(idle) => setBusy(!idle)} onDone={onCloned} />}
    </Modal>
  );
}

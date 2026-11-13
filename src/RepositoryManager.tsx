import { useEffect, useState } from 'preact/hooks';
import { call, type Status } from './api';
import { Modal } from './ui/controls';
import { DiffView } from './DiffView';
import { TransportProgress } from './TransportDialog';

interface Tag {
  name: string;
  hash: string;
  subject: string;
}
interface Management {
  status: Status;
  tags: Tag[];
  remotes: { name: string }[];
}
interface StashFile {
  path: string;
  oldPath?: string | null;
  revision: string;
  base: string;
}

export function RepositoryManager({
  root,
  onClose,
  onChanged,
}: {
  root: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<Management>();
  const [tab, setTab] = useState<'branches' | 'tags' | 'stashes'>('branches');
  const [selected, setSelected] = useState('');
  const [remoteBranch, setRemoteBranch] = useState('');
  const [remoteConfirm, setRemoteConfirm] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState('');
  const [remote, setRemote] = useState('');
  const [force, setForce] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [keepIndex, setKeepIndex] = useState(false);
  const [untracked, setUntracked] = useState(true);
  const [paths, setPaths] = useState<string[]>([]);
  const [files, setFiles] = useState<StashFile[]>([]);
  const [file, setFile] = useState<StashFile | null>(null);
  const [job, setJob] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    const next = await call<Management>('repository_management', { root });
    setData(next);
    setRevision(next.status.repository.head ?? '');
    setRemote((previous) => previous || next.remotes[0]?.name || '');
  }
  useEffect(() => {
    void load().catch((error) => setError(String(error)));
  }, [root]);
  useEffect(() => {
    setSelected('');
    setRemoteConfirm(false);
    setRemoteBranch('');
    setConfirm(false);
    setForce(false);
    setName('');
    setMessage('');
    setFile(null);
    setFiles([]);
  }, [tab]);
  useEffect(() => {
    if (tab !== 'stashes' || !selected) return;
    let current = true;
    setFile(null);
    setFiles([]);
    const stash = data?.status.stashes.find((stash) => stash.reference === selected);
    if (!stash) return;
    void call<StashFile[]>('stash_files', { root, hash: stash.hash })
      .then((files) => {
        if (current) setFiles(files);
      })
      .catch((error) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [root, tab, selected, data?.status.stashes]);
  async function mutate(command: string, request: unknown) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await call(command, { root, request });
      setSelected('');
      setConfirm(false);
    } catch (error) {
      setError(String(error));
    } finally {
      await load().catch((error) => setError(String(error)));
      await onChanged().catch((error) => setError(String(error)));
      setBusy(false);
    }
  }
  const branch = data?.status.branches.find((branch) => branch.full === selected);
  const tag = data?.tags.find((tag) => tag.name === selected);
  const stash = data?.status.stashes.find((stash) => stash.reference === selected);
  const selectedRemoteBranch = data?.status.branches.find((branch) => branch.full === remoteBranch);
  const branchRemote = data?.remotes
    .filter((remote) => selectedRemoteBranch?.name.startsWith(remote.name + '/'))
    .sort((a, b) => b.name.length - a.name.length)[0];
  function refAction(action: string) {
    void mutate('edit_ref', {
      action,
      name: action === 'tag-create' ? name : (tag?.name ?? branch?.name ?? ''),
      newName: name,
      hash: action === 'tag-create' ? revision : (tag?.hash ?? branch?.hash ?? ''),
      message,
      force,
    });
  }
  function stashAction(action: string) {
    void mutate('edit_stash', {
      action,
      hash: stash?.hash ?? '',
      reference: stash?.reference ?? '',
      message: message || 'Work in progress',
      keepIndex,
      includeUntracked: untracked,
      paths,
    });
  }
  async function deleteRemote(kind: 'heads' | 'tags') {
    const selected = kind === 'heads' ? selectedRemoteBranch : tag;
    const targetRemote = kind === 'heads' ? branchRemote?.name : remote;
    if (!selected || !targetRemote || busy || !remoteConfirm) return;
    setBusy(true);
    setError('');
    try {
      setJob(
        await call<string>('delete_remote_ref', {
          root,
          remote: targetRemote,
          name: kind === 'heads' ? selected.name.slice(targetRemote.length + 1) : selected.name,
          kind,
          hash: selected.hash,
        }),
      );
      setRemoteConfirm(false);
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="分支、标签与 Stash"
      busy={busy}
      onClose={onClose}
      class="history-dialog workflow-dialog"
    >
      <h2>分支、标签与 Stash</h2>
      <div class="modal-actions">
        {(['branches', 'tags', 'stashes'] as const).map((item) => (
          <button
            key={item}
            disabled={busy}
            aria-pressed={tab === item}
            onClick={() => setTab(item)}
          >
            {item === 'branches' ? '分支管理' : item === 'tags' ? '标签管理' : 'Stash 管理'}
          </button>
        ))}
        <button
          disabled={busy}
          onClick={() => void load().catch((error) => setError(String(error)))}
        >
          重新读取
        </button>
      </div>
      {tab === 'branches' && (
        <div class="transport-form">
          <label>
            本地分支
            <select
              aria-label="管理本地分支"
              disabled={busy}
              value={selected}
              onChange={(event) => {
                setSelected(event.currentTarget.value);
                setConfirm(false);
              }}
            >
              {[
                <option value="">选择分支</option>,
                ...(data?.status.branches
                  .filter((branch) => !branch.remote)
                  .map((branch) => (
                    <option key={branch.full} value={branch.full}>
                      {branch.name}
                      {branch.current ? '（当前）' : ''}
                    </option>
                  )) ?? []),
              ]}
            </select>
          </label>
          <label>
            新名称
            <input
              aria-label="分支新名称"
              value={name}
              disabled={busy}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <button disabled={busy || !branch || !name} onClick={() => refAction('branch-rename')}>
            重命名分支
          </button>
          <label>
            <input
              type="checkbox"
              checked={force}
              disabled={busy}
              onChange={(event) => {
                setForce(event.currentTarget.checked);
                setConfirm(false);
              }}
            />
            允许删除未合并分支
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirm}
              disabled={busy}
              onChange={(event) => setConfirm(event.currentTarget.checked)}
            />
            确认删除 {branch?.name}
          </label>
          <button
            disabled={busy || !branch || branch.current || !confirm}
            onClick={() => refAction('branch-delete')}
          >
            删除本地分支
          </button>
        </div>
      )}
      {tab === 'branches' && (
        <div class="transport-form">
          <label>
            远程分支
            <select
              aria-label="管理远程分支"
              value={remoteBranch}
              disabled={busy}
              onChange={(event) => {
                setRemoteBranch(event.currentTarget.value);
                setRemoteConfirm(false);
              }}
            >
              <option value="">选择远程分支</option>
              {data?.status.branches
                .filter((branch) => branch.remote)
                .map((branch) => (
                  <option key={branch.full} value={branch.full}>
                    {branch.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={remoteConfirm}
              disabled={busy}
              onChange={(event) => setRemoteConfirm(event.currentTarget.checked)}
            />
            确认删除服务器上的分支 {selectedRemoteBranch?.name}
          </label>
          <button
            disabled={busy || !selectedRemoteBranch || !branchRemote || !remoteConfirm}
            onClick={() => void deleteRemote('heads')}
          >
            删除远程分支
          </button>
        </div>
      )}
      {tab === 'tags' && (
        <div class="transport-form">
          <label>
            已有标签
            <select
              aria-label="管理标签"
              disabled={busy}
              value={selected}
              onChange={(event) => {
                setSelected(event.currentTarget.value);
                setConfirm(false);
                setRemoteConfirm(false);
              }}
            >
              <option value="">选择标签</option>
              {data?.tags.map((tag) => (
                <option key={tag.name} value={tag.name}>
                  {tag.name} · {tag.subject}
                </option>
              ))}
            </select>
          </label>
          <label>
            新标签名称
            <input
              aria-label="新标签名称"
              value={name}
              disabled={busy}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label>
            目标提交 SHA
            <input
              aria-label="标签目标提交"
              value={revision}
              disabled={busy}
              onInput={(event) => setRevision(event.currentTarget.value)}
            />
          </label>
          <label>
            标签说明
            <textarea
              value={message}
              disabled={busy}
              onInput={(event) => setMessage(event.currentTarget.value)}
            />
          </label>
          <button
            disabled={busy || !name || !revision || !message.trim()}
            onClick={() => refAction('tag-create')}
          >
            创建附注标签
          </button>
          <label>
            推送远程
            <select
              value={remote}
              disabled={busy}
              onChange={(event) => {
                setRemote(event.currentTarget.value);
                setRemoteConfirm(false);
              }}
            >
              {data?.remotes.map((remote) => (
                <option key={remote.name} value={remote.name}>
                  {remote.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || !tag || !remote}
            onClick={() => {
              setBusy(true);
              setError('');
              void call<string>('push_tag', {
                root,
                name: tag!.name,
                hash: tag!.hash,
                remote,
              })
                .then(setJob)
                .catch((error) => {
                  setError(String(error));
                  setBusy(false);
                });
            }}
          >
            推送所选标签
          </button>
          <label>
            <input
              type="checkbox"
              checked={confirm}
              disabled={busy}
              onChange={(event) => setConfirm(event.currentTarget.checked)}
            />
            确认删除本地标签 {tag?.name}
          </label>
          <button disabled={busy || !tag || !confirm} onClick={() => refAction('tag-delete')}>
            删除本地标签
          </button>
        </div>
      )}
      {tab === 'tags' && (
        <div class="transport-form">
          <label>
            <input
              type="checkbox"
              checked={remoteConfirm}
              disabled={busy}
              onChange={(event) => setRemoteConfirm(event.currentTarget.checked)}
            />
            确认删除 {remote} 服务器上的标签 {tag?.name}
          </label>
          <button
            disabled={busy || !tag || !remote || !remoteConfirm}
            onClick={() => void deleteRemote('tags')}
          >
            删除远程标签
          </button>
        </div>
      )}
      {tab === 'stashes' && (
        <div class="transport-form">
          <label>
            Stash
            <select
              aria-label="选择 Stash"
              disabled={busy}
              value={selected}
              onChange={(event) => {
                setSelected(event.currentTarget.value);
                setConfirm(false);
              }}
            >
              <option value="">选择 Stash</option>
              {data?.status.stashes.map((stash) => (
                <option key={stash.reference} value={stash.reference}>
                  {stash.reference} · {stash.message}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={keepIndex}
              disabled={busy}
              onChange={(event) => setKeepIndex(event.currentTarget.checked)}
            />
            保存时保留暂存内容，恢复时还原暂存布局
          </label>
          <div class="modal-actions">
            <button disabled={busy || !selected} onClick={() => stashAction('apply')}>
              Apply
            </button>
            <button disabled={busy || !selected} onClick={() => stashAction('pop')}>
              Pop
            </button>
          </div>
          <label>
            <input
              type="checkbox"
              checked={confirm}
              disabled={busy}
              onChange={(event) => setConfirm(event.currentTarget.checked)}
            />
            确认删除所选 Stash
          </label>
          <button disabled={busy || !selected || !confirm} onClick={() => stashAction('drop')}>
            Drop
          </button>
          <div class="modal-actions">
            {files.map((file) => (
              <button key={file.path} onClick={() => setFile(file)}>
                {file.path}
              </button>
            ))}
          </div>
          {file && (
            <div style={{ height: 320 }}>
              <DiffView
                root={root}
                version={0}
                target={{
                  path: file.path,
                  oldPath: file.oldPath ?? null,
                  revision: file.revision,
                  beforeRevision: file.base,
                }}
              />
            </div>
          )}
          <h3>保存新的 Stash</h3>
          <label>
            说明
            <input
              value={message}
              disabled={busy}
              onInput={(event) => setMessage(event.currentTarget.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={untracked}
              disabled={busy}
              onChange={(event) => setUntracked(event.currentTarget.checked)}
            />
            包含未跟踪文件
          </label>
          <p>勾选文件后只保存这些文件，留空保存全部更改。</p>
          <div class="navigation-files">
            {data?.status.changes
              .filter((change) => !change.conflict)
              .map((change) => (
                <label key={change.path}>
                  <input
                    type="checkbox"
                    checked={paths.includes(change.path)}
                    disabled={busy}
                    onChange={(event) =>
                      setPaths(
                        event.currentTarget.checked
                          ? [...paths, change.path]
                          : paths.filter((path) => path !== change.path),
                      )
                    }
                  />
                  {change.path}
                </label>
              ))}
          </div>
          <button
            disabled={busy || !data?.status.changes.length}
            onClick={() => stashAction('save')}
          >
            保存 Stash
          </button>
        </div>
      )}
      {job && (
        <TransportProgress
          id={job}
          onIdle={(idle) => setBusy(!idle)}
          onDone={async () => {
            await load();
            await onChanged();
          }}
        />
      )}
      {error && (
        <p role="alert" class="error-text">
          {error}
        </p>
      )}
      <div class="modal-actions">
        <button disabled={busy} onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}

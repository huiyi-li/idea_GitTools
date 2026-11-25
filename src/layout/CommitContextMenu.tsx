import type { Commit, Status } from '../api';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { NavigationAction } from '../navigation/types';

export function CommitContextMenu({
  context,
  commits,
  status,
  busy,
  historyDisabled,
  onClose,
  onCopyRevision,
  onSavePatch,
  onSelectCommit,
  onPreviewNavigation,
  onOpenInteractive,
  onCherryPick,
  onRevert,
  onCreateTag,
  onOpenRevisionTree,
}: {
  context: { commit: Commit; x: number; y: number };
  commits: Commit[];
  status: Status | null;
  busy: boolean;
  historyDisabled: boolean;
  onClose: () => void;
  onCopyRevision: () => void;
  onSavePatch: () => void;
  onSelectCommit: (hash: string) => void;
  onPreviewNavigation: (target: string, action?: NavigationAction, creating?: boolean) => void;
  onOpenInteractive: (
    commit: Commit,
    action?: 'reword' | 'fixup' | 'squash' | 'drop',
  ) => void;
  onCherryPick: (commit: Commit) => void;
  onRevert: (commit: Commit) => void;
  onCreateTag: (commit: Commit) => void;
  onOpenRevisionTree: (commit: Commit) => void;
}) {
  const { commit, x, y } = context;
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const positionMenu = () => {
      const bounds = menu.current?.getBoundingClientRect();
      if (!bounds) return;
      setPosition({
        left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
      });
    };
    positionMenu();
    window.addEventListener('resize', positionMenu);
    return () => window.removeEventListener('resize', positionMenu);
  }, [x, y]);
  const child = commits.find((item) => item.parents.includes(commit.hash));
  return (
    <div
      ref={menu}
      class="action-popup commit-context-menu"
      role="menu"
      style={{
        ...position,
        maxHeight: 'calc(100vh - 16px)',
        maxWidth: 'calc(100vw - 16px)',
        overflowY: 'auto',
      }}
    >
      <button role="menuitem" disabled={busy} onClick={onCopyRevision}>
        复制 Revision Number
      </button>
      <button role="menuitem" disabled={busy} onClick={onSavePatch}>
        保存为 Patch…
      </button>
      <button
        role="menuitem"
        disabled={busy}
        onClick={() => {
          onOpenRevisionTree(commit);
          onClose();
        }}
      >
        浏览此提交的完整仓库文件树…
      </button>
      <button
        role="menuitem"
        disabled={busy || !commit.parents[0]}
        onClick={() => {
          const parent = commit.parents[0];
          if (!parent) return;
          onSelectCommit(parent);
          onClose();
        }}
      >
        跳转到父提交
      </button>
      <button
        role="menuitem"
        disabled={busy || !child}
        onClick={() => {
          if (!child) return;
          onSelectCommit(child.hash);
          onClose();
        }}
      >
        跳转到子提交
      </button>
      <hr />
      <button
        role="menuitem"
        disabled={busy || status?.repository.operation !== 'none'}
        onClick={() => onPreviewNavigation(commit.hash)}
      >
        签出此提交…
      </button>
      <button
        role="menuitem"
        disabled={busy || status?.repository.operation !== 'none'}
        onClick={() => onPreviewNavigation(commit.hash, 'checkout', true)}
      >
        从此提交创建分支…
      </button>
      <button
        role="menuitem"
        disabled={busy || !status?.repository.branch || status.repository.operation !== 'none'}
        onClick={() => onPreviewNavigation(commit.hash, 'reset')}
      >
        重置当前分支到此提交…
      </button>
      <hr />
      <button
        role="menuitem"
        disabled={
          busy ||
          !commit.parents[0] ||
          status?.repository.head !== commit.hash ||
          status.repository.operation !== 'none' ||
          !!status.changes.length
        }
        onClick={() => onPreviewNavigation(commit.parents[0] ?? '', 'reset')}
      >
        撤销当前提交…
      </button>
      <button
        role="menuitem"
        disabled={historyDisabled}
        onClick={() => onOpenInteractive(commit, 'reword')}
      >
        编辑提交说明…
      </button>
      <button
        role="menuitem"
        disabled={historyDisabled}
        onClick={() => onOpenInteractive(commit, 'fixup')}
      >
        Fixup 到上一个提交…
      </button>
      <button
        role="menuitem"
        disabled={historyDisabled}
        onClick={() => onOpenInteractive(commit, 'squash')}
      >
        Squash 到上一个提交…
      </button>
      <button
        role="menuitem"
        disabled={historyDisabled}
        onClick={() => onOpenInteractive(commit, 'drop')}
      >
        删除此提交…
      </button>
      <hr />
      <button
        role="menuitem"
        disabled={historyDisabled}
        onClick={() => {
          onClose();
          onCherryPick(commit);
        }}
      >
        Cherry-pick…
      </button>
      <button
        role="menuitem"
        disabled={historyDisabled}
        onClick={() => {
          onClose();
          onRevert(commit);
        }}
      >
        Revert…
      </button>
      <button
        role="menuitem"
        disabled={
          busy ||
          !status?.repository.branch ||
          status.repository.operation !== 'none' ||
          !!status.changes.length
        }
        onClick={() => {
          onClose();
          onOpenInteractive(commit);
        }}
      >
        从此提交开始交互式 Rebase…
      </button>
      <button
        role="menuitem"
        disabled={busy || status?.repository.operation !== 'none'}
        onClick={() => {
          onClose();
          onCreateTag(commit);
        }}
      >
        从此提交创建标签…
      </button>
    </div>
  );
}

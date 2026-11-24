import type { Branch, Details, Status } from '../api';
import type { OperationPreview } from '../HistoryDialog';
import type { SettingsSection } from '../SettingsModal';

export type ActiveModal =
  | { kind: 'none' }
  | { kind: 'settings'; section?: SettingsSection }
  | { kind: 'command-palette' }
  | { kind: 'workspace' }
  | { kind: 'clone'; initialUrl?: string }
  | { kind: 'remotes' }
  | {
      kind: 'manager';
      tab: 'branches' | 'tags' | 'stashes' | 'shelves';
      stash?: Status['stashes'][number];
      revision?: string;
    }
  | { kind: 'branch-edit'; branch: Branch; action: 'rename' | 'delete' }
  | { kind: 'worktrees' }
  | { kind: 'ignore'; path: string }
  | { kind: 'hunks'; path: string; area: 'staged' | 'unstaged' }
  | { kind: 'amend' }
  | {
      kind: 'interactive';
      base: string;
      action?: { hash: string; action: 'reword' | 'fixup' | 'squash' | 'drop' };
    }
  | {
      kind: 'file-history';
      tab: 'history' | 'blame' | 'selection' | 'tree';
      revision?: string | null;
    }
  | { kind: 'local-history'; path: string }
  | { kind: 'multi-repo' }
  | { kind: 'diagnostics' }
  | { kind: 'bisect' }
  | { kind: 'submodules' }
  | { kind: 'transfer'; action: 'fetch' | 'pull' | 'push' }
  | { kind: 'operation'; preview: OperationPreview }
  | { kind: 'revision-input'; value: string }
  | { kind: 'recovery' }
  | { kind: 'compare'; branch: string }
  | { kind: 'quick-dialog'; dialogKind: 'branch' | 'stash' | 'shelf'; value: string }
  | { kind: 'in-memory-edit'; details: Details };

export const NO_MODAL: ActiveModal = { kind: 'none' };

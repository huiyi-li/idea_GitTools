export type NavigationAction = 'checkout' | 'reset';
export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep';
export type LocalStrategy = 'normal' | 'backup' | 'force';

export interface NavigationPreview {
  root: string;
  action: NavigationAction;
  target: string;
  targetHash: string;
  expectedHead: string | null;
  expectedBranch: string | null;
  fingerprint: string;
  localBranches: string[];
  remote: boolean;
  local: boolean;
  suggestedBranch: string;
  worktreePath: string | null;
  changes: { path: string; status: string }[];
  localChanges: string[];
  untrackedOverwrites: string[];
  leaving: { hash: string; subject: string }[];
  leavingCount: number;
}

export interface NavigationRequest {
  preview: NavigationPreview;
  mode: ResetMode;
  strategy: LocalStrategy;
  newBranch: string | null;
}

export interface OperationRecord {
  id: string;
  action: NavigationAction;
  originalHead: string | null;
  originalBranch: string | null;
  targetHash: string;
  phase: string;
  stashSha: string | null;
  error: string | null;
  failureKind: string | null;
  blockedFiles: string[];
}

export interface NavigationResult {
  completed: boolean;
  kind: string;
  message: string;
  blockedFiles: string[];
  record: OperationRecord | null;
}

export interface RecoveryOverview {
  records: OperationRecord[];
  operation: string;
  originalHead: string | null;
  current: string | null;
  progress: string | null;
  reason: string;
}

export interface ReflogEntry { hash: string; reference: string; subject: string }

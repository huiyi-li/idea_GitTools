import { invoke } from '@tauri-apps/api/core';

export interface Repository {
  root: string;
  name: string;
  branch: string | null;
  head: string | null;
  operation: string;
}

export interface Change {
  path: string;
  oldPath: string | null;
  index: string;
  workTree: string;
  conflict: boolean;
}

export interface Branch {
  name: string;
  full: string;
  hash: string;
  current: boolean;
  remote: boolean;
  upstream: string;
}

export interface Status {
  repository: Repository;
  changes: Change[];
  branches: Branch[];
  stashes: { reference: string; hash: string; message: string }[];
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  refs: string[];
}

export interface LogPage {
  commits: Commit[];
  hasMore: boolean;
}

export interface Details {
  commit: Commit;
  body: string;
  changes: Change[];
}

export interface DiffTarget {
  path: string;
  oldPath: string | null;
  revision: string | null;
  beforeRevision?: string;
  area?: 'staged' | 'unstaged';
}

export type HistoryAction = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface HistoryRequest {
  action: HistoryAction;
  target: string;
  targetHash: string;
  expectedHead: string;
  expectedBranch: string;
  mergeMode: 'auto' | 'no-ff' | 'ff-only' | 'squash';
  mainline: number | null;
}

export interface BranchComparison {
  base: string;
  target: string;
  baseName: string;
  targetName: string;
  baseOnly: number;
  targetOnly: number;
  changes: Change[];
}

export interface FileDiff {
  before: string;
  after: string;
  binary: boolean;
  tooLarge: boolean;
  canLoad?: boolean;
  large?: boolean;
  reason?: string;
}

export function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>(command, args);
}

export function readSaved<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function staged(change: Change) {
  return change.index !== ' ' && change.index !== '?' && !change.conflict;
}

export function unstaged(change: Change) {
  return change.workTree !== ' ' || change.index === '?' || change.conflict;
}

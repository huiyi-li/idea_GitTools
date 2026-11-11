import type { PreparedDiff } from '../merge/analysis';

export type SnapshotState =
  'text' | 'missing' | 'binary' | 'too-large' | 'encoding' | 'submodule' | 'unavailable';
export interface FileSnapshot {
  path: string;
  revision: string | null;
  state: SnapshotState;
  text: string;
  fingerprint: string;
  reason?: string;
  size?: number;
  large?: boolean;
  canLoad?: boolean;
}
export interface WorktreeSnapshot {
  file: FileSnapshot;
  branch: string;
  head: string | null;
}
export interface CommitReview {
  revision: string;
  parent: string | null;
  before: FileSnapshot;
  after: FileSnapshot;
  current: WorktreeSnapshot;
}
export interface ReviewDiffs {
  commit?: PreparedDiff;
  current?: PreparedDiff;
}
export type Pane = 'before' | 'after' | 'current';
export type Scope = 'commit' | 'current';
export const readable = (snapshot: FileSnapshot) =>
  snapshot.state === 'text' || snapshot.state === 'missing';
export const snapshotMessage: Record<SnapshotState, string> = {
  text: '',
  missing: '此版本不存在该文件',
  binary: '二进制文件',
  'too-large': '文件超过自动加载阈值',
  encoding: '文件编码不支持 UTF-8',
  submodule: '子模块或目录',
  unavailable: '当前文件无法读取',
};

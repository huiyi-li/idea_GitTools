export type Provider = 'github' | 'gitlab';

export interface Account {
  id: string;
  provider: Provider;
  server: string;
  userId: string;
  login: string;
}

export interface HostedRepository {
  id: string;
  path: string;
  name: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  webUrl: string;
  sshUrl: string;
  httpsUrl: string;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

export interface ReviewRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  draft: boolean;
  sourceBranch: string;
  sourceRepository: string;
  targetBranch: string;
  headSha: string;
  baseSha: string;
  webUrl: string;
  updatedAt: string;
  mergeStatus: string;
}

export interface ReviewFile {
  path: string;
  oldPath: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface ReviewCommit {
  sha: string;
  title: string;
  author: string;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface Check {
  name: string;
  state: string;
  webUrl: string;
}

export const providerName = (provider: Provider) => (provider === 'github' ? 'GitHub' : 'GitLab');
export const reviewName = (provider: Provider) => (provider === 'github' ? 'PR' : 'MR');

export function stateLabel(review: ReviewRequest) {
  if (review.state === 'merged') return '已合并';
  if (review.state === 'closed') return '已关闭';
  return review.draft ? '草稿' : '待合并';
}

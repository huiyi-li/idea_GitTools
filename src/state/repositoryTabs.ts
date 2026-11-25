export interface RepositoryTab {
  root: string;
  name: string;
  relativePath?: string;
  workspaceRoot?: string;
}

export interface WorkspaceMeta {
  root: string;
  truncated: boolean;
  warnings: string[];
}

export interface PersistedTabsState {
  version: 1;
  tabs: RepositoryTab[];
  activeRoot: string;
  workspaceMeta: WorkspaceMeta | null;
}

export interface PersistedTabSession {
  view: 'log' | 'changes';
  branch: string;
  activeChangeList: string;
}

export const OPEN_TABS_KEY = 'ideagittool.openTabs.v1';
export const TAB_SESSIONS_KEY = 'ideagittool.tabSessions.v1';
const MAX_PERSISTED_SESSIONS = 50;

function normalizeTab(raw: unknown): RepositoryTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.root !== 'string' || !candidate.root.trim()) return null;
  const fallbackName = candidate.root.replaceAll('\\', '/').split('/').filter(Boolean).pop() || candidate.root;
  const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : fallbackName;
  const tab: RepositoryTab = { root: candidate.root, name };
  if (typeof candidate.relativePath === 'string' && candidate.relativePath.trim()) {
    tab.relativePath = candidate.relativePath;
  }
  if (typeof candidate.workspaceRoot === 'string' && candidate.workspaceRoot.trim()) {
    tab.workspaceRoot = candidate.workspaceRoot;
  }
  return tab;
}

function normalizeWorkspaceMeta(raw: unknown): WorkspaceMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.root !== 'string' || !candidate.root.trim()) return null;
  return {
    root: candidate.root,
    truncated: Boolean(candidate.truncated),
    warnings: Array.isArray(candidate.warnings)
      ? candidate.warnings.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function deduplicateTabs(tabs: RepositoryTab[]): RepositoryTab[] {
  const seen = new Set<string>();
  const result: RepositoryTab[] = [];
  for (const tab of tabs) {
    if (!tab.root || seen.has(tab.root)) continue;
    seen.add(tab.root);
    result.push(tab);
  }
  return result;
}

export function hasPersistedTabsState(): boolean {
  try {
    return globalThis.localStorage?.getItem(OPEN_TABS_KEY) !== null;
  } catch {
    return false;
  }
}

export function readPersistedTabsState(): PersistedTabsState | null {
  try {
    const raw = globalThis.localStorage?.getItem(OPEN_TABS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null;
    const tabs = Array.isArray(parsed.tabs)
      ? deduplicateTabs(parsed.tabs.map(normalizeTab).filter((tab): tab is RepositoryTab => tab !== null))
      : [];
    const activeCandidate = typeof parsed.activeRoot === 'string' ? parsed.activeRoot : '';
    const activeRoot = tabs.some((tab) => tab.root === activeCandidate) ? activeCandidate : '';
    const workspaceMeta = normalizeWorkspaceMeta(parsed.workspaceMeta);
    return {
      version: 1,
      tabs,
      activeRoot,
      workspaceMeta,
    };
  } catch {
    return null;
  }
}

export function savePersistedTabsState(state: PersistedTabsState): void {
  const tabs = deduplicateTabs(state.tabs);
  const activeRoot = tabs.some((tab) => tab.root === state.activeRoot) ? state.activeRoot : '';
  const payload: PersistedTabsState = {
    version: 1,
    tabs,
    activeRoot,
    workspaceMeta: state.workspaceMeta ? normalizeWorkspaceMeta(state.workspaceMeta) : null,
  };
  globalThis.localStorage?.setItem(OPEN_TABS_KEY, JSON.stringify(payload));
}

export function readPersistedTabSessions(): Record<string, PersistedTabSession> {
  try {
    const raw = globalThis.localStorage?.getItem(TAB_SESSIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const sessions: Record<string, PersistedTabSession> = {};
    for (const [root, value] of Object.entries(parsed)) {
      if (!root || !value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      sessions[root] = {
        view: item.view === 'changes' ? 'changes' : 'log',
        branch: typeof item.branch === 'string' ? item.branch : '',
        activeChangeList: typeof item.activeChangeList === 'string' ? item.activeChangeList : '',
      };
    }
    return sessions;
  } catch {
    return {};
  }
}

export function savePersistedTabSession(root: string, session: PersistedTabSession): void {
  if (!root) return;
  try {
    const current = readPersistedTabSessions();
    delete current[root];
    current[root] = {
      view: session.view === 'changes' ? 'changes' : 'log',
      branch: typeof session.branch === 'string' ? session.branch : '',
      activeChangeList: typeof session.activeChangeList === 'string' ? session.activeChangeList : '',
    };
    const entries = Object.entries(current);
    const trimmed =
      entries.length > MAX_PERSISTED_SESSIONS
        ? Object.fromEntries(entries.slice(entries.length - MAX_PERSISTED_SESSIONS))
        : current;
    globalThis.localStorage?.setItem(TAB_SESSIONS_KEY, JSON.stringify(trimmed));
  } catch {
    /* Session persistence failure should not block UI interaction. */
  }
}

export function removePersistedTabSession(root: string): void {
  if (!root) return;
  try {
    const current = readPersistedTabSessions();
    if (!(root in current)) return;
    delete current[root];
    globalThis.localStorage?.setItem(TAB_SESSIONS_KEY, JSON.stringify(current));
  } catch {
    /* Ignore storage errors when cleaning up session state. */
  }
}

export function upsertRepositoryTab(tabs: RepositoryTab[], incoming: RepositoryTab): RepositoryTab[] {
  const index = tabs.findIndex((tab) => tab.root === incoming.root);
  if (index === -1) {
    return [...tabs, { ...incoming }];
  }
  const existing = tabs[index];
  const merged: RepositoryTab = {
    root: existing.root,
    name: incoming.name || existing.name,
    ...(incoming.relativePath ?? existing.relativePath ? { relativePath: incoming.relativePath ?? existing.relativePath } : {}),
    ...(incoming.workspaceRoot ?? existing.workspaceRoot ? { workspaceRoot: incoming.workspaceRoot ?? existing.workspaceRoot } : {}),
  };
  const next = [...tabs];
  next[index] = merged;
  return next;
}

export function mergeRepositoryTabs(tabs: RepositoryTab[], incoming: RepositoryTab[]): RepositoryTab[] {
  let result = tabs;
  for (const tab of incoming) {
    result = upsertRepositoryTab(result, tab);
  }
  return result;
}

export function removeRepositoryTab(
  tabs: RepositoryTab[],
  targetRoot: string,
  activeRoot: string,
): { tabs: RepositoryTab[]; nextActiveRoot: string } {
  const index = tabs.findIndex((tab) => tab.root === targetRoot);
  if (index === -1) {
    return { tabs, nextActiveRoot: activeRoot };
  }
  const nextTabs = tabs.filter((tab) => tab.root !== targetRoot);
  if (targetRoot !== activeRoot) {
    return { tabs: nextTabs, nextActiveRoot: activeRoot };
  }
  if (!nextTabs.length) {
    return { tabs: [], nextActiveRoot: '' };
  }
  const nextIndex = Math.min(index, nextTabs.length - 1);
  return { tabs: nextTabs, nextActiveRoot: nextTabs[nextIndex].root };
}

export function removeOtherTabs(
  tabs: RepositoryTab[],
  keepRoot: string,
): { tabs: RepositoryTab[]; nextActiveRoot: string } {
  const kept = tabs.find((tab) => tab.root === keepRoot);
  if (!kept) {
    return { tabs: [], nextActiveRoot: '' };
  }
  return { tabs: [kept], nextActiveRoot: kept.root };
}

export function removeTabsToRight(
  tabs: RepositoryTab[],
  pivotRoot: string,
  activeRoot: string,
): { tabs: RepositoryTab[]; nextActiveRoot: string } {
  const pivotIndex = tabs.findIndex((tab) => tab.root === pivotRoot);
  if (pivotIndex === -1) {
    return { tabs, nextActiveRoot: activeRoot };
  }
  const nextTabs = tabs.slice(0, pivotIndex + 1);
  const activeStillPresent = nextTabs.some((tab) => tab.root === activeRoot);
  return {
    tabs: nextTabs,
    nextActiveRoot: activeStillPresent ? activeRoot : pivotRoot,
  };
}

export function reorderRepositoryTabs(
  tabs: RepositoryTab[],
  fromRoot: string,
  toRoot: string,
): RepositoryTab[] {
  if (fromRoot === toRoot) return tabs;
  const fromIndex = tabs.findIndex((tab) => tab.root === fromRoot);
  const toIndex = tabs.findIndex((tab) => tab.root === toRoot);
  if (fromIndex === -1 || toIndex === -1) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function splitPathSegments(path: string): string[] {
  return path.replaceAll('\\', '/').split('/').filter(Boolean);
}

export function formatRepositoryTabLabel(tab: RepositoryTab, allTabs: RepositoryTab[]): string {
  const sameNameTabs = allTabs.filter((item) => item.name === tab.name);
  if (sameNameTabs.length <= 1) {
    return tab.name;
  }
  if (tab.relativePath && tab.relativePath !== '.') {
    return `${tab.name} · ${tab.relativePath}`;
  }
  const targetSegments = splitPathSegments(tab.root);
  const peerSegments = sameNameTabs
    .filter((item) => item.root !== tab.root)
    .map((item) => splitPathSegments(item.root));
  let depth = 2;
  while (depth < targetSegments.length) {
    const suffix = targetSegments.slice(-depth).join('/');
    const collides = peerSegments.some((segments) => segments.slice(-depth).join('/') === suffix);
    if (!collides) {
      return `${tab.name} · ${suffix}`;
    }
    depth++;
  }
  return `${tab.name} · ${tab.root}`;
}

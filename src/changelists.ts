import { readSaved, save } from './api';

export interface ChangeListGroup {
  id: string;
  name: string;
  paths: string[];
}

const key = (root: string) => `changelists.${root}`;

export function readChangeLists(root: string): ChangeListGroup[] {
  const value = readSaved<unknown>(key(root), []);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ChangeListGroup[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.name !== 'string' || !Array.isArray(record.paths)) return [];
    return [{ id: record.id, name: record.name, paths: record.paths.filter((path): path is string => typeof path === 'string') }];
  });
}

export function writeChangeLists(root: string, lists: ChangeListGroup[]) {
  save(key(root), lists);
}

export function changeListPath(change: { path: string; oldPath: string | null }): string[] {
  return change.oldPath ? [change.path, change.oldPath] : [change.path];
}


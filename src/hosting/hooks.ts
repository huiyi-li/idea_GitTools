import { useEffect, useRef, useState } from 'preact/hooks';
import { call } from '../api';
import type { Page } from './types';

// The key travels with each result so an old account's data cannot flash in a new view.
export function useRemote<T>(command: string, args: Record<string, unknown>, enabled = true) {
  const key = JSON.stringify([command, args]);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    value?: T;
    error?: string;
    loading: boolean;
  }>();
  const generation = useRef(0);
  useEffect(() => {
    const id = ++generation.current;
    if (!enabled) return;
    const requestId = `${Date.now()}-${Math.random()}`;
    let sent = false;
    setResult({ key, loading: true });
    const timer = setTimeout(() => {
      sent = true;
      void call<T>('hosting_read', {
        requestId,
        request: { kind: command.replace(/^hosting_/, ''), ...args },
      }).then(
        (value) => {
          if (generation.current === id) setResult({ key, value, loading: false });
        },
        (error) => {
          if (generation.current === id) setResult({ key, error: String(error), loading: false });
        },
      );
    }, 100);
    return () => {
      clearTimeout(timer);
      generation.current++;
      if (sent) void call('hosting_cancel_read', { requestId }).catch(() => {});
    };
  }, [key, revision, enabled]);
  const current = enabled && result?.key === key ? result : undefined;
  return {
    value: current?.value,
    error: current?.error,
    loading: enabled && (!current || current.loading),
    reload: () => setRevision((value) => value + 1),
  };
}

export function useRemotePage<T>(command: string, args: Record<string, unknown>) {
  const key = JSON.stringify([command, args]);
  const [cursor, setCursor] = useState({ key, page: 1 });
  const page = cursor.key === key ? cursor.page : 1;
  const data = useRemote<Page<T>>(command, { ...args, page });
  return {
    ...data,
    page,
    previous: () => setCursor({ key, page: Math.max(1, page - 1) }),
    next: () => setCursor({ key, page: page + 1 }),
  };
}

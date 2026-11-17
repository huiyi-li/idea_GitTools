import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { call } from '../api';

export function useRepositoryRead<T>(command: string, root: string) {
  const generation = useRef(0);
  const active = useRef(true);
  const currentRoot = useRef(root);
  currentRoot.current = root;
  const [state, setState] = useState<{ root: string; data?: T; loading: boolean; error: string }>({ root, loading: true, error: '' });
  const isCurrent = useCallback(() => active.current && currentRoot.current === root, [root]);
  const reload = useCallback(async () => {
    if (!isCurrent()) return false;
    const request = ++generation.current;
    setState({ root, loading: true, error: '' });
    try {
      const data = await call<T>(command, { root });
      if (!isCurrent() || request !== generation.current) return false;
      setState({ root, data, loading: false, error: '' });
      return true;
    } catch (error) {
      if (isCurrent() && request === generation.current) setState({ root, loading: false, error: String(error) });
      return false;
    }
  }, [command, root, isCurrent]);
  useEffect(() => {
    active.current = true;
    void reload();
    return () => { active.current = false; generation.current++; };
  }, [reload]);
  return { ...(state.root === root ? state : { data: undefined, loading: true, error: '' }), reload, isCurrent };
}

import { useEffect, useState } from 'preact/hooks';

const key = 'editor.minimap.enabled';
const changed = 'editor-minimap-changed';
let enabled = readPreference();

function readPreference() {
  try {
    return globalThis.localStorage?.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function setMinimapEnabled(value: boolean) {
  enabled = value;
  try {
    globalThis.localStorage?.setItem(key, String(value));
  } catch {
    // The toggle still works for this session if storage is unavailable.
  }
  window.dispatchEvent(new window.Event(changed));
}

export function useMinimapPreference(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(enabled);
  useEffect(() => {
    const update = () => setValue(enabled);
    const stored = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      enabled = readPreference();
      update();
    };
    window.addEventListener(changed, update);
    window.addEventListener('storage', stored);
    update();
    return () => {
      window.removeEventListener(changed, update);
      window.removeEventListener('storage', stored);
    };
  }, []);
  return [value, setMinimapEnabled];
}

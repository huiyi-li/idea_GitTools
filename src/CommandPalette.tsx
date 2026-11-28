import { useEffect, useMemo, useState } from 'preact/hooks';
import { useI18n } from './i18n';
import { Icon, Modal } from './ui/controls';
import { Kbd } from './ui/primitives';
import './command-palette.css';

export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  keywords?: string;
  shortcut?: string;
  icon?: string;
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = commands.filter((cmd) => !cmd.disabled);
    if (!q) return available;
    return available.filter((cmd) =>
      `${cmd.label} ${cmd.category} ${cmd.keywords ?? ''}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function runCommand(cmd?: PaletteCommand) {
    if (!cmd) return;
    onClose();
    cmd.run();
  }

  return (
    <Modal title="命令面板" onClose={onClose} class="command-palette-modal">
      <div class="command-palette-search">
        <Icon name="general/search" />
        <input
          autoFocus
          aria-label="搜索命令、工具或分支"
          placeholder={t('palette.placeholder')}
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((prev) => (filtered.length ? (prev + 1) % filtered.length : 0));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((prev) =>
                filtered.length ? (prev - 1 + filtered.length) % filtered.length : 0,
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              runCommand(filtered[activeIndex]);
            }
          }}
        />
        <Kbd>Esc</Kbd>
      </div>
      <div class="command-palette-list" role="listbox" aria-label="匹配命令列表">
        {filtered.map((cmd, idx) => (
          <button
            key={cmd.id}
            type="button"
            role="option"
            aria-selected={idx === activeIndex}
            class={`command-palette-item ${idx === activeIndex ? 'active' : ''}`}
            onMouseEnter={() => setActiveIndex(idx)}
            onClick={() => runCommand(cmd)}
          >
            <span class="command-palette-item-main">
              {cmd.icon && <Icon name={cmd.icon} />}
              <span class="ellipsis">{cmd.label}</span>
            </span>
            <span class="command-palette-item-meta">
              <span class="ui-badge">{cmd.category}</span>
              {cmd.shortcut && <Kbd>{cmd.shortcut}</Kbd>}
            </span>
          </button>
        ))}
        {!filtered.length && <div class="command-palette-empty">{t('palette.empty')}</div>}
      </div>
    </Modal>
  );
}

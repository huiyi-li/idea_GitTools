import type { ComponentChildren, JSX, Ref } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

const icons = import.meta.glob('./icons/**/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export function Icon({ name, class: className = '' }: { name: string; class?: string }) {
  const light = icons[`./icons/${name}.svg`];
  const dark = icons[`./icons/${name}_dark.svg`] ?? light;
  return (
    <span class={`ui-icon ${className}`} aria-hidden="true">
      <img class="icon-light" src={light} alt="" draggable={false} />
      <img class="icon-dark" src={dark} alt="" draggable={false} />
    </span>
  );
}

const fileTypes: Record<string, string> = {
  ts: 'typeScript',
  tsx: 'typeScript',
  js: 'javaScript',
  jsx: 'javaScript',
  mjs: 'javaScript',
  json: 'json',
  rs: 'rust',
  py: 'python',
  md: 'markdown',
  xml: 'xml',
  svg: 'xml',
  html: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  c: 'c',
  cpp: 'cpp',
  h: 'h',
  hpp: 'h',
  gitignore: 'gitignore',
};

export function FileIcon({ path }: { path: string }) {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return <Icon name={'fileTypes/' + (fileTypes[extension] ?? 'text')} />;
}

export function ToolButton({
  icon,
  label,
  active,
  children,
  buttonRef,
  ...props
}: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: string;
  label: string;
  active?: boolean;
  children?: ComponentChildren;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      {...props}
      class={`tool-button ${active ? 'active' : ''} ${props.class ?? ''}`}
      title={props.title ?? label}
      aria-label={label}
      aria-pressed={active}
    >
      <Icon name={icon} />
      {children}
    </button>
  );
}

export function ActionMenu({
  label,
  icon = 'general/moreHorizontal',
  text,
  disabled,
  children,
}: {
  label: string;
  icon?: string;
  text?: string;
  disabled?: boolean;
  children: ComponentChildren;
}) {
  const [opened, setOpened] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!opened || !trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = popup.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top: Math.max(
        8,
        anchor.bottom + bounds.height + 4 <= window.innerHeight
          ? anchor.bottom + 4
          : anchor.top - bounds.height - 4,
      ),
    });
    popup.current.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus();
  }, [opened]);
  useEffect(() => {
    if (!opened) return;
    const outside = (event: PointerEvent) => {
      if (
        !container.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        setOpened(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpened(false);
        trigger.current?.focus();
      }
    };
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) setOpened(false);
    };
    const resize = () => setOpened(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [opened]);
  return (
    <div class="action-menu" ref={container}>
      <ToolButton
        buttonRef={trigger}
        icon={icon}
        label={label}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={opened}
        active={opened}
        onClick={() => setOpened(!opened)}
      >
        {text && (
          <>
            <span>{text}</span>
            <Icon name="general/chevronDown" />
          </>
        )}
      </ToolButton>
      {opened &&
        createPortal(
          <div
            ref={popup}
            class="action-popup"
            style={position}
            role="group"
            aria-label={label}
            onKeyDown={(event) => {
              if (event.key === 'Tab') {
                setOpened(false);
                trigger.current?.focus();
                return;
              }
              const items = Array.from(
                popup.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ??
                  [],
              );
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const index = items.indexOf(document.activeElement as HTMLElement);
                items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
              }
            }}
            onClick={(event) => {
              if ((event.target as Element).closest('button')) {
                setOpened(false);
                trigger.current?.focus();
              }
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  busy = false,
  class: className = '',
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  class?: string;
  children: ComponentChildren;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>('select, input, textarea, button:not(:disabled)')?.focus(),
    );
    return () => {
      cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      class="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panel}
        class={'modal ' + className}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onClose();
          }
          if (event.key === 'Tab') {
            const controls = Array.from(
              panel.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
              ),
            );
            const first = controls[0],
              last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function Split({
  children,
  vertical = false,
  second = false,
  initial,
  min = 140,
  storageKey,
  label,
  hideSecond = false,
}: {
  children: [ComponentChildren, ComponentChildren];
  vertical?: boolean;
  second?: boolean;
  initial: number;
  min?: number;
  storageKey: string;
  label: string;
  hideSecond?: boolean;
}) {
  const [size, setSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(`split.${storageKey}`));
      return Number.isFinite(saved) && saved >= min ? saved : initial;
    } catch {
      return initial;
    }
  });
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; start: number; size: number }>();
  const limit = (value: number) => {
    const bounds = root.current?.getBoundingClientRect();
    const length = bounds ? (vertical ? bounds.height : bounds.width) : min * 2;
    return Math.max(min, Math.min(value, length - min - 5));
  };
  const remember = (value: number) => {
    try {
      localStorage.setItem(`split.${storageKey}`, String(value));
    } catch {
      /* The layout still works when storage is unavailable. */
    }
  };
  const fixed = { flex: `0 0 clamp(${min}px, ${size}px, calc(100% - ${min + 5}px))` };
  return (
    <div ref={root} class={`split ${vertical ? 'vertical' : 'horizontal'}`}>
      <div class="split-pane" style={!hideSecond && !second ? fixed : undefined}>
        {children[0]}
      </div>
      <div
        class="split-handle"
        hidden={hideSecond}
        style={hideSecond ? { display: 'none' } : undefined}
        role="separator"
        tabIndex={hideSecond ? -1 : 0}
        aria-label={label}
        aria-orientation={vertical ? 'horizontal' : 'vertical'}
        aria-valuemin={min}
        aria-valuenow={Math.round(size)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const pane = root.current!.children[second ? 2 : 0].getBoundingClientRect();
          drag.current = {
            id: event.pointerId,
            start: vertical ? event.clientY : event.clientX,
            size: vertical ? pane.height : pane.width,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current || drag.current.id !== event.pointerId) return;
          const delta = (vertical ? event.clientY : event.clientX) - drag.current.start;
          setSize(limit(drag.current.size + delta * (second ? -1 : 1)));
        }}
        onLostPointerCapture={() => {
          if (drag.current) remember(size);
          drag.current = undefined;
        }}
        onPointerUp={(event) => {
          if (drag.current?.id === event.pointerId)
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onDblClick={() => {
          setSize(initial);
          remember(initial);
        }}
        onKeyDown={(event) => {
          const negative = vertical ? 'ArrowUp' : 'ArrowLeft';
          const positive = vertical ? 'ArrowDown' : 'ArrowRight';
          if (event.key !== negative && event.key !== positive) return;
          event.preventDefault();
          const next = limit(size + (event.key === positive ? 16 : -16) * (second ? -1 : 1));
          setSize(next);
          remember(next);
        }}
      />
      <div class="split-pane" hidden={hideSecond} style={hideSecond ? { display: 'none' } : second ? fixed : undefined}>
        {children[1]}
      </div>
    </div>
  );
}

import type { ComponentChildren } from 'preact';
import './primitives.css';

export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      class="ui-switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span class="ui-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div class="ui-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          class="ui-segmented-option"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ComponentChildren;
}) {
  return (
    <div class="ui-settings-row">
      <div class="ui-settings-row-info">
        <span class="ui-settings-row-title">{title}</span>
        {description && <span class="ui-settings-row-desc">{description}</span>}
      </div>
      <div class="ui-settings-row-control">{children}</div>
    </div>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="ui-kbd">{children}</kbd>;
}

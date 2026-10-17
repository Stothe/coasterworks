import { Kbd } from "./Kbd";

export interface SegmentedOption<T extends string = string> {
  id: T;
  label: string;
  /** Shown as a hint beside the label and announced as the button's key. */
  shortcut?: string;
}

export interface SegmentedProps<T extends string = string> {
  /** Names the group for assistive technology. */
  label: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange(id: T): void;
  /** Turns every option off. */
  disabled?: boolean;
}

/** A row of buttons of which one is on, such as the speeds. */
export function Segmented<T extends string = string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-lg bg-white/5 p-[3px]"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          // The name is the label alone; the shortcut is a hint, not part of it.
          aria-label={option.label}
          aria-pressed={value === option.id}
          aria-keyshortcuts={option.shortcut}
          disabled={disabled}
          onClick={() => onChange(option.id)}
          className="hud-button min-w-8 gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted aria-pressed:bg-white/15 aria-pressed:text-ink"
        >
          {option.label}
          {option.shortcut !== undefined && <Kbd>{option.shortcut}</Kbd>}
        </button>
      ))}
    </div>
  );
}

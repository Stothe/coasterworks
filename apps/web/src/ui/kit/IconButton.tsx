import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export interface IconButtonProps {
  /** The button's name for assistive technology, and the text of its tooltip. */
  label: string;
  icon: ReactNode;
  onClick(): void;
  disabled?: boolean;
  /** Makes it a toggle: true when it is on. Leave it out for a plain button. */
  pressed?: boolean;
  /** What the tooltip says, when that is more than the label: `Coming soon` on a disabled button. */
  tooltip?: string;
}

/** A button that shows an icon, with its label in a tooltip. At least 32px square. */
export function IconButton({
  label,
  icon,
  onClick,
  disabled = false,
  pressed,
  tooltip = label,
}: IconButtonProps) {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="hud-button min-w-8 rounded-lg px-1.5 text-muted hover:text-ink disabled:pointer-events-none aria-pressed:bg-white/15 aria-pressed:text-ink"
    >
      {icon}
    </button>
  );
  return (
    // Each button brings its own provider so it works anywhere; the delay is the same everywhere.
    <Tooltip.Provider delayDuration={400}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          {disabled ? (
            // A disabled button hears no pointer, so the tooltip hangs on a span around it.
            <span className="inline-flex cursor-not-allowed">{button}</span>
          ) : (
            button
          )}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="glass z-50 px-2 py-1 text-xs text-ink select-none"
          >
            {tooltip}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

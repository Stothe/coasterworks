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
}

/** A button that shows an icon, with its label in a tooltip. At least 32px square. */
export function IconButton({ label, icon, onClick, disabled = false, pressed }: IconButtonProps) {
  return (
    // Each button brings its own provider so it works anywhere; the delay is the same everywhere.
    <Tooltip.Provider delayDuration={400}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className="hud-button min-w-8 rounded-lg px-1.5 text-muted hover:text-ink aria-pressed:bg-white/15 aria-pressed:text-ink"
          >
            {icon}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="glass z-50 px-2 py-1 text-xs text-ink select-none"
          >
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

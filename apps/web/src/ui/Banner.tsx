export interface BannerProps {
  text: string;
  /** A button beside the text, such as Resume. */
  action?: { label: string; onClick(): void; disabled?: boolean };
}

/**
 * A message that stays until what it reports is over: unlike a toast it has no timer and no close
 * button. For a stopped simulation or a lost connection, which the player must not miss.
 */
export function Banner({ text, action }: BannerProps) {
  return (
    <div
      role="alert"
      className="glass pointer-events-auto flex max-w-xl items-center gap-3 py-1.5 pr-1.5 pl-4 text-sm"
    >
      <span className="flex-1 py-1 text-[#ffb4b4]">{text}</span>
      {action && (
        <button
          type="button"
          disabled={action.disabled}
          onClick={action.onClick}
          className="hud-button rounded-lg bg-accent px-3 font-medium text-white"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

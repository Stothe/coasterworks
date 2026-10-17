import * as Popover from "@radix-ui/react-popover";
import { useRef, useState, type ReactNode } from "react";
import { PIXEL_RATIO_CAPS, useSettings } from "../state/settings";
import { IconButton, Segmented } from "./kit";

export interface TopRightProps {
  /** Agent events and errors since the notifications were last opened. */
  unread: number;
  /** The bell was pressed: show what has happened. */
  onOpenNotifications(): void;
  /** The search button was pressed: open the command bar. */
  onOpenSearch(): void;
  /** Turns search off, for a park that has lost its connection. */
  disabled?: boolean;
}

/** The most a badge counts to before it says `9+`. */
const BADGE_MAX = 9;

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

const SparkIcon = () => (
  <Icon>
    <path
      d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </Icon>
);

const SearchIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </Icon>
);

const GearIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
    <path
      d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </Icon>
);

/** The bell, and over its corner how many things have happened since it was last pressed. */
function BellIcon({ unread }: { unread: number }) {
  return (
    <span className="relative inline-flex">
      <Icon>
        <path
          d="M4 11V7.5a4 4 0 0 1 8 0V11l1.2 1.5H2.8Z M6.5 14a1.6 1.6 0 0 0 3 0"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </Icon>
      {unread > 0 && (
        <span
          data-testid="unread-count"
          aria-hidden="true"
          className="absolute -top-2 -right-2.5 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] leading-4 font-semibold text-white"
        >
          {unread > BADGE_MAX ? `${BADGE_MAX}+` : unread}
        </span>
      )}
    </span>
  );
}

const CAP_OPTIONS = PIXEL_RATIO_CAPS.map((cap) => ({ id: String(cap), label: String(cap) }));

/** What the settings popover holds: the pixel ratio cap and Show FPS. */
function SettingsPanel() {
  const cap = useSettings((state) => state.pixelRatioCap);
  const showFps = useSettings((state) => state.showFps);
  const setCap = useSettings((state) => state.setPixelRatioCap);
  const setShowFps = useSettings((state) => state.setShowFps);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Pixel ratio cap</span>
        <Segmented
          label="Pixel ratio cap"
          options={CAP_OPTIONS}
          value={String(cap)}
          onChange={(id) => {
            const next = PIXEL_RATIO_CAPS.find((choice) => String(choice) === id);
            if (next !== undefined) setCap(next);
          }}
        />
        <span className="text-xs text-muted">Applies the next time the park loads.</span>
      </div>
      <label className="hud-button justify-start gap-2 rounded-lg text-sm">
        <input
          type="checkbox"
          checked={showFps}
          onChange={(e) => setShowFps(e.target.checked)}
          className="size-4 accent-accent"
        />
        Show FPS
      </label>
    </div>
  );
}

/** The settings button, and the small panel it opens under itself. */
function Settings() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor ref={anchor} className="inline-flex">
        <IconButton
          label="Settings"
          icon={<GearIcon />}
          pressed={open}
          onClick={() => setOpen((now) => !now)}
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          aria-label="Settings"
          align="end"
          sideOffset={8}
          // The button toggles the panel itself: a press on it must not also count as outside.
          onInteractOutside={(e) => {
            if (e.target instanceof Node && anchor.current?.contains(e.target)) e.preventDefault();
          }}
          // There is no Popover.Trigger to give the focus back to, so it goes to the button.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            anchor.current?.querySelector("button")?.focus();
          }}
          className="glass z-50 w-60 p-3 text-ink"
        >
          <SettingsPanel />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The top-right cluster: the Assistant (not here yet), the notifications, search, and settings.
 * The notifications and the search are the app's to answer; the settings are kept here.
 */
export function TopRight({
  unread,
  onOpenNotifications,
  onOpenSearch,
  disabled = false,
}: TopRightProps) {
  return (
    <div className="glass flex items-center gap-0.5 p-[3px]">
      <IconButton
        label="Assistant"
        tooltip="Coming soon"
        icon={<SparkIcon />}
        onClick={() => {}}
        disabled
      />
      <IconButton
        label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        icon={<BellIcon unread={unread} />}
        onClick={onOpenNotifications}
      />
      <IconButton
        label="Open command bar"
        icon={<SearchIcon />}
        onClick={onOpenSearch}
        disabled={disabled}
      />
      <Settings />
    </div>
  );
}

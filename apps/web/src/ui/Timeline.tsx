import type { EventMessage } from "@coasterworks/protocol";
import { dateOf, formatDate } from "@coasterworks/sim";
import {
  useTimeline,
  type ClientLabel,
  type TileRect,
  type TimelineEntry,
} from "../state/useTimeline";
import { formatCents } from "./format";
import { EmptyState } from "./kit";

export interface TimelineProps {
  /** The host's log events, which the timeline lists. */
  events: readonly EventMessage[];
  /** An entry with an area was clicked: look at it. */
  onFocus(rect: TileRect): void;
}

/** What an entry cost, in words: nothing for a free one. */
function costText(cost: number): string | null {
  if (cost > 0) return `Charged ${formatCents(cost)}`;
  if (cost < 0) return `Refunded ${formatCents(-cost)}`;
  return null;
}

/** Who did it. An agent stands out, because a player wants to know what one has been up to. */
function Badge({ client }: { client: ClientLabel }) {
  return (
    <span
      className={`rounded px-1.5 text-[11px] leading-5 font-medium ${
        client === "Agent" ? "bg-accent/25 text-[#a9c9ff]" : "bg-white/10 text-muted"
      }`}
    >
      {client}
    </span>
  );
}

function Details({ entry }: { entry: TimelineEntry }) {
  const cost = costText(entry.cost);
  return (
    <>
      <span className="flex items-baseline gap-2">
        <span className={`flex-1 text-sm ${entry.undone ? "text-muted line-through" : ""}`}>
          {entry.title}
        </span>
        {entry.undone && <span className="sr-only">(undone)</span>}
        <Badge client={entry.client} />
      </span>
      <span className="flex gap-2 text-xs text-muted">
        <span>{formatDate(dateOf(entry.tick))}</span>
        {cost !== null && <span>{cost}</span>}
      </span>
    </>
  );
}

const ROW = "flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left";

/**
 * Everything that has happened in the park, newest first, whoever did it: the player, an agent
 * through MCP, or the system. An entry that worked on an area is a button that looks at it.
 */
export function Timeline({ events, onFocus }: TimelineProps) {
  const entries = useTimeline(events);
  if (entries.length === 0) {
    return (
      <EmptyState
        title="Nothing has happened yet."
        hint="Everything done in the park, by you or by an agent, will be listed here."
      />
    );
  }
  return (
    <ul aria-label="Timeline" className="flex flex-col gap-0.5">
      {entries.map((entry) => (
        <li key={entry.id} data-undone={entry.undone}>
          {entry.rect ? (
            <button
              type="button"
              onClick={() => entry.rect && onFocus(entry.rect)}
              className={`hud-button items-stretch justify-start ${ROW}`}
            >
              <Details entry={entry} />
            </button>
          ) : (
            <div className={ROW}>
              <Details entry={entry} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

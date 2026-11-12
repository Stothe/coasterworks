import type { QueryResult } from "@coasterworks/protocol";
import { useEffect, useState } from "react";
import { formatCents } from "../format";
import { Row, Rows } from "./Rows";

/** A guest as `guest_get` answers. */
export interface GuestView {
  id: number;
  name: string;
  tile: { x: number; y: number };
  state: string;
  happiness: number;
  energy: number;
  hunger: number;
  thirst: number;
  bathroom: number;
  nausea: number;
  cash: number;
  thought: { id: number; text: string } | null;
}

/** How often an open guest panel asks after the guest, in milliseconds. */
export const GUEST_POLL_MS = 1000;
/** How many of the guest's thoughts the panel remembers. */
export const THOUGHT_HISTORY = 5;

/** Asks the sim a question. */
export type QueryFn = (name: string, input: unknown) => Promise<QueryResult<unknown>>;

/** What the guest is doing, in a few words, from the sim's state name. */
const DOING: Record<string, string> = {
  entering: "Arriving",
  wandering: "Walking around",
  heading: "Heading somewhere",
  leaving: "Leaving the park",
  lost: "Lost",
};

/**
 * The needs, each with its label and whether a high value is good (energy) or bad (hunger and the
 * rest): the bar is colored by how the guest is doing, not by the number.
 */
const NEEDS: ReadonlyArray<{ key: keyof GuestView; label: string; highIsGood: boolean }> = [
  { key: "happiness", label: "Happiness", highIsGood: true },
  { key: "energy", label: "Energy", highIsGood: true },
  { key: "hunger", label: "Hunger", highIsGood: false },
  { key: "thirst", label: "Thirst", highIsGood: false },
  { key: "bathroom", label: "Bathroom", highIsGood: false },
  { key: "nausea", label: "Nausea", highIsGood: false },
];

function isGuestView(value: unknown): value is GuestView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["id"] === "number" && typeof v["name"] === "string";
}

/** A need as a bar from 0 to 255, green when it is going well for the guest and red when not. */
function NeedBar({
  label,
  value,
  highIsGood,
}: {
  label: string;
  value: number;
  highIsGood: boolean;
}) {
  const share = Math.max(0, Math.min(1, value / 255));
  const wellness = highIsGood ? share : 1 - share;
  const color = wellness >= 0.6 ? "bg-success" : wellness < 0.3 ? "bg-danger" : "bg-accent";
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 text-sm text-muted">{label}</span>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={255}
        aria-valuenow={value}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill"
      >
        <div className={`h-full rounded-full ${color}`} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * One guest: name, what they are doing, their needs as bars, cash, and what they have been
 * thinking. The sim is asked after them every second while the panel is open; the thoughts it
 * answered with are kept, the latest first, the last five of them.
 */
export function GuestInspector({ id, query }: { id: number; query: QueryFn | null }) {
  const [guest, setGuest] = useState<GuestView | null>(null);
  const [gone, setGone] = useState(false);
  const [thoughts, setThoughts] = useState<string[]>([]);

  useEffect(() => {
    setGuest(null);
    setGone(false);
    setThoughts([]);
    if (!query) return;
    let live = true;
    const ask = () => {
      query("guest_get", { id }).then(
        (answer) => {
          if (!live) return;
          if (!answer.ok || !isGuestView(answer.result)) {
            setGone(true);
            return;
          }
          const view = answer.result;
          setGone(false);
          setGuest(view);
          const text = view.thought?.text;
          if (text !== undefined) {
            setThoughts((known) =>
              known[0] === text ? known : [text, ...known].slice(0, THOUGHT_HISTORY),
            );
          }
        },
        () => {
          if (live) setGone(true);
        },
      );
    };
    ask();
    const timer = setInterval(ask, GUEST_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, query]);

  if (gone && !guest) return <p className="text-sm text-muted">This guest has left the park.</p>;
  if (!guest) return <p className="text-sm text-muted">Finding the guest</p>;
  return (
    <div className="flex flex-col gap-3">
      <Rows label="Guest">
        <Row label="Name">{guest.name}</Row>
        <Row label="Doing" {...(guest.state === "lost" && { tone: "bad" as const })}>
          {gone ? "Has left the park" : (DOING[guest.state] ?? guest.state)}
        </Row>
        <Row label="Cash">{formatCents(guest.cash)}</Row>
      </Rows>
      <div role="group" aria-label="Needs" className="flex flex-col gap-1.5">
        {NEEDS.map(({ key, label, highIsGood }) => (
          <NeedBar key={key} label={label} value={guest[key] as number} highIsGood={highIsGood} />
        ))}
      </div>
      <section aria-label="Thoughts" className="flex flex-col gap-1">
        <h3 className="m-0 text-xs font-medium text-muted">Thoughts</h3>
        {thoughts.length === 0 ? (
          <p className="m-0 text-sm text-muted">Nothing on their mind</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {thoughts.map((text, index) => (
              <li key={`${index}-${text}`} className={`text-sm ${index === 0 ? "" : "text-muted"}`}>
                “{text}”
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

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
  /** The ride or stall the guest is busy with, or null (absent from a sim that has none). */
  ride?: { id: number; name: string; doing: string } | null;
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
  queuing: "Queuing",
  riding: "On a ride",
  buying: "Buying something",
};

/** What the guest is doing with a ride or stall, by the `doing` the sim gives, and its name. */
const WITH_RIDE: Record<string, (name: string) => string> = {
  heading: (name) => `Heading for ${name}`,
  queuing: (name) => `Queuing for ${name}`,
  riding: (name) => `On ${name}`,
  buying: (name) => `At ${name}`,
};

/** What the guest is doing, in words: with the ride or stall they are busy with, if any. */
export function doingOf(guest: Pick<GuestView, "state" | "ride">): string {
  const ride = guest.ride;
  const withRide = ride ? WITH_RIDE[ride.doing] : undefined;
  if (ride && withRide) return withRide(ride.name);
  return DOING[guest.state] ?? guest.state;
}

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
/** How the sim's `guest_get` says there is no guest with that id (`No guest with id 4`). */
const NO_SUCH_GUEST = /^No guest with id \d+$/;

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
    let timer: ReturnType<typeof setInterval> | undefined;
    const ask = () => {
      query("guest_get", { id }).then(
        (answer) => {
          if (!live) return;
          if (!answer.ok && NO_SUCH_GUEST.test(answer.error)) {
            // The sim says there is no such guest, and ids are never given out again: they have
            // left for good, so there is nothing more to ask.
            setGone(true);
            clearInterval(timer);
            return;
          }
          // Any other refusal, or an answer not shaped like a guest, says nothing about whether
          // they are still here: keep what is shown and ask again next time.
          if (!answer.ok || !isGuestView(answer.result)) return;
          const view = answer.result;
          setGuest(view);
          const text = view.thought?.text;
          if (text !== undefined) {
            setThoughts((known) =>
              known[0] === text ? known : [text, ...known].slice(0, THOUGHT_HISTORY),
            );
          }
        },
        // A question that did not get through says nothing about the guest: keep what is shown
        // and ask again next time.
        () => {},
      );
    };
    ask();
    timer = setInterval(ask, GUEST_POLL_MS);
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
          {gone ? "Has left the park" : doingOf(guest)}
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

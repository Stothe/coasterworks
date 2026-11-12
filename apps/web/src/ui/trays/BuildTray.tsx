import type { QueryResult } from "@coasterworks/protocol";
import { useEffect, useState } from "react";
import { uiStore, useUiStore } from "../../state/uiStore";
import { isBuildCommand, rotOf } from "../../viewport/ridePlacement";
import { formatCents } from "../format";
import { Kbd, Segmented } from "../kit";

/** Asks the sim a question. */
export type QueryFn = (name: string, input: unknown) => Promise<QueryResult<unknown>>;

/** A ride or stall type as `content_list` gives it, as much of it as a card shows. */
export interface BuildType {
  id: string;
  kind: "ride" | "stall";
  category: string;
  name: string;
  description: string;
  footprint: { w: number; h: number };
  cost: number;
}

function isBuildType(value: unknown): value is BuildType {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const footprint = v["footprint"] as Record<string, unknown> | null | undefined;
  return (
    typeof v["id"] === "string" &&
    (v["kind"] === "ride" || v["kind"] === "stall") &&
    typeof v["category"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["cost"] === "number" &&
    typeof footprint?.["w"] === "number" &&
    typeof footprint["h"] === "number"
  );
}

/** What each of the two build trays is: the kind it builds, its command and its chips. */
interface BuildKind {
  kind: "ride" | "stall";
  command: "ride_build" | "stall_build";
  /** What the tray calls one: names its card list. */
  noun: string;
  categories: ReadonlyArray<{ id: string; label: string }>;
}

const RIDES: BuildKind = {
  kind: "ride",
  command: "ride_build",
  noun: "Rides",
  categories: [
    { id: "gentle", label: "Gentle" },
    { id: "thrill", label: "Thrill" },
  ],
};

const STALLS: BuildKind = {
  kind: "stall",
  command: "stall_build",
  noun: "Shops and stalls",
  categories: [
    { id: "food", label: "Food" },
    { id: "drink", label: "Drink" },
    { id: "facility", label: "Facilities" },
  ],
};

/** The types of one kind the sim can build, once it has said; null until then. */
function useBuildTypes(query: QueryFn | null, kind: "ride" | "stall") {
  const [types, setTypes] = useState<BuildType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!query) return;
    let live = true;
    // A question that throws is one that failed, like one whose promise is rejected.
    Promise.resolve()
      .then(() => query("content_list", { kind }))
      .then(
        (answer) => {
          if (!live) return;
          if (!answer.ok) setError(answer.error);
          else if (Array.isArray(answer.result)) setTypes(answer.result.filter(isBuildType));
          else setError("The park sent no list of types");
        },
        (reason: unknown) => {
          if (live) setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    return () => {
      live = false;
    };
  }, [query, kind]);
  return { types, error };
}

/** A quarter-turn arrow. */
function RotateIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M13 2.5v3h-3" />
    </svg>
  );
}

export interface BuildTrayProps {
  /** Asks the sim; null before the connection is made, when there is nothing to list yet. */
  query: QueryFn | null;
  /** What the last command cost, in cents; negative for an undo's refund; null before any. */
  lastCharge: number | null;
  disabled?: boolean;
}

/** What the tray says under the cards: what to do, why the spot will not do, or what it cost. */
function Status({ lastCharge }: { lastCharge: number | null }) {
  const placement = useUiStore((state) => state.placement);
  const check = useUiStore((state) => state.placementCheck);
  if (!placement || !isBuildCommand(placement.command)) {
    return <span className="text-xs text-muted">Pick one to place it</span>;
  }
  return (
    <>
      <span
        className={`text-xs ${check && !check.ok ? "text-danger" : "text-muted"}`}
        aria-live="polite"
      >
        {check && !check.ok && check.reason
          ? check.reason
          : "Click the ground to build · R turns it · Esc puts it down"}
      </span>
      {lastCharge !== null && (
        <span className={`ml-auto text-sm tabular-nums ${lastCharge < 0 ? "text-success" : ""}`}>
          {lastCharge < 0
            ? `Refunded ${formatCents(Math.abs(lastCharge))}`
            : `Charged ${formatCents(lastCharge)}`}
        </span>
      )}
    </>
  );
}

function BuildTray({
  kind: what,
  query,
  lastCharge,
  disabled = false,
}: BuildTrayProps & {
  kind: BuildKind;
}) {
  const { types, error } = useBuildTypes(query, what.kind);
  const placement = useUiStore((state) => state.placement);
  const inHand = placement?.command === what.command ? String(placement.defaults["type"]) : null;
  const rot = placement?.command === what.command ? rotOf(placement.defaults) : 0;
  const first = what.categories[0]?.id ?? "";
  // The chip starts on the category of the type in hand, so a placement from the command bar
  // shows its card.
  const [chosen, setChosen] = useState<string | null>(null);
  const handCategory = types?.find((type) => type.id === inHand)?.category;
  const category = chosen ?? handCategory ?? first;
  const cards = (types ?? []).filter((type) => type.category === category);

  const pick = (type: BuildType) =>
    uiStore.getState().startPlacement(what.command, { type: type.id, rot });

  return (
    <div className="flex min-w-[28rem] max-w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented
          label="Category"
          options={what.categories}
          value={category}
          onChange={setChosen}
          disabled={disabled}
        />
        <button
          type="button"
          aria-label="Rotate"
          aria-keyshortcuts="R"
          disabled={disabled || inHand === null}
          onClick={() => uiStore.getState().rotatePlacement()}
          className="hud-button ml-auto gap-1.5 rounded-lg bg-fill px-2.5 text-xs font-medium text-muted hover:text-ink"
        >
          <RotateIcon />
          Rotate
          <Kbd>R</Kbd>
        </button>
        <span className="w-10 text-xs text-muted tabular-nums" aria-label="Turned">
          {`${rot * 90}°`}
        </span>
      </div>
      {error !== null && types === null ? (
        <p role="alert" className="m-0 text-xs text-danger">
          {`Could not list the ${what.noun.toLowerCase()}: ${error}`}
        </p>
      ) : types === null ? (
        <p className="m-0 text-xs text-muted">{`Loading the ${what.noun.toLowerCase()}`}</p>
      ) : cards.length === 0 ? (
        <p className="m-0 text-xs text-muted">Nothing of this kind to build yet</p>
      ) : (
        <ul aria-label={what.noun} className="m-0 flex list-none gap-2 overflow-x-auto p-1">
          {cards.map((type) => {
            const selected = type.id === inHand;
            const { w, h } = type.footprint;
            return (
              <li key={type.id} className="flex">
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${type.name}, ${formatCents(type.cost)}, ${w * h === 1 ? "1 tile" : `${w} by ${h} tiles`}`}
                  title={type.description}
                  disabled={disabled}
                  onClick={() => pick(type)}
                  className="hud-button w-40 flex-col items-start gap-0.5 rounded-lg bg-fill p-2.5 text-left ring-accent aria-pressed:bg-fill-active aria-pressed:ring-2"
                >
                  <span className="text-sm font-medium text-ink">{type.name}</span>
                  <span className="text-xs text-success tabular-nums">
                    {formatCents(type.cost)}
                  </span>
                  <span className="text-xs text-muted">
                    {w * h === 1 ? "1 tile" : `${w} × ${h} tiles`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1">
        <Status lastCharge={lastCharge} />
      </div>
    </div>
  );
}

/** The Rides tool's tray: Gentle and Thrill rides as cards; a card puts that ride in hand. */
export function RidesTray(props: BuildTrayProps) {
  return <BuildTray kind={RIDES} {...props} />;
}

/** The Shops tool's tray: food, drink and facilities as cards; a card puts that stall in hand. */
export function ShopsTray(props: BuildTrayProps) {
  return <BuildTray kind={STALLS} {...props} />;
}

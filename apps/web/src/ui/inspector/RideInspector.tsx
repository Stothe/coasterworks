import { MAX_RIDE_NAME, MAX_RIDE_PRICE, type ExecResult } from "@coasterworks/sim";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSnapshot, type SnapshotSource } from "../../state/useSnapshot";
import { formatCents } from "../format";
import { Panel, Tabs } from "../kit";
import { Stepper } from "../trays/Stepper";
import type { QueryFn } from "./GuestInspector";
import { Row, Rows } from "./Rows";

/** A ride or stall as `ride_get` answers, as much of it as the panel reads. */
export interface RideView {
  id: number;
  type: string;
  kind: "ride" | "stall";
  name: string;
  open: boolean;
  /** Cents. */
  price: number;
  /** 0 idle, 1 loading, 2 running, 3 unloading. */
  phase: number;
  riders: number[];
  queue: number[];
  stats: {
    customers: number;
    income: number;
    runningCost: number;
    monthCustomers: number;
    monthIncome: number;
  };
  /** The content type, or null for one the content no longer has. */
  content: {
    name: string;
    cost: number;
    runningCost: number;
    excitement?: number;
    intensity?: number;
    nausea?: number;
  } | null;
}

/** How often an open ride panel asks after the ride, in milliseconds. */
export const RIDE_POLL_MS = 1000;

/** How far the price buttons move it, in cents. */
export const PRICE_STEP = 10;

/** How the sim's `ride_get` says there is no ride with that id (`No ride with id 4`). */
const NO_SUCH_RIDE = /^No ride with id \d+$/;

/** What a ride is doing, by the phase the sim gives. */
const PHASES = ["Idle", "Loading", "Running", "Unloading"] as const;

function isRideView(value: unknown): value is RideView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "number" &&
    typeof v["name"] === "string" &&
    (v["kind"] === "ride" || v["kind"] === "stall") &&
    typeof v["price"] === "number" &&
    typeof v["stats"] === "object" &&
    v["stats"] !== null &&
    Array.isArray(v["riders"]) &&
    Array.isArray(v["queue"])
  );
}

/** A rating of 0 to 999, as the 0.00 to 9.99 the player reads. */
export function formatRating(rating: number): string {
  return (rating / 100).toFixed(2);
}

/** Dollars as typed: `2`, `2.5` or `2.50`, as cents; null for anything else. */
export function parseDollars(text: string): number | null {
  const match = /^\s*\$?(\d{1,3})(?:\.(\d{0,2}))?\s*$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** Cents as the price field shows them: `1.50`. */
const formatDollars = (cents: number) => (cents / 100).toFixed(2);

export interface RideInspectorProps {
  id: number;
  /** Asks the sim; null without a connection. */
  query: QueryFn | null;
  /** Runs a sim command; a refusal is a result, not a throw. */
  execute(name: string, input: unknown): Promise<ExecResult>;
  notify(text: string, options?: { kind?: "info" | "error" }): void;
  /** Where the ride's phase is followed between questions, by id; a miss is no news. */
  source?: SnapshotSource;
  /** The header's controls, such as the inspector's close button. */
  actions?: ReactNode;
  disabled?: boolean;
}

const NO_SOURCE: SnapshotSource = { snapshot: null };

const button =
  "hud-button rounded-lg bg-fill px-3 text-sm font-medium text-ink disabled:opacity-40";

/**
 * One ride or stall: its name and whether it is open and what it is doing, and two tabs. Overview
 * opens and closes it, sets its price, renames and demolishes it; Stats has its customers and
 * takings, what it costs to run, its queue and riders, and a ride's ratings. The sim is asked
 * after it every second while the panel is open, and again at once after a command, until the sim
 * says there is no such ride.
 */
export function RideInspector({
  id,
  query,
  execute,
  notify,
  source = NO_SOURCE,
  actions,
  disabled = false,
}: RideInspectorProps) {
  const [ride, setRide] = useState<RideView | null>(null);
  const [gone, setGone] = useState(false);
  const [tab, setTab] = useState("overview");
  // Asks again now: set by the effect that polls, for the commands to call.
  const refresh = useRef<() => void>(() => {});
  // The live phase from the snapshots, looked up by id: the status and the list may disagree for
  // a moment, and a ride the status does not have yet is simply not in it.
  const livePhase = useSnapshot(source, (snapshot) => {
    const status = snapshot?.rideStatus;
    if (!status) return undefined;
    for (let i = 0; i < status.count; i++) if (status.id[i] === id) return status.phase[i];
    return undefined;
  });

  useEffect(() => {
    setRide(null);
    setGone(false);
    setTab("overview");
    if (!query) return;
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const ask = () => {
      query("ride_get", { id }).then(
        (answer) => {
          if (!live) return;
          if (!answer.ok && NO_SUCH_RIDE.test(answer.error)) {
            // Demolished: ids are not given out again, so there is nothing more to ask.
            setGone(true);
            clearInterval(timer);
            return;
          }
          // Any other refusal says nothing about whether it still stands: ask again next time.
          if (answer.ok && isRideView(answer.result)) setRide(answer.result);
        },
        () => {},
      );
    };
    refresh.current = ask;
    ask();
    timer = setInterval(ask, RIDE_POLL_MS);
    return () => {
      live = false;
      refresh.current = () => {};
      clearInterval(timer);
    };
  }, [id, query]);

  const run = useCallback(
    async (name: string, input: unknown): Promise<boolean> => {
      const result = await execute(name, input);
      if (!result.ok) notify(result.error, { kind: "error" });
      refresh.current();
      return result.ok;
    },
    [execute, notify],
  );

  if (gone) {
    return (
      <Panel title="Ride" actions={actions}>
        <p className="text-sm text-muted">This has been demolished.</p>
      </Panel>
    );
  }
  if (!ride) {
    return (
      <Panel title="Ride" actions={actions}>
        <p className="text-sm text-muted">Finding the ride</p>
      </Panel>
    );
  }
  const phase = livePhase ?? ride.phase;
  const doing = ride.kind === "ride" && ride.open ? ` · ${PHASES[phase] ?? "Idle"}` : "";
  return (
    <Panel title={ride.name} actions={actions}>
      <p className="mb-3 text-xs text-muted" aria-label="Status">
        <span className={ride.open ? "text-success" : ""}>{ride.open ? "Open" : "Closed"}</span>
        {doing}
      </p>
      <Tabs
        label="Ride sections"
        value={tab}
        onValueChange={setTab}
        tabs={[
          {
            id: "overview",
            label: "Overview",
            content: <Overview key={id} id={id} ride={ride} run={run} disabled={disabled} />,
          },
          { id: "stats", label: "Stats", content: <Stats ride={ride} /> },
        ]}
      />
    </Panel>
  );
}

interface OverviewProps {
  /** The id the panel is inspecting now; `ride` may still be the last one's for a moment. */
  id: number;
  ride: RideView;
  run(name: string, input: unknown): Promise<boolean>;
  disabled: boolean;
}

function Overview({ id, ride, run, disabled }: OverviewProps) {
  const noun = ride.kind === "ride" ? "ride" : "stall";
  // The price last asked for, until the sim's answer shows it has changed: a step taken before
  // then goes on from what was asked, not from the price the last answer had.
  const requested = useRef<number | null>(null);
  useEffect(() => {
    // Only the answer to the last step ends it: an earlier step's answer comes while it is pending.
    if (requested.current === ride.price) requested.current = null;
  }, [ride.price]);
  const setPrice = (cents: number) => {
    requested.current = cents;
    void run("ride_set_price", { id: ride.id, cents }).then((ok) => {
      if (!ok) requested.current = null;
    });
  };
  // The id the open confirm is for, or null: Yes demolishes that one and no other.
  const [confirming, setConfirming] = useState<number | null>(null);
  const refund = ride.content ? Math.floor(ride.content.cost / 2) : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => void run(ride.open ? "ride_close" : "ride_open", { id: ride.id })}
          className={`hud-button rounded-lg px-4 text-sm font-medium ${
            ride.open ? "bg-fill text-ink" : "bg-accent-strong text-on-accent"
          }`}
        >
          {ride.open ? `Close ${noun}` : `Open ${noun}`}
        </button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted">Price $</span>
        <Stepper
          label="Price"
          inputLabel="Price in dollars"
          value={ride.price}
          min={0}
          max={MAX_RIDE_PRICE}
          commitOnBlur
          format={formatDollars}
          parse={parseDollars}
          onChange={setPrice}
          onStep={(by) =>
            setPrice(
              Math.min(
                MAX_RIDE_PRICE,
                Math.max(0, (requested.current ?? ride.price) + by * PRICE_STEP),
              ),
            )
          }
          canDecrease={ride.price > 0}
          canIncrease={ride.price < MAX_RIDE_PRICE}
          disabled={disabled}
        />
      </div>
      <NameField
        key={`${ride.id}:${ride.name}`}
        name={ride.name}
        disabled={disabled}
        onRename={(name) => void run("ride_rename", { id: ride.id, name })}
      />
      {confirming === id ? (
        <div role="group" aria-label="Confirm demolish" className="flex items-center gap-2">
          <span className="text-sm">
            Demolish? <span className="text-muted">{`Refunds ${formatCents(refund)}`}</span>
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              const target = confirming;
              setConfirming(null);
              if (target === id && ride.id === id) void run("ride_demolish", { id: target });
            }}
            className="hud-button ml-auto rounded-lg bg-danger px-3 text-sm font-medium text-canvas"
          >
            Yes
          </button>
          <button type="button" onClick={() => setConfirming(null)} className={button}>
            No
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setConfirming(id)}
          className={`${button} self-start text-danger`}
        >
          Demolish
        </button>
      )}
    </div>
  );
}

/** The name, typed in and taken on Enter or when the field is left. */
function NameField({
  name,
  onRename,
  disabled,
}: {
  name: string;
  onRename(name: string): void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(name);
  const commit = () => {
    const next = draft.trim();
    if (next.length > 0 && next !== name) onRename(next);
    else setDraft(name);
  };
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted">Name</span>
      <input
        type="text"
        value={draft}
        maxLength={MAX_RIDE_NAME}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            // The box has dealt with it: the inspector stays open.
            event.stopPropagation();
            setDraft(name);
            event.currentTarget.blur();
          }
        }}
        className="min-h-8 w-44 rounded-lg border border-line-strong bg-fill-strong px-2 text-sm text-ink disabled:opacity-40"
      />
    </label>
  );
}

function Stats({ ride }: { ride: RideView }) {
  const { stats, content } = ride;
  const isRide = ride.kind === "ride";
  return (
    <div className="flex flex-col gap-3">
      <Rows label="Takings">
        <Row label="Customers this month">{stats.monthCustomers}</Row>
        <Row label="Customers all time">{stats.customers}</Row>
        <Row label="Income this month">{formatCents(stats.monthIncome)}</Row>
        <Row label="Income all time">{formatCents(stats.income)}</Row>
        <Row label="Running cost">
          {content ? `${formatCents(content.runningCost)} a month` : "—"}
        </Row>
        <Row label={isRide ? "In the queue" : "Waiting"}>{ride.queue.length}</Row>
        {isRide && <Row label="Riders">{ride.riders.length}</Row>}
      </Rows>
      {isRide && content && (
        <section aria-label="Ratings section" className="flex flex-col gap-1.5">
          <h3 className="m-0 text-xs font-medium text-muted">Ratings</h3>
          <Rows label="Ratings">
            <Row label="Excitement">{formatRating(content.excitement ?? 0)}</Row>
            <Row label="Intensity">{formatRating(content.intensity ?? 0)}</Row>
            <Row label="Nausea">{formatRating(content.nausea ?? 0)}</Row>
          </Rows>
        </section>
      )}
    </div>
  );
}

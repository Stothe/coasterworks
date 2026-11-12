import type { RidePublic } from "@coasterworks/protocol";
import type { TerrainData } from "@coasterworks/render";
import { useMemo } from "react";
import type { ExecResult } from "@coasterworks/sim";
import type { Action, ActionContext, InspectorTab } from "../actions/types";
import { uiStore, useUiStore } from "../state/uiStore";
import { useSnapshot, type SnapshotSource } from "../state/useSnapshot";
import { useParkInfo } from "../state/useParkInfo";
import type { TileRect, TimelineEntry } from "../state/useTimeline";
import { ParkFinances } from "./inspector/ParkFinances";
import { useParkState } from "../state/useParkState";
import { EntranceInspector } from "./inspector/EntranceInspector";
import { GuestInspector, type QueryFn } from "./inspector/GuestInspector";
import { ParkOverview } from "./inspector/ParkOverview";
import { RideInspector } from "./inspector/RideInspector";
import { TileInspector } from "./inspector/TileInspector";
import { tileInfo } from "./inspector/tileInfo";
import { IconButton, Panel, Tabs } from "./kit";
import { EDGE_GAP_REM, INSPECTOR_WIDTH_REM } from "./layout";
import { Timeline } from "./Timeline";

export interface InspectorProps {
  /** The latest terrain, which the tile tab reads on every render. */
  terrain: TerrainData | null;
  /** Where the park's money and date are read from, and followed as snapshots arrive. */
  source: SnapshotSource;
  /** The park's name from the host's welcome, until a snapshot says what it is called now. */
  parkName?: string | undefined;
  /**
   * Every action: the finances tab's loan forms are the ones that run the finance commands, and the
   * tile tab's buttons are the ones that take an area of tiles.
   */
  actions: readonly Action[];
  ctx: ActionContext | null;
  /** Runs a sim command. It resolves with the sim's answer; a refusal is a result, not a throw. */
  execute(name: string, input: unknown): Promise<ExecResult>;
  /** Shows a message to the player. */
  notify(text: string, options?: { kind?: "info" | "error" }): void;
  /** The park's timeline, newest first, which its tab lists. */
  timeline?: readonly TimelineEntry[];
  /** Looks at an area of the map: what a timeline entry with an area does when clicked. */
  focusTile?(rect: TileRect): void;
  /** The rides and stalls, which the overview counts; null before the first snapshot. */
  rides?: readonly RidePublic[] | null;
}

const NO_ENTRIES: readonly TimelineEntry[] = [];
const NOWHERE = () => {};

/** The park's tabs, which are the inspector's tabs but for the tile. */
type ParkTab = Exclude<InspectorTab, "tile">;

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const closeButton = (
  <IconButton
    label="Close inspector"
    icon={<CloseIcon />}
    onClick={() => uiStore.getState().closeInspector()}
  />
);

/**
 * The one panel on the right, which shows whatever is selected: a tile, or else the park. It is
 * the only panel that changes with the selection, and there is never a second.
 */
export function Inspector(props: InspectorProps) {
  const open = useUiStore((state) => state.inspector.open);
  const selection = useUiStore((state) => state.selection);
  if (!open) return null;
  return (
    <aside
      aria-label="Inspector"
      className="pointer-events-auto absolute top-16 flex max-h-[calc(100%-9rem)] max-w-[calc(100vw-1.75rem)] animate-enter flex-col"
      style={{ width: `${INSPECTOR_WIDTH_REM}rem`, right: `${EDGE_GAP_REM}rem` }}
    >
      {selection?.kind === "tile" ? (
        <TilePanel {...props} x={selection.x} y={selection.y} />
      ) : selection?.kind === "guest" ? (
        <GuestPanel {...props} id={selection.id} />
      ) : selection?.kind === "ride" ? (
        <RidePanel {...props} id={selection.id} />
      ) : selection?.kind === "entrance" ? (
        <EntrancePanel {...props} />
      ) : (
        <ParkPanel {...props} />
      )}
    </aside>
  );
}

function Status({ children }: { children: string }) {
  return <p className="mb-3 text-xs text-muted">{children}</p>;
}

function TilePanel({
  terrain,
  actions,
  x,
  y,
  execute,
  notify,
}: InspectorProps & { x: number; y: number }) {
  const info = tileInfo(terrain, x, y);
  return (
    <Panel title={`Tile (${x}, ${y})`} actions={closeButton}>
      {info && (
        <Status>{`${info.surface} · ${info.water === 0 ? "dry" : `water ${info.water}`}`}</Status>
      )}
      <TileInspector
        terrain={terrain}
        actions={actions}
        x={x}
        y={y}
        execute={execute}
        notify={notify}
      />
    </Panel>
  );
}

function GuestPanel({ ctx, id }: InspectorProps & { id: number }) {
  const client = ctx?.client ?? null;
  const query = useMemo<QueryFn | null>(
    () => (client ? (name, input) => client.query(name, input) : null),
    [client],
  );
  return (
    <Panel title="Guest" actions={closeButton}>
      <GuestInspector id={id} query={query} />
    </Panel>
  );
}

function RidePanel({ ctx, source, execute, notify, id }: InspectorProps & { id: number }) {
  const client = ctx?.client ?? null;
  const query = useMemo<QueryFn | null>(
    () => (client ? (name, input) => client.query(name, input) : null),
    [client],
  );
  return (
    <RideInspector
      id={id}
      query={query}
      execute={execute}
      notify={notify}
      source={source}
      actions={closeButton}
      disabled={ctx === null}
    />
  );
}

function EntrancePanel({ source, ctx, execute, notify }: InspectorProps) {
  const park = useParkState(source);
  return (
    <Panel title="Park entrance" actions={closeButton}>
      <EntranceInspector park={park} execute={execute} notify={notify} disabled={ctx === null} />
    </Panel>
  );
}

function ParkPanel({
  source,
  parkName,
  actions,
  ctx,
  execute,
  notify,
  timeline = NO_ENTRIES,
  focusTile = NOWHERE,
  rides,
}: InspectorProps) {
  const tab = useUiStore((state) => state.inspector.tab);
  // The tile's tab is no tab of the park's: a park that is shown while it is current shows Overview.
  const shown: ParkTab = tab === "tile" ? "overview" : tab;
  // The snapshot has the name as it is now; the welcome's goes stale after a rename.
  const name = useSnapshot(source, (snapshot) => snapshot?.header.park.name) ?? parkName;
  const info = useParkInfo(source, name);
  const park = useParkState(source);
  return (
    <Panel title={name ?? "Park"} actions={closeButton}>
      {info && <Status>{info.date}</Status>}
      <Tabs
        label="Park sections"
        value={shown}
        onValueChange={(next) => uiStore.getState().openInspector(next as ParkTab)}
        tabs={[
          {
            id: "overview",
            label: "Overview",
            content: <ParkOverview info={info} park={park} rides={rides ?? null} />,
          },
          {
            id: "finances",
            label: "Finances",
            content: (
              <ParkFinances
                info={info}
                actions={actions}
                ctx={ctx}
                execute={execute}
                notify={notify}
              />
            ),
          },
          {
            id: "timeline",
            label: "Timeline",
            content: <Timeline entries={timeline} onFocus={focusTile} />,
          },
        ]}
      />
    </Panel>
  );
}

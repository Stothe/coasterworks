import type { TerrainData } from "@coasterworks/render";
import type { ExecResult } from "@coasterworks/sim";
import { EmptyState } from "../kit";
import { Row, Rows } from "./Rows";
import { TILE_ACTIONS, runTileAction } from "./tileActions";
import { tileInfo } from "./tileInfo";

export interface TileInspectorProps {
  /** The latest terrain. Nothing here is kept between renders: it is read again each time. */
  terrain: TerrainData | null;
  x: number;
  y: number;
  /** Runs a sim command. It resolves with the sim's answer; a refusal is a result, not a throw. */
  execute(name: string, input: unknown): Promise<ExecResult>;
  /** Shows a message to the player. */
  notify(text: string, options?: { kind?: "info" | "error" }): void;
}

const CORNERS = [
  ["NW", "nw"],
  ["NE", "ne"],
  ["SW", "sw"],
  ["SE", "se"],
] as const;

/**
 * The inspector's tile tab: the tile's four corner heights, its lowest corner, surface and water,
 * and five things to do to it. Everything shown is read from `terrain` on each render, so it
 * follows the map as the sim changes it.
 */
export function TileInspector({ terrain, x, y, execute, notify }: TileInspectorProps) {
  if (!terrain) {
    return (
      <EmptyState title="Waiting for the map" hint="The tile will show once the park has loaded." />
    );
  }
  const info = tileInfo(terrain, x, y);
  if (!info) {
    return (
      <EmptyState
        title="This tile is not on the map"
        hint="Click a tile of the park to look at it."
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted">Corner heights</h3>
        <div role="group" aria-label="Corner heights" className="grid grid-cols-2 gap-1.5">
          {CORNERS.map(([name, key]) => (
            <div
              key={key}
              className="flex items-baseline justify-between rounded-lg bg-white/5 px-2.5 py-1.5"
            >
              <span className="text-xs text-muted">{name}</span>
              <b className="text-sm tabular-nums">{info.corners[key]}</b>
            </div>
          ))}
        </div>
      </div>
      <Rows label="Tile">
        <Row label="Lowest corner">{info.lowest}</Row>
        <Row label="Surface">{info.surface}</Row>
        <Row label="Water level">{info.water === 0 ? "none" : info.water}</Row>
      </Rows>
      <div role="group" aria-label="Tile actions" className="grid grid-cols-2 gap-1.5">
        {TILE_ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => void runTileAction(action.id, terrain, x, y, execute, notify)}
            className="hud-button rounded-lg bg-white/5 px-3 text-sm font-medium"
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

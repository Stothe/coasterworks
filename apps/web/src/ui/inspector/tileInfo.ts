import type { TerrainData } from "@coasterworks/render";
import { SURFACES } from "../../viewport/terrainTools";

/** What the terrain says about one tile. */
export interface TileInfo {
  /** The heights of the tile's four corners: north-west (x, y), north-east, south-east, south-west. */
  corners: { nw: number; ne: number; se: number; sw: number };
  lowest: number;
  /** The surface's name: `Grass`. */
  surface: string;
  /** 0 for a dry tile, else the water's level in height steps. */
  water: number;
}

/**
 * Reads tile (`x`, `y`) from `terrain`, or null if it is not on the map or there is no map. Every
 * call reads the arrays as they are, so a caller that calls it on each render never shows a stale
 * tile.
 */
export function tileInfo(terrain: TerrainData | null, x: number, y: number): TileInfo | null {
  if (!terrain) return null;
  const { width, height, corners, surface, water } = terrain;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const stride = width + 1;
  const at = (cx: number, cy: number) => corners[cy * stride + cx] ?? 0;
  const nw = at(x, y);
  const ne = at(x + 1, y);
  const se = at(x + 1, y + 1);
  const sw = at(x, y + 1);
  const id = surface[y * width + x] ?? 0;
  return {
    corners: { nw, ne, se, sw },
    lowest: Math.min(nw, ne, se, sw),
    surface: SURFACES.find((entry) => entry.id === id)?.label ?? `Surface ${id}`,
    water: water[y * width + x] ?? 0,
  };
}

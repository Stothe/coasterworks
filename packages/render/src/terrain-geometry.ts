import type { Surface } from "@coasterworks/sim";
import { surfaceColor, WATER_COLOR } from "./palette.js";
import { CHUNK, HEIGHT_STEP, WATER_LIFT } from "./units.js";

/** The terrain arrays the renderer needs, with the map size in tiles. */
export interface TerrainData {
  width: number;
  height: number;
  /** Corner heights, `(width + 1) * (height + 1)`, index `cy * (width + 1) + cx`. */
  corners: Int16Array;
  /** Surface per tile (0..4), index `ty * width + tx`. */
  surface: Uint8Array;
  /** Water level per tile (0 is dry, otherwise the surface height in sim steps). */
  water: Uint8Array;
}

/**
 * Geometry for one chunk as flat arrays. Vertices are not shared between triangles (flat shading),
 * so `indices` is simply `0..n-1`; it is kept so the result can be uploaded as an indexed mesh.
 */
export interface ChunkGeometry {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** Tiles in the chunk (water tiles for a water mesh). */
  tileCount: number;
}

/** How many chunks the map has along each axis. */
export function chunkCount(t: TerrainData): { cx: number; cy: number } {
  return { cx: Math.ceil(t.width / CHUNK), cy: Math.ceil(t.height / CHUNK) };
}

/** The tile range a chunk covers, clipped to the map. Empty when the chunk is off the map. */
function chunkTiles(t: TerrainData, chunkX: number, chunkY: number) {
  const x0 = chunkX * CHUNK;
  const y0 = chunkY * CHUNK;
  return {
    x0,
    y0,
    x1: Math.max(x0, Math.min(t.width, x0 + CHUNK)),
    y1: Math.max(y0, Math.min(t.height, y0 + CHUNK)),
  };
}

/**
 * Returns the vertex positions of the two triangles of tile (`x`, `y`) as 18 numbers. Both are
 * counter-clockwise seen from above (+Y), so their front faces point up. The tile is split along the
 * diagonal joining the two corners with the smaller height difference; ties split along NW-SE.
 */
export function tileTriangles(t: TerrainData, x: number, y: number, out: Float64Array): void {
  const stride = t.width + 1;
  const hNW = t.corners[y * stride + x] as number;
  const hNE = t.corners[y * stride + x + 1] as number;
  const hSE = t.corners[(y + 1) * stride + x + 1] as number;
  const hSW = t.corners[(y + 1) * stride + x] as number;

  // Vertices as x, y, z.
  const nw = [x, hNW * HEIGHT_STEP, y] as const;
  const ne = [x + 1, hNE * HEIGHT_STEP, y] as const;
  const se = [x + 1, hSE * HEIGHT_STEP, y + 1] as const;
  const sw = [x, hSW * HEIGHT_STEP, y + 1] as const;

  const triangles =
    Math.abs(hNW - hSE) <= Math.abs(hNE - hSW)
      ? [nw, sw, se, nw, se, ne] // NW-SE diagonal
      : [nw, sw, ne, ne, sw, se]; // NE-SW diagonal
  for (let i = 0; i < 6; i++) {
    const v = triangles[i] as readonly [number, number, number];
    out[i * 3] = v[0];
    out[i * 3 + 1] = v[1];
    out[i * 3 + 2] = v[2];
  }
}

/** Builds the terrain mesh arrays for chunk (`chunkX`, `chunkY`), clipped to the map. */
export function buildChunkGeometry(t: TerrainData, chunkX: number, chunkY: number): ChunkGeometry {
  const { x0, y0, x1, y1 } = chunkTiles(t, chunkX, chunkY);
  const tileCount = (x1 - x0) * (y1 - y0);
  const vertexCount = tileCount * 6;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(vertexCount);
  const tri = new Float64Array(18);

  let v = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      tileTriangles(t, x, y, tri);
      const [r, g, b] = surfaceColor(t.surface[y * t.width + x] as Surface, x, y);
      for (let k = 0; k < 2; k++) {
        const o = k * 9;
        // Normal = (b - a) x (c - a), normalized.
        const ux = (tri[o + 3] as number) - (tri[o] as number);
        const uy = (tri[o + 4] as number) - (tri[o + 1] as number);
        const uz = (tri[o + 5] as number) - (tri[o + 2] as number);
        const wx = (tri[o + 6] as number) - (tri[o] as number);
        const wy = (tri[o + 7] as number) - (tri[o + 1] as number);
        const wz = (tri[o + 8] as number) - (tri[o + 2] as number);
        let nx = uy * wz - uz * wy;
        let ny = uz * wx - ux * wz;
        let nz = ux * wy - uy * wx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) {
          nx /= len;
          ny /= len;
          nz /= len;
        } else {
          nx = 0;
          ny = 1;
          nz = 0;
        }
        for (let i = 0; i < 3; i++, v++) {
          positions[v * 3] = tri[o + i * 3] as number;
          positions[v * 3 + 1] = tri[o + i * 3 + 1] as number;
          positions[v * 3 + 2] = tri[o + i * 3 + 2] as number;
          normals[v * 3] = nx;
          normals[v * 3 + 1] = ny;
          normals[v * 3 + 2] = nz;
          colors[v * 3] = r;
          colors[v * 3 + 1] = g;
          colors[v * 3 + 2] = b;
          indices[v] = v;
        }
      }
    }
  }
  return { positions, normals, colors, indices, tileCount };
}

/**
 * Builds the water surface for chunk (`chunkX`, `chunkY`): one flat quad (two triangles) per tile
 * with water, at the tile's water level plus a hair to avoid z-fighting. Returns `null` when the
 * chunk has no water.
 */
export function buildWaterGeometry(
  t: TerrainData,
  chunkX: number,
  chunkY: number,
): ChunkGeometry | null {
  const { x0, y0, x1, y1 } = chunkTiles(t, chunkX, chunkY);
  let tileCount = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if ((t.water[y * t.width + x] as number) > 0) tileCount++;
    }
  }
  if (tileCount === 0) return null;

  const vertexCount = tileCount * 6;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(vertexCount);

  let v = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const level = t.water[y * t.width + x] as number;
      if (level === 0) continue;
      const h = level * HEIGHT_STEP + WATER_LIFT;
      // NW, SW, SE and NW, SE, NE: counter-clockwise seen from above.
      const quad = [x, y, x, y + 1, x + 1, y + 1, x, y, x + 1, y + 1, x + 1, y];
      for (let i = 0; i < 6; i++, v++) {
        positions[v * 3] = quad[i * 2] as number;
        positions[v * 3 + 1] = h;
        positions[v * 3 + 2] = quad[i * 2 + 1] as number;
        normals[v * 3 + 1] = 1;
        colors[v * 3] = WATER_COLOR[0];
        colors[v * 3 + 1] = WATER_COLOR[1];
        colors[v * 3 + 2] = WATER_COLOR[2];
        indices[v] = v;
      }
    }
  }
  return { positions, normals, colors, indices, tileCount };
}

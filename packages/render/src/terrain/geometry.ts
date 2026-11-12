import { groundHeightAt, groundNormalAt } from "../heightfield.js";
import { CHUNK, HEIGHT_STEP, SUBDIV } from "../units.js";

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
 * The mesh of one terrain chunk as flat arrays: a grid of `SUBDIV` cells per tile edge whose
 * vertices are shared between the triangles around them, so the shading is smooth.
 */
export interface TerrainChunkGeometry {
  /** World positions, three floats per vertex, row by row from the chunk's north-west corner. */
  positions: Float32Array;
  /** Unit normals of the smooth ground, three floats per vertex. */
  normals: Float32Array;
  /** Three vertex indices per triangle; every triangle is counter-clockwise seen from above. */
  indices: Uint32Array;
  /** Tiles in the chunk. */
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
 *
 * This is the tile as the picker sees it: two flat triangles through the four corners. The drawn
 * ground is the smooth surface through the same corners, which differs by a fraction of a step.
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

/**
 * Builds the smooth terrain mesh of chunk (`chunkX`, `chunkY`), clipped to the map.
 *
 * Every vertex sits on the smooth ground (`groundHeightAt`) and carries the ground's own normal
 * there (`groundNormalAt`), not an average of the triangles around it. Both depend only on the
 * terrain and the vertex's place in the world, so the vertices two neighboring chunks have in
 * common get identical positions and normals: no cracks and no shading seam along chunk borders.
 *
 * Each cell is split along the diagonal joining the two corners with the smaller height
 * difference (ties along NW-SE), which keeps ridges and gullies from looking serrated.
 */
export function buildTerrainChunk(
  t: TerrainData,
  chunkX: number,
  chunkY: number,
): TerrainChunkGeometry {
  const { x0, y0, x1, y1 } = chunkTiles(t, chunkX, chunkY);
  const tilesX = x1 - x0;
  const tilesY = y1 - y0;
  const tileCount = tilesX * tilesY;
  if (tileCount === 0) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      tileCount: 0,
    };
  }

  const cellsX = tilesX * SUBDIV;
  const cellsY = tilesY * SUBDIV;
  const row = cellsX + 1;
  const positions = new Float32Array(row * (cellsY + 1) * 3);
  const normals = new Float32Array(positions.length);
  const indices = new Uint32Array(cellsX * cellsY * 6);

  let v = 0;
  for (let j = 0; j <= cellsY; j++) {
    // Counted in whole cells from the map's corner, so a shared vertex is the same number in
    // every chunk that has it.
    const z = (y0 * SUBDIV + j) / SUBDIV;
    for (let i = 0; i <= cellsX; i++, v += 3) {
      const x = (x0 * SUBDIV + i) / SUBDIV;
      const normal = groundNormalAt(t, x, z);
      positions[v] = x;
      positions[v + 1] = groundHeightAt(t, x, z);
      positions[v + 2] = z;
      normals[v] = normal[0];
      normals[v + 1] = normal[1];
      normals[v + 2] = normal[2];
    }
  }

  let k = 0;
  for (let j = 0; j < cellsY; j++) {
    for (let i = 0; i < cellsX; i++, k += 6) {
      const nw = j * row + i;
      const ne = nw + 1;
      const sw = nw + row;
      const se = sw + 1;
      const hNW = positions[nw * 3 + 1] as number;
      const hNE = positions[ne * 3 + 1] as number;
      const hSW = positions[sw * 3 + 1] as number;
      const hSE = positions[se * 3 + 1] as number;
      if (Math.abs(hNW - hSE) <= Math.abs(hNE - hSW)) {
        indices.set([nw, sw, se, nw, se, ne], k); // NW-SE diagonal
      } else {
        indices.set([nw, sw, ne, ne, sw, se], k); // NE-SW diagonal
      }
    }
  }
  return { positions, normals, indices, tileCount };
}

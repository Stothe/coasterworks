import { z } from "zod";
import { defineQuery } from "../commands/define.js";
import { inBounds } from "../terrain/terrain.js";

/** Most tiles along one side of an area `terrain_get` returns. */
const MAX_AREA_SIDE = 64;

/** Heights, surfaces, and water for a rectangle of tiles. */
export const terrainGet = defineQuery({
  name: "terrain_get",
  description: `Reads an area of terrain, at most ${MAX_AREA_SIDE}x${MAX_AREA_SIDE} tiles. corners holds (w+1)*(h+1) heights; surface and water hold w*h values each. All are row-major: index = row*(w+1)+col for corners, row*w+col for tiles; a row runs along x, rows stack along y.`,
  category: "terrain",
  input: z.object({
    x: z.int().min(0),
    y: z.int().min(0),
    w: z.int().min(1).max(MAX_AREA_SIDE),
    h: z.int().min(1).max(MAX_AREA_SIDE),
  }),
  run: ({ terrain }, { x, y, w, h }) => {
    if (!inBounds(terrain, x, y, w, h)) throw new RangeError("Area is outside the park");

    // Every row of the area is a contiguous run in the world's arrays, so copy it whole.
    const corners: number[] = [];
    for (let cy = y; cy <= y + h; cy++) {
      const start = cy * (terrain.width + 1) + x;
      corners.push(...terrain.corners.subarray(start, start + w + 1));
    }
    const surface: number[] = [];
    const water: number[] = [];
    for (let ty = y; ty < y + h; ty++) {
      const start = ty * terrain.width + x;
      surface.push(...terrain.surface.subarray(start, start + w));
      water.push(...terrain.water.subarray(start, start + w));
    }
    return { x, y, w, h, corners, surface, water };
  },
});

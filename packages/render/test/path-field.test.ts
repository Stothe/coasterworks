import type { Box2, DataTexture, Vector2, Vector4 } from "three";
import { describe, expect, it } from "vitest";
import type { EntrancePlace, RenderContext } from "../src/context.js";
import type { TerrainData } from "../src/terrain/geometry.js";
import {
  PATH_HALF_WIDTH,
  PATH_LANE,
  PATH_MARGIN,
  PATH_TEXELS,
  bakePathField,
  createPathField,
  samplePathField,
  type PathField,
} from "../src/terrain/path-field.js";
import { createPaths } from "../src/terrain/paths.glsl.js";

// The paths module's own data: the baked distance field the shader draws paths from. No other
// module's tests live in this file.

const SIZE = 12;
const FOOTPATH = 1;
const QUEUE = 2;

/** A `SIZE` by `SIZE` path layer with the given tiles set, each `[x, y]` or `[x, y, kind]`. */
function layer(tiles: readonly (readonly number[])[], size = SIZE): Uint8Array {
  const paths = new Uint8Array(size * size);
  for (const [x, y, kind] of tiles) paths[(y as number) * size + (x as number)] = kind ?? FOOTPATH;
  return paths;
}

/** A field baked from scratch for the given tiles. */
function bake(
  tiles: readonly (readonly number[])[],
  entrance: EntrancePlace | null = null,
  size = SIZE,
): PathField {
  const field = createPathField(size, size);
  bakePathField(field, layer(tiles, size), entrance);
  return field;
}

/** A straight run of tiles from (x0, y0) to (x1, y1), ends included. */
function run(x0: number, y0: number, x1: number, y1: number, kind = FOOTPATH): number[][] {
  const tiles: number[][] = [];
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    tiles.push([x0 + Math.sign(x1 - x0) * i, y0 + Math.sign(y1 - y0) * i, kind]);
  }
  return tiles;
}

const distance = (field: PathField, x: number, z: number) => samplePathField(field, x, z).distance;

/** How far from (`cx`, `cz`) the edge of the path is in direction `angle`, by bisection. */
function edgeAlong(field: PathField, cx: number, cz: number, angle: number): number {
  let inside = 0;
  let outside = 0.9;
  for (let i = 0; i < 30; i++) {
    const mid = (inside + outside) / 2;
    if (distance(field, cx + Math.cos(angle) * mid, cz + Math.sin(angle) * mid) < 0) inside = mid;
    else outside = mid;
  }
  return (inside + outside) / 2;
}

/** One byte of distance, in tiles. */
const STEP = 1 / 255;

/** The index of the first byte at which two fields differ, or -1 when they are the same. */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** The least and the greatest distance over a grid of points `step` apart, ends included. */
function range(
  field: PathField,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  step: number,
): { least: number; most: number } {
  let least = Infinity;
  let most = -Infinity;
  for (let x = x0; x <= x1 + 1e-9; x += step) {
    for (let z = z0; z <= z1 + 1e-9; z += step) {
      const d = distance(field, x, z);
      least = Math.min(least, d);
      most = Math.max(most, d);
    }
  }
  return { least, most };
}

describe("createPathField", () => {
  it("covers the map and the margin at eight texels a tile, two bytes a texel, with no paths", () => {
    const field = createPathField(4, 3);
    expect(PATH_TEXELS).toBe(8);
    expect(field.tilesX).toBe(4 + PATH_MARGIN * 2);
    expect(field.tilesY).toBe(3 + PATH_MARGIN * 2);
    expect(field.width).toBe(field.tilesX * PATH_TEXELS);
    expect(field.height).toBe(field.tilesY * PATH_TEXELS);
    expect(field.data.length).toBe(field.width * field.height * 2);
    let other = 0;
    for (let i = 0; i < field.data.length; i += 2) {
      if (field.data[i] !== 255 || field.data[i + 1] !== 0) other++;
    }
    expect(other).toBe(0);
    expect(distance(field, 2, 1.5)).toBeCloseTo(0.5, 6);
  });

  it("is left empty by a bake with no paths, and by a layer of the wrong size", () => {
    const field = createPathField(SIZE, SIZE);
    expect(bakePathField(field, null, null)).toBeNull();
    expect(bakePathField(field, new Uint8Array(5).fill(1), null)).toBeNull();
    expect(firstDifference(field.data, createPathField(SIZE, SIZE).data)).toBe(-1);
  });
});

describe("the baked distance", () => {
  it("makes a lone tile a round pad", () => {
    const field = bake([[5, 5]]);
    const radii: number[] = [];
    for (let k = 0; k < 16; k++) radii.push(edgeAlong(field, 5.5, 5.5, (k * Math.PI) / 8));
    // Round: the same radius whichever way, a little under the half width (the smoothing takes
    // a hair off anything this tightly curved).
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.012);
    expect(Math.min(...radii)).toBeGreaterThan(PATH_HALF_WIDTH - 0.04);
    expect(Math.max(...radii)).toBeLessThan(PATH_HALF_WIDTH + 0.005);
    // Not a square: the tile's corners are well outside, its middle well inside.
    expect(distance(field, 5.05, 5.05)).toBeGreaterThan(0.2);
    expect(distance(field, 5.95, 5.95)).toBeGreaterThan(0.2);
    expect(distance(field, 5.5, 5.5)).toBeLessThan(-0.2);
    // And the next tile over is open ground.
    expect(distance(field, 7.5, 5.5)).toBeCloseTo(0.5, 6);
  });

  it("makes a straight run a band of even width with round ends", () => {
    const field = bake(run(2, 5, 8, 5));
    // Both edges are straight lines 0.4 from the center line, across every tile border.
    for (let x = 3; x <= 8; x += 0.0625) {
      expect(Math.abs(distance(field, x, 5.5 - PATH_HALF_WIDTH))).toBeLessThan(2 * STEP);
      expect(Math.abs(distance(field, x, 5.5 + PATH_HALF_WIDTH))).toBeLessThan(2 * STEP);
      expect(distance(field, x, 5.5)).toBeLessThan(-0.25);
      expect(distance(field, x, 5.5 - 0.3)).toBeCloseTo(-0.1, 1);
      expect(distance(field, x, 5.5 + 0.6)).toBeCloseTo(0.2, 1);
    }
    // The ends are half discs about the last tiles' centers.
    for (const [cx, away] of [
      [2.5, Math.PI],
      [8.5, 0],
    ] as const) {
      for (let k = -4; k <= 4; k++) {
        const radius = edgeAlong(field, cx, 5.5, away + (k * Math.PI) / 8);
        expect(radius).toBeGreaterThan(PATH_HALF_WIDTH - 0.04);
        expect(radius).toBeLessThan(PATH_HALF_WIDTH + 0.005);
      }
    }
    expect(distance(field, 2.12, 5.12)).toBeGreaterThan(0.1);
    expect(distance(field, 1.9, 5.5)).toBeGreaterThan(0.15);
  });

  it("gives a run along Z the same shape as a run along X", () => {
    const alongX = bake(run(2, 5, 8, 5));
    const alongZ = bake(run(5, 2, 5, 8));
    for (let a = 1.5; a <= 9.5; a += 0.19) {
      for (let b = 4.6; b <= 6.4; b += 0.11) {
        expect(distance(alongZ, b, a)).toBeCloseTo(distance(alongX, a, b), 6);
      }
    }
  });

  it("rounds the outside of a bend and fillets the inside", () => {
    // West along row 5 to (5, 5), then north up column 5.
    const field = bake([...run(2, 5, 5, 5), ...run(5, 4, 5, 2)]);
    // Outside (south-east of the corner tile's center): a quarter circle about that center.
    for (let k = 0; k <= 4; k++) {
      const radius = edgeAlong(field, 5.5, 5.5, (k * Math.PI) / 8);
      expect(radius).toBeGreaterThan(PATH_HALF_WIDTH - 0.04);
      expect(radius).toBeLessThan(PATH_HALF_WIDTH + 0.005);
    }
    expect(distance(field, 5.92, 5.92)).toBeGreaterThan(0.15);
    // Inside (north-west): the two edges would meet in a sharp corner at (5.1, 5.1). The fillet
    // puts that point inside the paving and moves the edge out along the diagonal.
    expect(distance(field, 5.1, 5.1)).toBeLessThan(-0.03);
    expect(distance(field, 5.1, 5.1)).toBeGreaterThan(-0.12);
    const reach = edgeAlong(field, 5.1, 5.1, (5 * Math.PI) / 4);
    expect(reach).toBeGreaterThan(0.05);
    expect(reach).toBeLessThan(0.16);
    expect(distance(field, 4.9, 4.9)).toBeGreaterThan(0.1);
    // Away from the bend both arms are back to their straight edges.
    expect(Math.abs(distance(field, 3.5, 5.1))).toBeLessThan(2 * STEP);
    expect(Math.abs(distance(field, 5.1, 3.5))).toBeLessThan(2 * STEP);
    // The bend is the same shape mirrored across its diagonal.
    for (let a = 4.2; a <= 6.2; a += 0.13) {
      for (let b = 4.2; b <= 6.2; b += 0.17) {
        expect(distance(field, a, b)).toBeCloseTo(distance(field, b, a), 6);
      }
    }
  });

  it("keeps the through edge of a T junction straight and fillets both sides of the branch", () => {
    const field = bake([...run(2, 5, 8, 5), ...run(5, 4, 5, 2)]);
    // The far (south) edge does not know the branch is there.
    for (let x = 3; x <= 8; x += 0.0625) {
      expect(Math.abs(distance(field, x, 5.5 + PATH_HALF_WIDTH))).toBeLessThan(2 * STEP);
    }
    // Both inside corners are filleted, and alike.
    expect(distance(field, 5.1, 5.1)).toBeLessThan(-0.03);
    expect(distance(field, 5.9, 5.1)).toBeLessThan(-0.03);
    for (let a = 0; a <= 1.4; a += 0.07) {
      for (let z = 3.6; z <= 6.4; z += 0.13) {
        expect(distance(field, 5.5 + a, z)).toBeCloseTo(distance(field, 5.5 - a, z), 6);
      }
    }
    // The junction is paved right across.
    expect(distance(field, 5.5, 5.5)).toBeLessThan(-0.25);
    expect(distance(field, 5.5, 5.0)).toBeLessThan(-0.25);
  });

  it("makes a cross junction alike on all four sides", () => {
    const field = bake([...run(2, 5, 8, 5), ...run(5, 2, 5, 8)]);
    for (let a = 0; a <= 1.4; a += 0.07) {
      for (let b = 0; b <= 1.4; b += 0.09) {
        const here = distance(field, 5.5 + a, 5.5 + b);
        expect(distance(field, 5.5 - a, 5.5 + b)).toBeCloseTo(here, 6);
        expect(distance(field, 5.5 + a, 5.5 - b)).toBeCloseTo(here, 6);
        expect(distance(field, 5.5 - a, 5.5 - b)).toBeCloseTo(here, 6);
        expect(distance(field, 5.5 + b, 5.5 + a)).toBeCloseTo(here, 6);
      }
    }
    for (const [x, z] of [
      [5.1, 5.1],
      [5.9, 5.1],
      [5.1, 5.9],
      [5.9, 5.9],
    ] as const) {
      expect(distance(field, x, z)).toBeLessThan(-0.03);
    }
    expect(distance(field, 4.85, 4.85)).toBeGreaterThan(0.1);
  });

  it("fills a 2 by 2 block solid", () => {
    const field = bake([
      [5, 5],
      [6, 5],
      [5, 6],
      [6, 6],
    ]);
    // The point the four tiles share is 0.5 from every line between centers: without the fill
    // it would be open ground.
    expect(distance(field, 6, 6)).toBeLessThan(-0.38);
    expect(range(field, 5.5, 6.5, 5.5, 6.5, 0.05).most).toBeLessThan(-0.25);
    // Its sides are straight and its corners round.
    for (let a = 5.6; a <= 6.4; a += 0.05) {
      expect(Math.abs(distance(field, a, 5.5 - PATH_HALF_WIDTH))).toBeLessThan(2 * STEP);
      expect(Math.abs(distance(field, 6.5 + PATH_HALF_WIDTH, a))).toBeLessThan(2 * STEP);
    }
    expect(distance(field, 5.12, 5.12)).toBeGreaterThan(0.1);
  });

  it("fills a plaza of any size, and leaves three tiles in an L open in their crook", () => {
    const plaza: number[][] = [];
    for (let y = 4; y <= 7; y++) for (let x = 3; x <= 7; x++) plaza.push([x, y]);
    const field = bake(plaza);
    expect(range(field, 3.5, 7.5, 4.5, 7.5, 0.0625).most).toBeLessThan(-0.25);
    // Away from its rim it is as deep as the field goes: one flat floor.
    const floor = range(field, 3.8, 7.2, 4.8, 7.2, 0.0625);
    expect(floor.most).toBeCloseTo(-PATH_HALF_WIDTH, 2);
    expect(floor.least).toBeCloseTo(-PATH_HALF_WIDTH, 2);
    for (let x = 3.6; x <= 7.4; x += 0.0625) {
      expect(Math.abs(distance(field, x, 4.5 - PATH_HALF_WIDTH))).toBeLessThan(2 * STEP);
    }

    const crook = bake([
      [5, 5],
      [6, 5],
      [5, 6],
    ]);
    // The middle of the missing fourth tile is open, and so is the shared corner's far side.
    expect(distance(crook, 6.5, 6.5)).toBeGreaterThan(0.3);
    expect(distance(crook, 6.1, 6.1)).toBeGreaterThan(0.05);
  });

  it("does not join tiles that only touch at a corner", () => {
    const field = bake([
      [5, 5],
      [6, 6],
    ]);
    expect(distance(field, 6, 6)).toBeGreaterThan(0.2);
    expect(distance(field, 5.5, 5.5)).toBeLessThan(-0.2);
    expect(distance(field, 6.5, 6.5)).toBeLessThan(-0.2);
  });

  it("keeps every path inside its own tiles", () => {
    const tiles = [...run(2, 5, 8, 5), ...run(5, 2, 5, 8), [9, 9], [2, 2], [3, 2], [2, 3], [3, 3]];
    const field = bake(tiles);
    const paved = layer(tiles);
    let least = Infinity;
    for (let z = 0.03; z < SIZE; z += 0.0625) {
      for (let x = 0.03; x < SIZE; x += 0.0625) {
        if (paved[Math.floor(z) * SIZE + Math.floor(x)]) continue;
        least = Math.min(least, distance(field, x, z));
      }
    }
    expect(least).toBeGreaterThan(0);
  });

  it("packs the distance so that the edge falls between bytes 127 and 128", () => {
    const field = bake(run(2, 5, 8, 5));
    const texel = (x: number, z: number) =>
      field.data[
        (Math.floor((z + PATH_MARGIN) * PATH_TEXELS) * field.width +
          Math.floor((x + PATH_MARGIN) * PATH_TEXELS)) *
          2
      ] as number;
    // The texel centers either side of the north edge at z = 5.1: 5.1875 inside, 5.0625 outside.
    const inside = texel(5.5, 5.19);
    const outside = texel(5.5, 5.06);
    expect(inside).toBeLessThan(127.5);
    expect(outside).toBeGreaterThan(127.5);
    expect(Math.abs(inside - (127.5 - 255 * 0.0875))).toBeLessThanOrEqual(1);
    expect(Math.abs(outside - (127.5 + 255 * 0.0375))).toBeLessThanOrEqual(1);
    // Deep inside and far outside are held at the ends of the byte.
    expect(texel(5.5, 5.5)).toBeGreaterThan(20);
    expect(texel(5.5, 9.5)).toBe(255);
  });
});

describe("the kind channel", () => {
  const queueOf = (field: PathField, x: number, z: number) => samplePathField(field, x, z).queue;

  it("says footpath on footpath tiles and queue on queue tiles, meeting on the tile border", () => {
    const field = bake([...run(2, 5, 5, 5), ...run(6, 5, 9, 5, QUEUE)]);
    expect(queueOf(field, 3.5, 5.5)).toBe(0);
    expect(queueOf(field, 5.9, 5.5)).toBe(0);
    expect(queueOf(field, 6.1, 5.5)).toBe(1);
    expect(queueOf(field, 8.5, 5.5)).toBe(1);
    expect(queueOf(field, 6, 5.5)).toBeCloseTo(0.5, 6);
    expect(queueOf(field, 6, 5.2)).toBeCloseTo(0.5, 6);
    // The shape does not care about the kind: the edge runs straight through the join.
    for (let x = 3; x <= 9; x += 0.0625) {
      expect(Math.abs(distance(field, x, 5.5 - PATH_HALF_WIDTH))).toBeLessThan(2 * STEP);
    }
  });

  it("carries a path's kind onto the open ground beside it", () => {
    const field = bake([...run(2, 5, 5, 5), ...run(6, 5, 9, 5, QUEUE)]);
    // Open tiles beside one kind only.
    expect(queueOf(field, 3.5, 4.8)).toBe(0);
    expect(queueOf(field, 8.5, 4.8)).toBe(1);
    expect(queueOf(field, 8.5, 6.2)).toBe(1);
    // Open tiles beside both: each texel takes the nearer path's kind.
    expect(queueOf(field, 5.2, 4.8)).toBe(0);
    expect(queueOf(field, 6.8, 4.8)).toBe(1);
    // Far from any path there is nothing to say.
    expect(queueOf(field, 3.5, 9.5)).toBe(0);
  });

  it("treats any other nonzero byte as a footpath", () => {
    const field = bake([
      [5, 5, 7],
      [6, 5, 1],
    ]);
    const plain = bake(run(5, 5, 6, 5));
    expect(firstDifference(field.data, plain.data)).toBe(-1);
  });
});

describe("the entrance lane", () => {
  const sides = [
    { side: 0, x: 3, y: 0, dx: 0, dy: -1 },
    { side: 1, x: SIZE - 1, y: 2, dx: 1, dy: 0 },
    { side: 2, x: 3, y: SIZE - 1, dx: 0, dy: 1 },
    { side: 3, x: 0, y: 2, dx: -1, dy: 0 },
  ] as const;

  it("runs straight out of the map from the entrance tile, joined to it", () => {
    for (const { side, x, y, dx, dy } of sides) {
      const field = bake([[x, y]], { x, y, side });
      // Paved along the center line from the entrance tile's middle to the last lane tile's.
      for (let step = 0; step <= PATH_LANE; step += 0.125) {
        expect(distance(field, x + 0.5 + dx * step, y + 0.5 + dy * step)).toBeLessThan(-0.25);
      }
      // A band of the usual width.
      const mid = PATH_LANE / 2;
      const cx = x + 0.5 + dx * mid;
      const cz = y + 0.5 + dy * mid;
      expect(
        Math.abs(distance(field, cx + dy * PATH_HALF_WIDTH, cz + dx * PATH_HALF_WIDTH)),
      ).toBeLessThan(2 * STEP);
      // It ends round, and past its end the ground is open out to the field's border.
      const end = PATH_LANE + PATH_HALF_WIDTH;
      expect(Math.abs(distance(field, x + 0.5 + dx * end, y + 0.5 + dy * end))).toBeLessThan(0.04);
      expect(distance(field, x + 0.5 + dx * (PATH_LANE + 1), y + 0.5 + dy * (PATH_LANE + 1))).toBe(
        0.5,
      );
      // A footpath.
      expect(samplePathField(field, cx, cz).queue).toBe(0);
    }
  });

  it("is drawn even when the entrance tile itself is not paved, and never inside the map", () => {
    const field = bake([], { x: 3, y: SIZE - 1, side: 2 });
    expect(distance(field, 3.5, SIZE + 0.5)).toBeLessThan(-0.25);
    expect(distance(field, 3.5, SIZE + PATH_LANE - 0.5)).toBeLessThan(-0.25);
    for (let z = 0.5; z < SIZE - 0.5; z += 0.5) expect(distance(field, 3.5, z)).toBeGreaterThan(0);
    // An entrance that is not on the edge it names lays its lane only where that leaves the map.
    const inland = bake([], { x: 3, y: SIZE - 3, side: 2 });
    for (let z = 0.5; z < SIZE; z += 0.5) expect(distance(inland, 3.5, z)).toBeGreaterThan(0);
    expect(distance(inland, 3.5, SIZE + 0.5)).toBeLessThan(-0.25);
  });

  it("is not there without an entrance, and goes when the entrance goes", () => {
    const field = bake([[3, SIZE - 1]], { x: 3, y: SIZE - 1, side: 2 });
    expect(distance(field, 3.5, SIZE + 1.5)).toBeLessThan(0);
    bakePathField(field, layer([[3, SIZE - 1]]), null);
    expect(firstDifference(field.data, bake([[3, SIZE - 1]]).data)).toBe(-1);
    expect(distance(field, 3.5, SIZE + 1.5)).toBe(0.5);
  });
});

describe("bakePathField, bake after bake", () => {
  it("says nothing changed when nothing did", () => {
    const tiles = run(2, 5, 8, 5);
    const field = bake(tiles);
    const before = field.data.slice();
    expect(bakePathField(field, layer(tiles), null)).toBeNull();
    expect(firstDifference(field.data, before)).toBe(-1);
  });

  it("rewrites only the tiles around a change and reports them", () => {
    const field = bake(run(2, 5, 8, 5), null, 32);
    const before = field.data.slice();
    const changed = bakePathField(field, layer([...run(2, 5, 8, 5), [20, 21]], 32), null);
    // The new tile and one tile around it.
    expect(changed).toEqual({
      x: (20 - 1 + PATH_MARGIN) * PATH_TEXELS,
      y: (21 - 1 + PATH_MARGIN) * PATH_TEXELS,
      width: 3 * PATH_TEXELS,
      height: 3 * PATH_TEXELS,
    });
    if (!changed) return;
    let touchedOutside = 0;
    for (let y = 0; y < field.height; y++) {
      for (let x = 0; x < field.width; x++) {
        const inRect =
          x >= changed.x &&
          x < changed.x + changed.width &&
          y >= changed.y &&
          y < changed.y + changed.height;
        if (inRect) continue;
        const at = (y * field.width + x) * 2;
        if (field.data[at] !== before[at] || field.data[at + 1] !== before[at + 1])
          touchedOutside++;
      }
    }
    expect(touchedOutside).toBe(0);
    expect(distance(field, 20.5, 21.5)).toBeLessThan(-0.2);
  });

  it("ends up exactly where a bake from scratch would, whatever the order of changes", () => {
    // A repeatable scatter of edits: add, change kind, remove.
    let seed = 12345;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    const size = 20;
    const paths = new Uint8Array(size * size);
    const field = createPathField(size, size);
    const entrances: (EntrancePlace | null)[] = [
      null,
      { x: 7, y: size - 1, side: 2 },
      { x: 0, y: 4, side: 3 },
    ];
    for (let round = 0; round < 60; round++) {
      const edits = 1 + Math.floor(next() * 4);
      for (let k = 0; k < edits; k++) {
        paths[Math.floor(next() * paths.length)] = Math.floor(next() * 3);
      }
      const entrance = entrances[round % entrances.length] as EntrancePlace | null;
      bakePathField(field, paths, entrance);
      const fresh = createPathField(size, size);
      bakePathField(fresh, paths, entrance);
      expect(firstDifference(field.data, fresh.data)).toBe(-1);
    }
    // Everything taken away again: back to the empty field.
    bakePathField(field, null, null);
    expect(firstDifference(field.data, createPathField(size, size).data)).toBe(-1);
  });

  it("is a seamless field: no step in the distance across any texel, tile borders included", () => {
    const tiles = [...run(2, 5, 8, 5), ...run(5, 2, 5, 8), [9, 9], [2, 2], [3, 2], [2, 3], [3, 3]];
    const field = bake(tiles);
    // A true distance changes by at most one texel's width from texel to texel.
    let steepest = 0;
    for (let y = 0; y < field.height; y++) {
      for (let x = 0; x < field.width; x++) {
        const at = (y * field.width + x) * 2;
        const here = field.data[at] as number;
        if (x + 1 < field.width) {
          steepest = Math.max(steepest, Math.abs(here - (field.data[at + 2] as number)));
        }
        if (y + 1 < field.height) {
          const below = field.data[at + field.width * 2] as number;
          steepest = Math.max(steepest, Math.abs(here - below));
        }
      }
    }
    expect(steepest).toBeLessThanOrEqual(Math.ceil(255 / PATH_TEXELS) + 1);
  });
});

describe("createPaths", () => {
  interface Copy {
    source: DataTexture;
    target: DataTexture;
    min: [number, number];
    max: [number, number];
    at: [number, number];
  }

  /** A paths module on a context that only notes what it is asked to copy to the GPU. */
  function setUp() {
    const copies: Copy[] = [];
    const renderer = {
      copyTextureToTexture(source: DataTexture, target: DataTexture, region: Box2, at: Vector2) {
        copies.push({
          source,
          target,
          min: [region.min.x, region.min.y],
          max: [region.max.x, region.max.y],
          at: [at.x, at.y],
        });
      },
    };
    const ctx = { quality: "high", renderer } as unknown as RenderContext;
    const module = createPaths(ctx);
    const texture = () => module.uniforms.cwPath_field?.value as DataTexture;
    return { module, copies, texture };
  }

  const terrain = (width: number, height: number) => ({ width, height }) as TerrainData;
  const frame = undefined as never;

  it("offers the chunk: the cwPaths function and the uniforms it declares", () => {
    const { module } = setUp();
    expect(module.glsl).toContain("void cwPaths(inout CwSurf s, vec3 worldPos)");
    for (const name of Object.keys(module.uniforms)) {
      expect(module.glsl).toMatch(new RegExp(`uniform \\w+ ${name};`));
    }
    const declared = [...module.glsl.matchAll(/uniform \w+ (\w+);/g)].map((match) => match[1]);
    expect(declared.sort()).toEqual(Object.keys(module.uniforms).sort());
    // Every name of its own carries the chunk's prefix.
    const names = [...module.glsl.matchAll(/^(?:const )?\w+ (\w+)\(|^const \w+ (\w+) =/gm)];
    for (const match of names) {
      const name = match[1] ?? match[2];
      if (name !== "cwPaths") expect(name).toMatch(/^cwPath_/);
    }
    module.dispose();
  });

  it("lays the field over the map and its margin", () => {
    const { module, texture } = setUp();
    module.setTerrain?.(terrain(20, 12));
    const rect = module.uniforms.cwPath_rect?.value as Vector4;
    expect(rect.x).toBe(-PATH_MARGIN);
    expect(rect.y).toBe(-PATH_MARGIN);
    expect(rect.z).toBeCloseTo(1 / (20 + 2 * PATH_MARGIN), 9);
    expect(rect.w).toBeCloseTo(1 / (12 + 2 * PATH_MARGIN), 9);
    expect(texture().image.width).toBe((20 + 2 * PATH_MARGIN) * PATH_TEXELS);
    expect(texture().image.height).toBe((12 + 2 * PATH_MARGIN) * PATH_TEXELS);
    module.dispose();
  });

  it("sends a new field whole, then only the rectangle a small change rewrote", () => {
    const { module, copies, texture } = setUp();
    module.setTerrain?.(terrain(SIZE, SIZE));
    module.setPaths(layer(run(2, 5, 8, 5)));
    module.setEntrance({ x: 3, y: SIZE - 1, side: 2 });
    const whole = texture().version;
    module.update?.(frame);
    // The first upload is the texture's own: nothing is copied piecemeal.
    expect(copies.length).toBe(0);
    expect(texture().version).toBeGreaterThanOrEqual(whole);
    const uploaded = texture().version;

    // One more tile, as when a path is dragged out.
    module.setPaths(layer([...run(2, 5, 8, 5), [9, 5]]));
    module.update?.(frame);
    expect(texture().version).toBe(uploaded);
    expect(copies.length).toBe(1);
    const copy = copies[0] as Copy;
    expect(copy.target).toBe(texture());
    expect(copy.source).not.toBe(texture());
    expect(copy.source.image.data).toBe(texture().image.data);
    expect(copy.min).toEqual([(8 + PATH_MARGIN) * PATH_TEXELS, (4 + PATH_MARGIN) * PATH_TEXELS]);
    expect(copy.max).toEqual([(11 + PATH_MARGIN) * PATH_TEXELS, (7 + PATH_MARGIN) * PATH_TEXELS]);
    expect(copy.at).toEqual(copy.min);

    // Nothing new: nothing sent.
    module.setPaths(layer([...run(2, 5, 8, 5), [9, 5]]));
    module.update?.(frame);
    module.update?.(frame);
    expect(copies.length).toBe(1);
    expect(texture().version).toBe(uploaded);
    module.dispose();
  });

  it("gathers several changes between frames into one upload", () => {
    const { module, copies } = setUp();
    module.setTerrain?.(terrain(40, 40));
    module.setPaths(layer([], 40));
    module.update?.(frame);
    module.setPaths(layer([[5, 5]], 40));
    module.setPaths(
      layer(
        [
          [5, 5],
          [9, 7],
        ],
        40,
      ),
    );
    module.update?.(frame);
    expect(copies.length).toBe(1);
    const copy = copies[0] as Copy;
    expect(copy.min).toEqual([(4 + PATH_MARGIN) * PATH_TEXELS, (4 + PATH_MARGIN) * PATH_TEXELS]);
    expect(copy.max).toEqual([(11 + PATH_MARGIN) * PATH_TEXELS, (9 + PATH_MARGIN) * PATH_TEXELS]);
    module.dispose();
  });

  it("sends the field whole when most of it changed, and starts afresh for a map of another size", () => {
    const { module, copies, texture } = setUp();
    module.setTerrain?.(terrain(SIZE, SIZE));
    module.update?.(frame);
    const before = texture().version;
    const all: number[][] = [];
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) all.push([x, y]);
    module.setPaths(layer(all));
    module.update?.(frame);
    expect(copies.length).toBe(0);
    expect(texture().version).toBeGreaterThan(before);

    const first = texture();
    module.setTerrain?.(terrain(SIZE + 4, SIZE));
    expect(texture()).not.toBe(first);
    // The old layer does not fit the new map: no paths until the new layer arrives.
    const data = texture().image.data as Uint8Array;
    let paved = 0;
    for (let i = 0; i < data.length; i += 2) if ((data[i] as number) < 128) paved++;
    expect(paved).toBe(0);
    // The same size again changes nothing.
    const second = texture();
    module.setTerrain?.(terrain(SIZE + 4, SIZE));
    expect(texture()).toBe(second);
    module.dispose();
  });

  it("follows the quality in force", () => {
    const { module } = setUp();
    expect(module.uniforms.cwPath_quality?.value).toBe(2);
    module.setQuality?.("low");
    expect(module.uniforms.cwPath_quality?.value).toBe(0);
    module.setQuality?.("medium");
    expect(module.uniforms.cwPath_quality?.value).toBe(1);
    module.dispose();
  });
});

import {
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
} from "three";
import type { EntrancePlace, Quality, RenderContext, SceneModule } from "./context.js";
import { buildHedge } from "./scenery/boundary.js";
import {
  EDGE_REACH,
  LAND_REACH,
  buildSurroundingsGeometry,
  createOuterLand,
  loopAt,
  meanEdgeHeight,
  ringLoops,
  type OuterLand,
  type SurroundingsGeometry,
} from "./scenery/land.js";
import { createSceneryMaterials } from "./scenery/material.js";
import { onLane, scatterScenery, type Scatter } from "./scenery/scatter.js";
import {
  LOD_COUNT,
  SPRUCE,
  VARIANTS,
  buildSceneryShape,
  type SceneryKind,
  type SceneryLod,
  type SceneryShape,
} from "./scenery/shapes.js";
import type { TerrainData } from "./terrain/geometry.js";

/** The land beyond the park. */
export type SurroundingsModule = SceneModule;

/**
 * How far the land with things on it runs out from the park's edge, in tiles. (Bare far ridges
 * are drawn further still, for the haze to fade into: see `scenery/land.ts`.)
 */
export const SURROUNDINGS_REACH = LAND_REACH;

/**
 * Things within this many tiles of the park are kept in small plots with every model of their
 * kind; the rest, which the camera seldom comes near, in large plots with one model a kind.
 */
const NEAR_BAND = 30;
/** The side of a plot in each band, in tiles. A plot is culled, and its detail chosen, as one. */
const PLOT_SIZE = [32, 52] as const;
/** The finest level of detail each band is ever drawn at. */
const FINEST = [0, 1] as const;

/**
 * How far from the camera, in tiles, each level of detail gives way to the next coarser one, by
 * quality and band. Measured to the nearest point of a plot. The near band holds few trees and
 * they are the ones looked at, so it keeps its detail further.
 */
const LOD_RANGE: Record<Quality, readonly (readonly [number, number, number])[]> = {
  high: [
    [16, 100, 190],
    [0, 28, 96],
  ],
  medium: [
    [12, 72, 150],
    [0, 18, 78],
  ],
  low: [
    [8, 44, 110],
    [0, 8, 60],
  ],
};
/** A plot goes back to a finer level only once the camera is this much inside its range. */
const LOD_SLACK = 0.9;
/** The share of the far band's trees each quality draws; they go in the order of their rank. */
const FAR_SHARE: Record<Quality, number> = { high: 1, medium: 0.82, low: 0.6 };
/** The coarsest level of detail that still casts shadows, by quality. */
const SHADOW_LOD: Record<Quality, number> = { high: 1, medium: 1, low: 0 };
/** How deep each kind is set into the ground, as a share of its size. */
const SINK: readonly number[] = [0.03, 0.03, 0.03, 0.05, 0.12];

/** The things of one kind (and, near the park, one model) in one plot of land. */
interface Cluster {
  /** One mesh per level of detail, all drawing the same instances; null where there is none. */
  meshes: (InstancedMesh | null)[];
  /** The level now shown, or -1 for none. */
  shown: number;
  finest: number;
  /** 0 for the band near the park, 1 for the far one. */
  band: number;
  /** How many of its instances the quality in force draws. */
  count: number;
  /** A sphere around every instance: its middle and radius. */
  x: number;
  y: number;
  z: number;
  radius: number;
  far: boolean;
  matrices: InstancedBufferAttribute;
  /** Per instance, in drawing order (by rank): where it stands, how far out, how deep. */
  px: Float32Array;
  pz: Float32Array;
  distance: Float32Array;
  sink: Float32Array;
  rank: Float32Array;
}

function ringGeometry(built: SurroundingsGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(built.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(built.normals, 3));
  geometry.setIndex(new BufferAttribute(built.indices, 1));
  return geometry;
}

function shapeGeometry(shape: SceneryShape): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(shape.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(shape.normals, 3));
  geometry.setAttribute("color", new BufferAttribute(shape.colors, 3));
  geometry.setAttribute("cwAux", new BufferAttribute(shape.aux, 3));
  const count = shape.positions.length / 3;
  geometry.setIndex(
    new BufferAttribute(count > 65535 ? shape.indices : new Uint16Array(shape.indices), 1),
  );
  return geometry;
}

/** A number that changes when the land near the park's edge does, which is all the ring depends on. */
function edgeSignature(t: TerrainData): number {
  const stride = t.width + 1;
  // The ring's heights come from the edge corners; its border normals reach two corners further in.
  const band = 3;
  let h = (t.width * 73856093) ^ (t.height * 19349663);
  for (let cz = 0; cz <= t.height; cz++) {
    const edgeRow = cz < band || cz > t.height - band;
    for (let cx = 0; cx <= t.width; cx++) {
      if (!edgeRow && cx >= band && cx <= t.width - band) {
        // Skip the middle of the row.
        cx = t.width - band;
        continue;
      }
      h = Math.imul(h ^ (t.corners[cz * stride + cx] as number), 16777619);
    }
  }
  return h;
}

const NOTHING = new Uint8Array(0);
const DBG_NOTREES = typeof location !== "undefined" && location.search.includes("notrees"); // DBG
const DBG_NOFAR = typeof location !== "undefined" && location.search.includes("nofar"); // DBG

/**
 * Creates the surroundings module: everything beyond the park's edge.
 *
 * - The land: a ring of ground that starts on the park's own border vertices, runs level for a
 *   few tiles and then rises into rolling hills (`scenery/land.ts`), drawn with the terrain
 *   material, whose surface chunk makes it meadow. Its height is given to the scene with
 *   `ctx.setOuterGround`, so the camera stays out of the hills and everything out here stands on
 *   the same ground.
 * - Trees, bushes and rocks (`scenery/shapes.ts`), scattered in clumps and clearings that thicken
 *   into forest toward the horizon (`scenery/scatter.ts`). They are drawn as instances, plot by
 *   plot of land: each plot is culled as one and drawn at the level of detail its distance from
 *   the camera calls for, from models with every spray of leaves down to a dozen vertices.
 * - The hedge along the park's edge, open at the entrance (`scenery/boundary.ts`).
 *
 * Nothing stands inside the park, and the way in to the entrance is kept clear. An edit inside
 * the park changes nothing here; an edit at its edge rebuilds only the nearest part of the land
 * and the hedge, and sets the things standing there back on the ground.
 */
export function createSurroundings(ctx: RenderContext): SurroundingsModule {
  const materials = createSceneryMaterials(ctx);
  const loops = ringLoops();
  const split = loopAt(loops, EDGE_REACH);
  /** The models, made when first wanted. */
  const models = new Map<number, BufferGeometry>();

  let size: { width: number; height: number } | null = null;
  let signature = 0;
  let base = 0;
  let land: OuterLand | null = null;
  let near: Mesh | null = null;
  let far: Mesh | null = null;
  let hedge: Mesh | null = null;
  let scatter: Scatter | null = null;
  let clusters: Cluster[] = [];
  let entrance: EntrancePlace | null = ctx.entrance();
  let quality: Quality = ctx.quality;
  let debugFrames = 0;

  function model(kind: SceneryKind, lod: SceneryLod, variant: number): BufferGeometry {
    const key = (kind * LOD_COUNT + lod) * 16 + variant;
    let geometry = models.get(key);
    if (!geometry) {
      geometry = shapeGeometry(buildSceneryShape(kind, variant, lod));
      geometry.computeBoundingSphere();
      // The wind moves a canopy a little way out of its still outline.
      if (geometry.boundingSphere) geometry.boundingSphere.radius += 0.15;
      models.set(key, geometry);
    }
    return geometry;
  }

  function drop(mesh: Mesh | null): void {
    if (!mesh) return;
    ctx.scene.remove(mesh);
    mesh.geometry.dispose();
  }

  function clearClusters(): void {
    for (const cluster of clusters) {
      for (const mesh of cluster.meshes) {
        if (!mesh) continue;
        ctx.scene.remove(mesh);
        // The geometry is a shared model; only the per-instance buffers are the cluster's own.
        mesh.dispose();
      }
    }
    clusters = [];
  }

  /** Encloses every instance of `cluster` in its sphere, from the finest mesh it has. */
  function bound(cluster: Cluster): void {
    for (const mesh of cluster.meshes) {
      if (!mesh) continue;
      const drawn = mesh.count;
      // Over every instance, so the sphere holds whatever the quality draws.
      mesh.count = cluster.rank.length;
      mesh.computeBoundingSphere();
      mesh.count = drawn;
    }
    const sphere = cluster.meshes.find((mesh) => mesh)?.boundingSphere;
    if (!sphere) return;
    cluster.x = sphere.center.x;
    cluster.y = sphere.center.y;
    cluster.z = sphere.center.z;
    cluster.radius = sphere.radius;
  }

  /** How much of every cluster the quality in force draws, and which of its meshes cast shadows. */
  function applyQuality(): void {
    const share = FAR_SHARE[quality];
    for (const cluster of clusters) {
      let count = cluster.rank.length;
      if (cluster.far) {
        count = 0;
        while (count < cluster.rank.length && (cluster.rank[count] as number) < share) count++;
      }
      cluster.count = count;
      cluster.meshes.forEach((mesh, lod) => {
        if (!mesh) return;
        mesh.count = count;
        // At the best quality the trees by the park keep their shadows from as far as they show.
        mesh.castShadow =
          lod <= SHADOW_LOD[quality] || (quality === "high" && cluster.band === 0 && lod === 2);
      });
    }
  }

  /** Shows each cluster at the level of detail its distance from the camera calls for. */
  function chooseDetail(): void {
    const eye = ctx.camera.position;
    const ranges = LOD_RANGE[quality];
    for (const cluster of clusters) {
      const range = ranges[cluster.band] as readonly [number, number, number];
      const dx = eye.x - cluster.x;
      const dy = eye.y - cluster.y;
      const dz = eye.z - cluster.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - cluster.radius;
      let lod = d < range[0] ? 0 : d < range[1] ? 1 : d < range[2] ? 2 : 3;
      // Stepping to a finer level takes coming a little closer than stepping off it did, so a
      // plot on the line does not flicker between two.
      if (cluster.shown >= 0 && lod < cluster.shown && d > (range[lod] as number) * LOD_SLACK) {
        lod = cluster.shown;
      }
      if (lod < cluster.finest) lod = cluster.finest;
      if (DBG_NOTREES || (DBG_NOFAR && cluster.band === 1)) lod = -1; // DBG
      // Small things have no far model: beyond their last they are not drawn.
      if (!cluster.meshes[lod] || cluster.count === 0) lod = -1;
      if (lod === cluster.shown) continue;
      const before = cluster.meshes[cluster.shown];
      if (before) before.visible = false;
      const now = cluster.meshes[lod];
      if (now) now.visible = true;
      cluster.shown = lod;
    }
  }

  /** Turns the scatter into clusters of instances, leaving the way in to the entrance clear. */
  function buildClusters(): void {
    clearClusters();
    if (!scatter || !land || !size) return;
    const s = scatter;

    const members = new Map<string, number[]>();
    for (let i = 0; i < s.count; i++) {
      const x = s.x[i] as number;
      const z = s.z[i] as number;
      if (onLane(size.width, size.height, entrance, x, z)) continue;
      const kind = s.kind[i] as number;
      const band = (s.distance[i] as number) < NEAR_BAND ? 0 : 1;
      const plot = PLOT_SIZE[band];
      // Near the park every model of a kind is used; far out, one.
      const variants = band === 0 ? ((VARIANTS[kind] as readonly number[])[0] as number) : 1;
      const variant = (s.variant[i] as number) % variants;
      const key = `${band},${Math.floor(x / plot)},${Math.floor(z / plot)},${kind},${variant}`;
      let list = members.get(key);
      if (!list) members.set(key, (list = []));
      list.push(i);
    }

    for (const [key, list] of members) {
      const [band, , , kind, variant] = key.split(",").map(Number) as [
        number,
        number,
        number,
        SceneryKind,
        number,
      ];
      list.sort((a, b) => (s.rank[a] as number) - (s.rank[b] as number));

      const count = list.length;
      const matrices = new InstancedBufferAttribute(new Float32Array(count * 16), 16);
      const tints = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
      const cluster: Cluster = {
        meshes: [],
        shown: -1,
        finest: FINEST[band as 0 | 1],
        band,
        count,
        x: 0,
        y: 0,
        z: 0,
        radius: 0,
        far: band === 1 && kind <= SPRUCE,
        matrices,
        px: new Float32Array(count),
        pz: new Float32Array(count),
        distance: new Float32Array(count),
        sink: new Float32Array(count),
        rank: new Float32Array(count),
      };
      const m = matrices.array;
      for (let n = 0; n < count; n++) {
        const i = list[n] as number;
        const x = s.x[i] as number;
        const z = s.z[i] as number;
        const across = s.size[i] as number;
        const turn = s.turn[i] as number;
        const sink = (SINK[kind] as number) * across;
        const cos = Math.cos(turn) * across;
        const sin = Math.sin(turn) * across;
        // A turn about the vertical and a scale, column by column.
        const o = n * 16;
        m[o] = cos;
        m[o + 2] = -sin;
        m[o + 5] = s.tall[i] as number;
        m[o + 8] = sin;
        m[o + 10] = cos;
        m[o + 12] = x;
        m[o + 13] = land.heightAt(x, z) - sink;
        m[o + 14] = z;
        m[o + 15] = 1;
        tints.array[n * 3] = s.tint[i * 3] as number;
        tints.array[n * 3 + 1] = s.tint[i * 3 + 1] as number;
        tints.array[n * 3 + 2] = s.tint[i * 3 + 2] as number;
        cluster.px[n] = x;
        cluster.pz[n] = z;
        cluster.distance[n] = s.distance[i] as number;
        cluster.sink[n] = sink;
        cluster.rank[n] = s.rank[i] as number;
      }

      const available = VARIANTS[kind] as readonly number[];
      for (let lod = 0; lod < LOD_COUNT; lod++) {
        const variants = available[lod] as number;
        if (lod < cluster.finest || variants === 0) {
          cluster.meshes.push(null);
          continue;
        }
        const geometry = model(kind, lod as SceneryLod, variant % variants);
        // Made empty and then given the cluster's own instances, which all its levels share.
        const mesh = new InstancedMesh(geometry, materials.lit, 0);
        mesh.instanceMatrix = matrices;
        mesh.instanceColor = tints;
        mesh.count = count;
        mesh.customDepthMaterial = materials.depth;
        mesh.receiveShadow = lod < 3;
        mesh.visible = false;
        mesh.matrixAutoUpdate = false;
        ctx.scene.add(mesh);
        cluster.meshes.push(mesh);
      }
      bound(cluster);
      clusters.push(cluster);
    }
    applyQuality();
    chooseDetail();
    console.log(
      "clusters",
      clusters.length,
      "instances",
      clusters.reduce((n, c) => n + c.rank.length, 0),
    );
  }

  /** Sets everything near the park back on the ground after the ground there changed. */
  function reseat(): void {
    if (!land) return;
    for (const cluster of clusters) {
      const m = cluster.matrices.array;
      let moved = false;
      for (let n = 0; n < cluster.px.length; n++) {
        if ((cluster.distance[n] as number) >= EDGE_REACH) continue;
        const y =
          land.heightAt(cluster.px[n] as number, cluster.pz[n] as number) -
          (cluster.sink[n] as number);
        if (m[n * 16 + 13] === Math.fround(y)) continue;
        m[n * 16 + 13] = y;
        moved = true;
      }
      if (moved) {
        cluster.matrices.needsUpdate = true;
        bound(cluster);
      }
    }
  }

  function buildHedgeMesh(): void {
    drop(hedge);
    hedge = null;
    if (!land || !size) return;
    const shape = buildHedge(size.width, size.height, land.heightAt, entrance);
    if (!shape) return;
    hedge = new Mesh(shapeGeometry(shape), materials.lit);
    hedge.castShadow = true;
    hedge.receiveShadow = true;
    hedge.matrixAutoUpdate = false;
    ctx.scene.add(hedge);
  }

  function ringMesh(t: TerrainData, from: number, to: number, shadows: boolean): Mesh {
    const built = buildSurroundingsGeometry(t, land as OuterLand, loops, from, to);
    const mesh = new Mesh(ringGeometry(built), ctx.terrainMaterial());
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    ctx.scene.add(mesh);
    return mesh;
  }

  return {
    setTerrain(t: TerrainData): void {
      const resized = !size || size.width !== t.width || size.height !== t.height;
      const next = edgeSignature(t);
      if (!resized && next === signature) return;
      signature = next;
      size = { width: t.width, height: t.height };
      // The land keeps reading the park's edge long after this call, so it gets heights of its
      // own that no later edit (or handing on of the terrain's buffers) can change under it.
      const edge: TerrainData = {
        ...size,
        corners: t.corners.slice(),
        surface: NOTHING,
        water: NOTHING,
      };
      // The hills keep the base of the first land, so an edit at the edge moves only what is
      // near it.
      if (resized) base = meanEdgeHeight(edge);
      land = createOuterLand(edge, base);
      ctx.setOuterGround(land.heightAt);

      drop(near);
      near = ringMesh(edge, 0, split, true);
      if (resized) {
        drop(far);
        far = ringMesh(edge, split, loops.length - 1, false);
        scatter = scatterScenery(t.width, t.height);
        buildClusters();
      } else {
        reseat();
      }
      buildHedgeMesh();
    },
    setEntrance(next: EntrancePlace | null): void {
      const same =
        (next === null && entrance === null) ||
        (next !== null &&
          entrance !== null &&
          next.x === entrance.x &&
          next.y === entrance.y &&
          next.side === entrance.side);
      if (same) return;
      entrance = next ? { x: next.x, y: next.y, side: next.side } : null;
      // The hedge opens somewhere else, and so does the clear way through the trees.
      buildHedgeMesh();
      buildClusters();
    },
    setQuality(q: Quality): void {
      quality = q;
      applyQuality();
    },
    update(): void {
      chooseDetail();
      if (++debugFrames % 200 === 100) {
        const tris = [0, 0, 0, 0, 0, 0, 0, 0];
        const count = [0, 0, 0, 0, 0, 0, 0, 0];
        for (const c of clusters) {
          const mesh = c.meshes[c.shown];
          if (!mesh) continue;
          tris[c.band * 4 + c.shown]! += ((mesh.geometry.index?.count ?? 0) / 3) * mesh.count;
          count[c.band * 4 + c.shown]! += mesh.count;
        }
        console.log("DBG calls", ctx.renderer.info.render.calls, "tris", ctx.renderer.info.render.triangles, "bandlod tris", tris.map((t) => Math.round(t / 1000)).join("/"), "count", count.join("/"));
      }
    },
    dispose(): void {
      ctx.setOuterGround(null);
      clearClusters();
      drop(near);
      drop(far);
      drop(hedge);
      near = far = hedge = null;
      for (const geometry of models.values()) geometry.dispose();
      models.clear();
      materials.dispose();
    },
  };
}

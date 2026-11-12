import { rotatedFootprint, rotateSide, typeById, type Rot, type Side } from "@coasterworks/content";
import type { RidePublic, RideStatusSection } from "@coasterworks/protocol";
import type { FrameInfo, Quality, RenderContext, SceneModule } from "../context.js";
import type { Ray } from "../picker.js";
import { createRideMaterials } from "./materials.js";
import {
  buildRideModel,
  rideDetailFor,
  type RideDetail,
  type RideInstance,
  type RideModel,
} from "./recipes.js";

/**
 * The ride layer: every ride and stall of the park drawn from its recipe (`recipes.ts`), placed
 * on its footprint, turned by its rotation and moving as its phase says, plus the placement ghost
 * and picking. It draws and answers; what a ride does is the sim's business.
 */

/** What the layer needs to know of a ride: the protocol's public record does. */
export type RidePlace = Pick<RidePublic, "id" | "type" | "x" | "y" | "rot" | "open">;

/** A ride about to be placed, drawn see-through on its footprint: green when `ok`, red when not,
 * and grey while `ok` is null: the sim has not said yet. */
export interface PlacementGhost {
  type: string;
  x: number;
  y: number;
  rot: Rot;
  ok: boolean | null;
}

export type RidesModule = SceneModule & {
  /**
   * The rides of the latest snapshot that carried them, or null for none. Rides are matched by
   * id: one already drawn stays (and keeps moving), a new one is built, a missing one goes.
   */
  setRides(list: readonly RidePlace[] | null): void;
  /**
   * What every ride is doing (ascending id order), applied each frame by id. A status for a ride
   * not drawn, or a ride with no status, is fine: the two can disagree for a frame.
   */
  setRideStatus(status: RideStatusSection | null): void;
  setPlacementGhost(ghost: PlacementGhost | null): void;
  /**
   * How fast the sim runs: 0 is paused, 1, 2, 4 and 8 are multipliers. Rides move in sim time:
   * paused they hold their pose, and at 8x they ease up and down, and turn, eight times faster.
   */
  setSimSpeed(speed: number): void;
  /**
   * The ride a world-space ray hits first (its pick boxes: most are one box of footprint and
   * height, a big wheel's are its base and its disc), with how far along
   * the ray (in units of the ray's direction made unit length), or null. With `reach`, only a
   * hit nearer than that counts.
   */
  pickAt(ray: Ray, reach?: number): { id: number; distance: number } | null;
};

/** The plan's name for the ride layer. */
export type RideLayer = RidesModule;

/** How fast a ride gets up to speed or comes to a stop: the time constant, in seconds. */
export const MOTION_EASE_S = 0.9;

/** How hard a ride is going and how far it has turned. */
export interface RideMotion {
  angle: number;
  speed: number;
}

/** How hard a ride in `phase` should be going: only a running, open ride moves. */
export function motionTarget(phase: number, open: boolean): number {
  return open && phase === 2 ? 1 : 0;
}

/**
 * Moves `motion` on by `dt` seconds toward the speed `phase` asks for, turning at `spinRate`
 * radians a second at full speed. Writes into `motion`; allocates nothing.
 */
export function stepMotion(
  motion: RideMotion,
  phase: number,
  open: boolean,
  dt: number,
  spinRate: number,
): void {
  const target = motionTarget(phase, open);
  if (dt > 0) {
    motion.speed += (target - motion.speed) * (1 - Math.exp(-dt / MOTION_EASE_S));
    if (target === 0 && motion.speed < 1e-3) motion.speed = 0;
    motion.angle = (motion.angle + spinRate * motion.speed * dt) % (Math.PI * 2);
  }
}

/** The yaw, about +Y, that turns a model's front (+Z, south) to face `side`. */
export function yawForSide(side: Side): number {
  return side === 2 ? 0 : side === 1 ? Math.PI / 2 : side === 0 ? Math.PI : -Math.PI / 2;
}

interface Entry {
  id: number;
  type: string;
  x: number;
  y: number;
  rot: Rot;
  open: boolean;
  model: RideModel;
  instance: RideInstance;
  motion: RideMotion;
  /** Whether a status has been seen yet: the first one sets the speed outright. */
  seen: boolean;
  /** The world boxes the ride is picked by, six numbers each: minX, maxX, minY, maxY, minZ, maxZ. */
  boxes: number[];
}

/**
 * Where the first hit of `ray` with the box is along it, as a distance in units of the ray's
 * unit direction, or Infinity on a miss. A ray starting inside the box hits it at 0.
 */
export function rayBoxDistance(
  ray: Ray,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): number {
  const { origin: o, direction: d } = ray;
  const length = Math.hypot(d.x, d.y, d.z);
  if (!(length > 0)) return Infinity;
  let near = 0;
  let far = Infinity;
  const axes: [number, number, number, number][] = [
    [o.x, d.x / length, minX, maxX],
    [o.y, d.y / length, minY, maxY],
    [o.z, d.z / length, minZ, maxZ],
  ];
  for (const [start, step, lo, hi] of axes) {
    if (Math.abs(step) < 1e-12) {
      if (start < lo || start > hi) return Infinity;
      continue;
    }
    let t0 = (lo - start) / step;
    let t1 = (hi - start) / step;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return Infinity;
  }
  return near;
}

export function createRides(ctx: RenderContext): RidesModule {
  const materials = createRideMaterials(ctx);
  const cheap = () => (ctx.software ?? false) && ctx.quality === "low";
  materials.setCloudShadow(!cheap());
  let detail: RideDetail = rideDetailFor(ctx.quality, ctx.software ?? false);
  /** One model per model id in use, at `detail`. */
  const models = new Map<string, RideModel>();
  /** Drawn rides in ascending id order. */
  let entries: Entry[] = [];
  let places: readonly RidePlace[] = [];
  let status: RideStatusSection | null = null;
  let ghostSpec: PlacementGhost | null = null;
  let ghost: { model: RideModel; instance: RideInstance; ok: boolean | null } | null = null;
  let simSpeed = 1;

  const castsShadow = () => ctx.quality !== "low";
  const receivesShadow = () => !(ctx.software && ctx.quality === "low");

  function modelFor(type: string): RideModel | null {
    const content = typeById(type);
    if (!content) return null;
    let model = models.get(content.model) ?? null;
    if (!model) {
      model = buildRideModel(content.model, detail);
      if (model) models.set(content.model, model);
    }
    return model;
  }

  /** Frees the models no ride and no ghost uses any more. */
  function releaseUnused(): void {
    for (const [id, model] of models) {
      const used = entries.some((e) => e.model === model) || ghost?.model === model;
      if (!used) {
        model.dispose();
        models.delete(id);
      }
    }
  }

  /** Places `instance` on the footprint of a `type` ride at (x, y) turned `rot`; returns its pick boxes. */
  function seat(
    instance: RideInstance,
    model: RideModel,
    type: string,
    x: number,
    y: number,
    rot: Rot,
  ): number[] {
    const content = typeById(type);
    const footprint = content ? rotatedFootprint(content.footprint, rot) : { w: 1, h: 1 };
    const front: Side = content && content.kind === "stall" ? (content.front as Side) : 2;
    const side = rotateSide(front, rot);
    const cx = x + footprint.w / 2;
    const cz = y + footprint.h / 2;
    const ground = ctx.heightAt(cx, cz);
    const group = instance.group;
    group.position.set(cx, ground, cz);
    group.rotation.y = yawForSide(side);
    group.updateMatrix();
    group.matrixAutoUpdate = false;
    group.updateMatrixWorld(true);
    const across = side === 1 || side === 3;
    const boxes: number[] = [];
    for (const box of model.picks) {
      const hx = across ? box.halfZ : box.halfX;
      const hz = across ? box.halfX : box.halfZ;
      boxes.push(cx - hx, cx + hx, ground, ground + box.height, cz - hz, cz + hz);
    }
    return boxes;
  }

  function shade(instance: RideInstance, ghostly: boolean): void {
    for (const m of instance.meshes) {
      m.castShadow = !ghostly && castsShadow();
      m.receiveShadow = !ghostly && receivesShadow();
    }
  }

  function makeEntry(place: RidePlace, model: RideModel): Entry {
    const instance = model.instantiate(materials.lit);
    shade(instance, false);
    ctx.scene.add(instance.group);
    // Rides of a kind do not turn in step.
    const motion = { angle: (place.id * 2.399) % (Math.PI * 2), speed: 0 };
    const boxes = seat(instance, model, place.type, place.x, place.y, place.rot);
    instance.pose(motion.angle, 0);
    return {
      id: place.id,
      type: place.type,
      x: place.x,
      y: place.y,
      rot: place.rot,
      open: place.open,
      model,
      instance,
      motion,
      seen: false,
      boxes,
    };
  }

  function dropEntry(entry: Entry): void {
    ctx.scene.remove(entry.instance.group);
    entry.instance.dispose();
  }

  function setRides(list: readonly RidePlace[] | null): void {
    places = list ?? [];
    const old = new Map<number, Entry>();
    for (const e of entries) old.set(e.id, e);
    const next: Entry[] = [];
    for (const place of places) {
      const model = modelFor(place.type);
      if (!model) continue;
      const kept = old.get(place.id);
      if (kept && kept.type === place.type) {
        old.delete(place.id);
        kept.open = place.open;
        if (kept.x !== place.x || kept.y !== place.y || kept.rot !== place.rot) {
          kept.x = place.x;
          kept.y = place.y;
          kept.rot = place.rot;
          kept.boxes = seat(kept.instance, kept.model, kept.type, kept.x, kept.y, kept.rot);
        }
        next.push(kept);
      } else {
        next.push(makeEntry(place, model));
      }
    }
    for (const gone of old.values()) dropEntry(gone);
    next.sort((a, b) => a.id - b.id);
    entries = next;
    releaseUnused();
  }

  function dropGhost(): void {
    if (!ghost) return;
    ctx.scene.remove(ghost.instance.group);
    ghost.instance.dispose();
    ghost = null;
  }

  const ghostMaterial = (ok: boolean | null) =>
    ok === null ? materials.ghostWait : ok ? materials.ghostOk : materials.ghostBad;

  function showGhost(spec: PlacementGhost | null): void {
    ghostSpec = spec;
    if (!spec) {
      dropGhost();
      releaseUnused();
      return;
    }
    const model = modelFor(spec.type);
    if (!model) {
      dropGhost();
      releaseUnused();
      return;
    }
    if (!ghost || ghost.model !== model) {
      dropGhost();
      const instance = model.instantiate(ghostMaterial(spec.ok));
      shade(instance, true);
      for (const m of instance.meshes) m.renderOrder = 10;
      instance.pose(0, 0);
      ctx.scene.add(instance.group);
      ghost = { model, instance, ok: spec.ok };
      releaseUnused();
    }
    if (ghost.ok !== spec.ok) {
      ghost.ok = spec.ok;
      const material = ghostMaterial(spec.ok);
      for (const m of ghost.instance.meshes) m.material = material;
    }
    seat(ghost.instance, model, spec.type, spec.x, spec.y, spec.rot);
  }

  /** Builds everything again at the detail now in force. */
  function rebuild(): void {
    const list = places;
    const spec = ghostSpec;
    const motions = new Map<number, [RideMotion, boolean]>();
    for (const e of entries) motions.set(e.id, [e.motion, e.seen]);
    for (const e of entries) dropEntry(e);
    entries = [];
    dropGhost();
    for (const model of models.values()) model.dispose();
    models.clear();
    setRides(list);
    for (const e of entries) {
      const kept = motions.get(e.id);
      if (kept) [e.motion, e.seen] = kept;
    }
    showGhost(spec);
  }

  function update(frame: FrameInfo): void {
    // Rides move in sim time: the frame's seconds, scaled by the sim's speed (0 holds them).
    const dt = frame.dt * simSpeed;
    const s = status;
    let j = 0;
    for (const e of entries) {
      // Both lists are in ascending id order: walk them side by side.
      let phase = 0;
      let found = false;
      if (s) {
        while (j < s.count && (s.id[j] as number) < e.id) j++;
        if (j < s.count && s.id[j] === e.id) {
          phase = s.phase[j] as number;
          found = true;
        }
      }
      if (found && !e.seen) {
        e.seen = true;
        e.motion.speed = motionTarget(phase, e.open);
      }
      stepMotion(e.motion, phase, e.open, dt, e.model.spinRate);
      e.instance.pose(e.motion.angle, e.motion.speed);
    }
  }

  return {
    setRides,
    setRideStatus(next: RideStatusSection | null): void {
      status = next;
    },
    setPlacementGhost: showGhost,
    setSimSpeed(speed: number): void {
      simSpeed = speed > 0 ? speed : 0;
    },
    pickAt(ray: Ray, reach = Infinity): { id: number; distance: number } | null {
      let best = reach;
      let hit: number | null = null;
      for (const e of entries) {
        for (let b = 0; b < e.boxes.length; b += 6) {
          const t = rayBoxDistance(
            ray,
            e.boxes[b] as number,
            e.boxes[b + 1] as number,
            e.boxes[b + 2] as number,
            e.boxes[b + 3] as number,
            e.boxes[b + 4] as number,
            e.boxes[b + 5] as number,
          );
          if (t < best) {
            best = t;
            hit = e.id;
          }
        }
      }
      return hit === null ? null : { id: hit, distance: best };
    },
    update,
    setTerrain(): void {
      // The ground under the rides may have moved.
      for (const e of entries) {
        e.boxes = seat(e.instance, e.model, e.type, e.x, e.y, e.rot);
      }
      if (ghost && ghostSpec)
        seat(ghost.instance, ghost.model, ghostSpec.type, ghostSpec.x, ghostSpec.y, ghostSpec.rot);
    },
    setQuality(q: Quality): void {
      materials.setCloudShadow(!((ctx.software ?? false) && q === "low"));
      const next = rideDetailFor(q, ctx.software ?? false);
      if (next !== detail) {
        detail = next;
        rebuild();
        return;
      }
      for (const e of entries) shade(e.instance, false);
    },
    dispose(): void {
      for (const e of entries) dropEntry(e);
      entries = [];
      dropGhost();
      for (const model of models.values()) model.dispose();
      models.clear();
      materials.dispose();
    },
  };
}

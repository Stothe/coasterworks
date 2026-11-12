import { ALL_TYPES, rotatedFootprint, type Rot } from "@coasterworks/content";
import type { RideStatusSection } from "@coasterworks/protocol";
import {
  InstancedMesh,
  Matrix4,
  Mesh,
  Scene,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "three";
import { describe, expect, it } from "vitest";
import { CameraRig } from "../src/camera.js";
import type { FrameInfo, Quality, RenderContext } from "../src/context.js";
import { rayFromCamera } from "../src/picker.js";
import { createRideMaterials } from "../src/rides/materials.js";
import { RECIPES, buildRideModel, rideDetailFor, type RideDetail } from "../src/rides/recipes.js";
import { createRides, rayBoxDistance, stepMotion, type RidePlace } from "../src/rides/rides.js";
import { sunFor } from "../src/sky.js";

// The ride layer as the scene drives it, without a GPU: recipes are built and measured, rides are
// placed, moved, picked and taken away, and what the layer hands three.js is read back.

const MODELS = ALL_TYPES.map((t) => t.model);
const DETAILS: RideDetail[] = [0, 1, 2];
const GROUND = 2;

function harness(quality: Quality = "high", software = false) {
  const scene = new Scene();
  const ctx = {
    scene,
    quality,
    software,
    heightAt: () => GROUND,
  } as unknown as RenderContext;
  const rides = createRides(ctx);
  const frame: FrameInfo = { time: 0, dt: 0, nowMs: 0, sun: sunFor(0.4) };
  return {
    scene,
    ctx,
    rides,
    step(dt: number) {
      frame.dt = dt;
      frame.time += dt;
      rides.update?.(frame);
    },
  };
}

function ride(
  id: number,
  type: string,
  x: number,
  y: number,
  rot: Rot = 0,
  open = true,
): RidePlace {
  return { id, type, x, y, rot, open };
}

function status(entries: [number, number][]): RideStatusSection {
  const count = entries.length;
  return {
    count,
    id: Int32Array.from(entries, (e) => e[0]),
    phase: Uint8Array.from(entries, (e) => e[1]),
    phaseTicks: new Uint16Array(count),
    riders: new Uint8Array(count),
    queue: new Uint16Array(count),
  };
}

/** Every mesh in `root`. */
function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) out.push(o);
  });
  return out;
}

/** The world-space bounds of every vertex drawn under `root`, instances included. */
function worldBounds(root: Object3D): { min: Vector3; max: Vector3 } {
  root.updateMatrixWorld(true);
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const v = new Vector3();
  const instance = new Matrix4();
  const full = new Matrix4();
  for (const m of meshes(root)) {
    const position = m.geometry.getAttribute("position");
    const count = m instanceof InstancedMesh ? m.count : 1;
    for (let k = 0; k < count; k++) {
      if (m instanceof InstancedMesh) {
        m.getMatrixAt(k, instance);
        full.multiplyMatrices(m.matrixWorld, instance);
      } else {
        full.copy(m.matrixWorld);
      }
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i).applyMatrix4(full);
        min.min(v);
        max.max(v);
      }
    }
  }
  return { min, max };
}

describe("ride recipes", () => {
  it("have one recipe for every content model", () => {
    for (const id of MODELS) expect(RECIPES[id], id).toBeTypeOf("function");
  });

  it("stay under 2,000 triangles at low, on the GPU and in software", () => {
    const counts: Record<string, number[]> = {};
    for (const id of MODELS) {
      counts[id] = DETAILS.map((d) => {
        const model = buildRideModel(id, d);
        if (!model) throw new Error(id);
        model.dispose();
        return model.triangles;
      });
      const [software, low, high] = counts[id] as [number, number, number];
      expect(low, `${id} at low`).toBeLessThan(2000);
      expect(software, `${id} in software`).toBeLessThanOrEqual(low);
      expect(high, `${id} above low`).toBeLessThan(8000);
    }
    expect(rideDetailFor("low", true)).toBe(0);
    expect(rideDetailFor("low", false)).toBe(1);
    expect(rideDetailFor("medium", true)).toBe(2);
    expect(rideDetailFor("high", false)).toBe(2);
  });

  it("fill their footprint and stand on the ground, still and at full speed", () => {
    const materials = createRideMaterials();
    for (const type of ALL_TYPES) {
      const model = buildRideModel(type.model, 1);
      if (!model) throw new Error(type.id);
      const instance = model.instantiate(materials.lit);
      const { w, h } = type.footprint;
      for (const motion of [0, 1]) {
        instance.pose(1.1, motion);
        const { min, max } = worldBounds(instance.group);
        expect(min.y, type.id).toBeGreaterThan(-0.01);
        expect(min.x, type.id).toBeGreaterThan(-w / 2 - 0.02);
        expect(max.x, type.id).toBeLessThan(w / 2 + 0.02);
        expect(min.z, type.id).toBeGreaterThan(-h / 2 - 0.02);
        expect(max.z, type.id).toBeLessThan(h / 2 + 0.02);
        // It fills the footprint: within a fifth of a tile of each edge.
        expect(max.x - min.x, type.id).toBeGreaterThan(w - (type.id === "big_wheel" ? 0.5 : 0.4));
        expect(max.z - min.z, type.id).toBeGreaterThan(h - 0.4);
        expect(max.y, type.id).toBeLessThanOrEqual(model.box.height + 0.01);
        // The pick box holds the model.
        expect(max.x).toBeLessThanOrEqual(model.box.halfX + 0.02);
        expect(max.z).toBeLessThanOrEqual(model.box.halfZ + 0.02);
      }
      instance.dispose();
      model.dispose();
    }
    materials.dispose();
  });

  it("write a handful of matrices a frame, and none when nothing moved", () => {
    const materials = createRideMaterials();
    for (const id of MODELS) {
      const model = buildRideModel(id, 1);
      if (!model) throw new Error(id);
      const instance = model.instantiate(materials.lit);
      instance.pose(0.5, 0.7);
      expect(instance.lastWrites, id).toBeLessThanOrEqual(13);
      instance.pose(0.5, 0.7);
      expect(instance.lastWrites, id).toBe(0);
      instance.dispose();
      model.dispose();
    }
    materials.dispose();
  });
});

describe("stepMotion", () => {
  it("spins up when running and open, and runs down otherwise", () => {
    const m = { angle: 0, speed: 0 };
    for (let i = 0; i < 100; i++) stepMotion(m, 2, true, 0.05, 1);
    expect(m.speed).toBeGreaterThan(0.95);
    const turned = m.angle;
    for (let i = 0; i < 200; i++) stepMotion(m, 3, true, 0.05, 1);
    expect(m.speed).toBe(0);
    const stopped = m.angle;
    stepMotion(m, 1, true, 0.05, 1);
    expect(m.angle).toBe(stopped);
    expect(turned).not.toBe(0);
    // Closed rides keep still.
    const closed = { angle: 1, speed: 0 };
    stepMotion(closed, 2, false, 0.05, 1);
    expect(closed).toEqual({ angle: 1, speed: 0 });
  });
});

describe("createRides", () => {
  it("places each ride on its rotated footprint, on the ground", () => {
    for (const type of ALL_TYPES) {
      for (const rot of [0, 1, 2, 3] as Rot[]) {
        const h = harness();
        h.rides.setRides([ride(1, type.id, 10, 20, rot)]);
        expect(h.scene.children).toHaveLength(1);
        const { min, max } = worldBounds(h.scene.children[0] as Object3D);
        const { w, h: d } = rotatedFootprint(type.footprint, rot);
        const where = `${type.id} rot ${rot}`;
        expect(min.x, where).toBeGreaterThan(10 - 0.02);
        expect(max.x, where).toBeLessThan(10 + w + 0.02);
        expect(min.z, where).toBeGreaterThan(20 - 0.02);
        expect(max.z, where).toBeLessThan(20 + d + 0.02);
        expect(min.y, where).toBeGreaterThan(GROUND - 0.01);
        h.rides.dispose();
      }
    }
  });

  it("turns a stall's counter to its front side after rotation", () => {
    const h = harness();
    // A snack stand serves to the south at rot 0; turned once clockwise it serves to the west.
    h.rides.setRides([ride(1, "snack_stand", 5, 5, 0), ride(2, "snack_stand", 8, 5, 1)]);
    const [a, b] = h.scene.children as [Object3D, Object3D];
    const front = new Vector3(0, 0, 1);
    expect(front.clone().applyQuaternion(a.quaternion).z).toBeCloseTo(1, 6);
    expect(front.clone().applyQuaternion(b.quaternion).x).toBeCloseTo(-1, 6);
  });

  it("shares geometry and materials between rides of a type, and frees them when unused", () => {
    const h = harness();
    h.rides.setRides([
      ride(1, "carousel", 2, 2),
      ride(2, "carousel", 8, 2),
      ride(3, "restrooms", 14, 2),
    ]);
    const [first, second, third] = h.scene.children as [Object3D, Object3D, Object3D];
    const geometriesOf = (o: Object3D) => meshes(o).map((m) => m.geometry);
    expect(geometriesOf(first)).toEqual(geometriesOf(second));
    const material = (meshes(first)[0] as Mesh).material;
    expect((meshes(third)[0] as Mesh).material).toBe(material);

    // Count every dispose: shared geometries, instance buffers and materials.
    const geometries = new Set<BufferGeometry>();
    for (const o of h.scene.children) for (const g of geometriesOf(o)) geometries.add(g);
    const disposed = new Map<BufferGeometry, number>();
    for (const g of geometries) {
      g.addEventListener("dispose", () => disposed.set(g, (disposed.get(g) ?? 0) + 1));
    }
    const carouselGeometries = new Set(geometriesOf(first));
    // One carousel goes: nothing is freed, the other still uses the carousel's geometry.
    h.rides.setRides([ride(1, "carousel", 2, 2), ride(3, "restrooms", 14, 2)]);
    expect(h.scene.children).toHaveLength(2);
    expect(disposed.size).toBe(0);
    // The last carousel goes: its geometry is freed once, the restrooms' is kept.
    h.rides.setRides([ride(3, "restrooms", 14, 2)]);
    for (const g of carouselGeometries) expect(disposed.get(g)).toBe(1);
    expect([...disposed.keys()].every((g) => carouselGeometries.has(g))).toBe(true);
    // Everything goes; then the module.
    let materialDisposed = 0;
    (material as Material).addEventListener("dispose", () => materialDisposed++);
    h.rides.setRides(null);
    expect(h.scene.children).toHaveLength(0);
    for (const g of geometries) expect(disposed.get(g)).toBe(1);
    h.rides.dispose();
    expect(materialDisposed).toBe(1);
  });

  it("frees a wheel's instanced gondolas with the ride", () => {
    const h = harness();
    h.rides.setRides([ride(1, "big_wheel", 2, 2)]);
    const cars = meshes(h.scene.children[0] as Object3D).find((m) => m instanceof InstancedMesh);
    expect(cars).toBeDefined();
    let freed = 0;
    cars?.addEventListener("dispose", () => freed++);
    h.rides.setRides([]);
    expect(freed).toBe(1);
  });

  it("keeps a ride drawn across updates, and moves or rebuilds it as it changes", () => {
    const h = harness();
    h.rides.setRides([ride(1, "carousel", 2, 2)]);
    const group = h.scene.children[0];
    h.rides.setRides([ride(1, "carousel", 2, 2, 0, false)]);
    expect(h.scene.children[0]).toBe(group);
    h.rides.setRides([ride(1, "carousel", 6, 2)]);
    expect(h.scene.children[0]).toBe(group);
    expect(group?.position.x).toBeCloseTo(7.5, 6);
    h.rides.setRides([ride(1, "swing_tower", 6, 2)]);
    expect(h.scene.children[0]).not.toBe(group);
    // A type with no recipe is left out, not an error.
    h.rides.setRides([ride(2, "no_such_ride", 1, 1)]);
    expect(h.scene.children).toHaveLength(0);
  });

  it("animates from the status by id and tolerates a status and a list that disagree", () => {
    const h = harness();
    h.rides.setRides([
      ride(1, "carousel", 2, 2),
      ride(2, "big_wheel", 8, 2),
      ride(4, "swing_tower", 14, 2, 0, false),
    ]);
    const turning = (i: number) => {
      const group = h.scene.children[i] as Object3D;
      return group.children.map((c) => c.matrix.elements.slice());
    };
    // Ride 1 running, ride 2 has no status, ride 3 is not drawn, ride 4 is closed.
    h.rides.setRideStatus(
      status([
        [1, 2],
        [3, 2],
        [4, 2],
      ]),
    );
    const before = [turning(0), turning(1), turning(2)];
    for (let i = 0; i < 10; i++) h.step(0.05);
    expect(turning(0)).not.toEqual(before[0]);
    expect(turning(1)).toEqual(before[1]);
    expect(turning(2)).toEqual(before[2]);
    // No status at all is fine too.
    h.rides.setRideStatus(null);
    expect(() => h.step(0.05)).not.toThrow();
  });

  describe("on sim time", () => {
    /** How far the wheel (children: frame, spin node, gondolas) has turned from `from`. */
    const spinOf = (h: ReturnType<typeof harness>) => {
      const e = (h.scene.children[0] as Object3D).children[1]?.matrix.elements as number[];
      return Math.atan2(e[6] as number, e[5] as number);
    };
    const turned = (a: number, b: number) => ((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    /** A wheel that was seen stopped, then told to run, with the sim at `speed`. */
    const starting = (speed: number) => {
      const h = harness();
      h.rides.setRides([ride(1, "big_wheel", 8, 2)]);
      h.rides.setSimSpeed(speed);
      h.rides.setRideStatus(status([[1, 1]]));
      h.step(0.05);
      h.rides.setRideStatus(status([[1, 2]]));
      return h;
    };

    it("holds a running ride's pose while the sim is paused", () => {
      const h = harness();
      h.rides.setRides([ride(1, "big_wheel", 8, 2)]);
      h.rides.setRideStatus(status([[1, 2]]));
      h.step(0.05);
      const before = (h.scene.children[0] as Object3D).children.map((c) =>
        c.matrix.elements.slice(),
      );
      h.rides.setSimSpeed(0);
      for (let i = 0; i < 200; i++) h.step(0.05);
      const after = (h.scene.children[0] as Object3D).children.map((c) =>
        c.matrix.elements.slice(),
      );
      expect(after).toEqual(before);
      // And it picks up again where it was.
      h.rides.setSimSpeed(1);
      for (let i = 0; i < 20; i++) h.step(0.05);
      expect((h.scene.children[0] as Object3D).children[1]?.matrix.elements).not.toEqual(before[1]);
    });

    it("eases and turns eight times sooner at 8x, as in the sim's own time", () => {
      // The same eight sim seconds: 80 frames of 0.1 s at 1x, 80 frames of 0.0125 s at 8x.
      const slow = starting(1);
      const fast = starting(8);
      const slowStart = spinOf(slow);
      const fastStart = spinOf(fast);
      for (let i = 0; i < 80; i++) {
        slow.step(0.1);
        fast.step(0.0125);
      }
      const slowTurn = turned(spinOf(slow), slowStart);
      const fastTurn = turned(spinOf(fast), fastStart);
      expect(slowTurn).toBeGreaterThan(1);
      expect(fastTurn).toBeCloseTo(slowTurn, 6);
      // Not yet at speed after a wall second at 1x, but there after one at 8x.
      const a = starting(1);
      const b = starting(8);
      for (let i = 0; i < 20; i++) {
        a.step(0.05);
        b.step(0.05);
      }
      const perFrame = (h: ReturnType<typeof harness>, dt: number) => {
        const was = spinOf(h);
        h.step(dt);
        return turned(spinOf(h), was) / dt;
      };
      // The wheel turns 0.32 radians per sim second at full speed.
      expect(perFrame(a, 0.05)).toBeLessThan(0.32 * 0.8);
      expect(perFrame(b, 0.05) / 8).toBeGreaterThan(0.32 * 0.95);
    });
  });

  it("draws the placement ghost see-through, tinted by whether it may go there", () => {
    const h = harness();
    h.rides.setPlacementGhost({ type: "drinks_stand", x: 4, y: 4, rot: 0, ok: true });
    expect(h.scene.children).toHaveLength(1);
    const ghost = h.scene.children[0] as Object3D;
    const mat = (meshes(ghost)[0] as Mesh).material as Material & { transparent: boolean };
    expect(mat.transparent).toBe(true);
    expect(meshes(ghost).every((m) => !m.castShadow)).toBe(true);
    h.rides.setPlacementGhost({ type: "drinks_stand", x: 5, y: 4, rot: 1, ok: false });
    expect(h.scene.children[0]).toBe(ghost);
    expect((meshes(ghost)[0] as Mesh).material).not.toBe(mat);
    expect(ghost.position.x).toBeCloseTo(5.5, 6);
    // The ghost is not picked.
    expect(
      h.rides.pickAt({ origin: { x: 5.5, y: 10, z: 4.5 }, direction: { x: 0, y: -1, z: 0 } }),
    ).toBeNull();
    let freed = 0;
    for (const m of meshes(ghost)) m.geometry.addEventListener("dispose", () => freed++);
    h.rides.setPlacementGhost(null);
    expect(h.scene.children).toHaveLength(0);
    expect(freed).toBeGreaterThan(0);
  });

  it("casts no shadows at low and builds the cheapest models in software", () => {
    const h = harness("low", true);
    h.rides.setRides([ride(1, "carousel", 2, 2)]);
    expect(meshes(h.scene).every((m) => !m.castShadow)).toBe(true);
    const cheap = meshes(h.scene).reduce((n, m) => n + (m.geometry.index?.count ?? 0) / 3, 0);
    h.rides.setQuality?.("high");
    h.ctx.quality = "high";
    h.rides.setQuality?.("high");
    expect(meshes(h.scene).some((m) => m.castShadow)).toBe(true);
    const fine = meshes(h.scene).reduce((n, m) => n + (m.geometry.index?.count ?? 0) / 3, 0);
    expect(fine).toBeGreaterThan(cheap);
  });
});

describe("picking rides", () => {
  const types: [string, number, number][] = [
    ["carousel", 10, 10],
    ["big_wheel", 20, 10],
    ["snack_stand", 30, 10],
  ];

  it("hits the ride under the view's middle from three angles, and not a tile next to it", () => {
    const h = harness();
    h.rides.setRides(types.map(([type, x, y], i) => ride(i + 1, type, x, y)));
    const rig = new CameraRig();
    for (const [i, [type, x, y]] of types.entries()) {
      const content = ALL_TYPES.find((t) => t.id === type);
      if (!content) throw new Error(type);
      const { w, h: d } = content.footprint;
      for (const [yaw, pitch] of [
        [0.785, 0.7],
        [2.4, 0.45],
        [4.0, 1.2],
      ] as const) {
        rig.yaw = yaw;
        rig.pitch = pitch;
        rig.distance = 25;
        rig.target = { x: x + w / 2, y: GROUND, z: y + d / 2 };
        const at = rayFromCamera(rig, 0, 0, 1.5, rig.fovY);
        expect(h.rides.pickAt(at, rig.distance + 0.15)?.id, `${type} ${yaw}`).toBe(i + 1);

        // A tile beside the footprint on the camera's side: the ground there is nearer than the ride.
        const eye = rig.position();
        const dx = eye.x - rig.target.x;
        const dz = eye.z - rig.target.z;
        const beside =
          Math.abs(dx) > Math.abs(dz)
            ? { x: dx > 0 ? x + w + 0.5 : x - 0.5, z: y + d / 2 }
            : { x: x + w / 2, z: dz > 0 ? y + d + 0.5 : y - 0.5 };
        rig.target = { x: beside.x, y: GROUND, z: beside.z };
        const next = rayFromCamera(rig, 0, 0, 1.5, rig.fovY);
        const ground = Math.hypot(
          rig.position().x - beside.x,
          rig.position().y - GROUND,
          rig.position().z - beside.z,
        );
        expect(h.rides.pickAt(next, ground + 0.15), `beside ${type} ${yaw}`).toBeNull();
      }
    }
  });

  it("gives the nearest of two rides along the ray", () => {
    const h = harness();
    h.rides.setRides([ride(1, "carousel", 0, 0), ride(2, "carousel", 5, 0)]);
    const ray = { origin: { x: -5, y: GROUND + 0.5, z: 1.5 }, direction: { x: 1, y: 0, z: 0 } };
    expect(h.rides.pickAt(ray)?.id).toBe(1);
    const back = { origin: { x: 15, y: GROUND + 0.5, z: 1.5 }, direction: { x: -1, y: 0, z: 0 } };
    expect(h.rides.pickAt(back)?.id).toBe(2);
    expect(h.rides.pickAt(back, 2)).toBeNull();
  });

  it("lets a ray through the big wheel's empty corners go by, but hits its disc, frame and base", () => {
    const h = harness();
    h.rides.setRides([ride(1, "big_wheel", 0, 0)]);
    // The wheel stands on x 0..2, z 0..4 (its disc is in the plane x = 1, the centre); the axle is 2.1 high.
    const along = (y: number, z: number, x: number, dir: "x" | "z") => ({
      origin: dir === "x" ? { x: -5, y: GROUND + y, z } : { x, y: GROUND + y, z: -5 },
      direction: dir === "x" ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 },
    });
    // The top corner of the old footprint-wide box: clear.
    expect(h.rides.pickAt(along(3.4, 0, 1.6, "z"))).toBeNull();
    expect(h.rides.pickAt(along(3.4, 3.85, 0, "x"))).toBeNull();
    // Through the disc, the frame and the base.
    expect(h.rides.pickAt(along(3.4, 2, 1, "x"))?.id).toBe(1);
    expect(h.rides.pickAt(along(2.1, 2, 1, "x"))?.id).toBe(1);
    expect(h.rides.pickAt(along(0.2, 0.7, 0.2, "z"))?.id).toBe(1);
    // From above, the base's top is what is hit, not the disc's height.
    const down = { origin: { x: 0.2, y: GROUND + 9, z: 0.3 }, direction: { x: 0, y: -1, z: 0 } };
    expect(h.rides.pickAt(down)?.distance).toBeCloseTo(8.5, 5);
  });

  it("measures distances along the ray made unit length", () => {
    const ray = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 2, y: 0, z: 0 } };
    expect(rayBoxDistance(ray, 3, 4, -1, 1, -1, 1)).toBeCloseTo(3, 9);
    expect(rayBoxDistance(ray, -4, -3, -1, 1, -1, 1)).toBe(Infinity);
    expect(rayBoxDistance(ray, -1, 1, -1, 1, -1, 1)).toBe(0);
  });
});

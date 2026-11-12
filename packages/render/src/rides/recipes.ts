import {
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Vector3 as V,
  type BufferGeometry,
  type Color,
  type Material,
} from "three";
import type { Quality } from "../context.js";
import { PartBuilder, paint, triangleCount } from "./build.js";

/**
 * The ride and stall models: one original procedural recipe per content `model` id, built from
 * three.js primitives in the modern look's colors. Each recipe makes the model at rotation 0,
 * centered on the middle of its footprint (x across the footprint's width, z across its height,
 * +z the south side, which is a stall's front), with the ground at y = 0, sized to fill the
 * footprint. Its geometry is made once per type and level of detail and shared by every ride of
 * that type; `instantiate` makes the scene objects of one ride around it.
 *
 * Moving parts hang under a few nodes whose matrices are written only when they move: the
 * carousel's turning top and its two sets of rising mounts, the big wheel's wheel and its
 * gondolas (one instanced mesh), the swing tower's crown (lift, tilt, turn) and its seats (one
 * instanced mesh).
 */

/** How finely a model is built: 0 on a software renderer at `low`, 1 at `low`, 2 above. */
export type RideDetail = 0 | 1 | 2;

/** The detail a model is built at for `quality`, and whether the renderer is a software one. */
export function rideDetailFor(quality: Quality, software: boolean): RideDetail {
  if (quality !== "low") return 2;
  return software ? 0 : 1;
}

/** The box a model is picked by, at rotation 0: x within ±halfX, z within ±halfZ, y 0..height. */
export interface RideBox {
  halfX: number;
  halfZ: number;
  height: number;
}

/** One ride's scene objects around a shared model. */
export interface RideInstance {
  /** Placed by the caller: its position and rotation are the ride's. */
  readonly group: Group;
  /** Every mesh, for the caller's shadow settings. */
  readonly meshes: readonly Mesh[];
  /**
   * Poses the moving parts: `angle` is how far the ride has turned (radians, of its own main
   * motion), `motion` how hard it is going, 0 still to 1 at full speed. Matrices are written only
   * for what changed.
   */
  pose(angle: number, motion: number): void;
  /** Matrices written by the last `pose` (node matrices and instance matrices both count). */
  readonly lastWrites: number;
  /** Frees what this instance owns (its instance buffers), not the shared geometry. */
  dispose(): void;
}

/** A model: shared geometry for one type at one level of detail. */
export interface RideModel {
  readonly id: string;
  readonly detail: RideDetail;
  readonly box: RideBox;
  /** Radians a second at full speed. 0 for a stall, which does not move. */
  readonly spinRate: number;
  /** Triangles one instance draws, instanced parts counted for every instance. */
  readonly triangles: number;
  /** The geometries this model owns. */
  readonly geometries: readonly BufferGeometry[];
  instantiate(material: Material): RideInstance;
  /** Frees the shared geometry. Instances must be disposed of first. */
  dispose(): void;
}

// The palette: the modern look's saturated but natural colors, painted no brighter than white
// paint, in the family of the gate's plaster, terracotta and gold.
const CREAM = paint(0xeee3cb);
const WHITE = paint(0xe9e4da);
const STONE = paint(0xbfae90);
const PAVING = paint(0xcfc3aa);
const RED = paint(0xc9503f);
const GOLD = paint(0xdba63a);
const WOOD = paint(0x9a6a42);
const TEAL = paint(0x2f8f9d);
const SKY = paint(0x8cc3df);
const BLUE = paint(0x2c5f9a);
const STEEL = paint(0x8b9098);
const DARK = paint(0x3a3431);
const SAGE = paint(0xb3c79f);
const SLATE = paint(0x5f6e80);
const CORAL = paint(0xe0775f);
/** The mounts' coats and the gondolas' and seats' paint, in turn. */
const BRIGHTS: readonly Color[] = [
  paint(0xe9e4da),
  paint(0xe59a8e),
  paint(0x8cc3df),
  paint(0xe6bd3a),
  paint(0x9fd3b4),
  paint(0xb9a5d8),
];

interface Spec {
  radial: number;
  gores: number;
  goreSegments: number;
  scallops: number;
  mounts: number;
  rimArcs: number;
  arcSegments: number;
  tube: number;
  spokes: number;
  gondolas: number;
  seats: number;
  thin: number;
}

const SPECS: Record<RideDetail, Spec> = {
  0: {
    radial: 6,
    gores: 6,
    goreSegments: 1,
    scallops: 10,
    mounts: 6,
    rimArcs: 6,
    arcSegments: 3,
    tube: 3,
    spokes: 6,
    gondolas: 6,
    seats: 8,
    thin: 3,
  },
  1: {
    radial: 10,
    gores: 8,
    goreSegments: 2,
    scallops: 16,
    mounts: 8,
    rimArcs: 8,
    arcSegments: 4,
    tube: 4,
    spokes: 8,
    gondolas: 8,
    seats: 10,
    thin: 4,
  },
  2: {
    radial: 24,
    gores: 12,
    goreSegments: 4,
    scallops: 24,
    mounts: 12,
    rimArcs: 12,
    arcSegments: 8,
    tube: 6,
    spokes: 12,
    gondolas: 8,
    seats: 12,
    thin: 6,
  },
};

const TAU = Math.PI * 2;
const m4 = () => new Matrix4();

/** An object whose matrix is written by hand, so that three.js does not recompose it each frame. */
function node(): Object3D {
  const o = new Object3D();
  o.matrixAutoUpdate = false;
  return o;
}

function mesh(geometry: BufferGeometry, material: Material): Mesh {
  const m = new Mesh(geometry, material);
  m.matrixAutoUpdate = false;
  return m;
}

function instanced(geometry: BufferGeometry, material: Material, count: number): InstancedMesh {
  const m = new InstancedMesh(geometry, material, count);
  m.matrixAutoUpdate = false;
  // The instances swing out past the box they were first measured in.
  m.frustumCulled = false;
  for (let i = 0; i < count; i++) m.setColorAt(i, BRIGHTS[(i + 1) % BRIGHTS.length] as Color);
  return m;
}

function modelOf(
  id: string,
  detail: RideDetail,
  box: RideBox,
  spinRate: number,
  geometries: BufferGeometry[],
  triangles: number,
  instantiate: (material: Material) => RideInstance,
): RideModel {
  return {
    id,
    detail,
    box,
    spinRate,
    triangles,
    geometries,
    instantiate,
    dispose() {
      for (const g of geometries) g.dispose();
    },
  };
}

/** A canopy of `gores` alternately colored gores over `profile`, with its underside. */
function canopy(
  b: PartBuilder,
  profile: readonly (readonly [number, number])[],
  s: Spec,
  a: Color,
  c: Color,
  under: Color,
): void {
  // A lathe faces outward when its profile runs upward, so the top is the profile from the rim
  // up to the middle, and the underside (seen from low down) the same from the middle out.
  const step = TAU / s.gores;
  const top = [...profile].reverse();
  for (let i = 0; i < s.gores; i++) {
    b.lathe(top, s.goreSegments, i % 2 === 0 ? a : c, i * step, step);
  }
  const below = profile.map(([r, y]) => [r, y - 0.012] as const);
  b.lathe(below, s.gores * s.goreSegments, under);
}

// ---------------------------------------------------------------------------------------------
// Carousel: a round platform, a lathed canopy with a scalloped rim, a center pole and a ring of
// stylized mounts on poles that rise and fall in two sets as it turns.
// ---------------------------------------------------------------------------------------------

const CAROUSEL_RADIUS = 1.38;

function mountPiece(b: PartBuilder, angle: number, radius: number, color: Color, s: Spec): void {
  // Standing tangent to the ring, facing the way the platform turns.
  const place = m4()
    .makeTranslation(Math.cos(angle) * radius, 0.55, Math.sin(angle) * radius)
    .multiply(m4().makeRotationY(-angle));
  const at = (x: number, y: number, z: number, tilt = 0) =>
    place.clone().multiply(m4().makeTranslation(x, y, z).multiply(m4().makeRotationX(tilt)));
  b.boxAt(0.1, 0.12, 0.3, color, at(0, 0, 0));
  b.boxAt(0.075, 0.16, 0.08, color, at(0, 0.1, 0.13, -0.45));
  b.boxAt(0.08, 0.075, 0.13, color, at(0, 0.18, 0.2, 0.25));
  b.boxAt(0.115, 0.03, 0.11, GOLD, at(0, 0.075, -0.02));
  if (s.mounts > 6) {
    b.boxAt(0.08, 0.13, 0.04, color, at(0, -0.1, 0.1, 0.35));
    b.boxAt(0.08, 0.13, 0.04, color, at(0, -0.1, -0.1, -0.35));
  }
}

function carousel(detail: RideDetail): RideModel {
  const s = SPECS[detail];
  const R = CAROUSEL_RADIUS;

  const base = new PartBuilder();
  base.column(0, 0, 0, 0.1, R + 0.04, R + 0.04, s.radial, PAVING);
  base.column(0, 0, 0.1, 0.13, R - 0.02, R - 0.02, s.radial, RED);

  const top = new PartBuilder();
  top.column(0, 0, 0.13, 0.17, R - 0.06, R - 0.06, s.radial, WOOD);
  // The drum in the middle, cream with a gold band, and the pole through it.
  top.column(0, 0, 0.17, 1.12, 0.3, 0.26, s.radial, CREAM);
  top.column(0, 0, 0.78, 0.86, 0.285, 0.285, s.radial, GOLD, true);
  top.column(0, 0, 1.12, 1.62, 0.07, 0.07, s.thin + 2, GOLD);
  for (let i = 0; i < s.mounts; i++) {
    const a = ((i + 0.5) / s.mounts) * TAU;
    const r = 0.98;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    top.column(x, z, 0.17, 1.24, 0.017, 0.017, s.thin, GOLD, true);
  }
  // The canopy, its gold rim band and the scallops hanging from it.
  canopy(
    top,
    [
      [0.0, 1.66],
      [0.32, 1.58],
      [0.95, 1.36],
      [R + 0.04, 1.22],
    ],
    s,
    RED,
    CREAM,
    CREAM,
  );
  top.column(0, 0, 1.12, 1.23, R + 0.04, R + 0.04, s.radial, GOLD, true);
  for (let i = 0; i < s.scallops; i++) {
    const a = ((i + 0.5) / s.scallops) * TAU;
    const geometry = new CylinderGeometry(0.1, 0.0, 0.11, 4, 1, false, Math.PI / 4);
    const m = m4()
      .makeTranslation(Math.cos(a) * (R + 0.02), 1.07, Math.sin(a) * (R + 0.02))
      .multiply(m4().makeRotationY(-a))
      .multiply(m4().makeScale(1, 1, 0.35));
    top.add(geometry, i % 2 === 0 ? GOLD : RED, m);
  }
  top.ball(0, 1.72, 0, 0.07, s.thin + 2, s.thin, GOLD);

  const mountsA = new PartBuilder();
  const mountsB = new PartBuilder();
  for (let i = 0; i < s.mounts; i++) {
    const a = ((i + 0.5) / s.mounts) * TAU;
    mountPiece(i % 2 === 0 ? mountsA : mountsB, a, 0.98, BRIGHTS[i % BRIGHTS.length] as Color, s);
  }

  const geometries = [base.build(), top.build(), mountsA.build(), mountsB.build()];
  const [baseG, topG, aG, bG] = geometries as [
    BufferGeometry,
    BufferGeometry,
    BufferGeometry,
    BufferGeometry,
  ];
  const triangles = geometries.reduce((sum, g) => sum + triangleCount(g), 0);

  return modelOf(
    "carousel",
    detail,
    { halfX: R + 0.09, halfZ: R + 0.09, height: 1.8 },
    0.9,
    geometries,
    triangles,
    (material) => {
      const group = new Group();
      const turn = node();
      const meshes = [
        mesh(baseG, material),
        mesh(topG, material),
        mesh(aG, material),
        mesh(bG, material),
      ];
      const [baseM, topM, aM, bM] = meshes as [Mesh, Mesh, Mesh, Mesh];
      group.add(baseM, turn);
      turn.add(topM, aM, bM);
      let lastAngle = NaN;
      let lastBob = NaN;
      const instance = {
        group,
        meshes,
        lastWrites: 0,
        pose(angle: number, motion: number) {
          let writes = 0;
          if (angle !== lastAngle) {
            turn.rotation.y = -angle;
            turn.updateMatrix();
            lastAngle = angle;
            writes++;
          }
          // The mounts rise and fall twice a turn, the two sets opposite, as hard as it goes.
          const bob = Math.sin(angle * 2) * 0.07 * motion;
          if (bob !== lastBob) {
            aM.position.y = bob;
            bM.position.y = -bob;
            aM.updateMatrix();
            bM.updateMatrix();
            lastBob = bob;
            writes += 2;
          }
          instance.lastWrites = writes;
        },
        dispose() {},
      };
      instance.pose(0, 0);
      return instance;
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Big wheel: two thin rims of torus segments joined by cross bars, spokes to a hub, an A-frame
// support on each side, and gondolas that hang level as the wheel turns.
// ---------------------------------------------------------------------------------------------

const WHEEL_AXLE = 2.1;
const WHEEL_RADIUS = 1.58;
const WHEEL_RIM_X = 0.24;

function bigWheel(detail: RideDetail): RideModel {
  const s = SPECS[detail];
  const H = WHEEL_AXLE;
  const R = WHEEL_RADIUS;
  const legRadial = Math.max(4, s.thin + 1);

  const frame = new PartBuilder();
  frame.box(0, 0.03, 0, 1.8, 0.06, 3.76, STONE);
  frame.box(0, 0.075, 0, 0.7, 0.05, 1.1, WOOD);
  for (const side of [-1, 1]) {
    const top = new V(side * 0.34, H, 0);
    const front = new V(side * 0.56, 0.08, 1.3);
    const back = new V(side * 0.56, 0.08, -1.3);
    frame.rod(front, top, 0.05, legRadial, WHITE);
    frame.rod(back, top, 0.05, legRadial, WHITE);
    const t = 0.42;
    frame.rod(lerp(front, top, t), lerp(back, top, t), 0.03, s.thin, WHITE);
    frame.column(front.x, front.z, 0.08, 0.16, 0.09, 0.09, s.thin + 2, STONE);
    frame.column(back.x, back.z, 0.08, 0.16, 0.09, 0.09, s.thin + 2, STONE);
  }
  frame.rod(new V(-0.4, H, 0), new V(0.4, H, 0), 0.07, s.thin + 2, STEEL, true);

  const wheel = new PartBuilder();
  const arc = TAU / s.rimArcs;
  const plane = m4().makeRotationY(Math.PI / 2);
  for (const side of [-1, 1]) {
    for (let i = 0; i < s.rimArcs; i++) {
      const m = m4()
        .makeTranslation(side * WHEEL_RIM_X, 0, 0)
        .multiply(plane)
        .multiply(m4().makeRotationZ(i * arc));
      wheel.torus(R, 0.035, s.tube, s.arcSegments, arc, i % 2 === 0 ? WHITE : GOLD, m);
    }
    for (let j = 0; j < s.spokes; j++) {
      const a = (j / s.spokes) * TAU;
      wheel.rod(
        new V(side * 0.1, 0, 0),
        new V(side * WHEEL_RIM_X, Math.sin(a) * R, Math.cos(a) * R),
        0.014,
        3,
        WHITE,
      );
    }
    if (detail === 2) {
      const m = m4()
        .makeTranslation(side * 0.17, 0, 0)
        .multiply(plane);
      wheel.torus(R * 0.42, 0.025, s.tube, 24, TAU, RED, m);
    }
  }
  wheel.rod(new V(-0.18, 0, 0), new V(0.18, 0, 0), 0.16, s.radial, RED, true);
  for (let k = 0; k < s.gondolas; k++) {
    const a = (k / s.gondolas) * TAU;
    const y = Math.sin(a) * R;
    const z = Math.cos(a) * R;
    wheel.rod(new V(-WHEEL_RIM_X, y, z), new V(WHEEL_RIM_X, y, z), 0.02, s.thin, STEEL);
  }

  // A gondola hangs from its pivot (the origin) on a short rod. Its paint comes from the
  // instance's color, over white.
  const gondola = new PartBuilder();
  gondola.rod(new V(0, 0.02, 0), new V(0, -0.12, 0), 0.014, 3, STEEL);
  gondola.box(0, -0.115, 0, 0.34, 0.035, 0.3, CREAM);
  gondola.box(0, -0.215, 0, 0.3, 0.17, 0.25, WHITE);
  gondola.box(0, -0.185, 0, 0.31, 0.06, 0.26, DARK);

  const geometries = [frame.build(), wheel.build(), gondola.build()];
  const [frameG, wheelG, gondolaG] = geometries as [BufferGeometry, BufferGeometry, BufferGeometry];
  const triangles =
    triangleCount(frameG) + triangleCount(wheelG) + triangleCount(gondolaG) * s.gondolas;

  return modelOf(
    "big_wheel",
    detail,
    { halfX: 0.92, halfZ: 1.9, height: H + R + 0.1 },
    0.32,
    geometries,
    triangles,
    (material) => {
      const group = new Group();
      const spin = node();
      spin.position.set(0, H, 0);
      spin.updateMatrix();
      const frameM = mesh(frameG, material);
      const wheelM = mesh(wheelG, material);
      const cars = instanced(gondolaG, material, s.gondolas);
      group.add(frameM, spin, cars);
      spin.add(wheelM);
      const m = new Matrix4();
      let lastAngle = NaN;
      const instance = {
        group,
        meshes: [frameM, wheelM, cars] as Mesh[],
        lastWrites: 0,
        pose(angle: number) {
          if (angle === lastAngle) {
            instance.lastWrites = 0;
            return;
          }
          lastAngle = angle;
          spin.rotation.x = angle;
          spin.updateMatrix();
          // Each gondola's pivot goes round with the wheel; the gondola itself stays level.
          for (let k = 0; k < s.gondolas; k++) {
            const a = (k / s.gondolas) * TAU - angle;
            m.makeTranslation(0, H + Math.sin(a) * R, Math.cos(a) * R);
            cars.setMatrixAt(k, m);
          }
          cars.instanceMatrix.needsUpdate = true;
          instance.lastWrites = 1 + s.gondolas;
        },
        dispose() {
          cars.dispose();
        },
      };
      instance.pose(0);
      return instance;
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Swing tower: a banded column and a crown that climbs it, tilts and spins, with seats on thin
// chains that swing out as it goes faster.
// ---------------------------------------------------------------------------------------------

const SWING_RIM = 0.78;
const SWING_CHAIN = 0.95;
const CROWN_DOWN = 1.32;
const CROWN_UP = 2.55;

function swingTower(detail: RideDetail): RideModel {
  const s = SPECS[detail];

  const column = new PartBuilder();
  column.column(0, 0, 0, 0.06, 1.4, 1.44, s.radial, STONE);
  column.column(0, 0, 0.06, 0.09, 1.3, 1.3, s.radial, WOOD);
  column.column(0, 0, 0.09, 0.14, 0.42, 0.46, s.radial, RED);
  const bands = 5;
  for (let i = 0; i < bands; i++) {
    const y0 = 0.14 + (i * (3.1 - 0.14)) / bands;
    const y1 = 0.14 + ((i + 1) * (3.1 - 0.14)) / bands;
    column.column(0, 0, y0, y1, 0.15, 0.15, s.radial, i % 2 === 0 ? WHITE : TEAL, true);
  }
  column.column(0, 0, 3.1, 3.18, 0.22, 0.22, s.radial, GOLD);
  column.column(0, 0, 3.18, 3.45, 0.18, 0.0, s.radial, TEAL);
  column.ball(0, 3.47, 0, 0.05, s.thin + 2, s.thin, GOLD);

  const crown = new PartBuilder();
  crown.column(0, 0, -0.12, 0.16, 0.26, 0.26, s.radial, GOLD);
  canopy(
    crown,
    [
      [0.26, 0.24],
      [0.6, 0.16],
      [SWING_RIM + 0.12, 0.02],
    ],
    s,
    TEAL,
    CREAM,
    CREAM,
  );
  crown.column(0, 0, -0.06, 0.04, SWING_RIM + 0.12, SWING_RIM + 0.12, s.radial, GOLD, true);
  for (let i = 0; i < s.seats; i++) {
    const a = (i / s.seats) * TAU;
    crown.rod(
      new V(0, -0.02, 0),
      new V(Math.cos(a) * SWING_RIM, -0.02, -Math.sin(a) * SWING_RIM),
      0.012,
      3,
      STEEL,
    );
  }

  // A seat hangs from its point on the rim (the origin) on two chains; +x is outward.
  const seat = new PartBuilder();
  const L = SWING_CHAIN;
  seat.rod(new V(0, 0, -0.06), new V(0, -L, -0.06), 0.007, 3, STEEL);
  seat.rod(new V(0, 0, 0.06), new V(0, -L, 0.06), 0.007, 3, STEEL);
  seat.box(0, -L, 0, 0.14, 0.03, 0.15, WHITE);
  seat.box(-0.065, -L + 0.07, 0, 0.025, 0.13, 0.15, WHITE);

  const geometries = [column.build(), crown.build(), seat.build()];
  const [columnG, crownG, seatG] = geometries as [BufferGeometry, BufferGeometry, BufferGeometry];
  const triangles = triangleCount(columnG) + triangleCount(crownG) + triangleCount(seatG) * s.seats;

  return modelOf(
    "swing_tower",
    detail,
    { halfX: 1.48, halfZ: 1.48, height: 3.55 },
    1.5,
    geometries,
    triangles,
    (material) => {
      const group = new Group();
      const lift = node();
      const tilt = node();
      const turn = node();
      const columnM = mesh(columnG, material);
      const crownM = mesh(crownG, material);
      const seats = instanced(seatG, material, s.seats);
      group.add(columnM, lift);
      lift.add(tilt);
      tilt.add(turn);
      turn.add(crownM, seats);
      const m = new Matrix4();
      const r = new Matrix4();
      let lastAngle = NaN;
      let lastMotion = NaN;
      const instance = {
        group,
        meshes: [columnM, crownM, seats] as Mesh[],
        lastWrites: 0,
        pose(angle: number, motion: number) {
          let writes = 0;
          if (motion !== lastMotion) {
            lastMotion = motion;
            // The crown climbs as the ride gets going and leans as it spins.
            const up = Math.min(1, motion * 1.6);
            lift.position.y = CROWN_DOWN + (CROWN_UP - CROWN_DOWN) * up * up * (3 - 2 * up);
            lift.updateMatrix();
            tilt.rotation.z = 0.1 * motion * motion;
            tilt.updateMatrix();
            // The seats swing out with the speed.
            const out = 0.65 * motion * motion;
            for (let i = 0; i < s.seats; i++) {
              const a = (i / s.seats) * TAU;
              m.makeRotationY(a)
                .multiply(r.makeTranslation(SWING_RIM, -0.02, 0))
                .multiply(r.makeRotationZ(out));
              seats.setMatrixAt(i, m);
            }
            seats.instanceMatrix.needsUpdate = true;
            writes += 2 + s.seats;
          }
          if (angle !== lastAngle) {
            lastAngle = angle;
            turn.rotation.y = angle;
            turn.updateMatrix();
            writes++;
          }
          instance.lastWrites = writes;
        },
        dispose() {
          seats.dispose();
        },
      };
      instance.pose(0, 0);
      return instance;
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Stalls: a kiosk box with a counter on the front and a striped awning of alternating strips
// (snacks and drinks, in their own colors and toppers), and restrooms: a small block with a
// pitched roof and two doors.
// ---------------------------------------------------------------------------------------------

interface KioskLook {
  body: Color;
  trim: Color;
  stripeA: Color;
  stripeB: Color;
  topper(b: PartBuilder, s: Spec): void;
}

function kiosk(id: string, detail: RideDetail, look: KioskLook): RideModel {
  const s = SPECS[detail];
  const b = new PartBuilder();
  b.box(0, 0.02, 0, 0.86, 0.04, 0.78, PAVING);
  b.box(0, 0.33, -0.07, 0.74, 0.58, 0.56, look.body);
  b.box(0, 0.52, 0.215, 0.6, 0.22, 0.02, DARK);
  b.box(0, 0.2, 0.225, 0.74, 0.34, 0.04, look.trim);
  b.box(0, 0.385, 0.27, 0.8, 0.04, 0.16, WOOD);
  b.box(0, 0.65, -0.07, 0.82, 0.06, 0.64, look.trim);
  // The awning: strips side by side, sloping down and out over the counter.
  const strips = detail === 0 ? 5 : 7;
  const width = 0.84 / strips;
  for (let i = 0; i < strips; i++) {
    const x = -0.42 + width * (i + 0.5);
    const color = i % 2 === 0 ? look.stripeA : look.stripeB;
    const at = m4()
      .makeTranslation(x, 0.66, 0.2)
      .multiply(m4().makeRotationX(0.5))
      .multiply(m4().makeTranslation(0, 0, 0.13));
    b.boxAt(width, 0.018, 0.26, color, at);
    const hem = m4()
      .makeTranslation(x, 0.66 - Math.sin(0.5) * 0.26 - 0.03, 0.2 + Math.cos(0.5) * 0.26)
      .multiply(m4().makeRotationX(0.12));
    b.boxAt(width, 0.07, 0.014, color, hem);
  }
  look.topper(b, s);
  const geometry = b.build();
  return modelOf(
    id,
    detail,
    { halfX: 0.44, halfZ: 0.44, height: 1.12 },
    0,
    [geometry],
    triangleCount(geometry),
    (material) => staticInstance(geometry, material),
  );
}

function restrooms(detail: RideDetail): RideModel {
  const b = new PartBuilder();
  b.box(0, 0.02, 0, 0.88, 0.04, 0.8, PAVING);
  b.box(0, 0.29, -0.03, 0.78, 0.5, 0.62, SAGE);
  // A roof pitched across the front, a little wider than the walls: a three-sided prism.
  const roof = new CylinderGeometry(0.46, 0.46, 0.9, 3, 1, false, Math.PI / 2);
  b.add(
    roof,
    SLATE,
    m4()
      .makeTranslation(0, 0.632, -0.03)
      .multiply(m4().makeScale(1, 0.4, 1))
      .multiply(m4().makeRotationZ(Math.PI / 2)),
  );
  b.box(0, 0.555, -0.03, 0.8, 0.03, 0.7, CREAM);
  for (const [x, door] of [
    [-0.19, BLUE],
    [0.19, CORAL],
  ] as const) {
    b.box(x, 0.21, 0.28, 0.22, 0.36, 0.03, door);
    b.box(x, 0.45, 0.285, 0.09, 0.09, 0.02, WHITE);
  }
  b.box(0, 0.2, 0.275, 0.05, 0.4, 0.02, CREAM);
  const geometry = b.build();
  return modelOf(
    "restrooms",
    detail,
    { halfX: 0.45, halfZ: 0.42, height: 0.92 },
    0,
    [geometry],
    triangleCount(geometry),
    (material) => staticInstance(geometry, material),
  );
}

function staticInstance(geometry: BufferGeometry, material: Material): RideInstance {
  const group = new Group();
  const m = mesh(geometry, material);
  group.add(m);
  return { group, meshes: [m], lastWrites: 0, pose() {}, dispose() {} };
}

const snackStand = (detail: RideDetail) =>
  kiosk("snack_stand", detail, {
    body: paint(0xf0d79a),
    trim: RED,
    stripeA: RED,
    stripeB: CREAM,
    topper(b, s) {
      // A round sign on a short post: a gold disc with a red middle.
      b.column(0, -0.1, 0.68, 0.8, 0.02, 0.02, s.thin, STEEL);
      const face = m4()
        .makeTranslation(0, 0.88, -0.1)
        .multiply(m4().makeRotationX(Math.PI / 2));
      b.add(new CylinderGeometry(0.16, 0.16, 0.04, s.radial), GOLD, face);
      const inner = m4()
        .makeTranslation(0, 0.88, -0.075)
        .multiply(m4().makeRotationX(Math.PI / 2));
      b.add(new CylinderGeometry(0.1, 0.1, 0.02, s.radial), RED, inner);
    },
  });

const drinksStand = (detail: RideDetail) =>
  kiosk("drinks_stand", detail, {
    body: SKY,
    trim: BLUE,
    stripeA: TEAL,
    stripeB: WHITE,
    topper(b, s) {
      // A big cup with a lid and a straw.
      b.column(0, -0.1, 0.68, 0.92, 0.075, 0.105, s.radial, WHITE);
      b.column(0, -0.1, 0.78, 0.84, 0.093, 0.097, s.radial, TEAL, true);
      b.column(0, -0.1, 0.92, 0.95, 0.115, 0.11, s.radial, BLUE);
      b.rod(new V(0.02, 0.92, -0.1), new V(0.07, 1.06, -0.13), 0.012, s.thin, RED, true);
    },
  });

/** The recipe of every content model id. */
export const RECIPES: Readonly<Record<string, (detail: RideDetail) => RideModel>> = {
  carousel,
  big_wheel: bigWheel,
  swing_tower: swingTower,
  snack_stand: snackStand,
  drinks_stand: drinksStand,
  restrooms,
};

/** Builds the model for content model id `id` at `detail`, or null for an id with no recipe. */
export function buildRideModel(id: string, detail: RideDetail): RideModel | null {
  const recipe = RECIPES[id];
  return recipe ? recipe(detail) : null;
}

function lerp(a: V, b: V, t: number): V {
  return new V().lerpVectors(a, b, t);
}

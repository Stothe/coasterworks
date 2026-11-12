import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
  type IUniform,
} from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl.js";
import {
  SHARED_UNIFORMS_GLSL,
  type EntrancePlace,
  type RenderContext,
  type SceneModule,
} from "./context.js";
import { NOISE_GLSL } from "./shaders/noise.glsl.js";

/** The park gate. */
export type EntranceModule = SceneModule & {
  /** Where the entrance is: its edge tile and the map edge it faces out of. Null for no gate. */
  setEntrance(entrance: EntrancePlace | null): void;
};

/**
 * The gate's measures, in world units (one tile is 1). It is built across X with its front
 * toward +Z, standing on y = 0 around the origin: the middle of the opening on the ground.
 */
export const GATE = {
  /** Middle of each tower, either side of the opening. The path between them is 0.8 wide. */
  towerX: 0.7,
  /** Top of a tower's stonework, where its roof starts. */
  towerTop: 1.26,
  /** Top of the roof, where the flagpole starts. */
  roofTop: 1.6,
  /** Top of the flagpole. */
  poleTop: 2.08,
  /** How far the towers go on below the ground, so that a slope under the gate shows no gap. */
  footing: 0.4,
  /** The arch between the towers: where its middle line starts, and how high it rises. */
  archSpring: 0.98,
  archRise: 0.44,
  /** The sign on the arch: how long along the arch, how tall, how thick. */
  signLength: 1.02,
  signHeight: 0.3,
  signDepth: 0.06,
  flagLength: 0.4,
  flagHeight: 0.22,
} as const;

/** Half the arch's span along its middle line: it springs from inside the towers. */
const ARCH_HALF_SPAN = GATE.towerX - 0.04;
/** The arch's beam: half its height (across the curve) and half its depth (front to back). */
const ARCH_HALF_HEIGHT = 0.05;
const ARCH_HALF_DEPTH = 0.065;
const BULB_RADIUS = 0.021;

/** The gate as plain arrays: one mesh, colored per vertex. */
export interface GateGeometry {
  /** x, y, z per vertex. */
  positions: Float32Array;
  /** Unit normals: smooth over every rounded surface. */
  normals: Float32Array;
  /** Linear RGB per vertex. */
  colors: Float32Array;
  /**
   * Four numbers per vertex for the shader. x: how far along its flag the vertex is, 0 at the
   * pole (and for everything that is not a flag) to 1 at the tip. y: 0, or for a light bulb its
   * number round the sign plus 1, or -1 on a flag. z, w: on the sign's two faces, the place on
   * the sign (along it from its middle, and up from its lower edge, in world units); z is -100
   * everywhere else, and on a flag w is then how far up it the vertex is, -1 to 1.
   */
  fx: Float32Array;
  indices: Uint16Array;
  triangleCount: number;
}

type Rgb = readonly [number, number, number];

const scratchColor = new Color();

function linear(hex: number): Rgb {
  scratchColor.setHex(hex, SRGBColorSpace);
  return [scratchColor.r, scratchColor.g, scratchColor.b];
}

// The gate's few colors. Plaster and stone stay under the brightness of white paint.
const PLASTER = linear(0xe6dcc6);
const STONE = linear(0xbfae90);
const ROOF = linear(0xc9503f);
const DADO = linear(0xb5483b);
const GOLD = linear(0xdba63a);
const BEAM = linear(0xdcd0b6);
const SIGN = linear(0x2c5f9a);
const BULB = linear(0xe6dab8);
const FLAG_A = linear(0xd9473f);
const FLAG_B = linear(0xe6bd3a);
const POLE = linear(0x8a8478);

/** Collects the gate's vertices and triangles. */
class Builder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  fx: number[] = [];
  indices: number[] = [];

  /** Adds a vertex and returns its index. The normal need not be unit length. */
  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    color: Rgb,
    fx: readonly [number, number, number, number] = [0, 0, -100, 0],
  ): number {
    const length = Math.hypot(nx, ny, nz) || 1;
    this.positions.push(x, y, z);
    this.normals.push(nx / length, ny / length, nz / length);
    this.colors.push(color[0], color[1], color[2]);
    this.fx.push(fx[0], fx[1], fx[2], fx[3]);
    return this.positions.length / 3 - 1;
  }

  /** Adds a triangle, wound so that it faces the way its vertices' normals point. */
  triangle(a: number, b: number, c: number): void {
    const p = this.positions;
    const n = this.normals;
    const ux = (p[b * 3] as number) - (p[a * 3] as number);
    const uy = (p[b * 3 + 1] as number) - (p[a * 3 + 1] as number);
    const uz = (p[b * 3 + 2] as number) - (p[a * 3 + 2] as number);
    const vx = (p[c * 3] as number) - (p[a * 3] as number);
    const vy = (p[c * 3 + 1] as number) - (p[a * 3 + 1] as number);
    const vz = (p[c * 3 + 2] as number) - (p[a * 3 + 2] as number);
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    // A triangle with no area (at the tip of a cone, say) draws nothing: leave it out.
    if (fx * fx + fy * fy + fz * fz < 1e-18) return;
    const sx = (n[a * 3] as number) + (n[b * 3] as number) + (n[c * 3] as number);
    const sy = (n[a * 3 + 1] as number) + (n[b * 3 + 1] as number) + (n[c * 3 + 1] as number);
    const sz = (n[a * 3 + 2] as number) + (n[b * 3 + 2] as number) + (n[c * 3 + 2] as number);
    if (fx * sx + fy * sy + fz * sz >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  /**
   * A shape turned about the upright axis through (cx, cz): `profile` is its outline as
   * [radius, y] points going up, and the surface is smooth along it and around it. A corner in
   * the outline is made by ending one call there and starting the next.
   */
  lathe(
    cx: number,
    cz: number,
    profile: readonly (readonly [number, number])[],
    segments: number,
    color: Rgb,
    fx?: readonly [number, number, number, number],
  ): void {
    const rows: number[] = [];
    for (let i = 0; i < profile.length; i++) {
      const [r, y] = profile[i] as readonly [number, number];
      const before = profile[Math.max(0, i - 1)] as readonly [number, number];
      const after = profile[Math.min(profile.length - 1, i + 1)] as readonly [number, number];
      // The outline's direction here, turned a quarter to point out of the shape.
      let outR = after[1] - before[1];
      let outY = -(after[0] - before[0]);
      // On the axis the surface can only face straight up or down.
      if (r === 0) {
        outR = 0;
        outY = Math.sign(outY) || 1;
      }
      rows.push(this.positions.length / 3);
      for (let s = 0; s < segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        const sin = Math.sin(angle);
        const cos = Math.cos(angle);
        this.vertex(cx + r * sin, y, cz + r * cos, outR * sin, outY, outR * cos, color, fx);
      }
    }
    for (let i = 0; i + 1 < rows.length; i++) {
      const a = rows[i] as number;
      const b = rows[i + 1] as number;
      for (let s = 0; s < segments; s++) {
        const n = (s + 1) % segments;
        this.quad(a + s, a + n, b + n, b + s);
      }
    }
  }

  /** A ball. */
  ball(
    x: number,
    y: number,
    z: number,
    radius: number,
    rings: number,
    segments: number,
    color: Rgb,
    fx?: readonly [number, number, number, number],
  ): void {
    const profile: [number, number][] = [];
    for (let i = 0; i <= rings; i++) {
      const a = (i / rings - 0.5) * Math.PI;
      const r = i === 0 || i === rings ? 0 : radius * Math.cos(a);
      profile.push([r, y + radius * Math.sin(a)]);
    }
    this.lathe(x, z, profile, segments, color, fx);
  }

  build(): GateGeometry {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      colors: new Float32Array(this.colors),
      fx: new Float32Array(this.fx),
      indices: new Uint16Array(this.indices),
      triangleCount: this.indices.length / 3,
    };
  }
}

/** A point on the arch's middle line and the directions there, at `angle` (0 at +X, PI at -X). */
function archAt(angle: number): {
  x: number;
  y: number;
  /** Unit, away from the middle of the arch. */
  outX: number;
  outY: number;
  /** Unit, along the arch toward +X. */
  alongX: number;
  alongY: number;
} {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const outLength = Math.hypot(GATE.archRise * cos, ARCH_HALF_SPAN * sin);
  const outX = (GATE.archRise * cos) / outLength;
  const outY = (ARCH_HALF_SPAN * sin) / outLength;
  return {
    x: ARCH_HALF_SPAN * cos,
    y: GATE.archSpring + GATE.archRise * sin,
    outX,
    outY,
    alongX: outY,
    alongY: -outX,
  };
}

/** The outline of a tower from the footing to the top of its stonework, as [radius, y]. */
const TOWER_BASE: readonly (readonly [number, number])[] = [
  [0.19, -GATE.footing],
  [0.19, 0.1],
  [0.185, 0.13],
  [0.165, 0.16],
  [0.14, 0.175],
];
/** The painted foot of the shaft, the gold band above it, and the plaster above that. */
const TOWER_DADO: readonly (readonly [number, number])[] = [
  [0.129, 0.175],
  [0.127, 0.4],
];
const TOWER_BAND: readonly (readonly [number, number])[] = [
  [0.127, 0.4],
  [0.137, 0.407],
  [0.141, 0.42],
  [0.137, 0.433],
  [0.126, 0.44],
];
const TOWER_SHAFT: readonly (readonly [number, number])[] = [
  [0.125, 0.44],
  [0.121, 0.7],
  [0.114, 0.98],
  [0.112, 1.06],
];
/** The window in each tower's shaft, front and back: how wide, and from where to where. */
const WINDOW = { halfWidth: 0.036, sill: 0.64, spring: 0.78 } as const;
const TOWER_HEAD: readonly (readonly [number, number])[] = [
  [0.112, 1.06],
  [0.13, 1.075],
  [0.137, 1.095],
  [0.13, 1.115],
  [0.124, 1.13],
  [0.15, 1.18],
  [0.172, 1.215],
  [0.176, 1.24],
  [0.168, GATE.towerTop],
  [0, GATE.towerTop],
];
/** The roof: a low dome drawn up into a point. */
const TOWER_ROOF: readonly (readonly [number, number])[] = [
  [0.19, GATE.towerTop - 0.012],
  [0.198, GATE.towerTop + 0.012],
  [0.186, GATE.towerTop + 0.05],
  [0.156, GATE.towerTop + 0.11],
  [0.112, GATE.towerTop + 0.17],
  [0.07, GATE.towerTop + 0.225],
  [0.04, GATE.towerTop + 0.28],
  [0.022, GATE.roofTop],
  [0, GATE.roofTop + 0.004],
];

/**
 * Builds the gate: two round towers with a painted foot, a gold band, pointed roofs and
 * flagpoles, an arch between them, a long rounded sign that follows the arch with light bulbs
 * round its edge, and a flag on each pole. Everything round is smooth-shaded; edges that should be
 * crisp (where a roof meets stone) are where one surface ends and the next begins. What is only
 * paint (the sign's picture, the towers' windows, the stripe on a flag) is left to the shader.
 */
export function buildGateGeometry(): GateGeometry {
  const b = new Builder();

  for (const side of [-1, 1]) {
    const x = side * GATE.towerX;
    b.lathe(x, 0, TOWER_BASE, 16, STONE);
    b.lathe(x, 0, TOWER_DADO, 16, DADO);
    b.lathe(x, 0, TOWER_BAND, 16, GOLD);
    b.lathe(x, 0, TOWER_SHAFT, 16, PLASTER);
    b.lathe(x, 0, TOWER_HEAD, 16, STONE);
    b.lathe(x, 0, TOWER_ROOF, 16, ROOF);
    b.lathe(
      x,
      0,
      [
        [0.011, GATE.roofTop - 0.02],
        [0.011, GATE.poleTop],
      ],
      6,
      POLE,
    );
    b.ball(x, GATE.poleTop + 0.02, 0, 0.028, 5, 8, GOLD);
    b.ball(x, GATE.roofTop + 0.012, 0, 0.03, 5, 8, GOLD);
  }

  // The arch: a rounded beam swept along half an ellipse from tower to tower.
  const archSteps = 28;
  const around = 10;
  let previousRing = -1;
  for (let i = 0; i <= archSteps; i++) {
    const at = archAt((i / archSteps) * Math.PI);
    const ring = b.positions.length / 3;
    for (let k = 0; k < around; k++) {
      const a = (k / around) * Math.PI * 2;
      // A rounded rectangle: a circle pushed out toward its corners.
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const up = Math.sign(cos) * Math.abs(cos) ** 0.7 * ARCH_HALF_HEIGHT;
      const out = Math.sign(sin) * Math.abs(sin) ** 0.7 * ARCH_HALF_DEPTH;
      b.vertex(
        at.x + at.outX * up,
        at.y + at.outY * up,
        out,
        at.outX * cos * ARCH_HALF_DEPTH,
        at.outY * cos * ARCH_HALF_DEPTH,
        sin * ARCH_HALF_HEIGHT,
        BEAM,
      );
    }
    if (previousRing >= 0) {
      for (let k = 0; k < around; k++) {
        const n = (k + 1) % around;
        b.quad(previousRing + k, previousRing + n, ring + n, ring + k);
      }
    }
    previousRing = ring;
  }

  buildSign(b);
  buildFlag(b, -GATE.towerX, FLAG_A);
  buildFlag(b, GATE.towerX, FLAG_B);
  return b.build();
}

/**
 * The sign: a long board with round ends, bent to follow the arch and standing on top of it.
 * Places on it are given as (s, t): `s` along it from the middle (toward +X), `t` up from its
 * lower edge.
 */
function buildSign(b: Builder): void {
  const length = GATE.signLength;
  const height = GATE.signHeight;
  const radius = height / 2;
  const half = length / 2;
  /** The lower edge sits just inside the top of the arch's beam. */
  const lift = ARCH_HALF_HEIGHT - 0.012;

  // How far along the arch each angle is from the top, to turn `s` back into an angle.
  const table: number[] = [0];
  const tableSteps = 256;
  let last = archAt(Math.PI / 2);
  for (let i = 1; i <= tableSteps; i++) {
    const at = archAt(Math.PI / 2 - (i / tableSteps) * (Math.PI / 2));
    table.push((table[i - 1] as number) + Math.hypot(at.x - last.x, at.y - last.y));
    last = at;
  }
  const angleAt = (s: number): number => {
    const distance = Math.abs(s);
    let i = 1;
    while (i < tableSteps && (table[i] as number) < distance) i++;
    const a = table[i - 1] as number;
    const c = table[i] as number;
    const k = c > a ? (distance - a) / (c - a) : 0;
    const turned = ((i - 1 + Math.min(1, Math.max(0, k))) / tableSteps) * (Math.PI / 2);
    return Math.PI / 2 - Math.sign(s) * turned;
  };
  /** World position of sign place (s, t) in the plane of the arch, and the directions there. */
  const place = (s: number, t: number) => {
    const at = archAt(angleAt(s));
    return {
      x: at.x + at.outX * (lift + t),
      y: at.y + at.outY * (lift + t),
      at,
    };
  };

  // Columns across the sign: close together round the ends, evenly spaced between.
  const columns: number[] = [];
  const capSteps = 7;
  for (let i = 0; i < capSteps; i++) {
    columns.push(-half + radius * (1 - Math.cos((i / capSteps) * (Math.PI / 2))));
  }
  const straight = length - height;
  const straightSteps = Math.ceil(straight / 0.05);
  for (let i = 0; i <= straightSteps; i++)
    columns.push(-straight / 2 + (i / straightSteps) * straight);
  for (let i = capSteps - 1; i >= 0; i--) {
    columns.push(half - radius * (1 - Math.cos((i / capSteps) * (Math.PI / 2))));
  }

  const rows = 4;
  const halfDepth = GATE.signDepth / 2;
  /**
   * How a face leans at sign place (s, t), in (s, t) terms: not at all in the middle of the
   * board, more and more toward the nearest edge on the way out to it.
   */
  const edgeOut = (s: number, t: number): [number, number] => {
    const past = Math.max(0, Math.abs(s) - (half - radius));
    const ds = (Math.sign(s) * past) / radius;
    const dt = (t - radius) / radius;
    const near = ds * ds + dt * dt;
    return [ds * near, dt * near];
  };

  for (const face of [1, -1]) {
    const grid: number[] = [];
    for (const s of columns) {
      const past = Math.max(0, Math.abs(s) - (half - radius));
      const reach = Math.sqrt(Math.max(0, radius * radius - past * past));
      for (let row = 0; row <= rows; row++) {
        const t = radius + reach * ((row / rows) * 2 - 1);
        const p = place(s, t);
        const [es, et] = edgeOut(s, t);
        // Flat across the board, rolling over toward the rim at its edge.
        const ex = es * p.at.alongX + et * p.at.outX;
        const ey = es * p.at.alongY + et * p.at.outY;
        grid.push(
          b.vertex(p.x, p.y, face * halfDepth, ex * 0.55, ey * 0.55, face, SIGN, [0, 0, s, t]),
        );
      }
    }
    for (let c = 0; c + 1 < columns.length; c++) {
      for (let row = 0; row < rows; row++) {
        const i = c * (rows + 1) + row;
        b.quad(
          grid[i] as number,
          grid[i + rows + 1] as number,
          grid[i + rows + 2] as number,
          grid[i + 1] as number,
        );
      }
    }
  }

  // The rim: round the outline, front edge to back edge.
  const outline: [number, number][] = [];
  for (const s of columns) outline.push([s, 1]);
  for (let c = columns.length - 2; c >= 1; c--) outline.push([columns[c] as number, -1]);
  const rim: number[] = [];
  for (const [s, sign] of outline) {
    const past = Math.max(0, Math.abs(s) - (half - radius));
    const reach = Math.sqrt(Math.max(0, radius * radius - past * past));
    const t = radius + sign * reach;
    const p = place(s, t);
    const ds = Math.sign(s) * past;
    const dt = t - radius;
    const l = Math.hypot(ds, dt) || 1;
    const ex = (ds / l) * p.at.alongX + (dt / l) * p.at.outX;
    const ey = (ds / l) * p.at.alongY + (dt / l) * p.at.outY;
    rim.push(b.vertex(p.x, p.y, halfDepth, ex, ey, 0.5, GOLD));
    b.vertex(p.x, p.y, -halfDepth, ex, ey, -0.5, GOLD);
  }
  for (let i = 0; i < rim.length; i++) {
    const a = rim[i] as number;
    const c = rim[(i + 1) % rim.length] as number;
    b.quad(a, c, c + 1, a + 1);
  }

  // Light bulbs round the edge of both faces, evenly spaced along a line a little inside it.
  const inset = 0.036;
  const lineRadius = radius - inset;
  const lineLength = 2 * straight + 2 * Math.PI * lineRadius;
  const bulbs = Math.round(lineLength / 0.095 / 2) * 2;
  for (let i = 0; i < bulbs; i++) {
    let d = (i / bulbs) * lineLength;
    let s: number;
    let t: number;
    if (d < straight) {
      // Along the top, toward +X.
      s = -straight / 2 + d;
      t = radius + lineRadius;
    } else if ((d -= straight) < Math.PI * lineRadius) {
      const a = d / lineRadius;
      s = straight / 2 + lineRadius * Math.sin(a);
      t = radius + lineRadius * Math.cos(a);
    } else if ((d -= Math.PI * lineRadius) < straight) {
      s = straight / 2 - d;
      t = radius - lineRadius;
    } else {
      const a = (d - straight) / lineRadius;
      s = -straight / 2 - lineRadius * Math.sin(a);
      t = radius - lineRadius * Math.cos(a);
    }
    const p = place(s, t);
    for (const face of [1, -1]) {
      b.ball(p.x, p.y, face * (halfDepth + BULB_RADIUS * 0.45), BULB_RADIUS, 4, 6, BULB, [
        0,
        i + 1,
        -100,
        0,
      ]);
    }
  }
}

/** A pennant on the pole at `x`, flying toward +X: both of its faces. */
function buildFlag(b: Builder, x: number, color: Rgb): void {
  const steps = 12;
  const top = GATE.poleTop - 0.015;
  for (const face of [1, -1]) {
    const grid: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      // It narrows toward the tip, which is cut off short of a point.
      const tall = GATE.flagHeight * (1 - 0.72 * u);
      const middle = top - GATE.flagHeight / 2;
      for (let row = 0; row <= 2; row++) {
        const y = middle + tall * (0.5 - row / 2);
        grid.push(
          b.vertex(x + 0.011 + u * GATE.flagLength, y, 0, 0, 0, face, color, [
            u,
            -1,
            -100,
            1 - row,
          ]),
        );
      }
    }
    for (let i = 0; i < steps; i++) {
      for (let row = 0; row < 2; row++) {
        const k = i * 3 + row;
        b.quad(
          grid[k] as number,
          grid[k + 3] as number,
          grid[k + 4] as number,
          grid[k + 1] as number,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const glsl = (n: number): string => n.toFixed(4);

const VERTEX_DECLARATIONS = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
attribute vec4 aFx;

// A flag in the wind: moves a vertex of the flat flag and leans its normal to match.
void cwGateFlag( inout vec3 p, inout vec3 n ) {
  float u = aFx.x;
  if ( u <= 0.0 ) return;
  // The two flags are out of step.
  float own = p.x > 0.0 ? 2.1 : 0.0;
  float a = 8.0 * u - 6.0 * uTime + own;
  float b = 15.0 * u - 10.4 * uTime + 1.7 * own + p.y * 9.0;
  float gust = 0.75 + 0.25 * sin( 0.9 * uTime + own );
  float wave = gust * ( 0.062 * sin( a ) + 0.02 * sin( b ) );
  float slope = gust * ( 0.062 * 8.0 * cos( a ) + 0.02 * 15.0 * cos( b ) );
  // How the sideways shift changes along the flag and up it, for the normal.
  float dzdx = ( wave + u * slope ) / ${glsl(GATE.flagLength)};
  float dzdy = u * gust * 0.02 * 9.0 * cos( b );
  p.z += u * wave;
  // A flag that waves reaches less far, and its tip hangs a little.
  p.x -= u * u * 0.03;
  p.y -= u * u * 0.035;
  n = normalize( vec3( -dzdx, -dzdy, 1.0 ) ) * sign( n.z );
}
`;

const COLOR_VERTEX_DECLARATIONS = /* glsl */ `
varying vec4 vCwFx;
varying vec3 vCwWorld;
// The place on the gate as built: x across the opening, y up from the ground, z out the front.
varying vec3 vCwLocal;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
varying vec4 vCwFx;
varying vec3 vCwWorld;
varying vec3 vCwLocal;
${SHARED_UNIFORMS_GLSL}
${NOISE_GLSL}
${ATMOSPHERE_GLSL}

// The arched window in the front and the back of each tower: x is how far inside its outline the
// place on the gate is (negative outside it), y is 1 on a tower's shaft and 0 elsewhere.
vec2 cwGateWindow( vec3 local ) {
  vec2 fromAxis = vec2( abs( local.x ) - ${glsl(GATE.towerX)}, local.z );
  float reach = length( fromAxis );
  float onShaft = step( reach, 0.132 ) * step( 0.45, local.y ) * step( local.y, 1.05 );
  // Distance round the shaft from the middle of its front or back.
  float turn = abs( atan( fromAxis.x, abs( fromAxis.y ) ) ) * 0.119;
  float inside = local.y > ${glsl(WINDOW.spring)}
    ? ${glsl(WINDOW.halfWidth)} - length( vec2( turn, local.y - ${glsl(WINDOW.spring)} ) )
    : min( ${glsl(WINDOW.halfWidth)} - turn, local.y - ${glsl(WINDOW.sill)} );
  return vec2( inside, onShaft );
}

// How lit up the gate's lights are: off by day, on from dusk.
float cwGateNight() {
  return 1.0 - smoothstep( 0.3, 0.75, uDaylight );
}
`;

// The sign's face is painted here: a rising sun with rays, inside a pale line.
const FRAGMENT_COLOR = /* glsl */ `
{
  float cwSign = step( -50.0, vCwFx.z );
  vec2 cwSt = vCwFx.zw;
  float cwPixel = fwidth( cwSt.y ) + 0.0005;
  float cwRadius = ${glsl(GATE.signHeight / 2)};
  // Distance in from the sign's rounded outline.
  vec2 cwOff = vec2( max( abs( cwSt.x ) - ${glsl(GATE.signLength / 2 - GATE.signHeight / 2)}, 0.0 ), cwSt.y - cwRadius );
  float cwIn = cwRadius - length( cwOff );
  // Rays fan out from the middle of the board's lower edge, inside the line.
  vec2 cwFrom = cwSt - vec2( 0.0, 0.066 );
  float cwTurn = atan( cwFrom.x, cwFrom.y );
  float cwReach = length( cwFrom );
  float cwRayWidth = fwidth( cwTurn ) * 11.0 + 0.001;
  float cwRay = smoothstep( -cwRayWidth, cwRayWidth, sin( cwTurn * 11.0 ) );
  vec3 cwPaint = mix( vec3( 0.022, 0.105, 0.3 ), vec3( 0.06, 0.26, 0.52 ), cwRay );
  // Paler toward the top, as if the light of the sun spread up the board.
  cwPaint *= 0.8 + 0.5 * smoothstep( 0.0, 0.3, cwSt.y );
  // The sun: a gold half disc with a pale rim.
  float cwSun = 1.0 - smoothstep( 0.1 - cwPixel, 0.1 + cwPixel, cwReach );
  float cwCore = 1.0 - smoothstep( 0.082 - cwPixel, 0.082 + cwPixel, cwReach );
  cwPaint = mix( cwPaint, vec3( 0.85, 0.74, 0.5 ), cwSun );
  cwPaint = mix( cwPaint, vec3( 0.78, 0.42, 0.06 ), cwCore );
  // A pale line just inside the bulbs.
  float cwLine = 1.0 - smoothstep( 0.008 - cwPixel, 0.008 + cwPixel, abs( cwIn - 0.07 ) );
  cwPaint = mix( cwPaint, vec3( 0.8, 0.72, 0.5 ), cwLine * 0.9 );
  // The strip the bulbs sit on.
  cwPaint = mix( cwPaint, vec3( 0.012, 0.035, 0.1 ), 1.0 - smoothstep( 0.058 - cwPixel, 0.058 + cwPixel, cwIn ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, cwPaint, cwSign );

  // A flag has a pale stripe along its middle.
  float cwFlag = step( vCwFx.y, -0.5 );
  float cwBand = fwidth( vCwFx.w ) + 0.001;
  float cwStripe = 1.0 - smoothstep( 0.3 - cwBand, 0.3 + cwBand, abs( vCwFx.w ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.8, 0.74, 0.6 ), cwFlag * cwStripe );

  // Plaster, paint and stone are not one flat color: they weather, the foot of a tower is damp
  // and dark, and under the overhang of its head the shaft is in shade.
  float cwPlain = ( 1.0 - cwSign ) * ( 1.0 - cwFlag ) * step( vCwFx.y, 0.5 );
  float cwWear = cwFbm( vCwLocal.xy * vec2( 9.0, 4.0 ) + vCwLocal.z * 7.0, 3 );
  float cwShade = 0.84 + 0.26 * cwWear;
  cwShade *= mix( 0.68, 1.0, smoothstep( -0.02, 0.22, vCwLocal.y ) );
  vec2 cwWindow = cwGateWindow( vCwLocal );
  cwShade *= mix( 1.0, 0.8, cwWindow.y * smoothstep( 0.86, 1.05, vCwLocal.y ) );
  diffuseColor.rgb *= mix( 1.0, cwShade, cwPlain );
  // The window: dark glass in a stone surround.
  float cwEdge = fwidth( cwWindow.x ) + 0.0005;
  float cwFrame = cwWindow.y * smoothstep( -0.016 - cwEdge, -0.016 + cwEdge, cwWindow.x );
  float cwGlass = cwWindow.y * smoothstep( -cwEdge, cwEdge, cwWindow.x );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.42, 0.36, 0.27 ), cwFrame );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.03, 0.05, 0.08 ), cwGlass );
}
`;

// Light: the bulbs glow from dusk, running round the sign, and the sign's paint catches them.
// By day a bulb is pale glass and a window dark.
const FRAGMENT_GLOW = /* glsl */ `
{
  float cwNight = cwGateNight();
  float cwBulb = step( 0.5, vCwFx.y );
  float cwChase = 0.5 + 0.5 * sin( vCwFx.y * 2.0944 - uTime * 4.0 );
  totalEmissiveRadiance += cwBulb * cwNight * vec3( 1.0, 0.72, 0.34 ) * ( 1.6 + 2.2 * cwChase * cwChase );
  float cwSign = step( -50.0, vCwFx.z );
  totalEmissiveRadiance += cwSign * cwNight * diffuseColor.rgb * vec3( 1.0, 0.8, 0.55 ) * 0.55;
  // And the towers' windows are lit from inside.
  vec2 cwLit = cwGateWindow( vCwLocal );
  float cwPane = cwLit.y * smoothstep( 0.0, 0.006, cwLit.x );
  totalEmissiveRadiance += cwPane * cwNight * vec3( 1.0, 0.62, 0.26 ) * 1.5;
}
`;

const FRAGMENT_CLOUD_SHADOW = /* glsl */ `
{
  float cwCloud = cwCloudShadow( vCwWorld.xz );
  reflectedLight.directDiffuse *= cwCloud;
  reflectedLight.directSpecular *= cwCloud;
}
`;

/**
 * Puts `addition` right after `#include <name>` in `source`, or in its place. Throws when the
 * include is not there: the names are three.js internals, and a version that renamed one must
 * fail loudly here, not draw a gate with limp flags in silence.
 */
function patch(source: string, name: string, addition: string, replace = false): string {
  const include = `#include <${name}>`;
  if (!source.includes(include)) {
    throw new Error(
      `Entrance: three.js's shader has no "${include}". The gate was written against ` +
        `three r186; see packages/render/src/entrance.ts.`,
    );
  }
  return source.replace(include, replace ? addition : `${include}\n${addition}`);
}

/**
 * Creates the entrance module: the gate of `buildGateGeometry`, standing across the outer edge of
 * the entrance tile with its front to the outside. It is one mesh with one material: three.js's
 * standard lighting, shadows and fog over vertex colors, with the sign's painting, the bulbs'
 * glow after dusk and the weathering of the stone added in the fragment stage, and the flags'
 * waving in the vertex stage (the shadow is drawn with the same waving).
 */
export function createEntrance(ctx: RenderContext): EntranceModule {
  const built = buildGateGeometry();
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(built.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(built.normals, 3));
  geometry.setAttribute("color", new BufferAttribute(built.colors, 3));
  geometry.setAttribute("aFx", new BufferAttribute(built.fx, 4));
  geometry.setIndex(new BufferAttribute(built.indices, 1));
  // The flags wave a little outside the box of the resting shape.
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 0.2;

  const uniforms: Record<string, IUniform> = { ...ctx.uniforms, ...ctx.atmosphereUniforms };

  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vertex = shader.vertexShader;
    vertex = patch(vertex, "common", VERTEX_DECLARATIONS + COLOR_VERTEX_DECLARATIONS);
    vertex = patch(
      vertex,
      "beginnormal_vertex",
      /* glsl */ `
      vec3 cwMoved = vec3( position );
      cwGateFlag( cwMoved, objectNormal );
      vCwFx = aFx;
      vCwLocal = cwMoved;
      vCwWorld = ( modelMatrix * vec4( cwMoved, 1.0 ) ).xyz;`,
    );
    vertex = patch(vertex, "begin_vertex", "vec3 transformed = cwMoved;", true);
    shader.vertexShader = vertex;

    let fragment = shader.fragmentShader;
    fragment = patch(fragment, "clipping_planes_pars_fragment", FRAGMENT_DECLARATIONS);
    fragment = patch(fragment, "color_fragment", FRAGMENT_COLOR);
    fragment = patch(fragment, "emissivemap_fragment", FRAGMENT_GLOW);
    fragment = patch(fragment, "lights_fragment_begin", FRAGMENT_CLOUD_SHADOW);
    shader.fragmentShader = fragment;
  };
  material.customProgramCacheKey = () => "cw-gate";

  const depthMaterial = new MeshDepthMaterial();
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vertex = shader.vertexShader;
    vertex = patch(vertex, "common", VERTEX_DECLARATIONS);
    vertex = patch(
      vertex,
      "begin_vertex",
      /* glsl */ `
      vec3 transformed = vec3( position );
      vec3 cwNormal = vec3( 0.0, 0.0, 1.0 );
      cwGateFlag( transformed, cwNormal );`,
      true,
    );
    shader.vertexShader = vertex;
  };
  depthMaterial.customProgramCacheKey = () => "cw-gate-depth";

  const gate = new Mesh(geometry, material);
  gate.customDepthMaterial = depthMaterial;
  gate.castShadow = true;
  gate.receiveShadow = true;
  gate.visible = false;
  ctx.scene.add(gate);

  let entrance: EntrancePlace | null = null;

  function seat(): void {
    gate.visible = entrance !== null;
    if (!entrance) return;
    // The middle of the tile's outer edge, and the way out of the park from there. The gate is
    // built with its front toward +Z, which is the way out of a south edge.
    const { side } = entrance;
    const x = entrance.x + (side === 1 ? 1 : side === 3 ? 0 : 0.5);
    const z = entrance.y + (side === 2 ? 1 : side === 0 ? 0 : 0.5);
    const turn = side === 2 ? 0 : side === 1 ? Math.PI / 2 : side === 0 ? Math.PI : -Math.PI / 2;
    // The towers stand to either side along the edge: sit on the lowest of the three spots, so
    // that neither tower hangs in the air (their footings reach down into higher ground).
    const acrossX = Math.cos(turn) * GATE.towerX;
    const acrossZ = -Math.sin(turn) * GATE.towerX;
    const y = Math.min(
      ctx.heightAt(x, z),
      ctx.heightAt(x + acrossX, z + acrossZ),
      ctx.heightAt(x - acrossX, z - acrossZ),
    );
    gate.position.set(x, y, z);
    gate.rotation.y = turn;
    gate.updateMatrixWorld();
  }

  return {
    setEntrance(next: EntrancePlace | null): void {
      entrance = next;
      seat();
    },
    setTerrain(): void {
      // The ground under the gate may have moved.
      seat();
    },
    dispose(): void {
      ctx.scene.remove(gate);
      geometry.dispose();
      material.dispose();
      depthMaterial.dispose();
    },
  };
}

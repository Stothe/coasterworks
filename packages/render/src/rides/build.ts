import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * A small kit for the ride recipes: three.js's own primitives, each painted one flat color,
 * placed by a matrix and merged into one geometry per moving part. Everything a recipe makes
 * comes out as plain indexed geometry with `position`, `normal` and `color` (linear) and nothing
 * else, so that a whole part is one draw call with the one shared ride material.
 */

const scratchColor = new Color();

/** A color in linear light from an sRGB hex value, as vertex colors want it. */
export function paint(hex: number): Color {
  return new Color().setHex(hex, SRGBColorSpace);
}

const UP = new Vector3(0, 1, 0);

/** Collects the primitives of one part. */
export class PartBuilder {
  private readonly pieces: BufferGeometry[] = [];

  /** Adds `geometry` painted `color` and moved by `matrix`. Takes ownership of `geometry`. */
  add(geometry: BufferGeometry, color: Color, matrix?: Matrix4): this {
    geometry.deleteAttribute("uv");
    if (matrix) geometry.applyMatrix4(matrix);
    const count = geometry.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    scratchColor.copy(color);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = scratchColor.r;
      colors[i * 3 + 1] = scratchColor.g;
      colors[i * 3 + 2] = scratchColor.b;
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    if (!geometry.index) {
      const index = new Uint32Array(count);
      for (let i = 0; i < count; i++) index[i] = i;
      geometry.setIndex(new BufferAttribute(index, 1));
    }
    this.pieces.push(geometry);
    return this;
  }

  /** A box of size `sx` by `sy` by `sz` with its middle at (`x`, `y`, `z`), turned `yaw` about Y. */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: Color, yaw = 0) {
    const m = new Matrix4().makeRotationY(yaw).setPosition(x, y, z);
    return this.add(new BoxGeometry(sx, sy, sz), color, m);
  }

  /** A box placed by an arbitrary matrix. */
  boxAt(sx: number, sy: number, sz: number, color: Color, matrix: Matrix4) {
    return this.add(new BoxGeometry(sx, sy, sz), color, matrix);
  }

  /** An upright cylinder (or cone) standing from `y0` to `y1` at (`x`, `z`). */
  column(
    x: number,
    z: number,
    y0: number,
    y1: number,
    radiusBottom: number,
    radiusTop: number,
    radial: number,
    color: Color,
    openEnded = false,
  ) {
    const m = new Matrix4().makeTranslation(x, (y0 + y1) / 2, z);
    return this.add(
      new CylinderGeometry(radiusTop, radiusBottom, y1 - y0, radial, 1, openEnded),
      color,
      m,
    );
  }

  /** A rod of `radius` from point `a` to point `b`, open at the ends. */
  rod(a: Vector3, b: Vector3, radius: number, radial: number, color: Color, capped = false) {
    const dir = new Vector3().subVectors(b, a);
    const length = dir.length();
    if (!(length > 0)) return this;
    const q = new Quaternion().setFromUnitVectors(UP, dir.normalize());
    const mid = new Vector3().addVectors(a, b).multiplyScalar(0.5);
    const m = new Matrix4().compose(mid, q, new Vector3(1, 1, 1));
    return this.add(new CylinderGeometry(radius, radius, length, radial, 1, !capped), color, m);
  }

  /** A lathe of `profile` ([radius, y] pairs) about Y, between angles `phi0` and `phi0 + phiLength`. */
  lathe(
    profile: readonly (readonly [number, number])[],
    segments: number,
    color: Color,
    phi0 = 0,
    phiLength = Math.PI * 2,
    matrix?: Matrix4,
  ) {
    const points = profile.map(([r, y]) => new Vector2(r, y));
    return this.add(new LatheGeometry(points, segments, phi0, phiLength), color, matrix);
  }

  /** A ball. */
  ball(x: number, y: number, z: number, radius: number, w: number, h: number, color: Color) {
    return this.add(
      new SphereGeometry(radius, w, h),
      color,
      new Matrix4().makeTranslation(x, y, z),
    );
  }

  /** An arc of a torus in the plane its matrix gives (by default the XY plane, about the Z axis). */
  torus(
    radius: number,
    tube: number,
    radial: number,
    tubular: number,
    arc: number,
    color: Color,
    matrix?: Matrix4,
  ) {
    return this.add(new TorusGeometry(radius, tube, radial, tubular, arc), color, matrix);
  }

  /**
   * Merges everything added into one geometry and frees the pieces. An empty part gives an empty
   * geometry.
   */
  build(): BufferGeometry {
    if (this.pieces.length === 0) {
      const empty = new BufferGeometry();
      empty.setAttribute("position", new BufferAttribute(new Float32Array(0), 3));
      return empty;
    }
    const merged = mergeGeometries(this.pieces, false);
    for (const piece of this.pieces) piece.dispose();
    this.pieces.length = 0;
    if (!merged) throw new Error("Rides: the parts of a model could not be merged.");
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
  }
}

/** Triangles in a geometry. */
export function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.index;
  if (index) return index.count / 3;
  return geometry.getAttribute("position").count / 3;
}

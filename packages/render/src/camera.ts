import type { V3 } from "./units.js";

/** The slice of a three.js camera the rig drives, so this module needs no three.js import. */
export interface CameraLike {
  position: { set(x: number, y: number, z: number): unknown };
  lookAt(x: number, y: number, z: number): void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * An orbit camera: it looks at `target` from `distance` away, rotated by `yaw` around the vertical
 * axis and raised by `pitch` above the ground plane. Yaw 0 puts the camera on the +Z side of the
 * target looking toward -Z (north); positive yaw swings it toward +X.
 */
export class CameraRig {
  target: V3 = { x: 0, y: 0, z: 0 };
  distance = 40;
  yaw = Math.PI / 4;
  pitch = 0.6;
  readonly limits = {
    pitch: [0.26, 1.4],
    distance: [4, 200],
  } as const;

  /** Turns the camera by the given radians; pitch is clamped to the limits, yaw is free. */
  orbit(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, this.limits.pitch[0], this.limits.pitch[1]);
  }

  /** Multiplies the distance by `factor` (below 1 zooms in), clamped to the limits. */
  zoom(factor: number): void {
    this.distance = clamp(this.distance * factor, this.limits.distance[0], this.limits.distance[1]);
  }

  /**
   * Moves the target across the ground by a screen-space offset in pixels. `dxScreen` goes along the
   * camera's right vector and `dyScreen` along its ground-projected forward vector, scaled so a pixel
   * covers the same world distance at the target whatever the zoom. A caller that drags the ground
   * with the pointer passes `-dx` and `+dy`.
   */
  pan(dxScreen: number, dyScreen: number, viewportHeight: number): void {
    const scale = (this.distance / viewportHeight) * 2;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.target.x += (cos * dxScreen - sin * dyScreen) * scale;
    this.target.z += (-sin * dxScreen - cos * dyScreen) * scale;
  }

  /** Snaps to one of RCT's four classic angles: 45 degrees plus index quarter turns, ~35 degrees up. */
  setClassic(index: 0 | 1 | 2 | 3): void {
    this.yaw = Math.PI / 4 + (index * Math.PI) / 2;
    this.pitch = 0.615;
  }

  /** Keeps the target over the map, which spans world X in [0, width] and Z in [0, height]. */
  clampTarget(width: number, height: number): void {
    this.target.x = clamp(this.target.x, 0, width);
    this.target.z = clamp(this.target.z, 0, height);
  }

  /** The camera position in world space. */
  position(): V3 {
    const flat = this.distance * Math.cos(this.pitch);
    return {
      x: this.target.x + flat * Math.sin(this.yaw),
      y: this.target.y + this.distance * Math.sin(this.pitch),
      z: this.target.z + flat * Math.cos(this.yaw),
    };
  }

  /** Points `camera` from `position()` at the target. */
  applyTo(camera: CameraLike): void {
    const p = this.position();
    camera.position.set(p.x, p.y, p.z);
    camera.lookAt(this.target.x, this.target.y, this.target.z);
  }
}

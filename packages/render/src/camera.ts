import type { V3 } from "./units.js";

/** The slice of a three.js camera the rig drives, so this module needs no three.js import. */
export interface CameraLike {
  position: { set(x: number, y: number, z: number): unknown };
  lookAt(x: number, y: number, z: number): void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The least height, in world units, the camera keeps above the ground under it. */
export const CAMERA_CLEARANCE = 1.0;

/** How far the target's height moves toward the ground under it each frame. */
const TARGET_EASE = 0.2;
/** Within this of the ground, the target's height snaps to it, so easing does not go on forever. */
const TARGET_SNAP = 1e-3;
/** The pitch search steps this far at a time, then narrows to the first pose that clears. */
const PITCH_STEP = 0.02;
const PITCH_REFINEMENTS = 14;
/** How many times the distance fix repeats, as the ground under a moving eye changes. */
const DISTANCE_PASSES = 8;

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
  /** Vertical field of view in radians. The scene's camera follows it, and `pan` is scaled by it. */
  fovY = (35 * Math.PI) / 180;
  readonly limits = {
    pitch: [0.26, 1.4],
    distance: [4, 200],
  } as const;
  /**
   * The ground height at world (`x`, `z`), installed by whoever owns the terrain. While it is set,
   * `settle()` keeps the target on the ground and the camera out of it. Without it, nothing is
   * done and the rig is a plain orbit camera.
   */
  heightAt: ((x: number, z: number) => number) | undefined;

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
   * camera's right vector and `dyScreen` along its ground-projected forward vector. A pixel is
   * scaled to the world distance it spans at the target (`distance * 2 * tan(fovY / 2)` over the
   * viewport's height), so a drag that passes `-dx` and `+dy` moves the ground under the cursor by
   * the same screen distance, whatever the zoom.
   */
  pan(dxScreen: number, dyScreen: number, viewportHeight: number): void {
    const scale = (this.distance * 2 * Math.tan(this.fovY / 2)) / viewportHeight;
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

  /**
   * Keeps the view out of the hills; the scene calls it once a frame, before `applyTo`.
   *
   * The target's height eases toward the ground under it, so the view follows the land as the
   * player pans over hills or reshapes them. Then, if the eye is less than `CAMERA_CLEARANCE`
   * above the ground under it, the pitch is raised, by as little as does it, to lift the eye. Only
   * when the pitch is at its limit does the distance grow instead. The eye is never left below the
   * ground, and the pose that results stays: panning away does not put the old pitch back.
   */
  settle(): void {
    const ground = this.heightAt;
    if (!ground) return;

    const groundAtTarget = ground(this.target.x, this.target.z);
    const gap = groundAtTarget - this.target.y;
    this.target.y =
      Math.abs(gap) <= TARGET_SNAP ? groundAtTarget : this.target.y + gap * TARGET_EASE;

    if (this.clearance(ground) >= 0) return;
    this.raisePitch(ground);
    if (this.clearance(ground) >= 0) return;
    this.raiseDistance(ground);
  }

  /** How far the eye is above the least height it may have: negative when it is too low. */
  private clearance(ground: (x: number, z: number) => number): number {
    const eye = this.position();
    return eye.y - ground(eye.x, eye.z) - CAMERA_CLEARANCE;
  }

  /**
   * Raises the pitch to the least that clears the ground, or to the limit if nothing does. The
   * eye moves toward being over the target as it rises, so the ground under it changes with the
   * pitch: the first pitch found by stepping up is narrowed by halving the step back down.
   */
  private raisePitch(ground: (x: number, z: number) => number): void {
    const [, maxPitch] = this.limits.pitch;
    const start = this.pitch;
    let low = start;
    let high = start;
    while (high < maxPitch) {
      low = high;
      high = Math.min(maxPitch, high + PITCH_STEP);
      this.pitch = high;
      if (this.clearance(ground) >= 0) break;
    }
    if (this.clearance(ground) < 0) return; // at the limit and still too low: the distance is next
    for (let i = 0; i < PITCH_REFINEMENTS; i++) {
      const mid = (low + high) / 2;
      this.pitch = mid;
      if (this.clearance(ground) >= 0) high = mid;
      else low = mid;
    }
    this.pitch = high;
  }

  /** Pulls the camera back until, at this pitch, the eye clears the ground under it. */
  private raiseDistance(ground: (x: number, z: number) => number): void {
    const lift = Math.sin(this.pitch);
    for (let pass = 0; pass < DISTANCE_PASSES && this.clearance(ground) < 0; pass++) {
      const eye = this.position();
      const wanted = ground(eye.x, eye.z) + CAMERA_CLEARANCE - this.target.y;
      this.distance = Math.max(this.distance, wanted / lift);
    }
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

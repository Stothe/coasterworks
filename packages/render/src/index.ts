export { CAMERA_CLEARANCE, CameraRig } from "./camera.js";
export type { CameraLike } from "./camera.js";
export { groundHeightAt } from "./ground.js";
export { attachControls } from "./input.js";
export type { ControlHandlers, ControlOptions, PickedTile } from "./input.js";
export { SURFACE_COLORS, WATER_COLOR, srgbToLinear, surfaceColor } from "./palette.js";
export type { Rgb } from "./palette.js";
export { pickTile, rayFromCamera } from "./picker.js";
export type { Ray, TileHit } from "./picker.js";
export { createScene } from "./scene.js";
export type { SceneHandle, SceneOptions } from "./scene.js";
export { sunFor } from "./sky.js";
export type { SunState } from "./sky.js";
export {
  buildChunkGeometry,
  buildWaterGeometry,
  chunkCount,
  tileTriangles,
} from "./terrain-geometry.js";
export type { ChunkGeometry, TerrainData } from "./terrain-geometry.js";
export { CHUNK, HEIGHT_STEP, WATER_LIFT, tileToWorld } from "./units.js";
export type { V3 } from "./units.js";

import { MeshStandardMaterial } from "three";

/**
 * The materials every ride and stall is drawn with, shared by all of them: one soft, matte,
 * vertex-colored standard material (the models carry their paint in their vertex colors), and
 * the two see-through ones of the placement ghost, tinted green where the ride may go and red
 * where it may not.
 */
export interface RideMaterials {
  lit: MeshStandardMaterial;
  ghostOk: MeshStandardMaterial;
  ghostBad: MeshStandardMaterial;
  dispose(): void;
}

function ghost(tint: number, glow: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    vertexColors: true,
    color: tint,
    emissive: glow,
    emissiveIntensity: 0.55,
    roughness: 0.8,
    metalness: 0,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
}

export function createRideMaterials(): RideMaterials {
  const lit = new MeshStandardMaterial({ vertexColors: true, roughness: 0.66, metalness: 0 });
  const ghostOk = ghost(0xb4f5b8, 0x1f8a3a);
  const ghostBad = ghost(0xf5b0a8, 0xa02a20);
  return {
    lit,
    ghostOk,
    ghostBad,
    dispose() {
      lit.dispose();
      ghostOk.dispose();
      ghostBad.dispose();
    },
  };
}

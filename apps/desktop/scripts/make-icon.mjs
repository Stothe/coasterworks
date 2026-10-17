// Draws the app icon: a rounded orange square with a white ring (a loop of track) and a dot (the
// car on it), as a 1024x1024 PNG at assets/icon.png. `pnpm tauri icon assets/icon.png` then
// produces everything in src-tauri/icons from it. There is no image library here: the pixels are
// shaded with signed-distance functions and the PNG is written with node:zlib.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/icon.png");

const ORANGE = [0xf5, 0x9e, 0x0b];
const WHITE = [0xff, 0xff, 0xff];

// Signed distances in pixels: negative inside the shape.
const roundedSquare = (x, y, half, radius) => {
  const qx = Math.abs(x - SIZE / 2) - (half - radius);
  const qy = Math.abs(y - SIZE / 2) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
};
const disc = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const ring = (x, y, r, thickness) =>
  Math.abs(Math.hypot(x - SIZE / 2, y - SIZE / 2) - r) - thickness / 2;

/** How much of a pixel a shape covers, from its distance at the pixel centre (1px anti-aliasing). */
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;
    const square = coverage(roundedSquare(px, py, 448, 200));
    const glyph = Math.max(
      coverage(ring(px, py, 262, 76)),
      // The car, a quarter of the way round the loop from the top.
      coverage(disc(px, py, SIZE / 2 + 262 * Math.SQRT1_2, SIZE / 2 - 262 * Math.SQRT1_2, 70)),
    );
    const at = row + 1 + x * 4;
    for (let c = 0; c < 3; c++)
      raw[at + c] = Math.round(ORANGE[c] * (1 - glyph) + WHITE[c] * glyph);
    raw[at + 3] = Math.round(255 * square);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // colour type: RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);

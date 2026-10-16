/**
 * FNV-1a 64-bit hashing. BigInt keeps the 64-bit arithmetic exact on every platform.
 *
 * This is for fingerprinting and stream derivation, not for security.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * Hashes `bytes` with FNV-1a 64. `seed` is the initial hash state and defaults to the FNV offset
 * basis, so passing a previous result as `seed` continues that hash over more bytes.
 */
export function fnv1a64(bytes: Uint8Array, seed: bigint = FNV_OFFSET_BASIS): bigint {
  let hash = BigInt.asUintN(64, seed);
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i] as number);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/**
 * Encodes a string as UTF-8, matching what `TextEncoder` produces (lone surrogates become
 * U+FFFD). Written by hand because `src` is compiled without Node or DOM globals.
 */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let codePoint = text.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** FNV-1a 64 of the UTF-8 encoding of `s`. */
export function hashString(s: string): bigint {
  return fnv1a64(utf8Bytes(s));
}

/** Formats a 64-bit hash as exactly 16 lowercase hex characters. Throws if `h` is not a uint64. */
export function hexHash(h: bigint): string {
  if (h < 0n || h > MASK_64) {
    throw new RangeError(`hexHash expects a 64-bit unsigned value, got ${h}`);
  }
  return h.toString(16).padStart(16, "0");
}

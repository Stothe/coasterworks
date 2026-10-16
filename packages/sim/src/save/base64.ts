import { CORRUPT_MESSAGE, SaveError } from "./error.js";

/**
 * Standard base64 (RFC 4648 section 4) with `=` padding. Written by hand because `src` is compiled
 * without Node or DOM globals, so there is no `Buffer`, `btoa`, or `atob`.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Value of each ASCII character in the alphabet, or -1. Anything above 127 is invalid. */
const DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  const whole = bytes.length - (bytes.length % 3);
  for (let i = 0; i < whole; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      ALPHABET.charAt(n >> 18) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - whole;
  if (rest === 1) {
    const n = (bytes[whole] as number) << 16;
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63) + "==";
  } else if (rest === 2) {
    const n = ((bytes[whole] as number) << 16) | ((bytes[whole + 1] as number) << 8);
    out +=
      ALPHABET.charAt(n >> 18) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      "=";
  }
  return out;
}

function invalid(why: string): SaveError {
  return new SaveError(`${CORRUPT_MESSAGE}: invalid base64 (${why})`);
}

/** Decodes padded standard base64. Throws `SaveError` on any other input. */
export function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw invalid("length is not a multiple of 4");
  if (text.length === 0) return new Uint8Array(0);

  let padding = 0;
  if (text.charAt(text.length - 1) === "=") padding = text.charAt(text.length - 2) === "=" ? 2 : 1;
  const dataLength = text.length - padding;

  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const at = i + j;
      let value = 0;
      if (at < dataLength) {
        const code = text.charCodeAt(at);
        value = code < 128 ? (DECODE[code] as number) : -1;
        if (value < 0) throw invalid(`bad character at ${at}`);
      }
      n = (n << 6) | value;
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

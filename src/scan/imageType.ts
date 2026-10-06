import type { SCAN_MIME_TYPES } from "../schema.js";

/**
 * The media type a base64 image really is, judged by its first bytes (magic numbers), or null when it is
 * none of the accepted formats. Only the first 24 base64 characters (18 bytes) are decoded.
 */
export function detectImageType(base64: string): (typeof SCAN_MIME_TYPES)[number] | null {
  const head = Buffer.from(base64.slice(0, 24), "base64");

  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";

  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length >= 8 && png.every((byte, i) => head[i] === byte)) return "image/png";

  if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

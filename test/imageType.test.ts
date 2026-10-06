import { describe, expect, it } from "vitest";
import { detectImageType } from "../src/scan/imageType.js";

const b64 = (bytes: number[], pad = 40) => Buffer.from([...bytes, ...new Array(pad).fill(0x41)]).toString("base64");
const ascii = (text: string) => [...Buffer.from(text, "ascii")];

describe("detectImageType", () => {
  it("recognises JPEG, PNG and WebP by their first bytes", () => {
    expect(detectImageType(b64([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageType(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(detectImageType(b64([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP")]))).toBe("image/webp");
  });

  it("rejects other formats and non-images", () => {
    expect(detectImageType(b64(ascii("GIF89a")))).toBeNull();
    expect(detectImageType(b64(ascii("%PDF-1.7")))).toBeNull();
    expect(detectImageType(b64([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")]))).toBeNull(); // RIFF but not WebP
    expect(detectImageType(b64(ascii("<html><script>")))).toBeNull();
    expect(detectImageType(b64([0x00, 0x01, 0x02]))).toBeNull();
  });

  it("copes with empty and tiny input", () => {
    expect(detectImageType("")).toBeNull();
    expect(detectImageType("/9j/")).toBe("image/jpeg"); // exactly FF D8 FF
    expect(detectImageType("AAAA")).toBeNull();
  });

  it("only looks at the beginning, so a huge payload is as cheap as a small one", () => {
    const huge = b64([0xff, 0xd8, 0xff], 1_000_000);
    const started = performance.now();

    expect(detectImageType(huge)).toBe("image/jpeg");
    expect(performance.now() - started).toBeLessThan(25);
  });
});

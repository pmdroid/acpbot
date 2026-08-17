import { describe, expect, test } from "bun:test";
import {
  annotateCrosshair,
  decodeJpeg,
  encodeJpeg,
} from "../src/computer/annotate";

function solidJpeg(
  width: number,
  height: number,
  rgb: [number, number, number],
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return encodeJpeg({ data, width, height }, 90);
}

function pixelAt(
  img: { width: number; data: Uint8Array },
  x: number,
  y: number,
): [number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

describe("annotateCrosshair", () => {
  test("fixture JPEG gets a non-zero annotation at (x,y)", () => {
    const x = 20;
    const y = 16;
    const fixture = solidJpeg(64, 48, [0, 0, 180]);
    const marked = annotateCrosshair(fixture, x, y, { quality: 90, arm: 6 });
    expect(marked.byteLength).toBeGreaterThan(0);
    expect(marked[0]).toBe(0xff);
    expect(marked[1]).toBe(0xd8);

    const before = decodeJpeg(fixture);
    const after = decodeJpeg(marked);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);

    const [br, bg, bb] = pixelAt(before, x, y);
    const [ar, ag, ab] = pixelAt(after, x, y);
    const delta = Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb);
    expect(delta).toBeGreaterThan(0);
    // Crosshair is red — the marked pixel should move toward red.
    expect(ar).toBeGreaterThan(br);
  });
});

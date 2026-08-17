/**
 * In-process JPEG annotate / downsample. Pure JS so the host binary
 * needs no native image addon and no sips/screencapture.
 *
 * Static import so `bun build --compile` traces jpeg-js (a createRequire
 * would be invisible to the bundler and drop click annotations in release).
 */
import jpeg from "jpeg-js";

export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

export function decodeJpeg(bytes: Uint8Array): RgbaImage {
  const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return {
    width: decoded.width,
    height: decoded.height,
    data: decoded.data,
  };
}

export function encodeJpeg(img: RgbaImage, quality = 60): Uint8Array {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const encoded = jpeg.encode(
    { data: img.data, width: img.width, height: img.height },
    q,
  );
  return new Uint8Array(encoded.data);
}

/** Read SOF dimensions without a full decode. */
export function jpegDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 3 >= bytes.length) return null;
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    // SOF0 / SOF1 / SOF2
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (i + 8 >= bytes.length) return null;
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
      if (width < 1 || height < 1) return null;
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}

export function downsampleToMaxEdge(
  bytes: Uint8Array,
  maxEdgePx: number,
  quality = 60,
): { jpeg: Uint8Array; width: number; height: number } {
  const maxEdge = Math.max(1, Math.round(maxEdgePx));
  const header = jpegDimensions(bytes);
  if (header && Math.max(header.width, header.height) <= maxEdge) {
    return { jpeg: bytes, width: header.width, height: header.height };
  }
  const img = decodeJpeg(bytes);
  const srcMax = Math.max(img.width, img.height);
  if (srcMax <= maxEdge) {
    return { jpeg: bytes, width: img.width, height: img.height };
  }
  const scale = maxEdge / srcMax;
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const resized = nearestNeighbor(img, width, height);
  return { jpeg: encodeJpeg(resized, quality), width, height };
}

/**
 * Draw a small crosshair on a *copy* of the JPEG. Agent geometry stays
 * on the unannotated buffer; Telegram gets this same-dimension copy.
 */
export function annotateCrosshair(
  bytes: Uint8Array,
  x: number,
  y: number,
  opts?: { arm?: number; quality?: number },
): Uint8Array {
  const img = decodeJpeg(bytes);
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) {
    return bytes;
  }
  const arm = opts?.arm ?? 8;
  const data = img.data.slice();
  // Saturated red so the mark survives JPEG quantization.
  const color: [number, number, number] = [255, 0, 0];
  for (let dx = -arm; dx <= arm; dx++) {
    setRgb(data, img.width, img.height, px + dx, py, color);
    setRgb(data, img.width, img.height, px + dx, py + 1, color);
  }
  for (let dy = -arm; dy <= arm; dy++) {
    setRgb(data, img.width, img.height, px, py + dy, color);
    setRgb(data, img.width, img.height, px + 1, py + dy, color);
  }
  return encodeJpeg(
    { data, width: img.width, height: img.height },
    opts?.quality ?? 60,
  );
}

function nearestNeighbor(src: RgbaImage, width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y + 0.5) * src.height / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x + 0.5) * src.width / width));
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      data[di] = src.data[si]!;
      data[di + 1] = src.data[si + 1]!;
      data[di + 2] = src.data[si + 2]!;
      data[di + 3] = src.data[si + 3]!;
    }
  }
  return { data, width, height };
}

function setRgb(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  color: [number, number, number],
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  data[i] = color[0];
  data[i + 1] = color[1];
  data[i + 2] = color[2];
  data[i + 3] = 255;
}

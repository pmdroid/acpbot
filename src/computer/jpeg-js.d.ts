declare module "jpeg-js" {
  export function decode(
    data: Buffer | Uint8Array,
    opts?: { useTArray?: boolean; formatAsRGBA?: boolean },
  ): { width: number; height: number; data: Uint8Array };
  export function encode(
    imgData: { data: Buffer | Uint8Array; width: number; height: number },
    quality?: number,
  ): { data: Buffer; width: number; height: number };
  const jpeg: { decode: typeof decode; encode: typeof encode };
  export default jpeg;
}

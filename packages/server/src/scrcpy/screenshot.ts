import type { Adb } from "@yume-chan/adb";
import { deflateSync } from "node:zlib";

const THUMB_WIDTH = 160;

/**
 * Encode a thumbnail from a frame someone already captured.
 *
 * A running script screencaps every poll, and the thumbnail cache was
 * screencapping the same device on its own timer — two ~8 MB transfers for the
 * same picture. Handing the script's frame here removes the second one, and the
 * thumbnail becomes as fresh as whatever the script is doing.
 */
export function thumbnailFromFrame(frame: { width: number; height: number; pixels: Uint8Array }): Buffer {
  const targetW = Math.min(THUMB_WIDTH, frame.width);
  const targetH = Math.max(1, Math.round((frame.height * targetW) / frame.width));
  return encodePng(targetW, targetH, downscale(frame.pixels, frame.width, frame.height, targetW, targetH));
}

/**
 * Area-average downscale, RGBA source -> RGB output (screenshots are opaque, so
 * the alpha channel is dead weight; dropping it shrinks the PNG ~25%+).
 */
function downscale(src: Uint8Array, sw: number, sh: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th * 3);
  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor((ty * sh) / th);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * sh) / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor((tx * sw) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * sw) / tw));
      let r = 0, g = 0, b = 0, count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let idx = (sy * sw + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          r += src[idx]!;
          g += src[idx + 1]!;
          b += src[idx + 2]!;
          idx += 4;
          count++;
        }
      }
      const o = (ty * tw + tx) * 3;
      out[o] = (r / count) | 0;
      out[o + 1] = (g / count) | 0;
      out[o + 2] = (b / count) | 0;
    }
  }
  return out;
}

// --- Minimal PNG encoder (RGBA, no external deps) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB (no alpha)
  const stride = width * 3;
  // Per-scanline "up" filter (2) — adjacent rows are similar, so this cuts the
  // deflated size noticeably versus no filtering on photographic wallpapers.
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 2; // filter: Up
    for (let x = 0; x < stride; x++) {
      const cur = rgb[y * stride + x]!;
      const above = y > 0 ? rgb[(y - 1) * stride + x]! : 0;
      raw[rowStart + 1 + x] = (cur - above) & 0xff;
    }
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Full-resolution PNG of the device screen, encoded on the device itself
 * (`screencap -p`). Used by the script editor's pickers, where the tiny
 * thumbnail above would be useless.
 */
export async function captureScreenshot(adb: Adb): Promise<Buffer> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell?.isSupported) throw new Error("shell protocol unavailable");
  const { stdout, exitCode } = await shell.spawnWait("screencap -p");
  if (exitCode !== 0 || stdout.byteLength < 8) throw new Error("screencap failed");
  return Buffer.from(stdout);
}

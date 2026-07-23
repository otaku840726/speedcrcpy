// Generates public/icon-192.png and public/icon-512.png without any native
// dependencies: draws a rounded-square background with a phone outline and
// encodes the RGBA buffer as PNG by hand (zlib is built into Node).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BG = [16, 20, 24, 255];
const CARD = [26, 32, 39, 255];
const ACCENT = [77, 163, 255, 255];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // Raw scanlines with filter byte 0.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function inRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x >= right || y < top || y >= bottom) return false;
  const cx = Math.max(left + radius, Math.min(right - radius, x));
  const cy = Math.max(top + radius, Math.min(bottom - radius, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 || (x >= left + radius && x < right - radius) || (y >= top + radius && y < bottom - radius);
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const u = size / 512;

  // Phone body / screen / speed chevrons, all in 512-space units.
  const phone = { left: 176, top: 96, width: 160, height: 320, radius: 28 };
  const screen = { left: 196, top: 128, width: 120, height: 240, radius: 8 };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x / u;
      const sy = y / u;
      let color = BG;
      if (!inRoundedRect(sx, sy, 16, 16, 480, 480, 96)) {
        color = [0, 0, 0, 0];
      } else if (inRoundedRect(sx, sy, screen.left, screen.top, screen.width, screen.height, screen.radius)) {
        color = ACCENT;
      } else if (inRoundedRect(sx, sy, phone.left, phone.top, phone.width, phone.height, phone.radius)) {
        color = CARD;
      } else {
        // Speed chevrons to the left of the phone.
        for (let i = 0; i < 3; i++) {
          const cx = 96 + i * 4;
          const cy = 256;
          const offset = i * 36;
          const dx = sx - (cx - offset);
          const dy = Math.abs(sy - cy);
          if (dx > -14 && dx < 14 && dy < 80 - Math.abs(dx) * 0 && Math.abs(dx + dy * 0.45 - 30) < 12 && dy < 90) {
            color = i === 0 ? ACCENT : CARD;
          }
        }
      }
      const idx = (y * size + x) * 4;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
      pixels[idx + 3] = color[3];
    }
  }
  return encodePng(size, pixels);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "../public");
mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), drawIcon(size));
  console.log(`wrote public/icon-${size}.png`);
}

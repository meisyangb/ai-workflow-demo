// scripts/gen-tauri-icons.mjs
// 生成 Tauri 所需最小合法图标（基于 favicon 主色 #863bff）。
// 零第三方依赖，仅依赖 Node 内置 zlib/crypto/Buffer/fs。
// 产物：src-tauri/icons/{32x32,128x128,128x128@2x,256x256,512x512,icon}.png + icon.ico + icon.icns
// icon.ico 用 BMP-within-ICO 的最小实现。icon.icns 用 ic08 (256) / ic09 (512) 条目。
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICON_DIR = resolve(__dirname, '..', 'src-tauri', 'icons');
if (!existsSync(ICON_DIR)) mkdirSync(ICON_DIR, { recursive: true });

const PRIMARY = [0x86, 0x3b, 0xff]; // purple matches favicon
const SECONDARY = [0x47, 0xbf, 0xff]; // accent cyan

// ── PNG helpers ──────────────────────────────────────────────────────────
function crc32(buf) {
  // CRC32 polynomial IEEE
  let c;
  const table = (crc32.table ||= (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([tBuf, data])), 0);
  return Buffer.concat([len, tBuf, data, crcBuf]);
}

function makePng(size, pixelFn) {
  const w = size, h = size;
  const raw = Buffer.alloc(h * (1 + w * 4)); // filter byte 0 per scanline
  for (let y = 0; y < h; y++) {
    let p = y * (1 + w * 4);
    raw[p++] = 0; // filter
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = pixelFn(x, y, w, h);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace none
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// draw a rounded-cornered block mimicking favicon palette (purple primary + cyan corner accent)
function paint(x, y, w, h) {
  const cx = w / 2, cy = h / 2;
  // rounded rect mask: corner radius 18%
  const r = Math.round(w * 0.18);
  function insideRounded(px, py) {
    const left = r, right = w - r, top = r, bot = h - r;
    if (px < left && py < top) return Math.hypot(px - left, py - top) <= r;
    if (px >= right && py < top) return Math.hypot(px - right + 1, py - top) <= r;
    if (px < left && py >= bot) return Math.hypot(px - left, py - bot + 1) <= r;
    if (px >= right && py >= bot) return Math.hypot(px - right + 1, py - bot + 1) <= r;
    return true;
  }
  if (!insideRounded(x, y)) return [0, 0, 0, 0];
  // diagonal gradient purple → darker purple
  const t = (x + y) / (w + h);
  const rr = Math.round(PRIMARY[0] * (1 - t * 0.35) + 0x4e * t * 0.35);
  const gg = Math.round(PRIMARY[1] * (1 - t * 0.35) + 0x0c * t * 0.35);
  const bb = Math.round(PRIMARY[2]);
  // cyan corner accent top-right ~18% radius
  if (Math.hypot(x - (w - Math.round(w * 0.28)), y - Math.round(h * 0.28)) < w * 0.14) {
    return [
      Math.round(rr * 0.35 + SECONDARY[0] * 0.65),
      Math.round(gg * 0.15 + SECONDARY[1] * 0.85),
      Math.round(bb * 0.10 + SECONDARY[2] * 0.90),
      255,
    ];
  }
  return [rr, gg, bb, 255];
}

for (const size of [32, 128, 256, 512]) {
  const png = makePng(size, (x, y, w, h) => paint(x, y, w, h));
  const name = `${size}x${size}.png`;
  writeFileSync(resolve(ICON_DIR, name), png);
  console.log(`wrote ${name} (${png.length} bytes)`);
}
// 128x128@2x.png = 256x256
const p256 = readPng(256);
writeFileSync(resolve(ICON_DIR, '128x128@2x.png'), p256);
console.log('wrote 128x128@2x.png');

function readPng(size) {
  return makePng(size, (x, y, w, h) => paint(x, y, w, h));
}

// ── ICO (32, 128, 256) as BMP-with-PNG or BMP; use BMP for XP compat with 32 and 128, 256 also BMP ──
// For simplicity use BMP (BITMAPINFOHEADER) uncompressed. ICO = ICONDIR + ICONDIRENTRY[] + images.
function makeIco(sizes) {
  const entries = [];
  let dataOffset = 6 + 16 * sizes.length;
  const imageBufs = [];
  for (const s of sizes) {
    const bmp = makeBmp(s, s, (x, y) => paint(x, y, s, s));
    entries.push({ w: s === 256 ? 0 : s, h: s === 256 ? 0 : s, colors: 0, reserved: 0, planes: 1, bitCount: 32, bytes: bmp.length, offset: dataOffset });
    dataOffset += bmp.length;
    imageBufs.push(bmp);
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(sizes.length, 4); // count
  const dir = Buffer.alloc(16 * sizes.length);
  sizes.forEach((_, i) => {
    const e = entries[i], o = i * 16;
    dir.writeUInt8(e.w, o);
    dir.writeUInt8(e.h, o + 1);
    dir.writeUInt8(e.colors, o + 2);
    dir.writeUInt8(e.reserved, o + 3);
    dir.writeUInt16LE(e.planes, o + 4);
    dir.writeUInt16LE(e.bitCount, o + 6);
    dir.writeUInt32LE(e.bytes, o + 8);
    dir.writeUInt32LE(e.offset, o + 12);
  });
  return Buffer.concat([header, dir, ...imageBufs]);
}

// BITMAPINFOHEADER + XOR mask pixels (bottom-up) + AND mask (1-bit transparency, rows aligned to 4 bytes).
function makeBmp(w, h, pixelFn) {
  const bpp = 4;
  const strideXor = Math.ceil((w * bpp) / 4) * 4;
  // AND mask bits per row = ceil(w/8) padded to 4-byte multiple
  const andRowBytes = Math.ceil(Math.ceil(w / 8) / 4) * 4;
  const xorSize = strideXor * h;
  const andSize = andRowBytes * h;
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0); // size
  info.writeInt32LE(w, 4);
  info.writeInt32LE(h * 2, 8); // height*2 because AND mask counted in "h" for ICO BMP
  info.writeUInt16LE(1, 12);   // planes
  info.writeUInt16LE(32, 14);  // bitCount
  info.writeUInt32LE(0, 16);   // compression BI_RGB
  info.writeUInt32LE(xorSize + andSize, 20); // sizeImage
  info.writeInt32LE(0, 24);    // XPelsPerMeter
  info.writeInt32LE(0, 28);    // YPelsPerMeter
  info.writeUInt32LE(0, 32);   // clrUsed
  info.writeUInt32LE(0, 36);   // clrImportant
  const xor = Buffer.alloc(xorSize, 0);
  const and = Buffer.alloc(andSize, 0);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y; // bottom-up
    const xorRow = y * strideXor;
    const andRow = y * andRowBytes;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixelFn(x, srcY, w, h);
      const xp = xorRow + x * 4;
      xor[xp] = b; xor[xp + 1] = g; xor[xp + 2] = r; xor[xp + 3] = a;
      if (a < 128) {
        // set bit in AND mask: bit 7 = leftmost pixel
        const byteIdx = andRow + (x >> 3);
        and[byteIdx] |= 0x80 >>> (x & 7);
      }
    }
  }
  // file header not needed; ICO stores DIB (info + pixels) directly
  return Buffer.concat([info, xor, and]);
}

const ico = makeIco([32, 128, 256]);
writeFileSync(resolve(ICON_DIR, 'icon.ico'), ico);
console.log(`wrote icon.ico (${ico.length} bytes)`);

// ── ICNS (icon.icns) with entries: ic08 = 256, ic09 = 512 ─────────────
function makeIcns(entries) {
  // entry = [type (4-char), size int, buf]
  const totalLen = 8 + entries.reduce((s, e) => s + 8 + e[2].length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(totalLen, 4);
  const chunks = [head];
  for (const [type, , buf] of entries) {
    const hdr = Buffer.alloc(8);
    hdr.write(type, 0, 'ascii');
    hdr.writeUInt32BE(8 + buf.length, 4);
    chunks.push(hdr, buf);
  }
  return Buffer.concat(chunks);
}
const icns = makeIcns([
  ['ic08', 256, readPng(256)],
  ['ic09', 512, readPng(512)],
]);
writeFileSync(resolve(ICON_DIR, 'icon.icns'), icns);
console.log(`wrote icon.icns (${icns.length} bytes)`);

// Final: write a 512→1024 placeholder PNG for Tauri's optional 1024x1024 usage (we don't reference it in conf, but helps later)
const big = makePng(1024, (x, y, w, h) => paint(x, y, w, h));
writeFileSync(resolve(ICON_DIR, '1024x1024.png'), big);
console.log(`wrote 1024x1024.png (${big.length} bytes)`);

// Integrity line (so file content shows deterministic)
const md5 = createHash('md5').update(Buffer.concat([readPng(32), ico, icns])).digest('hex');
console.log('integrity md5(32+ico+icns) =', md5);

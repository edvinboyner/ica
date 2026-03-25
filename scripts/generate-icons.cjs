#!/usr/bin/env node
// Generates icon16.png, icon48.png, icon128.png using only Node built-ins.
// Design: ICA-green rounded square with a white price-comparison bar chart.

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

// ── CRC32 ────────────────────────────────────────────────────────────────────
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[i] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── PNG encoding ─────────────────────────────────────────────────────────────
function mkChunk(type, data) {
  const t = Buffer.from(type);
  const l = Buffer.alloc(4);
  l.writeUInt32BE(data.length);
  const cBuf = Buffer.alloc(4);
  cBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([l, t, data, cBuf]);
}

function encodePNG(W, H, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // Build raw scanlines (filter byte 0 = None per row)
  const raw = Buffer.alloc((1 + W * 4) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      const di = y * (W * 4 + 1) + 1 + x * 4;
      raw[di] = rgba[si];
      raw[di + 1] = rgba[si + 1];
      raw[di + 2] = rgba[si + 2];
      raw[di + 3] = rgba[si + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    mkChunk("IHDR", ihdr),
    mkChunk("IDAT", idat),
    mkChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Pixel drawing helpers ─────────────────────────────────────────────────────
function makeCanvas(W, H) {
  const px = new Uint8Array(W * H * 4); // all transparent

  function blend(x, y, r, g, b, a) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    const sa = a / 255,
      da = px[i + 3] / 255,
      oa = sa + da * (1 - sa);
    if (oa > 0) {
      px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
      px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
      px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
      px[i + 3] = Math.round(oa * 255);
    }
  }

  function fillRect(x1, y1, x2, y2, r, g, b, a = 255) {
    for (let y = Math.max(0, y1); y < Math.min(H, y2); y++)
      for (let x = Math.max(0, x1); x < Math.min(W, x2); x++)
        blend(x, y, r, g, b, a);
  }

  // Rounded rectangle — smooth edge via distance field
  function roundedRect(x1, y1, x2, y2, radius, r, g, b) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const cx = Math.max(x1 + radius, Math.min(x2 - radius, x));
        const cy = Math.max(y1 + radius, Math.min(y2 - radius, y));
        const dx = x - cx, dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= radius + 0.5) {
          // inside or on edge
          const aa = Math.min(255, Math.round((radius + 0.5 - dist) * 255));
          blend(x, y, r, g, b, aa);
        }
      }
    }
  }

  return { px, blend, fillRect, roundedRect };
}

// ── Icon drawing ──────────────────────────────────────────────────────────────
function drawIcon(size) {
  const { px, fillRect, roundedRect } = makeCanvas(size, size);

  // Scale helper: map from 128-px design space
  const s = (n) => Math.max(1, Math.round((n * size) / 128));

  // Background — ICA green rounded square
  const pad = s(4);
  const rad = s(20);
  roundedRect(pad, pad, size - pad, size - pad, rad, 26, 92, 46);

  // ── Bar chart design ──────────────────────────────────────────────────────
  // Three bars representing price comparison across stores,
  // getting shorter (= cheaper) from left to right, with checkmark on last.

  const barW = s(18);
  const gap = s(12);
  const bottom = size - s(22);
  const maxH = s(64);

  const bars = [
    { h: maxH, offset: 0 }, // tallest (expensive)
    { h: s(50), offset: 1 }, // mid
    { h: s(36), offset: 2 }, // shortest (cheapest) — has checkmark
  ];

  for (const { h, offset } of bars) {
    const x = s(20) + offset * (barW + gap);
    const y = bottom - h;
    // Rounded top (2px radius)
    const rTop = Math.min(s(4), Math.floor(barW / 2));
    // Draw bar body
    fillRect(x, y + rTop, x + barW, bottom, 255, 255, 255);
    // Rounded top cap
    for (let dy = 0; dy < rTop; dy++) {
      const halfW = Math.round(
        (barW / 2) * (1 - Math.pow((rTop - dy) / rTop, 2))
      );
      const cx = x + barW / 2;
      fillRect(
        cx - halfW,
        y + dy,
        cx + halfW,
        y + dy + 1,
        255,
        255,
        255
      );
    }
  }

  // Checkmark below the shortest (rightmost) bar
  const ckX = s(20) + 2 * (barW + gap);
  const ckY = bottom + s(5);
  const ckSz = s(12);
  if (ckSz >= 3) {
    // Two strokes of the checkmark
    const thick = Math.max(1, s(3));
    // Short left stroke (going down-right)
    for (let i = 0; i < Math.round(ckSz * 0.4); i++) {
      fillRect(
        ckX + i,
        ckY + i,
        ckX + i + thick,
        ckY + i + thick,
        255,
        255,
        255
      );
    }
    // Long right stroke (going up-right from the bottom of short stroke)
    const jx = ckX + Math.round(ckSz * 0.4);
    const jy = ckY + Math.round(ckSz * 0.4);
    for (let i = 0; i < Math.round(ckSz * 0.7); i++) {
      fillRect(
        jx + i,
        jy - i,
        jx + i + thick,
        jy - i + thick,
        255,
        255,
        255
      );
    }
  }

  return px;
}

// ── Generate all sizes ────────────────────────────────────────────────────────
const outDir = path.join(__dirname, "..", "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const rgba = drawIcon(size);
  const png = encodePNG(size, size, rgba);
  const out = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`✓ icon${size}.png (${png.length} bytes)`);
}

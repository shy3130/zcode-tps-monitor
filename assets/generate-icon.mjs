#!/usr/bin/env node
// 生成插件图标 assets/icon.png(256×256,4× 超采样抗锯齿)。
// 纯 Node 实现,无依赖:用 SDF(有向距离场)画形状,zlib 编码 PNG。
// 用法:node assets/generate-icon.mjs [输出路径] [尺寸]
//   node assets/generate-icon.mjs                # assets/icon.png 256px
//   node assets/generate-icon.mjs preview 32     # 预览小尺寸(检验 16~32px 可辨识度)

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";

const OUT = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : path.join(path.dirname(url.fileURLToPath(import.meta.url)), "icon.png");
const SIZE = Number(process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : process.argv[3]) || 256;
const SS = 4; // 超采样倍数
const W = SIZE * SS;

// ---------- 基础 SDF ----------
const sdRoundedRect = (px, py, cx, cy, hx, hy, r) => {
  const dx = Math.abs(px - cx) - (hx - r), dy = Math.abs(py - cy) - (hy - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
};
const sdSegment = (px, py, ax, ay, bx, by, r) => {
  const abx = bx - ax, aby = by - ay, apx = px - ax, apy = py - ay;
  const t = Math.min(1, Math.max(0, (apx * abx + apy * aby) / (abx * abx + aby * aby)));
  return Math.hypot(apx - abx * t, apy - aby * t) - r;
};
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;
// ---------- 场景参数(以 256 坐标系描述) ----------
const S = W / 256;
const BG_TOP = [31, 54, 69];
const BG_BOTTOM = [11, 27, 37];
const EDGE = [62, 91, 104];
const MINT = [121, 253, 196];
const PEARL = [225, 255, 243];
const PULSE = [[50, 150], [85, 150], [110, 94], [141, 168], [168, 116], [206, 116]];
const mix = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);
const coverageOf = (distance) => Math.min(1, Math.max(0, 0.5 - distance * S));

function coverage(px, py) {
  const x = px / S, y = py / S;
  const tile = sdRoundedRect(x, y, 128, 128, 118, 118, 52);
  const gradient = (x * 0.35 + y * 0.65) / 256;
  let color = mix(BG_TOP, BG_BOTTOM, gradient);
  const border = coverageOf(Math.abs(tile + 2) - 1.5);
  color = mix(color, EDGE, border * 0.65);

  let pulse = Infinity;
  for (let i = 1; i < PULSE.length; i++) {
    pulse = Math.min(pulse, sdSegment(x, y, ...PULSE[i - 1], ...PULSE[i], 9));
  }
  color = mix(color, MINT, coverageOf(pulse));
  color = mix(color, PEARL, coverageOf(sdCircle(x, y, ...PULSE.at(-1), 9)));
  return { col: color, a: coverageOf(tile) };
}

// ---------- 渲染 + 4× 盒式下采样 ----------
const px = new Float64Array(W * W * 3);
const al = new Float64Array(W * W);
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const { col, a } = coverage(x + 0.5, y + 0.5);
    const i = (y * W + x) * 3;
    px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2];
    al[y * W + x] = a;
  }
}
const n = SIZE, out = Buffer.alloc(n * n * 4);
for (let y = 0; y < n; y++) {
  for (let x = 0; x < n; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
      const si = ((y * SS + dy) * W + x * SS + dx) * 3, sa = al[(y * SS + dy) * W + x * SS + dx];
      r += px[si] * sa; g += px[si + 1] * sa; b += px[si + 2] * sa; a += sa;
    }
    const o = (y * n + x) * 4;
    out[o] = a ? Math.round(r / a) : 0;
    out[o + 1] = a ? Math.round(g / a) : 0;
    out[o + 2] = a ? Math.round(b / a) : 0;
    out[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

// ---------- PNG 编码 ----------
const crcTable = Array.from({ length: 256 }, (_, k) => {
  let c = k;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const raw = Buffer.alloc((n * 4 + 1) * n);
for (let y = 0; y < n; y++) {
  raw[y * (n * 4 + 1)] = 0;
  out.copy(raw, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(OUT, png);
console.log(`OK ${OUT} ${n}x${n} ${png.length} bytes`);

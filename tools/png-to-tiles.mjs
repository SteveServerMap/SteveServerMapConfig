#!/usr/bin/env node
/**
 * png-to-tiles.mjs —— 把一张整图 PNG 切成站点瓦片（XYZ + manifest）
 * =============================================================================
 * 适用场景：手里只有拼好的整张地图 PNG（没有 Xaero 导出原图 / 区域 zip），
 * 但知道它的世界画幅（左上角世界坐标 + 每方块像素数）。
 *
 * 用法：
 *   node tools/png-to-tiles.mjs <png> --x-min=-1024 --z-min=-1024 --scale=0.5 --out=.data/tiles/nether
 *
 * 参数：
 *   --x-min / --z-min   图片左上角对应的世界坐标（方块，整数）
 *   --scale             输出前先按比例缩放（如 0.5 = 2px/方块图降为 1px/方块，2×2 平均）
 *   --tile=256          瓦片尺寸（默认 256，与站点契约一致）
 *   --out=              输出目录（会被清空重建）
 *
 * 坐标语义与站点 assets/js/tiles.js 的 manifest 契约一致：
 *   - level 0 的 1 像素 = 1 方块；层级 L 的 1 像素 = 2^L 方块；
 *   - 所有层级的 originBlockX/Z 都等于 worldBlockRange 左上角；
 *   - worldBlockRange 会向外补齐到 tileSize 的整数倍，保证
 *     cols * tileSize = xMax - xMin（tiles.js 的一致性自检）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { encodePng } from './xaero-decode.mjs';

/* ------------------------------ PNG 解码（RGBA/RGB 8bit，非隔行） ------------------------------ */

export function decodePng(buf) {
  let p = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[i] = v;
    }
    cur.copy(px, y * stride);
    prev = cur;
  }
  if (channels === 4) return { width, height, rgba: px };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = px[i * 3];
    rgba[i * 4 + 1] = px[i * 3 + 1];
    rgba[i * 4 + 2] = px[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/* ------------------------------ 2×2 平均缩放 ------------------------------ */

export function downscale(src, factor) {
  const w = Math.max(1, Math.floor(src.width * factor));
  const h = Math.max(1, Math.floor(src.height * factor));
  const steps = Math.round(1 / factor);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let dy = 0; dy < steps; dy += 1) {
        for (let dx = 0; dx < steps; dx += 1) {
          const sy = y * steps + dy;
          const sx = x * steps + dx;
          if (sy >= src.height || sx >= src.width) continue;
          const si = (sy * src.width + sx) * 4;
          if (!src.rgba[si + 3]) continue;
          r += src.rgba[si];
          g += src.rgba[si + 1];
          b += src.rgba[si + 2];
          a += src.rgba[si + 3];
          n += 1;
        }
      }
      if (!n) continue;
      const di = (y * w + x) * 4;
      out[di] = Math.round(r / n);
      out[di + 1] = Math.round(g / n);
      out[di + 2] = Math.round(b / n);
      out[di + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, rgba: out };
}

/* ----------------------------------- 主流程 ----------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const opt = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const OUT = opt('out', '.data/tiles/png');
  const TILE = Math.max(64, Math.floor(Number(opt('tile', 256)) || 256));
  const SCALE = Number(opt('scale', 1));

  if (!target) {
    console.error('用法：node tools/png-to-tiles.mjs <png> --x-min=<n> --z-min=<n> [--scale=0.5] --out=<dir>');
    process.exit(2);
  }
  if (!(SCALE > 0) || !(SCALE <= 1)) {
    console.error('--scale 只支持 (0, 1]（放大切片不支持：level 0 必须 1 像素 ≤ 1 方块）');
    process.exit(2);
  }
  if (SCALE !== 1 && Math.abs(1 / SCALE - Math.round(1 / SCALE)) > 1e-9) {
    console.error('--scale 只支持 1/2^k（如 1、0.5、0.25），保证整数像素平均');
    process.exit(2);
  }
  const xMin = Number(opt('x-min', NaN));
  const zMin = Number(opt('z-min', NaN));
  if (!Number.isFinite(xMin) || !Number.isFinite(zMin)) {
    console.error('必须提供 --x-min 和 --z-min（图片左上角的世界坐标）');
    process.exit(2);
  }

  const png = decodePng(await fs.readFile(target));
console.log(`源图 ${png.width}×${png.height}，scale=${SCALE}，瓦片 ${TILE}px`);
let base = png;
if (SCALE !== 1) {
  base = downscale(png, SCALE);
  console.log(`缩放后 ${base.width}×${base.height}（1 像素 = 1 方块）`);
}

const cols = Math.ceil(base.width / TILE);
const rows = Math.ceil(base.height / TILE);
const outDir = path.resolve(OUT);
const tileDir = path.join(outDir, 'tiles');
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(path.join(tileDir, '0'), { recursive: true });

// level 0：按 TILE×TILE 网格直切（边缘不足一块的补透明）
const level0 = new Map();
for (let ty = 0; ty < rows; ty += 1) {
  for (let tx = 0; tx < cols; tx += 1) {
    const buf = Buffer.alloc(TILE * TILE * 4);
    let any = false;
    for (let y = 0; y < TILE; y += 1) {
      const sy = ty * TILE + y;
      if (sy >= base.height) break;
      for (let x = 0; x < TILE; x += 1) {
        const sx = tx * TILE + x;
        if (sx >= base.width) break;
        const si = (sy * base.width + sx) * 4;
        if (!base.rgba[si + 3]) continue;
        const di = (y * TILE + x) * 4;
        buf[di] = base.rgba[si];
        buf[di + 1] = base.rgba[si + 1];
        buf[di + 2] = base.rgba[si + 2];
        buf[di + 3] = base.rgba[si + 3];
        any = true;
      }
    }
    if (!any) continue;
    level0.set(`${tx}_${ty}`, buf);
  }
}
let written = 0;
for (const [key, buf] of level0) {
  const [tx, ty] = key.split('_').map(Number);
  await fs.writeFile(path.join(tileDir, '0', `${tx}_${ty}.png`), encodePng(TILE, TILE, buf));
  written += 1;
}

// 金字塔：瓦片网格逐层对半（每块 = 4 个子瓦片 2×2 平均，与 xaero-tiles.mjs 同一语义），
// 直到 1×1。站点 tiles.js 按层级网格索引取瓦片，网格必须是整数对半，不能按整图对半。
const levels = [
  { level: 0, minX: 0, maxX: cols - 1, minZ: 0, maxZ: rows - 1, cols, rows, blocksPerPixel: 1 },
];
let prev = { map: level0, cols, rows };
let level = 0;
while (prev.cols > 1 || prev.rows > 1) {
  level += 1;
  const c2 = Math.max(1, Math.ceil(prev.cols / 2));
  const r2 = Math.max(1, Math.ceil(prev.rows / 2));
  const half = TILE / 2;
  await fs.mkdir(path.join(tileDir, String(level)), { recursive: true });
  const map = new Map();
  for (let ty = 0; ty < r2; ty += 1) {
    for (let tx = 0; tx < c2; tx += 1) {
      const buf = Buffer.alloc(TILE * TILE * 4);
      let any = false;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const child = prev.map.get(`${tx * 2 + dx}_${ty * 2 + dy}`);
          if (!child) continue;
          for (let y = 0; y < half; y += 1) {
            for (let x = 0; x < half; x += 1) {
              let r = 0;
              let g = 0;
              let b = 0;
              let a = 0;
              let n = 0;
              for (let sy = 0; sy < 2; sy += 1) {
                for (let sx = 0; sx < 2; sx += 1) {
                  const si = ((y * 2 + sy) * TILE + x * 2 + sx) * 4;
                  if (!child[si + 3]) continue;
                  r += child[si];
                  g += child[si + 1];
                  b += child[si + 2];
                  a += child[si + 3];
                  n += 1;
                }
              }
              if (!n) continue;
              const di = ((dy * half + y) * TILE + dx * half + x) * 4;
              buf[di] = Math.round(r / n);
              buf[di + 1] = Math.round(g / n);
              buf[di + 2] = Math.round(b / n);
              buf[di + 3] = Math.round(a / n);
              any = true;
            }
          }
        }
      }
      if (!any) continue;
      map.set(`${tx}_${ty}`, buf);
      await fs.writeFile(path.join(tileDir, String(level), `${tx}_${ty}.png`), encodePng(TILE, TILE, buf));
    }
  }
  levels.push({
    level,
    minX: 0,
    maxX: c2 - 1,
    minZ: 0,
    maxZ: r2 - 1,
    cols: c2,
    rows: r2,
    blocksPerPixel: 2 ** level,
  });
  console.log(`level ${level}：${map.size} 块瓦片（${c2}×${r2}）`);
  prev = { map, cols: c2, rows: r2 };
}

const manifest = {
  generatedAt: new Date().toISOString(),
  tileSize: TILE,
  source: 'stitched-png',
  levels: levels.map((l) => ({ ...l, originBlockX: xMin, originBlockZ: zMin })),
  worldBlockRange: { xMin, xMax: xMin + cols * TILE, zMin, zMax: zMin + rows * TILE },
  stats: { kind: 'png', images: 1, pixels: base.width * base.height, level0Tiles: written },
};
await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`\n输出：${outDir}（level 0 共 ${written} 块瓦片）`);
console.log(`世界范围：X ${xMin}..${xMin + cols * TILE} · Z ${zMin}..${zMin + rows * TILE}（已补齐到瓦片整数倍，图内 ${base.width}×${base.height} 方块）`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('png-to-tiles.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

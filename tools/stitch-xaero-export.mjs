#!/usr/bin/env node
/**
 * stitch-xaero-export.mjs —— 把 Xaero「Multiple Unscaled Images」导出的多张 PNG 拼成一张
 *
 * 背景：Xaero 世界地图右键 → Export Map as PNG → 勾选 Multiple Unscaled Images，
 *      会按 1 px = 1 方块导出成多张 PNG（文件名带时间戳，通常也带区域/块坐标）。
 *
 * 用法：
 *   node tools/stitch-xaero-export.mjs <导出目录> --out=stitched.png [--cols=N] [--scale=N]
 *
 * 拼接规则（自动判断）：
 *   1. 若文件名里的**最后两个整数**能组成连续网格（每个坐标只出现一次）→ 按坐标拼；
 *   2. 否则按文件名自然排序，按 --cols（默认 4）从左到右、从上到下依次摆放；
 *   3. --cols 只在第 2 种情况下生效。
 *
 * 输出：一张 PNG（RGBA），并打印每张图的尺寸/坐标，方便核对。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/* ------------------------------- 参数 ------------------------------- */

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT = opt('out', 'stitched.png');
const COLS = Math.max(1, Number(opt('cols', 4)) || 4);
const SCALE = Math.max(1, Math.floor(Number(opt('scale', 1)) || 1));

if (!target) {
  console.error('用法：node tools/stitch-xaero-export.mjs <导出目录> --out=stitched.png [--cols=4] [--scale=1]');
  process.exit(2);
}

/* ------------------------------- PNG 解码 ------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 解码 PNG → { width, height, rgba: Buffer }，支持 8 位 RGB/RGBA/灰度/调色板 + 隔行扫描不常见故略 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let p = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let palette = null;
  let trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG');
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8) throw new Error(`不支持 ${bitDepth} 位深的 PNG`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
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
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pred) & 0xff;
          break;
        }
        default: throw new Error(`未知过滤器 ${filter}`);
      }
      cur[i] = v;
    }
    cur.copy(pixels, y * stride);
    prev = cur;
  }

  // 统一转成 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 6) {
      r = pixels[i * 4]; g = pixels[i * 4 + 1]; b = pixels[i * 4 + 2]; a = pixels[i * 4 + 3];
    } else if (colorType === 2) {
      r = pixels[i * 3]; g = pixels[i * 3 + 1]; b = pixels[i * 3 + 2];
    } else if (colorType === 3) {
      const idx = pixels[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    } else {
      r = g = b = pixels[i];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}

/* ------------------------------- PNG 编码 ------------------------------- */

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  const stat = await fs.stat(target);
  const dir = stat.isDirectory() ? target : path.dirname(target);
  const entries = (await fs.readdir(dir))
    .filter((n) => /\.png$/i.test(n))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!entries.length) {
    console.error(`目录里没有 PNG：${dir}`);
    process.exit(2);
  }

  console.log(`找到 ${entries.length} 张 PNG：${dir}`);
  const images = [];
  for (const name of entries) {
    const buf = await fs.readFile(path.join(dir, name));
    const img = decodePng(buf);
    const nums = (name.match(/-?\d+/g) || []).map(Number);
    images.push({ name, ...img, nums });
  }
  const size = `${images[0].width}×${images[0].height}`;
  const uniform = images.every((i) => i.width === images[0].width && i.height === images[0].height);
  console.log(`单张尺寸 ${size}${uniform ? '（全部一致）' : '（尺寸不一致，将按最大尺寸拼）'}`);

  // 规则 1：文件名最后两个整数当坐标，且不重复
  const coordKey = (img) => (img.nums.length >= 2 ? `${img.nums[img.nums.length - 2]},${img.nums[img.nums.length - 1]}` : null);
  const keys = images.map(coordKey);
  const allHaveCoords = keys.every((k) => k !== null);
  const uniqueKeys = new Set(keys).size === keys.length;
  const useCoords = allHaveCoords && uniqueKeys;

  let cols;
  let rows;
  let placement;
  if (useCoords) {
    const xs = images.map((i) => i.nums[i.nums.length - 2]);
    const zs = images.map((i) => i.nums[i.nums.length - 1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    cols = maxX - minX + 1;
    rows = maxZ - minZ + 1;
    placement = images.map((img) => ({
      img,
      col: img.nums[img.nums.length - 2] - minX,
      row: img.nums[img.nums.length - 1] - minZ,
    }));
    console.log(`按文件名坐标拼接：X ${minX}..${maxX}（${cols} 列）· Z ${minZ}..${maxZ}（${rows} 行）`);
  } else {
    cols = Math.min(COLS, images.length);
    rows = Math.ceil(images.length / cols);
    placement = images.map((img, i) => ({ img, col: i % cols, row: Math.floor(i / cols) }));
    console.log(`文件名里没有可用的坐标，按自然排序铺开：${cols} 列 × ${rows} 行（如需改顺序用 --cols=N）`);
  }

  const cellW = Math.max(...images.map((i) => i.width));
  const cellH = Math.max(...images.map((i) => i.height));
  const fullW = cols * cellW;
  const fullH = rows * cellH;
  console.log(`拼接后：${fullW}×${fullH} px（每格 ${cellW}×${cellH}）`);

  const canvas = Buffer.alloc(fullW * fullH * 4);
  for (const { img, col, row } of placement) {
    const ox = col * cellW;
    const oz = row * cellH;
    for (let y = 0; y < img.height; y += 1) {
      const src = y * img.width * 4;
      const dst = ((oz + y) * fullW + ox) * 4;
      img.rgba.copy(canvas, dst, src, src + img.width * 4);
    }
  }

  // 可选降采样
  let outW = fullW;
  let outH = fullH;
  let output = canvas;
  if (SCALE > 1) {
    outW = Math.floor(fullW / SCALE);
    outH = Math.floor(fullH / SCALE);
    output = Buffer.alloc(outW * outH * 4);
    for (let y = 0; y < outH; y += 1) {
      for (let x = 0; x < outW; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let dy = 0; dy < SCALE; dy += 1) {
          for (let dx = 0; dx < SCALE; dx += 1) {
            const si = (((y * SCALE + dy) * fullW) + (x * SCALE + dx)) * 4;
            const alpha = canvas[si + 3];
            if (alpha) { r += canvas[si]; g += canvas[si + 1]; b += canvas[si + 2]; a += alpha; n += 1; }
          }
        }
        const di = (y * outW + x) * 4;
        if (n) {
          output[di] = Math.round(r / n);
          output[di + 1] = Math.round(g / n);
          output[di + 2] = Math.round(b / n);
          output[di + 3] = Math.round(a / n);
        }
      }
    }
  }

  const outPath = path.resolve(OUT);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, encodePng(outW, outH, output));
  console.log(`\n输出：${outPath}（${outW}×${outH} px）`);
  console.log('提示：拼接后请在站点里用「画幅校准」把左上角对齐到世界坐标，或者用 .data 里的映射表。');
}

main().catch((err) => {
  console.error('拼接失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});

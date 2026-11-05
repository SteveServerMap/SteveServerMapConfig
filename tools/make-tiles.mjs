#!/usr/bin/env node
/**
 * make-tiles.mjs —— 把 Xaero region 直接生成 XYZ 瓦片（1 px = 1 方块）+ 预览页
 *
 * 用法：
 *   node tools/make-tiles.mjs <mw$default 目录> --out=.data/tiles/frp-web-overworld [--tile=256]
 *
 * 产物：
 *   <out>/manifest.json          瓦片元信息（层级、原点、世界坐标范围）
 *   <out>/tiles/<level>/<x>_<y>.png
 *   <out>/viewer.html            自带的平移/缩放预览页（浏览器直接打开，需要 http 服务）
 *
 * 说明：
 *   - level 0 = 1 px 代表 1 方块，每张瓦片 256×256 方块
 *   - 完全透明的瓦片不写盘
 *   - 高层级由上一层 2×2 平均得到
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { readZipEntry, decodeRegionPayload, encodePng } from './xaero-decode.mjs';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT = opt('out', '.data/tiles');
const TILE = Math.max(64, Math.floor(Number(opt('tile', 256)) || 256));
const REGION_BLOCKS = 512;

if (!target) {
  console.error('用法：node tools/make-tiles.mjs <mw$default 目录> --out=.data/tiles/xxx [--tile=256]');
  process.exit(2);
}

/* ------------------------------ PNG 解码（读回瓦片用） ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function decodePng(buf) {
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

/* ----------------------------------- 主流程 ----------------------------------- */

async function main() {
  const walk = async (dir, out = []) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, out);
      else if (/\.zip$/i.test(e.name)) out.push(full);
    }
    return out;
  };
  const files = (await walk(target)).sort();
  if (!files.length) {
    console.error('没找到区域 zip');
    process.exit(2);
  }
  console.log(`区域文件 ${files.length} 个，瓦片尺寸 ${TILE}px，输出 ${OUT}`);

  /** level0 瓦片：key = `${tx}_${ty}`，value = Buffer(256*256*4) */
  const level0 = new Map();
  let decoded = 0;
  let skipped = 0;

  for (const file of files) {
    const raw = await fs.readFile(file);
    const entry = readZipEntry(raw);
    if (!entry) { skipped += 1; continue; }
    let result;
    try {
      result = decodeRegionPayload(entry.content);
    } catch {
      skipped += 1;
      continue;
    }
    decoded += 1;
    const m = /(-?\d+)_(-?\d+)\.zip$/i.exec(path.basename(file));
    if (!m) { skipped += 1; continue; }
    const rx = Number(m[1]);
    const rz = Number(m[2]);

    for (let ty = 0; ty < REGION_BLOCKS / TILE; ty += 1) {
      for (let tx = 0; tx < REGION_BLOCKS / TILE; tx += 1) {
        const gx = rx * (REGION_BLOCKS / TILE) + tx;
        const gz = rz * (REGION_BLOCKS / TILE) + ty;
        const key = `${gx}_${gz}`;
        let buf = level0.get(key);
        if (!buf) {
          buf = Buffer.alloc(TILE * TILE * 4);
          level0.set(key, buf);
        }
        let hasPixel = false;
        for (let y = 0; y < TILE; y += 1) {
          const srcRow = (ty * TILE + y) * REGION_BLOCKS * 4 + tx * TILE * 4;
          const dstRow = y * TILE * 4;
          const src = result.blocks.subarray(srcRow, srcRow + TILE * 4);
          buf.set(src, dstRow);
          if (!hasPixel) {
            for (let i = 3; i < src.length; i += 4) { if (src[i]) { hasPixel = true; break; } }
          }
        }
        if (!hasPixel) level0.delete(key);
      }
    }
  }

  const tileDir = path.join(OUT, 'tiles');
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(path.join(tileDir, '0'), { recursive: true });

  // 写 level 0（跳过全透明）
  let written = 0;
  for (const [key, buf] of level0) {
    if (!buf.some((v, i) => i % 4 === 3 && v)) continue;
    const [tx, ty] = key.split('_').map(Number);
    await fs.writeFile(path.join(tileDir, '0', `${tx}_${ty}.png`), encodePng(TILE, TILE, buf));
    written += 1;
  }
  const xs = [...level0.keys()].map((k) => Number(k.split('_')[0]));
  const zs = [...level0.keys()].map((k) => Number(k.split('_')[1]));
  const minTx = Math.min(...xs);
  const maxTx = Math.max(...xs);
  const minTz = Math.min(...zs);
  const maxTz = Math.max(...zs);
  console.log(`level 0：${written} 块瓦片写盘（世界像素 ${minTx * TILE}..${(maxTx + 1) * TILE} × ${minTz * TILE}..${(maxTz + 1) * TILE}）`);

  // 构建金字塔
  const levels = [{ level: 0, minX: minTx, maxX: maxTx, minZ: minTz, maxZ: maxTz }];
  let prev = { map: level0, minX: minTx, maxX: maxTx, minZ: minTz, maxZ: maxTz };
  let level = 0;
  while (prev.maxX - prev.minX > 1 || prev.maxZ - prev.minZ > 1) {
    level += 1;
    const cur = new Map();
    const curMinX = Math.floor(prev.minX / 2);
    const curMaxX = Math.floor(prev.maxX / 2);
    const curMinZ = Math.floor(prev.minZ / 2);
    const curMaxZ = Math.floor(prev.maxZ / 2);
    await fs.mkdir(path.join(tileDir, String(level)), { recursive: true });
    for (let ty = curMinZ; ty <= curMaxZ; ty += 1) {
      for (let tx = curMinX; tx <= curMaxX; tx += 1) {
        const buf = Buffer.alloc(TILE * TILE * 4);
        let any = false;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const child = prev.map.get(`${tx * 2 + dx}_${ty * 2 + dy}`);
            if (!child) continue;
            for (let y = 0; y < TILE / 2; y += 1) {
              for (let x = 0; x < TILE / 2; x += 1) {
                // 取 2×2 平均
                let r = 0;
                let g = 0;
                let b = 0;
                let a = 0;
                let n = 0;
                for (let sy = 0; sy < 2; sy += 1) {
                  for (let sx = 0; sx < 2; sx += 1) {
                    const si = ((y * 2 + sy) * TILE + (x * 2 + sx)) * 4;
                    if (child[si + 3]) { r += child[si]; g += child[si + 1]; b += child[si + 2]; a += child[si + 3]; n += 1; }
                  }
                }
                if (!n) continue;
                const di = ((dy * (TILE / 2) + y) * TILE + dx * (TILE / 2) + x) * 4;
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
        cur.set(`${tx}_${ty}`, buf);
        await fs.writeFile(path.join(tileDir, String(level), `${tx}_${ty}.png`), encodePng(TILE, TILE, buf));
      }
    }
    levels.push({ level, minX: curMinX, maxX: curMaxX, minZ: curMinZ, maxZ: curMaxZ });
    prev = { map: cur, minX: curMinX, maxX: curMaxX, minZ: curMinZ, maxZ: curMaxZ };
    console.log(`level ${level}：${cur.size} 块瓦片（${curMaxX - curMinX + 1}×${curMaxZ - curMinZ + 1}）`);
    if (cur.size === 0) break;
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    tileSize: TILE,
    regionBlocks: REGION_BLOCKS,
    // level 0：1 px = 1 方块
    blocksPerPixelLevel0: 1,
    levels: levels.map((l) => ({
      ...l,
      cols: l.maxX - l.minX + 1,
      rows: l.maxZ - l.minZ + 1,
      // 该层级 1 像素代表多少方块
      blocksPerPixel: 2 ** l.level,
      // 该层级左上角瓦片对应的世界坐标（方块）
      originBlockX: l.minX * TILE * 2 ** l.level,
      originBlockZ: l.minZ * TILE * 2 ** l.level,
    })),
    worldBlockRange: {
      xMin: levels[0].minX * TILE,
      xMax: (levels[0].maxX + 1) * TILE,
      zMin: levels[0].minZ * TILE,
      zMax: (levels[0].maxZ + 1) * TILE,
    },
    stats: { regions: decoded, skipped, level0Tiles: written },
  };
  await fs.writeFile(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // 预览页
  await fs.writeFile(path.join(OUT, 'viewer.html'), VIEWER_HTML, 'utf8');
  const size = (await fs.stat(path.join(OUT, 'manifest.json'))).size;
  console.log(`\nmanifest.json ${(size / 1024).toFixed(1)} KB；预览页 ${path.join(OUT, 'viewer.html')}`);
  console.log(`世界范围：X ${manifest.worldBlockRange.xMin}..${manifest.worldBlockRange.xMax} · Z ${manifest.worldBlockRange.zMin}..${manifest.worldBlockRange.zMax}`);
}

export const VIEWER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>瓦片预览</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f1210; color: #d8e3d5; font: 13px/1.5 system-ui, sans-serif; }
  #wrap { position: fixed; inset: 0; overflow: hidden; cursor: grab; }
  #wrap.dragging { cursor: grabbing; }
  canvas { image-rendering: pixelated; }
  #hud { position: fixed; left: 12px; bottom: 12px; background: rgba(0,0,0,.6); padding: 8px 10px; border-radius: 8px; white-space: pre; font-family: ui-monospace, monospace; }
  #hud b { color: #5ad26f; font-weight: 600; }
</style>
</head>
<body>
<div id="wrap"><canvas id="cv"></canvas></div>
<div id="hud"></div>
<script type="module">
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const hud = document.getElementById('hud');
const manifest = await (await fetch('manifest.json')).json();
const levels = manifest.levels;
const tileSize = manifest.tileSize;
const cache = new Map();

let level = 0;
let camX = 0; // 世界方块坐标（视口中心）
let camZ = 0;
let scale = 1; // 屏幕像素 / 世界方块

function levelFor(scale) {
  let l = 0;
  while (l + 1 < levels.length && scale * 2 ** (l + 1) <= 1.2) l += 1;
  return l;
}
function loadTile(lv, tx, ty) {
  const key = lv + '/' + tx + '_' + ty;
  if (cache.has(key)) return cache.get(key);
  const img = new Image();
  img.src = 'tiles/' + lv + '/' + tx + '_' + ty + '.png';
  img.decoding = 'async';
  cache.set(key, img);
  return img;
}
function resize() {
  cv.width = innerWidth; cv.height = innerHeight;
  cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
  draw();
}
function draw() {
  const lv = levelFor(scale);
  const L = levels[lv];
  const bpp = L.blocksPerPixel; // 该层 1 像素代表多少方块
  const pxPerBlock = scale / bpp; // 该层瓦片像素在屏幕上的缩放
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const halfW = cv.width / 2 / scale;
  const halfH = cv.height / 2 / scale;
  const tileBlocks = tileSize * bpp;
  const tx0 = Math.floor((camX - halfW) / tileBlocks);
  const tx1 = Math.floor((camX + halfW) / tileBlocks);
  const tz0 = Math.floor((camZ - halfH) / tileBlocks);
  const tz1 = Math.floor((camZ + halfH) / tileBlocks);
  let drawn = 0, missing = 0;
  for (let ty = tz0; ty <= tz1; ty += 1) {
    for (let tx = tx0; tx <= tx1; tx += 1) {
      if (tx < L.minX || tx > L.maxX || ty < L.minZ || ty > L.maxZ) continue;
      const img = loadTile(lv, tx, ty);
      if (!img.complete || !img.naturalWidth) { missing += 1; continue; }
      const sx = (tx * tileBlocks - camX) * scale + cv.width / 2;
      const sy = (ty * tileBlocks - camZ) * scale + cv.height / 2;
      const sw = tileBlocks * scale;
      ctx.drawImage(img, sx, sy, sw, sw);
      drawn += 1;
    }
  }
  hud.innerHTML = \`层级 <b>\${lv}</b> · 1 像素 = \${bpp} 方块 · 缩放 <b>\${scale.toFixed(2)}</b> px/方块\\n世界坐标 <b>\${Math.round(camX)}, \${Math.round(camZ)}</b>\\n瓦片 \${drawn} 绘制 / \${missing} 加载中 · 滚轮缩放 · 拖动平移\`;
  if (missing) setTimeout(() => { if (!running) return; draw(); }, 120);
}
let running = true;
function loop() { if (!running) return; draw(); requestAnimationFrame(loop); }

const wrap = document.getElementById('wrap');
let dragging = false, lastX = 0, lastY = 0;
wrap.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; wrap.classList.add('dragging'); });
addEventListener('pointerup', () => { dragging = false; wrap.classList.remove('dragging'); });
addEventListener('pointermove', (e) => {
  if (!dragging) return;
  camX -= (e.clientX - lastX) / scale;
  camZ -= (e.clientY - lastY) / scale;
  lastX = e.clientX; lastY = e.clientY;
  draw();
});
wrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  const rect = cv.getBoundingClientRect();
  const mx = e.clientX - rect.left - cv.width / 2;
  const my = e.clientY - rect.top - cv.height / 2;
  const beforeX = camX + mx / scale;
  const beforeZ = camZ + my / scale;
  scale = Math.min(4, Math.max(0.02, scale * factor));
  camX = beforeX - mx / scale;
  camZ = beforeZ - my / scale;
  draw();
}, { passive: false });

// 初始视野：居中到世界范围中点，缩放让世界宽度约占屏幕 80%
const R = manifest.worldBlockRange;
camX = (R.xMin + R.xMax) / 2;
camZ = (R.zMin + R.zMax) / 2;
scale = Math.min(1, (innerWidth * 0.8) / (R.xMax - R.xMin));
addEventListener('resize', resize);
resize();
</script>
</body>
</html>
`;

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('make-tiles.mjs')) {
  main().catch((err) => {
    console.error('生成瓦片失败：', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}


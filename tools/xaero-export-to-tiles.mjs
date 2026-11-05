// 直接：Xaero 导出图（<i>_<j>_x<X>_z<Z>.png, 1024×1024）→ XYZ 瓦片 + manifest + viewer
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { encodePng } from './xaero-decode.mjs';
import { VIEWER_HTML } from './make-tiles.mjs';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const OUT = opt('out', '.data/tiles/export');
const TILE = 256;
if (!target) { console.error('用法：node tools/xaero-export-to-tiles.mjs <导出目录> --out=.data/tiles/xxx'); process.exit(2); }

/* PNG 解码（RGBA/RGB 8bit） */
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 6; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
  }
  const ch = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch;
  const px = Buffer.alloc(stride * h); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v = (v + a) & 255; else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
      cur[i] = v;
    }
    cur.copy(px, y * stride); prev = cur;
  }
  if (ch === 4) return { w, h, rgba: px };
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { out[i*4]=px[i*3]; out[i*4+1]=px[i*3+1]; out[i*4+2]=px[i*3+2]; out[i*4+3]=255; }
  return { w, h, rgba: out };
}

const files = (await fs.readdir(target)).filter((n) => /\.png$/i.test(n)).sort();
const imgs = [];
for (const name of files) {
  const m = /x(-?\d+)_z(-?\d+)/i.exec(name);
  if (!m) { console.log(`跳过（文件名无 x/z 坐标）：${name}`); continue; }
  const png = decodePng(await fs.readFile(path.join(target, name)));
  imgs.push({ name, x: Number(m[1]), z: Number(m[2]), ...png });
}
if (!imgs.length) { console.error('没有可用导出图'); process.exit(2); }
const cellW = imgs[0].w, cellH = imgs[0].h;
const minX = Math.min(...imgs.map((i) => i.x)), maxX = Math.max(...imgs.map((i) => i.x));
const minZ = Math.min(...imgs.map((i) => i.z)), maxZ = Math.max(...imgs.map((i) => i.z));
const cols = (maxX - minX) / cellW + 1, rows = (maxZ - minZ) / cellH + 1;
console.log(`${imgs.length} 张导出图，每张 ${cellW}×${cellH}，网格 ${cols}×${rows}`);
console.log(`世界范围 X ${minX}..${minX + cols * cellW} · Z ${minZ}..${minZ + rows * cellH}`);

// 拼成大图（1 px = 1 方块）
const fullW = cols * cellW, fullH = rows * cellH;
const canvas = Buffer.alloc(fullW * fullH * 4);
for (const img of imgs) {
  const ox = (img.x - minX) / cellW * cellW, oz = (img.z - minZ) / cellH * cellH;
  for (let y = 0; y < img.h; y++) {
    const src = y * img.w * 4, dst = ((oz + y) * fullW + ox) * 4;
    img.rgba.copy(canvas, dst, src, src + img.w * 4);
  }
}
console.log(`拼接后 ${fullW}×${fullH} px`);

// 切瓦片 + 金字塔
const outDir = path.resolve(OUT);
await fs.rm(outDir, { recursive: true, force: true });
const tileDir = path.join(outDir, 'tiles');
const levels = [];
let cur = { rgba: canvas, w: fullW, h: fullH };
let level = 0;
while (level <= 12) {
  const c2 = Math.ceil(cur.w / TILE), r2 = Math.ceil(cur.h / TILE);
  await fs.mkdir(path.join(tileDir, String(level)), { recursive: true });
  let written = 0;
  for (let ty = 0; ty < r2; ty++) for (let tx = 0; tx < c2; tx++) {
    const buf = Buffer.alloc(TILE * TILE * 4);
    let any = false;
    for (let y = 0; y < TILE; y++) {
      const sy = ty * TILE + y; if (sy >= cur.h) break;
      for (let x = 0; x < TILE; x++) {
        const sx = tx * TILE + x; if (sx >= cur.w) break;
        const si = (sy * cur.w + sx) * 4; if (!cur.rgba[si + 3]) continue;
        const di = (y * TILE + x) * 4;
        buf[di] = cur.rgba[si]; buf[di+1] = cur.rgba[si+1]; buf[di+2] = cur.rgba[si+2]; buf[di+3] = cur.rgba[si+3];
        any = true;
      }
    }
    if (!any) continue;
    await fs.writeFile(path.join(tileDir, String(level), `${tx}_${ty}.png`), encodePng(TILE, TILE, buf));
    written++;
  }
  levels.push({ level, minX: 0, maxX: c2 - 1, minZ: 0, maxZ: r2 - 1, cols: c2, rows: r2, blocksPerPixel: 2 ** level, originBlockX: minX, originBlockZ: minZ });
  console.log(`level ${level}: ${written} 块 (${c2}×${r2})`);
  const nw = Math.max(1, Math.floor(cur.w / 2)), nh = Math.max(1, Math.floor(cur.h / 2));
  if (nw === cur.w && nh === cur.h) break; // 已经 1×1，不能再缩了
  const next = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sy = y*2+dy, sx = x*2+dx; if (sy >= cur.h || sx >= cur.w) continue;
      const si = (sy*cur.w+sx)*4; if (!cur.rgba[si+3]) continue;
      r += cur.rgba[si]; g += cur.rgba[si+1]; b += cur.rgba[si+2]; a += cur.rgba[si+3]; n++;
    }
    if (!n) continue;
    const di = (y*nw+x)*4;
    next[di]=Math.round(r/n); next[di+1]=Math.round(g/n); next[di+2]=Math.round(b/n); next[di+3]=Math.round(a/n);
  }
  cur = { rgba: next, w: nw, h: nh };
  level++;
}
const manifest = {
  generatedAt: new Date().toISOString(), tileSize: TILE, source: 'xaero-export',
  levels,
  worldBlockRange: { xMin: minX, xMax: minX + fullW, zMin: minZ, zMax: minZ + fullH },
};
await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
await fs.writeFile(path.join(outDir, 'viewer.html'), VIEWER_HTML, 'utf8');
console.log(`\n输出：${outDir}`);

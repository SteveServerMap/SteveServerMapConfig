#!/usr/bin/env node
/**
 * xaero-tiles.mjs —— 把 xaero/<维度>/ 里的导出图/区域数据切成站点瓦片
 * =============================================================================
 * 两类输入（可混放，PNG 优先）：
 *   1. Xaero「Export Map as PNG」多张无缩放导出：文件名带 x<X>_z<Z>，1 px = 1 方块；
 *   2. Xaero 缓存里的区域 zip：<rx>_<rz>.zip（每个区域 512×512 方块），
 *      默认跳过 caves/ 洞穴层，只取地表。
 *
 * 产物（与站点 assets/js/tiles.js 的 manifest 契约一致）：
 *   <out>/manifest.json
 *   <out>/tiles/<level>/<x>_<y>.png
 *
 * 坐标语义：
 *   - level 0 的 1 像素 = 1 方块；层级 L 的 1 像素 = 2^L 方块；
 *   - worldBlockRange 会向外补齐到 tileSize 的整数倍，保证
 *     cols * tileSize = xMax - xMin（tiles.js 的一致性自检）；
 *   - 所有层级的 originBlockX/Z 都等于 worldBlockRange 左上角。
 *
 * 零依赖：只用 Node 内置模块 + tools/xaero-decode.mjs 的 PNG 编码 / 区域解码。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { encodePng, readZipEntry, decodeRegionPayload } from './xaero-decode.mjs';

export const DEFAULT_TILE_SIZE = 256;
export const REGION_BLOCKS = 512;

/* ============================== 小工具 ============================== */

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function parseExportName(name) {
  const m = /x(-?\d+)_z(-?\d+)/i.exec(name);
  if (!m) return null;
  return { x: Number(m[1]), z: Number(m[2]) };
}

function parseRegionName(name) {
  const m = /(-?\d+)_(-?\d+)\.zip$/i.exec(name);
  if (!m) return null;
  return { x: Number(m[1]), z: Number(m[2]) };
}

async function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 洞穴层不是地表图，混进来会让同一坐标出现两套颜色
      if (entry.name.toLowerCase() === 'caves') continue;
      await walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function pngHeader(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

/**
 * PNG 解码：支持 8bit 灰度 / 灰度+alpha / RGB / RGBA，非隔行。
 * 返回 { width, height, rgba }；不支持的类型抛错。
 */
export function decodePng(buf) {
  let p = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  let bitDepth = 8;
  let interlace = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!(width > 0) || !(height > 0)) throw new Error('PNG 尺寸无效');
  if (bitDepth !== 8) throw new Error(`暂不支持 ${bitDepth}bit PNG（只支持 8bit）`);
  if (interlace) throw new Error('暂不支持隔行 PNG');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`暂不支持 PNG colorType=${colorType}`);

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

  if (colorType === 6) return { width, height, rgba: px };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    if (colorType === 2) {
      rgba[i * 4] = px[i * 3];
      rgba[i * 4 + 1] = px[i * 3 + 1];
      rgba[i * 4 + 2] = px[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else if (colorType === 0) {
      const v = px[i];
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    } else {
      const v = px[i * 2];
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = px[i * 2 + 1];
    }
  }
  return { width, height, rgba };
}

/* ============================== 扫描源目录 ============================== */

/**
 * 快速扫描一个 xaero/<维度> 目录，不解码整张图。
 * @returns {Promise<{kind:'png'|'region'|'empty', images:number, regions:number,
 *   bounds:{xMin:number,xMax:number,zMin:number,zMax:number}|null,
 *   bytes:number, pngFiles:string[], regionFiles:string[]}>}
 */
export async function inspectXaeroSource(sourceDir) {
  const files = await walkFiles(sourceDir);
  const pngFiles = [];
  const regionFiles = [];
  let bytes = 0;
  let xMin = Infinity;
  let xMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;

  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    const lower = file.toLowerCase();
    if (lower.endsWith('.png')) {
      const coords = parseExportName(path.basename(file));
      if (!coords) continue;
      let buf = null;
      try {
        const handle = await fs.open(file, 'r');
        try {
          buf = Buffer.alloc(33);
          await handle.read(buf, 0, buf.length, 0);
        } finally {
          await handle.close();
        }
      } catch {
        buf = null;
      }
      const size = buf ? pngHeader(buf) : null;
      if (!size) continue;
      pngFiles.push(file);
      bytes += stat.size;
      xMin = Math.min(xMin, coords.x);
      zMin = Math.min(zMin, coords.z);
      xMax = Math.max(xMax, coords.x + size.width);
      zMax = Math.max(zMax, coords.z + size.height);
    } else if (lower.endsWith('.zip')) {
      const coords = parseRegionName(path.basename(file));
      if (!coords) continue;
      regionFiles.push(file);
      bytes += stat.size;
      xMin = Math.min(xMin, coords.x * REGION_BLOCKS);
      zMin = Math.min(zMin, coords.z * REGION_BLOCKS);
      xMax = Math.max(xMax, (coords.x + 1) * REGION_BLOCKS);
      zMax = Math.max(zMax, (coords.z + 1) * REGION_BLOCKS);
    }
  }

  const kind = pngFiles.length ? 'png' : regionFiles.length ? 'region' : 'empty';
  return {
    kind,
    images: pngFiles.length,
    regions: regionFiles.length,
    bounds: Number.isFinite(xMin) && xMax > xMin && zMax > zMin ? { xMin, xMax, zMin, zMax } : null,
    bytes,
    pngFiles,
    regionFiles,
  };
}

/* ============================== 瓦片写入 ============================== */

function makeGrid(xMin, zMin, xMax, zMax, tileSize) {
  const cols = Math.max(1, Math.ceil((xMax - xMin) / tileSize));
  const rows = Math.max(1, Math.ceil((zMax - zMin) / tileSize));
  return {
    cols,
    rows,
    xMin,
    zMin,
    xMax: xMin + cols * tileSize,
    zMax: zMin + rows * tileSize,
  };
}

function getTile(map, tx, ty, tileSize) {
  const key = `${tx}_${ty}`;
  let buf = map.get(key);
  if (!buf) {
    buf = Buffer.alloc(tileSize * tileSize * 4);
    map.set(key, buf);
  }
  return buf;
}

/**
 * 把一块 RGBA 像素放进 level-0 瓦片网格。
 * 只写 alpha > 0 的像素；blackIsTransparent 时把纯黑当未探索。
 */
function blitRgba({ map, grid, tileSize, src, width, height, worldX, worldZ, blackThreshold, keepBlack }) {
  for (let y = 0; y < height; y += 1) {
    const gz = worldZ + y;
    if (gz < grid.zMin || gz >= grid.zMax) continue;
    for (let x = 0; x < width; x += 1) {
      const gx = worldX + x;
      if (gx < grid.xMin || gx >= grid.xMax) continue;
      const si = (y * width + x) * 4;
      if (!src[si + 3]) continue;
      if (!keepBlack && src[si] <= blackThreshold && src[si + 1] <= blackThreshold && src[si + 2] <= blackThreshold) continue;
      const px = gx - grid.xMin;
      const pz = gz - grid.zMin;
      const tx = Math.floor(px / tileSize);
      const ty = Math.floor(pz / tileSize);
      const buf = getTile(map, tx, ty, tileSize);
      const di = ((pz % tileSize) * tileSize + (px % tileSize)) * 4;
      buf[di] = src[si];
      buf[di + 1] = src[si + 1];
      buf[di + 2] = src[si + 2];
      buf[di + 3] = src[si + 3];
    }
  }
}

async function writeLevel(outDir, tileSize, level, map) {
  const dir = path.join(outDir, 'tiles', String(level));
  await fs.mkdir(dir, { recursive: true });
  let written = 0;
  const keys = [...map.keys()].sort((a, b) => {
    const [ax, ay] = a.split('_').map(Number);
    const [bx, by] = b.split('_').map(Number);
    return ay - by || ax - bx;
  });
  for (const key of keys) {
    const buf = map.get(key);
    let any = false;
    for (let i = 3; i < buf.length; i += 4) {
      if (buf[i]) {
        any = true;
        break;
      }
    }
    if (!any) continue;
    await fs.writeFile(path.join(dir, `${key}.png`), encodePng(tileSize, tileSize, buf));
    written += 1;
  }
  return written;
}

function buildNextLevel(prevMap, prevCols, prevRows, tileSize) {
  const cols = Math.max(1, Math.ceil(prevCols / 2));
  const rows = Math.max(1, Math.ceil(prevRows / 2));
  const map = new Map();
  const half = tileSize / 2;
  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      const buf = Buffer.alloc(tileSize * tileSize * 4);
      let any = false;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const child = prevMap.get(`${tx * 2 + dx}_${ty * 2 + dy}`);
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
                  const si = ((y * 2 + sy) * tileSize + x * 2 + sx) * 4;
                  if (!child[si + 3]) continue;
                  r += child[si];
                  g += child[si + 1];
                  b += child[si + 2];
                  a += child[si + 3];
                  n += 1;
                }
              }
              if (!n) continue;
              const di = ((dy * half + y) * tileSize + dx * half + x) * 4;
              buf[di] = Math.round(r / n);
              buf[di + 1] = Math.round(g / n);
              buf[di + 2] = Math.round(b / n);
              buf[di + 3] = Math.round(a / n);
              any = true;
            }
          }
        }
      }
      if (any) map.set(`${tx}_${ty}`, buf);
    }
  }
  return { map, cols, rows };
}

function levelMeta(level, grid, tileSize) {
  return {
    level,
    minX: 0,
    maxX: grid.cols - 1,
    minZ: 0,
    maxZ: grid.rows - 1,
    cols: grid.cols,
    rows: grid.rows,
    blocksPerPixel: 2 ** level,
    originBlockX: grid.xMin,
    originBlockZ: grid.zMin,
  };
}

/* ============================== 主流程 ============================== */

/**
 * 生成站点瓦片。
 * @param {object} options
 * @param {string} options.sourceDir xaero/<维度> 目录
 * @param {string} options.outDir    输出目录（会被清空）
 * @param {number} [options.tileSize=256]
 * @param {boolean} [options.keepBlack=false] 保留纯黑未探索区域
 * @param {number} [options.blackThreshold=10]
 * @param {(info:object)=>void} [options.onProgress]
 * @returns {Promise<object>} manifest + 统计
 */
export async function generateXaeroTiles({
  sourceDir,
  outDir,
  tileSize = DEFAULT_TILE_SIZE,
  keepBlack = false,
  blackThreshold = 10,
  onProgress = null,
} = {}) {
  if (!sourceDir) throw new Error('缺少 sourceDir');
  if (!outDir) throw new Error('缺少 outDir');
  const tile = isPositiveInt(tileSize) ? tileSize : DEFAULT_TILE_SIZE;
  if (tile % 2 !== 0) throw new Error('tileSize 必须是偶数（金字塔按 2×2 降采样）');
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const started = Date.now();
  const scan = await inspectXaeroSource(sourceDir);
  if (!scan.bounds) throw new Error('源目录里没有可用的 Xaero 导出 PNG 或区域 zip');

  report({ phase: 'scan', scan });
  const grid = makeGrid(scan.bounds.xMin, scan.bounds.zMin, scan.bounds.xMax, scan.bounds.zMax, tile);
  const level0 = new Map();
  let skipped = 0;
  let decoded = 0;
  let pixels = 0;

  if (scan.kind === 'png') {
    for (const file of scan.pngFiles) {
      const coords = parseExportName(path.basename(file));
      if (!coords) {
        skipped += 1;
        continue;
      }
      let png;
      try {
        png = decodePng(await fs.readFile(file));
      } catch (err) {
        skipped += 1;
        report({ phase: 'skip', file, error: err.message });
        continue;
      }
      decoded += 1;
      blitRgba({
        map: level0,
        grid,
        tileSize: tile,
        src: png.rgba,
        width: png.width,
        height: png.height,
        worldX: coords.x,
        worldZ: coords.z,
        blackThreshold,
        keepBlack,
      });
      pixels += png.width * png.height;
      report({ phase: 'image', file, done: decoded, total: scan.pngFiles.length });
    }
  } else {
    for (const file of scan.regionFiles) {
      const coords = parseRegionName(path.basename(file));
      if (!coords) {
        skipped += 1;
        continue;
      }
      let result;
      try {
        const raw = await fs.readFile(file);
        const entry = readZipEntry(raw);
        if (!entry) throw new Error('zip 里没有 region 数据');
        result = decodeRegionPayload(entry.content);
      } catch (err) {
        skipped += 1;
        report({ phase: 'skip', file, error: err.message });
        continue;
      }
      decoded += 1;
      blitRgba({
        map: level0,
        grid,
        tileSize: tile,
        src: result.blocks,
        width: REGION_BLOCKS,
        height: REGION_BLOCKS,
        worldX: coords.x * REGION_BLOCKS,
        worldZ: coords.z * REGION_BLOCKS,
        blackThreshold,
        keepBlack,
      });
      pixels += REGION_BLOCKS * REGION_BLOCKS;
      report({ phase: 'region', file, done: decoded, total: scan.regionFiles.length });
    }
  }

  if (!decoded) throw new Error('源目录找到了文件，但没有一张能成功解码');

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const levels = [];
  let tilesWritten = 0;
  let prev = { map: level0, cols: grid.cols, rows: grid.rows };
  let level = 0;
  while (true) {
    const written = await writeLevel(outDir, tile, level, prev.map);
    tilesWritten += written;
    const meta = levelMeta(level, { cols: prev.cols, rows: prev.rows, xMin: grid.xMin, zMin: grid.zMin }, tile);
    levels.push(meta);
    report({ phase: 'level', level, cols: prev.cols, rows: prev.rows, written });
    if (prev.cols === 1 && prev.rows === 1) break;
    const next = buildNextLevel(prev.map, prev.cols, prev.rows, tile);
    prev = next;
    level += 1;
    if (level > 32) throw new Error('金字塔层级异常（超过 32 层）');
    if (!prev.map.size) break;
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    tileSize: tile,
    source: 'xaero-folder',
    levels,
    worldBlockRange: { xMin: grid.xMin, xMax: grid.xMax, zMin: grid.zMin, zMax: grid.zMax },
    stats: {
      kind: scan.kind,
      images: scan.images,
      regions: scan.regions,
      decoded,
      skipped,
      pixels,
      level0Tiles: levels[0] ? (levels[0].cols * levels[0].rows) : 0,
      tilesWritten,
    },
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  report({ phase: 'done', manifest, tilesWritten, durationMs: Date.now() - started });
  return { ...manifest, outDir, durationMs: Date.now() - started };
}

/* ============================== CLI ============================== */

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('xaero-tiles.mjs')) {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith('--'));
  const opt = (name, fallback) => {
    const hit = args.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  if (!target) {
    console.error('用法：node tools/xaero-tiles.mjs <xaero/维度目录> --out=<输出目录> [--tile=256] [--keep-black]');
    process.exit(2);
  }
  generateXaeroTiles({
    sourceDir: target,
    outDir: opt('out', '.data/tiles/xaero'),
    tileSize: Number(opt('tile', DEFAULT_TILE_SIZE)) || DEFAULT_TILE_SIZE,
    keepBlack: args.includes('--keep-black'),
  })
    .then((result) => {
      console.log(`\n输出：${result.outDir}`);
      console.log(
        `世界范围：X ${result.worldBlockRange.xMin}..${result.worldBlockRange.xMax} · ` +
          `Z ${result.worldBlockRange.zMin}..${result.worldBlockRange.zMax}`,
      );
      console.log(`层级 ${result.levels.length} · 瓦片 ${result.stats.tilesWritten} 张 · ${(result.durationMs / 1000).toFixed(1)}s`);
    })
    .catch((err) => {
      console.error('生成瓦片失败：', err && err.stack ? err.stack : err);
      process.exit(1);
    });
}

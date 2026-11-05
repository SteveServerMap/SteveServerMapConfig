/**
 * tile-merge.mjs —— 瓦片集级差分合并（纯算法层，可在 Node 下单测）
 * =============================================================================
 * 基底：站点 tiles/<维度>/（manifest.json + tiles/<level>/<x>_<y>.png，level 0 的 1 像素 = 1 方块）
 * 新图：另一套 Xaero 导出（x<X>_z<Z>.png 或 <rx>_<rz>.zip 区域文件，可混放）
 *
 * 合并语义与单图合并（merge-core）一致，粒度是「一张 level-0 瓦片」：
 *   void / onlyBase / onlyIncoming / changed / same 五类；
 *   fillNew 控制 onlyIncoming 是否补入，updateChanged 控制 changed 是否用新图覆盖；
 *   same / onlyBase 直接沿用基底瓦片文件（字节级复制），changed 合成时新图透明处保留基底像素。
 *
 * 内存有界：一次只处理一张 level-0 瓦片；金字塔逐层从磁盘读子瓦片构建。
 * 输出契约与 generateXaeroTiles 完全一致（世界范围 = 基底范围），可直接替换 tiles/<维度>/。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { decodePng, inspectXaeroSource, REGION_BLOCKS } from './xaero-tiles.mjs';
import { readZipEntry, decodeRegionPayload, encodePng } from './xaero-decode.mjs';

/** 分类编号与 merge-core.js 的 TILE 一致（UI 叠加层共用同一套颜色） */
export const TILE = Object.freeze({
  VOID: 0,
  ONLY_BASE: 1,
  ONLY_INCOMING: 2,
  CHANGED: 3,
  SAME: 4,
});

/** level-0 瓦片数上限（一张 256² 瓦片约 256 KB，上限防手滑把超大世界拖爆磁盘） */
const MAX_LEVEL0_TILES = 1_000_000;
/** 新图解码后常驻内存的 RGBA 上限 */
const MAX_SOURCE_RGBA_BYTES = 512 * 1024 * 1024;

const num = (v, fallback = NaN) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/* ============================== 小工具 ============================== */

async function readTile(tilesDir, tx, ty) {
  try {
    return (await decodePng(await fs.readFile(path.join(tilesDir, `${tx}_${ty}.png`)))).rgba;
  } catch {
    return null;
  }
}

/** 一张瓦片的「是否有内容 + 平均色」统计（与 merge-core 的判定口径一致） */
function tileMetrics(buf, tileSize, voidLuminance) {
  if (!buf) return { void: true, content: 0, r: 0, g: 0, b: 0 };
  const total = tileSize * tileSize;
  let lit = 0;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let aSum = 0;
  let content = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3];
    aSum += a;
    if (!a) continue;
    content += 1;
    const r = buf[i];
    const g = buf[i + 1];
    const b = buf[i + 2];
    rSum += r;
    gSum += g;
    bSum += b;
    if (0.2126 * r + 0.7152 * g + 0.0722 * b > voidLuminance) lit += 1;
  }
  return {
    void: lit / total < 0.03 || aSum / total < 8,
    content,
    r: content ? rSum / content : 0,
    g: content ? gSum / content : 0,
    b: content ? bSum / content : 0,
  };
}

/**
 * 把新图源中与指定 level-0 瓦片重叠的像素 blit 进一张瓦片缓冲。
 * 与生成管线同规则：只写 alpha>0 的像素，纯黑按未探索跳过（除非 keepBlack）。
 * 没有任何源与该瓦片重叠时返回 null（省掉分配）。
 */
function blitIntoTile({ sources, tx, ty, grid, tileSize, blackThreshold, keepBlack }) {
  const tileX0 = grid.xMin + tx * tileSize;
  const tileZ0 = grid.zMin + ty * tileSize;
  const tileX1 = tileX0 + tileSize;
  const tileZ1 = tileZ0 + tileSize;
  let hit = false;
  for (const src of sources) {
    if (src.worldX < tileX1 && src.worldX + src.width > tileX0 && src.worldZ < tileZ1 && src.worldZ + src.height > tileZ0) {
      hit = true;
      break;
    }
  }
  if (!hit) return null;

  const buf = Buffer.alloc(tileSize * tileSize * 4);
  for (const src of sources) {
    if (src.worldX >= tileX1 || src.worldX + src.width <= tileX0) continue;
    if (src.worldZ >= tileZ1 || src.worldZ + src.height <= tileZ0) continue;
    const x0 = Math.max(0, tileX0 - src.worldX);
    const z0 = Math.max(0, tileZ0 - src.worldZ);
    const x1 = Math.min(src.width, tileX1 - src.worldX);
    const z1 = Math.min(src.height, tileZ1 - src.worldZ);
    for (let z = z0; z < z1; z += 1) {
      const rowSrc = z * src.width * 4;
      const rowDst = (src.worldZ + z - tileZ0) * tileSize * 4;
      for (let x = x0; x < x1; x += 1) {
        const si = rowSrc + x * 4;
        if (!src.rgba[si + 3]) continue;
        if (!keepBlack && src.rgba[si] <= blackThreshold && src.rgba[si + 1] <= blackThreshold && src.rgba[si + 2] <= blackThreshold) continue;
        const di = rowDst + (src.worldX + x - tileX0) * 4;
        buf[di] = src.rgba[si];
        buf[di + 1] = src.rgba[si + 1];
        buf[di + 2] = src.rgba[si + 2];
        buf[di + 3] = src.rgba[si + 3];
      }
    }
  }
  return buf;
}

/** changed 合成：新图有像素处用新图，透明处保留基底 */
function mergedBuf(base, inc) {
  const buf = Buffer.from(base);
  for (let i = 0; i < buf.length; i += 4) {
    if (inc[i + 3] > 0) {
      buf[i] = inc[i];
      buf[i + 1] = inc[i + 1];
      buf[i + 2] = inc[i + 2];
      buf[i + 3] = inc[i + 3];
    }
  }
  return buf;
}

function hasContent(buf) {
  for (let i = 3; i < buf.length; i += 4) {
    if (buf[i]) return true;
  }
  return false;
}

/* ============================== 主流程 ============================== */

/**
 * 差分合并两套瓦片。输出目录会被清空。
 * @param {object} options
 * @param {string} options.baseDir       站点 tiles/<维度>/（含 manifest.json）
 * @param {string} options.incomingDir   新图文件目录（Xaero 导出 PNG / 区域 zip 混放）
 * @param {string} options.outDir        合并结果输出目录
 * @param {number} [options.voidLuminance=8]
 * @param {number} [options.diffThreshold=24]
 * @param {boolean} [options.fillNew=true]
 * @param {boolean} [options.updateChanged=true]
 * @param {(info:object)=>void} [options.onProgress]
 * @returns {Promise<{manifest:object,outDir:string,counts:object,blocksArea:object,
 *                    grid:{cols:number,rows:number,map:number[]},durationMs:number}>}
 */
export async function mergeTileSets({
  baseDir,
  incomingDir,
  outDir,
  voidLuminance = 8,
  diffThreshold = 24,
  fillNew = true,
  updateChanged = true,
  keepBlack = false,
  blackThreshold = 10,
  onProgress = null,
} = {}) {
  if (!baseDir || !incomingDir || !outDir) throw new Error('mergeTileSets 缺少 baseDir/incomingDir/outDir');
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const started = Date.now();
  const voidLum = clamp(num(voidLuminance, 8), 0, 255);
  const diffThr = clamp(num(diffThreshold, 24), 0, 255);

  // ---- 基底 manifest 与网格 ----
  let baseManifest;
  try {
    baseManifest = JSON.parse(await fs.readFile(path.join(baseDir, 'manifest.json'), 'utf8'));
  } catch (err) {
    throw new Error(`读取基底 manifest.json 失败：${err.message}`);
  }
  const tileSize = baseManifest?.tileSize;
  if (!(Number.isInteger(tileSize) && tileSize > 0 && tileSize % 2 === 0)) {
    throw new Error('基底 manifest 的 tileSize 无效（需要正的偶数）');
  }
  const range = baseManifest.worldBlockRange;
  if (!range || !(range.xMax > range.xMin) || !(range.zMax > range.zMin)) {
    throw new Error('基底 manifest 缺少有效的 worldBlockRange');
  }
  const spanX = range.xMax - range.xMin;
  const spanZ = range.zMax - range.zMin;
  if (spanX % tileSize !== 0 || spanZ % tileSize !== 0) {
    throw new Error(`基底瓦片网格与 tileSize 不一致（${spanX}×${spanZ} / ${tileSize}），请先在主编辑器重新生成瓦片`);
  }
  const cols = spanX / tileSize;
  const rows = spanZ / tileSize;
  if (cols * rows > MAX_LEVEL0_TILES) {
    throw new Error(`基底瓦片网格太大（${cols}×${rows} = ${cols * rows} 张 level-0 瓦片），超出合并能力`);
  }
  const grid = { xMin: range.xMin, zMin: range.zMin, xMax: range.xMax, zMax: range.zMax, cols, rows };

  // ---- 新图扫描与解码 ----
  const scan = await inspectXaeroSource(incomingDir);
  if (!scan.bounds) {
    throw new Error('新图里没有可用的 Xaero 导出 PNG（文件名需带 x<X>_z<Z>）或区域 zip');
  }
  if (scan.bounds.xMax <= range.xMin || scan.bounds.xMin >= range.xMax || scan.bounds.zMax <= range.zMin || scan.bounds.zMin >= range.zMax) {
    throw new Error(
      `新图与目标瓦片集在世界坐标上完全不重叠（新图 X ${scan.bounds.xMin}..${scan.bounds.xMax} · Z ${scan.bounds.zMin}..${scan.bounds.zMax}；` +
        `目标 X ${range.xMin}..${range.xMax} · Z ${range.zMin}..${range.zMax}）`,
    );
  }
  report({ phase: 'scan', scan });

  const sources = [];
  let decoded = 0;
  let skipped = 0;
  let rgbaBytes = 0;
  for (const file of scan.pngFiles) {
    const m = /x(-?\d+)_z(-?\d+)/i.exec(path.basename(file));
    if (!m) {
      skipped += 1;
      continue;
    }
    try {
      const png = decodePng(await fs.readFile(file));
      sources.push({ worldX: Number(m[1]), worldZ: Number(m[2]), width: png.width, height: png.height, rgba: png.rgba });
      decoded += 1;
      rgbaBytes += png.rgba.length;
    } catch (err) {
      skipped += 1;
      report({ phase: 'skip', file, error: err.message });
    }
  }
  for (const file of scan.regionFiles) {
    const m = /(-?\d+)_(-?\d+)\.zip$/i.exec(path.basename(file));
    if (!m) {
      skipped += 1;
      continue;
    }
    try {
      const raw = await fs.readFile(file);
      const entry = readZipEntry(raw);
      if (!entry) throw new Error('zip 里没有 region 数据');
      const result = decodeRegionPayload(entry.content);
      sources.push({
        worldX: Number(m[1]) * REGION_BLOCKS,
        worldZ: Number(m[2]) * REGION_BLOCKS,
        width: REGION_BLOCKS,
        height: REGION_BLOCKS,
        rgba: result.blocks,
      });
      decoded += 1;
      rgbaBytes += result.blocks.length;
    } catch (err) {
      skipped += 1;
      report({ phase: 'skip', file, error: err.message });
    }
  }
  if (!decoded) throw new Error('新图文件找到了，但没有一个能成功解码');
  if (rgbaBytes > MAX_SOURCE_RGBA_BYTES) {
    throw new Error(`新图解码后太大（${Math.round(rgbaBytes / 1024 / 1024)} MB > 512 MB），请分多次合并`);
  }

  // ---- 输出目录 ----
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const outTilesRoot = path.join(outDir, 'tiles');
  const outLevel0 = path.join(outTilesRoot, '0');
  await fs.mkdir(outLevel0, { recursive: true });

  const baseTilesDir = path.join(baseDir, 'tiles', '0');
  let baseKeys = new Set();
  try {
    for (const name of await fs.readdir(baseTilesDir)) {
      if (/^\d+_\d+\.png$/i.test(name)) baseKeys.add(name.slice(0, -4));
    }
  } catch {
    /* 基底没有 level-0 目录：视为全空 */
  }

  // ---- 逐瓦片差分 + 写 level 0 ----
  const gridMap = new Uint8Array(cols * rows);
  const mask = new Uint8Array(cols * rows);
  const counts = { void: 0, onlyBase: 0, onlyIncoming: 0, changed: 0, same: 0 };
  const blocksArea = { onlyIncoming: 0, changed: 0 };
  let baseTiles = 0;
  let level0Written = 0;
  let copied = 0;
  const totalTiles = cols * rows;
  let lastReport = 0;

  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      const done = ty * cols + tx;
      if (done - lastReport >= 200 || done === totalTiles - 1) {
        lastReport = done;
        report({ phase: 'diff', done: done + 1, total: totalTiles });
      }
      const key = `${tx}_${ty}`;
      const baseBuf = baseKeys.has(key) ? await readTile(baseTilesDir, tx, ty) : null;
      if (baseBuf) baseTiles += 1;
      const incBuf = blitIntoTile({ sources, tx, ty, grid, tileSize, blackThreshold, keepBlack });

      const bm = tileMetrics(baseBuf, tileSize, voidLum);
      const im = tileMetrics(incBuf, tileSize, voidLum);
      let cls;
      if (bm.void && im.void) cls = TILE.VOID;
      else if (bm.void && !im.void) cls = TILE.ONLY_INCOMING;
      else if (!bm.void && im.void) cls = TILE.ONLY_BASE;
      else {
        const dist = Math.sqrt((bm.r - im.r) ** 2 + (bm.g - im.g) ** 2 + (bm.b - im.b) ** 2);
        cls = dist > diffThr ? TILE.CHANGED : TILE.SAME;
      }
      gridMap[done] = cls;
      counts[{ 0: 'void', 1: 'onlyBase', 2: 'onlyIncoming', 3: 'changed', 4: 'same' }[cls]] += 1;
      if (cls === TILE.ONLY_INCOMING) blocksArea.onlyIncoming += im.content;
      if (cls === TILE.CHANGED) blocksArea.changed += im.content;

      let out = null; // { mode:'copy' } | { mode:'write', buf }
      if (cls === TILE.ONLY_BASE || cls === TILE.SAME || (cls === TILE.CHANGED && !updateChanged)) {
        out = baseBuf ? { mode: 'copy' } : null;
      } else if (cls === TILE.ONLY_INCOMING && fillNew) {
        out = { mode: 'write', buf: incBuf };
      } else if (cls === TILE.CHANGED && updateChanged) {
        out = { mode: 'write', buf: mergedBuf(baseBuf, incBuf) };
      }
      if (out) {
        const target = path.join(outLevel0, `${key}.png`);
        if (out.mode === 'copy') {
          await fs.copyFile(path.join(baseTilesDir, `${key}.png`), target);
          copied += 1;
        } else {
          await fs.writeFile(target, encodePng(tileSize, tileSize, out.buf));
        }
        if (out.mode === 'copy' ? hasContent(baseBuf) : hasContent(out.buf)) {
          mask[done] = 1;
          level0Written += 1;
        } else {
          await fs.rm(target, { force: true });
        }
      }
    }
  }

  // ---- 金字塔 ----
  const levels = [];
  let level = 0;
  let lcols = cols;
  let lrows = rows;
  let prevMask = mask;
  let tilesWritten = level0Written;
  const levelMeta = (lvl, c, r) => ({
    level: lvl,
    minX: 0,
    maxX: c - 1,
    minZ: 0,
    maxZ: r - 1,
    cols: c,
    rows: r,
    blocksPerPixel: 2 ** lvl,
    originBlockX: range.xMin,
    originBlockZ: range.zMin,
  });
  levels.push(levelMeta(0, cols, rows));
  const half = tileSize / 2;

  while (!(lcols === 1 && lrows === 1)) {
    const ncols = Math.max(1, Math.ceil(lcols / 2));
    const nrows = Math.max(1, Math.ceil(lrows / 2));
    const nextMask = new Uint8Array(ncols * nrows);
    const levelDir = path.join(outTilesRoot, String(level + 1));
    await fs.mkdir(levelDir, { recursive: true });
    const childDir = level === 0 ? outLevel0 : path.join(outTilesRoot, String(level));
    let written = 0;
    for (let ty = 0; ty < nrows; ty += 1) {
      for (let tx = 0; tx < ncols; tx += 1) {
        const buf = Buffer.alloc(tileSize * tileSize * 4);
        let any = false;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const cx = tx * 2 + dx;
            const cy = ty * 2 + dy;
            if (cx >= lcols || cy >= lrows || !prevMask[cy * lcols + cx]) continue;
            const child = await readTile(childDir, cx, cy);
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
        if (any) {
          await fs.writeFile(path.join(levelDir, `${tx}_${ty}.png`), encodePng(tileSize, tileSize, buf));
          nextMask[ty * ncols + tx] = 1;
          written += 1;
        }
      }
    }
    if (!written) break;
    tilesWritten += written;
    levels.push(levelMeta(level + 1, ncols, nrows));
    lcols = ncols;
    lrows = nrows;
    prevMask = nextMask;
    level += 1;
    report({ phase: 'level', level, cols: lcols, rows: lrows, written });
    if (level > 32) throw new Error('金字塔层级异常（超过 32 层）');
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    tileSize,
    source: 'tile-merge',
    levels,
    worldBlockRange: { xMin: range.xMin, xMax: range.xMax, zMin: range.zMin, zMax: range.zMax },
    stats: {
      kind: scan.kind,
      images: scan.images,
      regions: scan.regions,
      decoded,
      skipped,
      level0Tiles: cols * rows,
      tilesWritten,
      baseTiles,
      copied,
      diff: { counts, blocksArea, voidLuminance: voidLum, diffThreshold: diffThr, fillNew, updateChanged },
    },
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  report({ phase: 'done', manifest, durationMs: Date.now() - started });
  return {
    manifest,
    outDir,
    counts,
    blocksArea,
    grid: { cols, rows, map: Array.from(gridMap) },
    durationMs: Date.now() - started,
  };
}

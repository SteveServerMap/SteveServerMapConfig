#!/usr/bin/env node
/**
 * xaero-probe.mjs —— Xaero World Map 数据探针
 *
 * 用途：把 Xaero 世界地图的缓存数据读出来，回答三个问题：
 *   1. 这份数据覆盖了哪些世界 / 维度 / 区域？范围多大？
 *   2. 区域文件里能解析出哪些方块 ID（调色板）？
 *   3. 每个文件的头部/结构有什么特征（用于后续写像素解码器）？
 *
 * 用法：
 *   node tools/xaero-probe.mjs <目录或文件> [--json=<输出文件>] [--sample=8]
 *
 *   <目录> 可以是解压后的 world-map 目录（例如 .../world-map/Multiplayer_xxx.com/null/mw$default），
 *          也可以是它的上级目录（会自动递归找 *.zip / *.xwmc）。
 *   --sample=N  每个维度抽多少个区域做深度分析（默认 8）
 *   --json=路径 把完整结果写成 JSON（默认写 .data/xaero-report.json）
 *
 * 零依赖：只用 node:fs / node:path / node:zlib（zip 用系统 unzip 语义自己最小解析）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/* ---------------------------------- 工具 ---------------------------------- */

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SAMPLE = Number(opt('sample', 8)) || 8;

/** Xaero 世界地图的区域大小（方块）。每个区域 32×32 区块 = 512×512 方块，渲染 512×512 像素 */
const REGION_BLOCKS = 512;
/** 区域文件名：<regionX>_<regionZ>.zip */
const REGION_NAME_RE = /^(-?\d+)_(-?\d+)\.(zip|xwmc|xaero)$/i;

if (!target) {
  console.error('用法：node tools/xaero-probe.mjs <目录或文件> [--json=<输出文件>] [--sample=8]');
  process.exit(2);
}

const absTarget = path.resolve(target);

/* -------------------------------- 最小 zip 解析 -------------------------------- */

/**
 * 从 zip 里取出唯一的条目内容（Xaero 的区域 zip 里只有一个 region.xaero / cache.xaero）。
 * 只支持 stored(0) 与 deflate(8)——Xaero 只会用这两种。
 */
function readZipEntry(buf) {
  // 找 End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let best = null;
  for (let n = 0; n < entries; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    let content = null;
    try {
      content = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : null;
    } catch {
      content = null;
    }
    if (!content) continue;
    if (!best || content.length > best.content.length) best = { name, rawSize, content };
  }
  return best;
}

/* --------------------------------- NBT 解析 --------------------------------- */

/**
 * 极简 NBT 读取器：Xaero 用 NBT 表示方块状态（`{id:"minecraft:stone", properties:{...}}`）。
 * 返回 { value, end }；失败返回 null。
 */
function parseNbt(buf, offset, depth = 0) {
  let p = offset;
  if (depth > 32) return null;
  const read = (n) => {
    if (p + n > buf.length) throw new RangeError('越界');
    const out = buf.subarray(p, p + n);
    p += n;
    return out;
  };
  const readTag = (limit) => {
    if (p >= buf.length) throw new RangeError('越界');
    const type = buf[p];
    p += 1;
    if (type === 0) return { type, name: null, value: null };
    const nameLen = read(2).readUInt16BE(0);
    const name = read(nameLen).toString('utf8');
    return { type, name, value: readPayload(type, limit) };
  };
  const readPayload = (type, limit) => {
    switch (type) {
      case 1: return read(1).readInt8(0);
      case 2: return read(2).readInt16BE(0);
      case 3: return read(4).readInt32BE(0);
      case 4: return Number(read(8).readBigInt64BE(0));
      case 5: return read(4).readFloatBE(0);
      case 6: return read(8).readDoubleBE(0);
      case 7: {
        const n = read(4).readInt32BE(0);
        return Buffer.from(read(n));
      }
      case 8: {
        const n = read(2).readUInt16BE(0);
        return read(n).toString('utf8');
      }
      case 9: {
        const itemType = buf[p];
        p += 1;
        const n = read(4).readInt32BE(0);
        const list = [];
        if (itemType !== 0) {
          for (let i = 0; i < n && list.length < 4096; i += 1) list.push(readPayload(itemType, limit));
        }
        return list;
      }
      case 10: {
        const obj = {};
        let guard = 0;
        while (p < buf.length && guard < 4096) {
          guard += 1;
          if (buf[p] === 0) {
            p += 1;
            return obj;
          }
          const { name, value } = readTag(limit);
          if (name != null) obj[name] = value;
        }
        return obj;
      }
      case 11: {
        const n = read(4).readInt32BE(0);
        const arr = [];
        for (let i = 0; i < n; i += 1) arr.push(read(4).readInt32BE(0));
        return arr;
      }
      case 12: {
        const n = read(4).readInt32BE(0);
        const arr = [];
        for (let i = 0; i < n; i += 1) arr.push(Number(read(8).readBigInt64BE(0)));
        return arr;
      }
      default:
        throw new RangeError(`未知 tag ${type}`);
    }
  };

  try {
    const { value } = readTag(null);
    return { value, end: p };
  } catch {
    return null;
  }
}

/** 从任意 offset 开始尝试解析若干 NBT 方块状态，返回找到的 ID 列表与命中位置 */
function collectBlockIds(buf, { max = 600, minHits = 1 } = {}) {
  const ids = [];
  const hits = [];
  const marker = Buffer.from([0x0a, 0x00, 0x00, 0x08, 0x00, 0x02, 0x69, 0x64]); // 0a 00 00 08 00 02 'id'
  let i = buf.indexOf(marker);
  while (i >= 0 && hits.length < max) {
    const parsed = parseNbt(buf, i);
    const id = parsed && parsed.value && typeof parsed.value === 'object' ? parsed.value.id : null;
    if (typeof id === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)) {
      ids.push(id);
      hits.push(i);
    }
    i = buf.indexOf(marker, i + 1);
  }
  return { ids, hits, complete: hits.length >= minHits };
}

/* --------------------------------- 目录扫描 --------------------------------- */

/** 判断一个路径是否是 Xaero 区域文件，返回 {world, dim, rx, rz, kind} */
function parseRegionPath(filePath, root) {
  const rel = path.relative(root, filePath);
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1];
  const m = REGION_NAME_RE.exec(base);
  if (!m) return null;
  const rx = Number(m[1]);
  const rz = Number(m[2]);
  const ext = m[3].toLowerCase();
  if (ext === 'xaero') return null; // 解压出来的裸文件不参与（已在 zip 里统计）
  // 结构：<world>/<dim>/mw$default[/caves/<n>]/<rx>_<rz>.<ext>
  const mwIndex = parts.indexOf('mw$default');
  const dimIndex = mwIndex > 0 ? mwIndex - 1 : parts.length - 4;
  const world = dimIndex > 0 ? parts[dimIndex - 1] : '(unknown)';
  const dim = parts[dimIndex] || '(unknown)';
  const isCaves = parts.includes('caves');
  return { world, dim: String(dim), rx, rz, ext, kind: ext === 'xwmc' ? 'cache' : 'region', isCaves, rel };
}

async function walk(dir, out = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(zip|xwmc)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/* ----------------------------------- 主流程 ----------------------------------- */

async function main() {
  const stat = await fsp.stat(absTarget).catch(() => null);
  if (!stat) {
    console.error(`路径不存在：${absTarget}`);
    process.exit(2);
  }

  const root = stat.isDirectory() ? absTarget : path.dirname(absTarget);
  const files = stat.isDirectory() ? await walk(absTarget) : [absTarget];
  if (!files.length) {
    console.error('没有找到 .zip / .xwmc 文件（请先解压 world-map.rar，再指向 world-map 目录）');
    process.exit(2);
  }

  /** world → dim → {regions:[], caches:[]} */
  const groups = new Map();
  for (const file of files) {
    const info = parseRegionPath(file, root);
    if (!info) continue;
    const key = `${info.world}||${info.dim}`;
    if (!groups.has(key)) groups.set(key, { world: info.world, dim: info.dim, regions: [], caches: [] });
    const group = groups.get(key);
    if (info.kind === 'region') group.regions.push({ file, ...info });
    else group.caches.push({ file, ...info });
  }

  const report = { generatedAt: new Date().toISOString(), root, regionBlocks: REGION_BLOCKS, groups: [], samples: [] };

  for (const group of groups.values()) {
    const coords = group.regions.map((r) => [r.rx, r.rz]);
    const xs = coords.map((c) => c[0]);
    const zs = coords.map((c) => c[1]);
    const bounds = coords.length
      ? {
          regionX: [Math.min(...xs), Math.max(...xs)],
          regionZ: [Math.min(...zs), Math.max(...zs)],
          blockX: [Math.min(...xs) * REGION_BLOCKS, (Math.max(...xs) + 1) * REGION_BLOCKS],
          blockZ: [Math.min(...zs) * REGION_BLOCKS, (Math.max(...zs) + 1) * REGION_BLOCKS],
        }
      : null;
    if (bounds) {
      bounds.widthBlocks = bounds.blockX[1] - bounds.blockX[0];
      bounds.heightBlocks = bounds.blockZ[1] - bounds.blockZ[0];
    }
    report.groups.push({
      world: group.world,
      dim: group.dim,
      regions: group.regions.length,
      caches: group.caches.length,
      bounds,
    });
  }

  // 抽样深度分析：每个维度取 --sample 个区域
  const byGroup = new Map();
  for (const group of groups.values()) byGroup.set(`${group.world}||${group.dim}`, group);
  for (const [key, group] of byGroup) {
    const picks = [...group.regions].sort((a, b) => a.rx - b.rx || a.rz - b.rz).slice(0, SAMPLE);
    for (const pick of picks) {
      const buf = await fsp.readFile(pick.file).catch(() => null);
      if (!buf) continue;
      const entry = readZipEntry(buf);
      if (!entry) continue;
      const ids = collectBlockIds(entry.content);
      const header = entry.content.subarray(0, 24).toString('hex').match(/../g)?.join(' ') ?? '';
      report.samples.push({
        world: pick.world,
        dim: pick.dim,
        region: [pick.rx, pick.rz],
        zipBytes: buf.length,
        payloadBytes: entry.content.length,
        payloadHead: header,
        blockIdCount: ids.ids.length,
        blockIds: [...new Set(ids.ids)].slice(0, 40),
      });
    }
  }

  // 人类可读摘要
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log(`Xaero 数据探测：${root}`);
  console.log(`共 ${files.length} 个区域/缓存文件，${report.groups.length} 个 世界×维度 组合`);
  console.log('');
  console.log(`${pad('世界', 26)}${pad('维度', 10)}${pad('区域', 7)}${pad('缓存', 7)}覆盖范围（方块）`);
  for (const g of report.groups) {
    const b = g.bounds;
    const span = b ? `X ${b.blockX[0]}..${b.blockX[1]}（${b.widthBlocks}）· Z ${b.blockZ[0]}..${b.blockZ[1]}（${b.heightBlocks}）` : '—';
    console.log(`${pad(g.world, 26)}${pad(g.dim, 10)}${pad(g.regions, 7)}${pad(g.caches, 7)}${span}`);
  }
  if (report.samples.length) {
    console.log('');
    console.log('抽样区域结构（payload = zip 里 region.xaero 解压后的大小）：');
    console.log(`${pad('区域', 14)}${pad('zip', 10)}${pad('payload', 11)}${pad('方块ID数', 9)}头部 16 字节`);
    for (const s of report.samples) {
      console.log(`${pad(`${s.region[0]}_${s.region[1]}`, 14)}${pad(s.zipBytes, 10)}${pad(s.payloadBytes, 11)}${pad(s.blockIdCount, 9)}${s.payloadHead}`);
    }
    const allIds = new Set(report.samples.flatMap((s) => s.blockIds));
    console.log('');
    console.log(`抽样可解析出的方块 ID（${allIds.size} 种）：${[...allIds].slice(0, 12).join(', ')}${allIds.size > 12 ? ' …' : ''}`);
  }

  const outFile = path.resolve(opt('json', path.join('.data', 'xaero-report.json')));
  await fsp.mkdir(path.dirname(outFile), { recursive: true }).catch(() => {});
  await fsp.writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log('');
  console.log(`完整报告：${outFile}`);
}

main().catch((err) => {
  console.error('探测失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});

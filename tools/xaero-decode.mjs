#!/usr/bin/env node
/**
 * xaero-decode.mjs —— 把 Xaero World Map 的 region.xaero 解成 PNG
 *
 * 格式来源：Xaero 的 mod jar 字节码（save 8.8 / xaeroworldmap-fabric-26.3-1.47.0）：
 *   DataOutputStream.write(0xFF)           // 魔数
 *   writeInt((major << 16) | minor)        // 版本，8.8 → 0x00080008
 *   write(flags)                           // 见下
 *   write(worldInterpretationVersion)      // 仅当 flags 含 2
 *   writeInt(caveStart)                    // 仅当 flags 含 4（-1 表示无）
 *   write(caveDepth)                       // 仅当 flags 含 4
 *   write(64 字节)                          // 8×8 区块存在表（每字节一个 MapTileChunk 的 loadState）
 *   每个存在的 chunk：
 *     writeInt(tileGridCache 相关)          // 占位/缓存
 *     4×4 个 MapTile：
 *       writeInt(标志)                      // 0 = 空 tile
 *       16×16 个方块：savePixel()
 *         writeInt(parametres)
 *           bit0  有方块状态
 *           bit1  有 overlay
 *           bit8-15 light
 *           bit12-19 / bit25-28 height（12 位）
 *           bit20 有 biome
 *           bit21 方块状态是内联 NBT（否则写调色板索引）
 *           bit22 biome 是内联 UTF（否则写调色板索引）
 *           bit24 有 topHeight（多一个字节）
 *     ...
 *
 * 用法：
 *   node tools/xaero-decode.mjs <region-xxx.zip | 目录> --out=<输出.png> [--max=4096]
 *
 * 输出：把区域里已经探索过的方块渲染成 1 px = 1 方块 的 PNG（未探索处透明）。
 * 颜色：内置一份「方块 ID → 颜色」近似表（Xaero 自己的配色是私有资源，这里只求形似）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/* ------------------------------- 参数 ------------------------------- */

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT = opt('out', null);
const MAX_SIDE = Number(opt('max', 0)) || 0;

if (!target || !OUT) {
  console.error('用法：node tools/xaero-decode.mjs <region-xxx.zip | 目录> --out=<输出.png> [--max=4096]');
  process.exit(2);
}

/* --------------------------- zip 读取（单条目） --------------------------- */

function readZipEntry(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let best = null;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const content = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!content) continue;
    if (!best || content.length > best.content.length) best = { name, content };
  }
  return best;
}

/* ------------------------------- NBT 读取 ------------------------------- */

/** 只支持 Xaero 写方块状态用到的类型（byte/short/int/long/float/double/array/string/list/compound） */
function makeNbtReader(buf) {
  let p = 0;
  const need = (n) => { if (p + n > buf.length) throw new RangeError('NBT 越界'); };
  const read = (n) => { need(n); const out = buf.subarray(p, p + n); p += n; return out; };
  function payload(type) {
    switch (type) {
      case 1: return read(1).readInt8(0);
      case 2: return read(2).readInt16BE(0);
      case 3: return read(4).readInt32BE(0);
      case 4: return Number(read(8).readBigInt64BE(0));
      case 5: return read(4).readFloatBE(0);
      case 6: return read(8).readDoubleBE(0);
      case 7: { const n = read(4).readInt32BE(0); return read(n); }
      case 8: { const n = read(2).readUInt16BE(0); return read(n).toString('utf8'); }
      case 9: {
        const itemType = read(1)[0];
        const n = read(4).readInt32BE(0);
        const list = [];
        for (let i = 0; i < n && i < 4096; i += 1) list.push(itemType === 0 ? null : payload(itemType));
        return list;
      }
      case 10: {
        const obj = {};
        for (let guard = 0; guard < 4096; guard += 1) {
          const t = read(1)[0];
          if (t === 0) return obj;
          const nameLen = read(2).readUInt16BE(0);
          const name = read(nameLen).toString('utf8');
          obj[name] = payload(t);
        }
        return obj;
      }
      case 11: { const n = read(4).readInt32BE(0); const arr = []; for (let i = 0; i < n; i += 1) arr.push(read(4).readInt32BE(0)); return arr; }
      case 12: { const n = read(4).readInt32BE(0); const arr = []; for (let i = 0; i < n && i < 4096; i += 1) arr.push(Number(read(8).readBigInt64BE(0))); return arr; }
      default: throw new RangeError(`未知 tag ${type}`);
    }
  }
  return {
    get offset() { return p; },
    set offset(v) { p = v; },
    /** 读一个具名 compound（根 tag 是 10） */
    readRoot() {
      const type = read(1)[0];
      if (type !== 10) throw new RangeError(`根 tag 不是 compound：${type}`);
      const nameLen = read(2).readUInt16BE(0);
      read(nameLen);
      return payload(10);
    },
    skip(n) { p += n; },
  };
}

/* ----------------------------- 区域解码 ----------------------------- */

const REGION_BLOCKS = 512;
const CHUNKS = 8;   // MapRegion.SIDE_LENGTH
const TILES = 4;    // MapTileChunk.SIDE_LENGTH
const TILE_BLOCKS = 16;

/** 单方块颜色（近似 Xaero / 原版地图色）：只求形似，不求一致 */
const BLOCK_COLORS = new Map(Object.entries({
  'minecraft:water': [0x3f, 0x76, 0xe4],
  'minecraft:ocean': [0x30, 0x5a, 0xa8],
  'minecraft:grass_block': [0x5d, 0x9a, 0x4a],
  'minecraft:short_grass': [0x6a, 0xa8, 0x4e],
  'minecraft:short_dry_grass': [0xa8, 0x96, 0x4e],
  'minecraft:tall_dry_grass': [0xb0, 0x9a, 0x52],
  'minecraft:grass': [0x6a, 0xa8, 0x4e],
  'minecraft:dirt': [0x86, 0x63, 0x44],
  'minecraft:coarse_dirt': [0x7a, 0x58, 0x3b],
  'minecraft:podzol': [0x6b, 0x4a, 0x28],
  'minecraft:mud': [0x3d, 0x38, 0x33],
  'minecraft:sand': [0xdb, 0xd3, 0xa0],
  'minecraft:sandstone': [0xd8, 0xcc, 0x94],
  'minecraft:gravel': [0x88, 0x83, 0x80],
  'minecraft:stone': [0x7f, 0x7f, 0x7f],
  'minecraft:cobblestone': [0x82, 0x82, 0x82],
  'minecraft:andesite': [0x8a, 0x8a, 0x88],
  'minecraft:diorite': [0xc0, 0xc0, 0xbe],
  'minecraft:granite': [0x96, 0x6a, 0x5a],
  'minecraft:deepslate': [0x4f, 0x4f, 0x55],
  'minecraft:tuff': [0x6b, 0x6d, 0x63],
  'minecraft:snow': [0xf2, 0xf8, 0xff],
  'minecraft:snow_block': [0xf2, 0xf8, 0xff],
  'minecraft:ice': [0x9d, 0xba, 0xf7],
  'minecraft:packed_ice': [0x94, 0xb1, 0xf0],
  'minecraft:lava': [0xd4, 0x5a, 0x14],
  'minecraft:oak_leaves': [0x48, 0x6e, 0x2b],
  'minecraft:birch_leaves': [0x6d, 0x84, 0x3a],
  'minecraft:spruce_leaves': [0x37, 0x51, 0x2b],
  'minecraft:dark_oak_leaves': [0x33, 0x53, 0x22],
  'minecraft:jungle_leaves': [0x3f, 0x7a, 0x21],
  'minecraft:acacia_leaves': [0x5d, 0x7d, 0x2c],
  'minecraft:mangrove_leaves': [0x3a, 0x6b, 0x2b],
  'minecraft:cherry_leaves': [0xe8, 0xb2, 0xc8],
  'minecraft:azalea_leaves': [0x5c, 0x7a, 0x3a],
  'minecraft:flowering_azalea_leaves': [0x6f, 0x7f, 0x45],
  'minecraft:azalea': [0x63, 0x7a, 0x3f],
  'minecraft:flowering_azalea': [0x74, 0x7f, 0x4a],
  'minecraft:moss_block': [0x59, 0x6f, 0x33],
  'minecraft:moss_carpet': [0x59, 0x6f, 0x33],
  'minecraft:cinnabar': [0x8e, 0x3d, 0x35],
  'minecraft:dead_bush': [0x8a, 0x6c, 0x3a],
  'minecraft:kelp': [0x3f, 0x5f, 0x3f],
  'minecraft:seagrass': [0x3e, 0x7a, 0x4e],
  'minecraft:clay': [0xa0, 0xa6, 0xb4],
  'minecraft:iron_ore': [0x9c, 0x8d, 0x7f],
  'minecraft:coal_ore': [0x53, 0x53, 0x53],
  'minecraft:oak_log': [0x6b, 0x55, 0x33],
  'minecraft:birch_log': [0xd7, 0xcf, 0xb8],
  'minecraft:stone_bricks': [0x7a, 0x7a, 0x7a],
  'minecraft:bricks': [0x96, 0x5c, 0x4c],
  'minecraft:glass': [0xc8, 0xe4, 0xf0],
  'minecraft:wildflowers': [0xb7, 0x9a, 0x4a],
  'minecraft:oxeye_daisy': [0xc9, 0xc9, 0x8a],
  'minecraft:dandelion': [0xc9, 0xb4, 0x3a],
}));

/** 没有配色表的方块：用名字哈希出一个稳定的土色系，避免整张图都是黑白 */
function fallbackColor(blockId) {
  let h = 2166136261;
  for (let i = 0; i < blockId.length; i += 1) {
    h ^= blockId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const r = 96 + (h & 0x3f);
  const g = 88 + ((h >>> 6) & 0x3f);
  const b = 76 + ((h >>> 12) & 0x3f);
  return [r, g, b];
}

function colorOf(blockId) {
  if (!blockId) return null;
  const hit = BLOCK_COLORS.get(blockId);
  if (hit) return hit;
  const short = blockId.replace('minecraft:', '');
  if (short.includes('leaves')) return BLOCK_COLORS.get('minecraft:oak_leaves');
  if (short.includes('water') || short === 'ocean') return BLOCK_COLORS.get('minecraft:water');
  if (short.includes('grass')) return BLOCK_COLORS.get('minecraft:grass_block');
  if (short.includes('sand')) return BLOCK_COLORS.get('minecraft:sand');
  if (short.includes('snow') || short.includes('ice')) return BLOCK_COLORS.get('minecraft:snow');
  if (short.includes('stone') || short.includes('deepslate')) return BLOCK_COLORS.get('minecraft:stone');
  if (short.includes('log') || short.includes('wood')) return BLOCK_COLORS.get('minecraft:oak_log');
  return fallbackColor(blockId);
}

/**
 * 解码一个 region.xaero 的 payload。
 * 返回 { version, flags, caveStart, caveDepth, width, height, blocks: Uint8Array(512*512*4) }
 */
function decodeRegionPayload(payload) {
  let p = 0;
  const u8 = () => {
    if (p >= payload.length) throw new RangeError('读越界');
    const v = payload[p];
    p += 1;
    return v;
  };
  const i32 = () => {
    if (p + 4 > payload.length) throw new RangeError('读越界');
    const v = payload.readInt32BE(p);
    p += 4;
    return v;
  };
  const i16 = () => {
    if (p + 2 > payload.length) throw new RangeError('读越界');
    const v = payload.readInt16BE(p);
    p += 2;
    return v;
  };

  // 头部只有 6 字节：魔数(1) + 版本 int(4) + flags(1)
  const magic = u8();
  const versionRaw = i32();
  const version = { major: versionRaw >>> 16, minor: versionRaw & 0xffff };
  const flags = u8();

  const width = REGION_BLOCKS;
  const height = REGION_BLOCKS;
  const blocks = new Uint8Array(width * height * 4); // RGBA

  // 调色板按写入顺序累积（内联 NBT 时追加，索引 = 当时表长）
  const blockPalette = [];
  const biomePalette = [];
  let pixels = 0;
  let tiles = 0;
  let emptyTiles = 0;

  // 区块流：第一个区块没有标记字节，之后每个存在的区块前有 1 字节标记 (chunkX << 4) | chunkZ
  let cx = 0;
  let cz = 0;
  let chunkIndex = 0;
  while (p < payload.length) {
    if (chunkIndex > 0) {
      const marker = u8();
      cx = (marker >> 4) & 0xf;
      cz = marker & 0xf;
    }
    chunkIndex += 1;
    for (let tx = 0; tx < TILES; tx += 1) {
        for (let tz = 0; tz < TILES; tz += 1) {
          // 空 tile 只写一个 -1；有数据的 tile 直接就是第一个方块的 parametres
          const firstParametres = i32();
          if (firstParametres === -1) {
            emptyTiles += 1;
            continue;
          }
          tiles += 1;
          // 256 个方块：x 外层、z 内层
          for (let bx = 0; bx < TILE_BLOCKS; bx += 1) {
            for (let bz = 0; bz < TILE_BLOCKS; bz += 1) {
              const parametres = bx === 0 && bz === 0 ? firstParametres : i32();
              const hasState = (parametres & 1) !== 0;
              const hasOverlays = (parametres & 2) !== 0;
              const hasBiome = (parametres & 0x100000) !== 0;
              const stateInline = (parametres & 0x200000) !== 0;
              const biomeInline = (parametres & 0x400000) !== 0;
              const hasTopHeight = (parametres & 0x1000000) !== 0;

              let blockId = null;
              if (hasState) {
                if (stateInline) {
                  const reader = makeNbtReader(payload.subarray(p));
                  const nbt = reader.readRoot();
                  p += reader.offset;
                  blockId = typeof nbt?.id === 'string' ? nbt.id : null;
                  blockPalette.push(blockId);
                } else {
                  const idx = i32();
                  blockId = blockPalette[idx] ?? null;
                }
              }
              if (hasTopHeight) u8();
              if (hasOverlays) {
                const overlays = u8();
                for (let o = 0; o < overlays; o += 1) {
                  const overlayParam = i32();
                  const overlayHasState = (overlayParam & 1) !== 0;
                  if (overlayHasState) {
                    if ((overlayParam & 0x400) !== 0) {
                      const reader = makeNbtReader(payload.subarray(p));
                      reader.readRoot();
                      p += reader.offset;
                    } else {
                      i32();
                    }
                  }
                }
              }
              if (hasBiome) {
                if (biomeInline) {
                  const len = i16();
                  biomePalette.push(payload.toString('utf8', p, p + len));
                  p += len;
                } else {
                  i32();
                }
              }

              const worldX = cx * TILES * TILE_BLOCKS + tx * TILE_BLOCKS + bx;
              const worldZ = cz * TILES * TILE_BLOCKS + tz * TILE_BLOCKS + bz;
              const color = colorOf(blockId);
              if (color) {
                const out = (worldZ * width + worldX) * 4;
                blocks[out] = color[0];
                blocks[out + 1] = color[1];
                blocks[out + 2] = color[2];
                blocks[out + 3] = 255;
                pixels += 1;
              }
            }
          }
          // tile 尾：worldInterpretationVersion(1) + caveStart(4) + caveDepth(1)
          u8();
          i32();
          u8();
        }
      }
  }

  return {
    version,
    flags,
    magic,
    width,
    height,
    blocks,
    pixels,
    tiles,
    emptyTiles,
    chunks: chunkIndex,
    remaining: payload.length - p,
    blockPalette,
    biomePalette,
  };
}

/* -------------------------------- PNG 编码 -------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter none
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
  const stat = await fsp.stat(target);
  let files = [];
  if (stat.isDirectory()) {
    const walk = async (dir, out) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, out);
        else if (/\.zip$/i.test(entry.name)) out.push(full);
      }
      return out;
    };
    files = (await walk(target, [])).sort();
  } else {
    files = [target];
  }
  if (!files.length) {
    console.error('没有找到区域 zip');
    process.exit(2);
  }

  console.log(`共 ${files.length} 个区域文件`);
  let decoded = 0;
  const results = [];
  for (const file of files) {
    const buf = await fsp.readFile(file);
    const entry = readZipEntry(buf);
    if (!entry) continue;
    try {
      const result = decodeRegionPayload(entry.content);
      decoded += 1;
      results.push({ file, result });
      console.log(
        `${path.basename(file)}: v${result.version.major}.${result.version.minor} flags=${result.flags} ` +
          `区块=${result.chunks} 非空tile=${result.tiles} 调色板=${result.blockPalette.length} 方块=${result.pixels} 剩余字节=${result.remaining}`,
      );
    } catch (err) {
      console.log(`${path.basename(file)}: 解码失败 —— ${err.message}`);
    }
  }

  if (!results.length) {
    console.error('没有任何区域解码成功');
    process.exit(1);
  }

  // 合并成一张图（按区域文件名里的区域坐标）
  const REGION_RE = /^(-?\d+)_(-?\d+)\.zip$/i;
  const withCoords = results
    .map(({ file, result }) => {
      const m = REGION_RE.exec(path.basename(file));
      return m ? { rx: Number(m[1]), rz: Number(m[2]), result } : null;
    })
    .filter(Boolean);
  if (!withCoords.length) throw new Error('文件名里没有区域坐标，无法布局');

  const minX = Math.min(...withCoords.map((c) => c.rx));
  const maxX = Math.max(...withCoords.map((c) => c.rx));
  const minZ = Math.min(...withCoords.map((c) => c.rz));
  const maxZ = Math.max(...withCoords.map((c) => c.rz));
  let width = (maxX - minX + 1) * REGION_BLOCKS;
  let height = (maxZ - minZ + 1) * REGION_BLOCKS;
  if (MAX_SIDE && Math.max(width, height) > MAX_SIDE) {
    const cut = withCoords.slice(0, 1);
    const only = cut[0];
    width = REGION_BLOCKS;
    height = REGION_BLOCKS;
    withCoords.length = 0;
    withCoords.push({ ...only, rx: 0, rz: 0 });
    console.log(`--max=${MAX_SIDE}：只渲染第一个区域`);
  }

  const canvas = Buffer.alloc(width * height * 4);
  for (const { rx, rz, result } of withCoords) {
    const ox = (rx - (MAX_SIDE ? 0 : minX)) * REGION_BLOCKS;
    const oz = (rz - (MAX_SIDE ? 0 : minZ)) * REGION_BLOCKS;
    for (let y = 0; y < REGION_BLOCKS; y += 1) {
      const srcStart = y * REGION_BLOCKS * 4;
      const dstStart = ((oz + y) * width + ox) * 4;
      canvas.set(result.blocks.subarray(srcStart, srcStart + REGION_BLOCKS * 4), dstStart);
    }
  }

  const outPath = path.resolve(OUT);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, encodePng(width, height, canvas));
  console.log(`\n输出：${outPath}（${width}×${height} px）`);
  console.log(`世界坐标范围：X ${(MAX_SIDE ? 0 : minX) * REGION_BLOCKS}..${((MAX_SIDE ? 0 : maxX) + 1) * REGION_BLOCKS} · Z ${(MAX_SIDE ? 0 : minZ) * REGION_BLOCKS}..${((MAX_SIDE ? 0 : maxZ) + 1) * REGION_BLOCKS}`);
}

main().catch((err) => {
  console.error('解码失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});

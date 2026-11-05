/**
 * tests/tile-merge.test.mjs —— tools/tile-merge.mjs 的单元测试
 *
 * 运行：node --test tests/tile-merge.test.mjs
 *
 * 覆盖：
 *   1. 三格世界差分：onlyBase / onlyIncoming / changed / void 分类与像素合成；
 *   2. same / onlyBase 走字节级复制，金字塔层级与基底一致；
 *   3. fillNew=false / updateChanged=false 的开关语义；
 *   4. 输出目录先清空、manifest 契约（source / worldBlockRange / levels）；
 *   5. 错误路径：缺 manifest、坏 tileSize、空新图目录、解码失败、完全不重叠；
 *   6. 生成的 manifest 能通过站点 assets/js/tiles.js 的 parseManifest（站点仓库存在时）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodePng } from '../tools/xaero-decode.mjs';
import { decodePng, generateXaeroTiles } from '../tools/xaero-tiles.mjs';
import { mergeTileSets, TILE } from '../tools/tile-merge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(__dirname, '..');
const SITE_TILES_JS = path.resolve(TOOL_DIR, '..', 'SteveServerMap.github.io', 'assets', 'js', 'tiles.js');

const TS = 64;
const GREEN = [0, 200, 60, 255];
const BLUE = [40, 80, 220, 255];
const YELLOW = [240, 220, 60, 255];
const RED = [220, 40, 40, 255];

function solidPng(size, rgba) {
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    buf[i * 4] = rgba[0];
    buf[i * 4 + 1] = rgba[1];
    buf[i * 4 + 2] = rgba[2];
    buf[i * 4 + 3] = rgba[3];
  }
  return encodePng(size, size, buf);
}

async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssm-tile-merge-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 基底瓦片集：世界 0..192 × 0..192，3×3 level-0 网格；0_0 绿、2_2 蓝，其余未探索 */
async function makeBaseTileSet(t) {
  const source = await makeTempDir(t);
  const out = await makeTempDir(t);
  await fs.writeFile(path.join(source, '0_0_x0_z0.png'), solidPng(TS, GREEN));
  await fs.writeFile(path.join(source, '0_2_x128_z128.png'), solidPng(TS, BLUE));
  await generateXaeroTiles({ sourceDir: source, outDir: out, tileSize: TS });
  return out;
}

/** 新图目录：1_1 黄、2_2 红；extra 为 [name, rgba] 追加项 */
async function makeIncomingDir(t, extra = []) {
  const dir = await makeTempDir(t);
  await fs.writeFile(path.join(dir, '0_1_x64_z64.png'), solidPng(TS, YELLOW));
  await fs.writeFile(path.join(dir, '0_2_x128_z128.png'), solidPng(TS, RED));
  for (const [name, rgba] of extra) await fs.writeFile(path.join(dir, name), solidPng(TS, rgba));
  return dir;
}

const exists = (p) => fs.stat(p).then(() => true, () => false);

test('差分分类与合成：onlyBase 字节复制 / onlyIncoming 补入 / changed 用新图覆盖', async (t) => {
  const base = await makeBaseTileSet(t);
  const inc = await makeIncomingDir(t);
  const out = await makeTempDir(t);
  // 输出目录里有旧文件：合并必须先清空
  await fs.mkdir(path.join(out, 'tiles', '0'), { recursive: true });
  await fs.writeFile(path.join(out, 'tiles', '0', 'stray.png'), 'x');
  await fs.writeFile(path.join(out, 'stray.txt'), 'x');

  const result = await mergeTileSets({ baseDir: base, incomingDir: inc, outDir: out });

  assert.deepEqual(result.counts, { void: 6, onlyBase: 1, onlyIncoming: 1, changed: 1, same: 0 });
  assert.deepEqual(result.blocksArea, { onlyIncoming: TS * TS, changed: TS * TS });
  assert.deepEqual(result.grid, {
    cols: 3,
    rows: 3,
    map: [
      TILE.ONLY_BASE, TILE.VOID, TILE.VOID,
      TILE.VOID, TILE.ONLY_INCOMING, TILE.VOID,
      TILE.VOID, TILE.VOID, TILE.CHANGED,
    ],
  });

  assert.equal(await exists(path.join(out, 'stray.txt')), false, '输出目录应被清空');
  assert.equal(await exists(path.join(out, 'tiles', '0', 'stray.png')), false);

  // 0_0 只有基底：字节级复制
  const base00 = await fs.readFile(path.join(base, 'tiles', '0', '0_0.png'));
  const out00 = await fs.readFile(path.join(out, 'tiles', '0', '0_0.png'));
  assert.ok(base00.equals(out00), 'onlyBase 瓦片应逐字节复制');

  // 1_1 新增：写入新图内容
  const tile11 = decodePng(await fs.readFile(path.join(out, 'tiles', '0', '1_1.png')));
  assert.equal(tile11.width, TS);
  assert.deepEqual([...tile11.rgba.subarray(0, 4)], YELLOW);

  // 2_2 变更：新图不透明处覆盖
  const tile22 = decodePng(await fs.readFile(path.join(out, 'tiles', '0', '2_2.png')));
  assert.deepEqual([...tile22.rgba.subarray(0, 4)], RED);

  // void 瓦片不落盘
  assert.equal(await exists(path.join(out, 'tiles', '0', '0_1.png')), false);
  assert.equal(await exists(path.join(out, 'tiles', '0', '2_0.png')), false);

  // 金字塔与基底层级一致
  const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.source, 'tile-merge');
  assert.equal(manifest.tileSize, TS);
  assert.deepEqual(manifest.worldBlockRange, { xMin: 0, xMax: 192, zMin: 0, zMax: 192 });
  assert.deepEqual(
    manifest.levels.map((l) => [l.level, l.cols, l.rows]),
    [[0, 3, 3], [1, 2, 2], [2, 1, 1]],
  );
  assert.equal(await exists(path.join(out, 'tiles', '1', '0_0.png')), true);
  assert.equal(await exists(path.join(out, 'tiles', '2', '0_0.png')), true);
  assert.deepEqual(manifest.stats.diff.counts, result.counts);
  assert.equal(manifest.stats.copied, 1);
  assert.ok(manifest.stats.tilesWritten > 0);
  assert.equal(result.durationMs >= 0, true);

  // 与站点解析器做真实契约校验（站点仓库不存在时 skip）
  const siteExists = await exists(SITE_TILES_JS);
  if (siteExists) {
    const siteTiles = await import(pathToFileURL(SITE_TILES_JS).href);
    const tileset = siteTiles.parseManifest(manifest, { manifestUrl: 'tiles/overworld/manifest.json' });
    assert.ok(tileset, '站点 parseManifest 应接受合并出的 manifest');
    assert.equal(tileset.imageWidth, 192);
    assert.equal(tileset.imageHeight, 192);
    assert.equal(tileset.levels.length, 3);
  }
});

test('色差小于阈值的瓦片判为 same 并字节复制', async (t) => {
  const base = await makeBaseTileSet(t);
  const inc = await makeIncomingDir(t, [['0_0_x0_z0.png', [2, 202, 62, 255]]]);
  const out = await makeTempDir(t);

  const result = await mergeTileSets({ baseDir: base, incomingDir: inc, outDir: out });
  assert.equal(result.counts.same, 1);
  assert.equal(result.counts.changed, 1);

  const base00 = await fs.readFile(path.join(base, 'tiles', '0', '0_0.png'));
  const out00 = await fs.readFile(path.join(out, 'tiles', '0', '0_0.png'));
  assert.ok(base00.equals(out00), 'same 瓦片应逐字节复制基底');
});

test('fillNew=false 不补入新增瓦片（分类不变）', async (t) => {
  const base = await makeBaseTileSet(t);
  const inc = await makeIncomingDir(t);
  const out = await makeTempDir(t);

  const result = await mergeTileSets({ baseDir: base, incomingDir: inc, outDir: out, fillNew: false });
  assert.deepEqual(result.counts, { void: 6, onlyBase: 1, onlyIncoming: 1, changed: 1, same: 0 });
  assert.equal(await exists(path.join(out, 'tiles', '0', '1_1.png')), false, 'fillNew=false 不应写新增瓦片');
  assert.equal(await exists(path.join(out, 'tiles', '0', '2_2.png')), true, 'changed 仍应合成');
  assert.equal(result.manifest.stats.diff.fillNew, false);
});

test('updateChanged=false 变更瓦片沿用基底（字节复制）', async (t) => {
  const base = await makeBaseTileSet(t);
  const inc = await makeIncomingDir(t);
  const out = await makeTempDir(t);

  const result = await mergeTileSets({ baseDir: base, incomingDir: inc, outDir: out, updateChanged: false });
  assert.equal(result.counts.changed, 1);
  const base22 = await fs.readFile(path.join(base, 'tiles', '0', '2_2.png'));
  const out22 = await fs.readFile(path.join(out, 'tiles', '0', '2_2.png'));
  assert.ok(base22.equals(out22), 'updateChanged=false 应保留基底像素');
  const tile22 = decodePng(out22);
  assert.deepEqual([...tile22.rgba.subarray(0, 4)], BLUE);
});

test('错误路径：缺 manifest / 坏 tileSize / 空新图 / 解码失败 / 完全不重叠', async (t) => {
  const base = await makeBaseTileSet(t);
  const out = await makeTempDir(t);

  const emptyBase = await makeTempDir(t);
  await assert.rejects(
    () => mergeTileSets({ baseDir: emptyBase, incomingDir: base, outDir: out }),
    /读取基底 manifest.json 失败/,
  );

  const badSizeBase = await makeTempDir(t);
  await fs.writeFile(
    path.join(badSizeBase, 'manifest.json'),
    JSON.stringify({ tileSize: 63, worldBlockRange: { xMin: 0, xMax: 189, zMin: 0, zMax: 63 } }),
  );
  await assert.rejects(
    () => mergeTileSets({ baseDir: badSizeBase, incomingDir: base, outDir: out }),
    /tileSize 无效/,
  );

  const emptyInc = await makeTempDir(t);
  await assert.rejects(
    () => mergeTileSets({ baseDir: base, incomingDir: emptyInc, outDir: out }),
    /没有可用的 Xaero 导出/,
  );

  // PNG 头合法（扫描能认出尺寸）但数据被截断 → 解码失败
  const brokenInc = await makeTempDir(t);
  await fs.writeFile(path.join(brokenInc, '0_9_x64_z64.png'), solidPng(TS, RED).subarray(0, 60));
  await assert.rejects(
    () => mergeTileSets({ baseDir: base, incomingDir: brokenInc, outDir: out }),
    /没有.*能成功解码/,
  );

  const farInc = await makeTempDir(t);
  await fs.writeFile(path.join(farInc, '0_0_x10000_z10000.png'), solidPng(TS, RED));
  await assert.rejects(
    () => mergeTileSets({ baseDir: base, incomingDir: farInc, outDir: out }),
    /完全不重叠/,
  );
});

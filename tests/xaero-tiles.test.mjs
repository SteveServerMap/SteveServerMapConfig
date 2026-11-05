/**
 * tests/xaero-tiles.test.mjs —— tools/xaero-tiles.mjs 的单元测试
 *
 * 运行：node --test tests/xaero-tiles.test.mjs
 *
 * 覆盖：
 *   1. 扫描 xaero/<维度>/：识别 x<X>_z<Z>.png、算出世界范围；
 *   2. 生成瓦片：manifest 世界范围 / 层级 / 金字塔 / 文件落盘；
 *   3. 纯黑（未探索）默认转透明，不写全透明瓦片；
 *   4. 生成的 manifest 能通过站点 assets/js/tiles.js 的 parseManifest（站点仓库存在时）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodePng } from '../tools/xaero-decode.mjs';
import { decodePng, generateXaeroTiles, inspectXaeroSource } from '../tools/xaero-tiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(__dirname, '..');
const SITE_TILES_JS = path.resolve(TOOL_DIR, '..', 'SteveServerMap.github.io', 'assets', 'js', 'tiles.js');

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssm-xaero-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('inspectXaeroSource 识别导出 PNG 并计算世界范围', async (t) => {
  const source = await makeTempDir(t);
  await fs.writeFile(path.join(source, '0_0_x0_z0.png'), solidPng(64, [255, 0, 0, 255]));
  await fs.writeFile(path.join(source, '0_1_x64_z0.png'), solidPng(64, [0, 0, 255, 255]));
  await fs.writeFile(path.join(source, '0_2_x128_z0.png'), solidPng(64, [0, 0, 0, 255]));

  const scan = await inspectXaeroSource(source);
  assert.equal(scan.kind, 'png');
  assert.equal(scan.images, 3);
  assert.equal(scan.regions, 0);
  assert.deepEqual(scan.bounds, { xMin: 0, xMax: 192, zMin: 0, zMax: 64 });
  assert.ok(scan.bytes > 0);
});

test('generateXaeroTiles 生成金字塔、跳过纯黑瓦片，manifest 可被站点解析', async (t) => {
  const source = await makeTempDir(t);
  const out = await makeTempDir(t);
  await fs.writeFile(path.join(source, '0_0_x0_z0.png'), solidPng(64, [255, 0, 0, 255]));
  await fs.writeFile(path.join(source, '0_1_x64_z0.png'), solidPng(64, [0, 0, 255, 255]));
  // 第三格全黑 = 未探索：默认转透明，不应产生 2_0.png
  await fs.writeFile(path.join(source, '0_2_x128_z0.png'), solidPng(64, [0, 0, 0, 255]));

  const result = await generateXaeroTiles({ sourceDir: source, outDir: out, tileSize: 64 });
  assert.deepEqual(result.worldBlockRange, { xMin: 0, xMax: 192, zMin: 0, zMax: 64 });
  assert.equal(result.tileSize, 64);
  assert.deepEqual(
    result.levels.map((level) => [level.level, level.cols, level.rows]),
    [[0, 3, 1], [1, 2, 1], [2, 1, 1]],
  );
  assert.equal(result.stats.kind, 'png');
  assert.equal(result.stats.decoded, 3);
  assert.equal(result.stats.tilesWritten, 2 + 1 + 1);

  const tile00 = path.join(out, 'tiles', '0', '0_0.png');
  const tile10 = path.join(out, 'tiles', '0', '1_0.png');
  const tile20 = path.join(out, 'tiles', '0', '2_0.png');
  assert.ok(await fs.stat(tile00).then(() => true, () => false));
  assert.ok(await fs.stat(tile10).then(() => true, () => false));
  assert.equal(await fs.stat(tile20).then(() => true, () => false), false);

  const decoded = decodePng(await fs.readFile(tile00));
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 64);
  assert.deepEqual([...decoded.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  const decodedBlue = decodePng(await fs.readFile(tile10));
  assert.deepEqual([...decodedBlue.rgba.subarray(0, 4)], [0, 0, 255, 255]);

  const raw = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(raw.source, 'xaero-folder');
  assert.equal(raw.worldBlockRange.xMax, 192);
  assert.deepEqual(raw.levels[0].originBlockX, 0);
  assert.deepEqual(raw.levels[0].originBlockZ, 0);

  // 与站点解析器做真实契约校验（站点仓库不存在时 skip）
  const siteExists = await fs.stat(SITE_TILES_JS).then(() => true, () => false);
  if (siteExists) {
    const siteTiles = await import(pathToFileURL(SITE_TILES_JS).href);
    const tileset = siteTiles.parseManifest(raw, { manifestUrl: 'tiles/overworld/manifest.json' });
    assert.ok(tileset, '站点 parseManifest 应接受生成的 manifest');
    assert.equal(tileset.imageWidth, 192);
    assert.equal(tileset.imageHeight, 64);
    assert.equal(tileset.baseUrl, 'tiles/overworld/tiles/');
    assert.equal(tileset.levels.length, 3);
  }
});

test('空目录返回 empty，生成时报错而不是写坏输出', async (t) => {
  const source = await makeTempDir(t);
  const out = await makeTempDir(t);
  const scan = await inspectXaeroSource(source);
  assert.equal(scan.kind, 'empty');
  assert.equal(scan.bounds, null);
  await assert.rejects(
    () => generateXaeroTiles({ sourceDir: source, outDir: out, tileSize: 64 }),
    /没有可用的 Xaero 导出 PNG/,
  );
});

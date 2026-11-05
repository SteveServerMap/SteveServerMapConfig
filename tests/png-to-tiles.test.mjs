/**
 * tests/png-to-tiles.test.mjs —— tools/png-to-tiles.mjs 的单元测试
 *
 * 运行：node --test tests/png-to-tiles.test.mjs
 *
 * 覆盖：
 *   1. 单张整图 → 瓦片 + manifest：世界范围 / 层级网格 / 边缘补透明；
 *   2. --scale=0.5 降采样（2 px/方块 → 1 px/方块）；
 *   3. 非法参数（缺 x-min、scale 非 1/2^k）报错退出；
 *   4. 生成的 manifest 能通过站点 assets/js/tiles.js 的 parseManifest（站点仓库存在时）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodePng } from '../tools/xaero-decode.mjs';
import { decodePng } from '../tools/png-to-tiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(__dirname, '..', 'tools', 'png-to-tiles.mjs');
const SITE_TILES_JS = path.resolve(__dirname, '..', '..', 'SteveServerMap.github.io', 'assets', 'js', 'tiles.js');

async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssm-pngtiles-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function checkerPng(width, height) {
  // 左上角 (x, y) 像素为红色，其余为蓝色；alpha 全 255
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (x < 4 && y < 4) {
        buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 0;
      } else {
        buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 255;
      }
      buf[i + 3] = 255;
    }
  }
  return encodePng(width, height, buf);
}

function runTool(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('整图直切：manifest 世界范围、层级网格、边缘补透明', async (t) => {
  const dir = await makeTempDir(t);
  const src = path.join(dir, 'src.png');
  const out = path.join(dir, 'out');
  await fs.writeFile(src, checkerPng(100, 64));

  const { code, stderr } = await runTool([src, '--x-min=-50', '--z-min=-32', '--tile=64', `--out=${out}`]);
  assert.equal(code, 0, stderr);

  const raw = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(raw.source, 'stitched-png');
  assert.equal(raw.tileSize, 64);
  // 100×64 补到 2×1 块瓦片 → 范围向外补齐 128×64
  assert.deepEqual(raw.worldBlockRange, { xMin: -50, xMax: 78, zMin: -32, zMax: 32 });
  assert.deepEqual(
    raw.levels.map((l) => [l.level, l.cols, l.rows, l.blocksPerPixel]),
    [[0, 2, 1, 1], [1, 1, 1, 2]],
  );
  for (const level of raw.levels) {
    assert.equal(level.originBlockX, -50);
    assert.equal(level.originBlockZ, -32);
  }

  // level 0：0_0.png、1_0.png 存在；没有多余的层级
  const l0 = await fs.readdir(path.join(out, 'tiles', '0'));
  assert.deepEqual(l0.sort(), ['0_0.png', '1_0.png']);
  assert.equal(await fs.stat(path.join(out, 'tiles', '1', '0_0.png')).then(() => true, () => false), true);
  assert.equal(await fs.stat(path.join(out, 'tiles', '2')).then(() => true, () => false), false);

  // 像素抽查：0_0 (0,0) 红；1_0 的 (0,0) 是源图 (64,0) → 蓝
  const tile00 = decodePng(await fs.readFile(path.join(out, 'tiles', '0', '0_0.png')));
  assert.deepEqual([...tile00.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  const tile10 = decodePng(await fs.readFile(path.join(out, 'tiles', '0', '1_0.png')));
  assert.deepEqual([...tile10.rgba.subarray(0, 4)], [0, 0, 255, 255]);
  // 1_0 只覆盖源图 x 64..99（36 列），x=36 列起补透明
  assert.equal(tile10.rgba[(0 * 64 + 36) * 4 + 3], 0);

  // 与站点解析器做真实契约校验（站点仓库不存在时 skip）
  const siteExists = await fs.stat(SITE_TILES_JS).then(() => true, () => false);
  if (siteExists) {
    const siteTiles = await import(pathToFileURL(SITE_TILES_JS).href);
    const tileset = siteTiles.parseManifest(raw, { manifestUrl: 'tiles/x/manifest.json' });
    assert.ok(tileset, '站点 parseManifest 应接受生成的 manifest');
    assert.equal(tileset.imageWidth, 128);
    assert.equal(tileset.imageHeight, 64);
    assert.equal(tileset.levels.length, 2);
  }
});

test('--scale=0.5：2 px/方块图降采样为 1 px/方块，范围随之减半', async (t) => {
  const dir = await makeTempDir(t);
  const src = path.join(dir, 'src.png');
  const out = path.join(dir, 'out');
  await fs.writeFile(src, checkerPng(100, 64));

  const { code, stderr } = await runTool([src, '--x-min=-1024', '--z-min=-1024', '--scale=0.5', '--tile=64', `--out=${out}`]);
  assert.equal(code, 0, stderr);

  const raw = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
  // 50×32 → 1×1 块瓦片，范围补齐到 64×64
  assert.deepEqual(raw.worldBlockRange, { xMin: -1024, xMax: -960, zMin: -1024, zMax: -960 });
  assert.equal(raw.stats.pixels, 50 * 32);
  // 50×32 → level 0 1×1，且 1×1 后不再生成金字塔
  assert.deepEqual(raw.levels.map((l) => [l.level, l.cols, l.rows]), [[0, 1, 1]]);
});

test('非法参数报错退出：缺 x-min、scale 非 1/2^k', async (t) => {
  const dir = await makeTempDir(t);
  const src = path.join(dir, 'src.png');
  await fs.writeFile(src, checkerPng(32, 32));

  const noMin = await runTool([src, '--z-min=0', `--out=${path.join(dir, 'a')}`]);
  assert.equal(noMin.code, 2);
  assert.match(noMin.stderr, /--x-min/);

  const badScale = await runTool([src, '--x-min=0', '--z-min=0', '--scale=0.3', `--out=${path.join(dir, 'b')}`]);
  assert.equal(badScale.code, 2);
  assert.match(badScale.stderr, /1\/2\^k/);

  const bigScale = await runTool([src, '--x-min=0', '--z-min=0', '--scale=2', `--out=${path.join(dir, 'c')}`]);
  assert.equal(bigScale.code, 2);
});

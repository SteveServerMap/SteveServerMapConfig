/**
 * tests/merge-tiles-server.test.mjs —— /api/merge-tiles/* 接口验收
 *
 * 运行：node --test tests/merge-tiles-server.test.mjs
 *
 * 覆盖：
 *   1. analyze → apply 全流程：暂存目录、发布替换、.backups 备份、审计日志、上传清理；
 *   2. 负向用例：无文件 400 / 未知维度 404 / 未启用瓦片 422 / 坏文件名 422 /
 *      完全不重叠 500 / 未分析就 apply 409。
 *
 * 安全：站点与数据目录都是 %TEMP% 下的隔离副本，绝不写真实站点。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../tools/xaero-decode.mjs';
import { decodePng, generateXaeroTiles } from '../tools/xaero-tiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(__dirname, '..');

const TS = 64;
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

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const exists = (p) => fs.stat(p).then(() => true, () => false);

let ctx = null;

before(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ssm-merge-tiles-api-'));
  const siteDir = path.join(root, 'site');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(siteDir, { recursive: true });
  await fs.writeFile(
    path.join(siteDir, 'config.json'),
    JSON.stringify(
      {
        dimensions: [
          { id: 'overworld', name: '主世界', tiles: { manifest: 'tiles/overworld/manifest.json' }, image: '主世界.png' },
          { id: 'nether', name: '下界', image: '下界.png' },
        ],
      },
      null,
      2,
    ),
  );

  // 基底瓦片集：世界 0..192 × 0..192，3×3 level-0 网格（0_0 绿、2_2 蓝，其余未探索）
  const src = path.join(root, 'base-src');
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, '0_0_x0_z0.png'), solidPng(TS, [0, 200, 60, 255]));
  await fs.writeFile(path.join(src, '0_2_x128_z128.png'), solidPng(TS, [40, 80, 220, 255]));
  await generateXaeroTiles({ sourceDir: src, outDir: path.join(siteDir, 'tiles', 'overworld'), tileSize: TS });
  await fs.rm(src, { recursive: true, force: true });

  const port = await freePort();
  const server = spawn(
    process.execPath,
    [path.join(TOOL_DIR, 'server.mjs'), `--port=${port}`, `--site=${siteDir}`, `--data=${dataDir}`],
    { cwd: TOOL_DIR, stdio: 'ignore', windowsHide: true },
  );
  const deadline = Date.now() + 20000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!healthy) {
    server.kill();
    throw new Error('工具服务器未就绪');
  }
  ctx = { root, siteDir, dataDir, port, server };
});

after(async () => {
  if (!ctx) return;
  ctx.server.kill();
  await new Promise((r) => setTimeout(r, 300));
  await fs.rm(ctx.root, { recursive: true, force: true }).catch(() => {});
});

const api = async (p, init) => {
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** FormData 多文件上传（Node 原生 fetch 自动生成 multipart 边界） */
const multipart = (files, fields = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const f of files) fd.append('files', new Blob([f.data], { type: 'application/octet-stream' }), f.name);
  return fd;
};

const analyze = (files, fields = {}) =>
  api('/api/merge-tiles/analyze', { method: 'POST', body: multipart(files, { dim: 'overworld', ...fields }) });

const incYellow = { name: '0_1_x64_z64.png', data: solidPng(TS, YELLOW) };
const incRed = { name: '0_2_x128_z128.png', data: solidPng(TS, RED) };

test('analyze → apply 全流程：暂存、发布、备份、审计', async () => {
  const res = await analyze([incYellow, incRed]);
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(b.ok, true);
  assert.equal(b.dim, 'overworld');
  assert.equal(b.staged, true);
  assert.equal(b.fillNew, true);
  assert.equal(b.updateChanged, true);
  assert.deepEqual(b.counts, { void: 6, onlyBase: 1, onlyIncoming: 1, changed: 1, same: 0 });
  assert.deepEqual(b.blocksArea, { onlyIncoming: TS * TS, changed: TS * TS });
  assert.deepEqual(b.grid, { cols: 3, rows: 3, map: [1, 0, 0, 0, 2, 0, 0, 0, 3] });
  assert.equal(b.incoming.decoded, 2);
  assert.equal(b.base.tileSize, TS);
  assert.equal(b.base.levels, 3);

  // 暂存目录已生成，但站点瓦片未动
  const stagingManifest = JSON.parse(
    await fs.readFile(path.join(ctx.dataDir, 'merge-staging', 'overworld', 'manifest.json'), 'utf8'),
  );
  assert.equal(stagingManifest.source, 'tile-merge');
  const before = JSON.parse(await fs.readFile(path.join(ctx.siteDir, 'tiles', 'overworld', 'manifest.json'), 'utf8'));
  assert.equal(before.source, 'xaero-folder');

  // 发布
  const applyRes = await api('/api/merge-tiles/apply', json({ dim: 'overworld' }));
  assert.equal(applyRes.status, 200);
  assert.equal(applyRes.body.ok, true);
  assert.equal(applyRes.body.dim, 'overworld');
  assert.equal(applyRes.body.levels, 3);
  assert.match(applyRes.body.backup, /^\.backups\/overworld\.bak-/);

  // 站点瓦片已替换为新合并结果
  const after = JSON.parse(await fs.readFile(path.join(ctx.siteDir, 'tiles', 'overworld', 'manifest.json'), 'utf8'));
  assert.equal(after.source, 'tile-merge');
  assert.deepEqual(after.worldBlockRange, { xMin: 0, xMax: 192, zMin: 0, zMax: 192 });
  assert.deepEqual(after.stats.diff.counts, { void: 6, onlyBase: 1, onlyIncoming: 1, changed: 1, same: 0 });

  const yellow = decodePng(await fs.readFile(path.join(ctx.siteDir, 'tiles', 'overworld', 'tiles', '0', '1_1.png')));
  assert.deepEqual([...yellow.rgba.subarray(0, 4)], YELLOW);
  const red = decodePng(await fs.readFile(path.join(ctx.siteDir, 'tiles', 'overworld', 'tiles', '0', '2_2.png')));
  assert.deepEqual([...red.rgba.subarray(0, 4)], RED);

  // 备份里是旧瓦片
  const backupManifest = JSON.parse(
    await fs.readFile(path.join(ctx.siteDir, applyRes.body.backup, 'manifest.json'), 'utf8'),
  );
  assert.equal(backupManifest.source, 'xaero-folder');

  // 上传目录已清理；审计日志有记录；config.json 未被改动
  assert.equal(await exists(path.join(ctx.dataDir, 'merge-uploads', 'overworld')), false);
  const log = await fs.readFile(path.join(ctx.dataDir, 'save.log'), 'utf8');
  assert.match(log, /"event":"merge-tiles-apply"/);
  const config = JSON.parse(await fs.readFile(path.join(ctx.siteDir, 'config.json'), 'utf8'));
  assert.equal(config.dimensions.length, 2);
});

test('负向用例：400 / 404 / 422 / 500 / 409', async () => {
  // 没有上传任何文件 → 400
  const r1 = await analyze([]);
  assert.equal(r1.status, 400);

  // 未知维度 → 404
  const r2 = await api('/api/merge-tiles/analyze', { method: 'POST', body: multipart([incYellow], { dim: 'nope' }) });
  assert.equal(r2.status, 404);

  // 维度没有启用瓦片底图 → 422
  const r3 = await api('/api/merge-tiles/analyze', { method: 'POST', body: multipart([incYellow], { dim: 'nether' }) });
  assert.equal(r3.status, 422);
  assert.match(r3.body.error, /瓦片底图/);

  // 文件名不符合 Xaero 命名 → 422
  const r4 = await analyze([{ name: 'hello.png', data: solidPng(TS, [1, 2, 3, 255]) }]);
  assert.equal(r4.status, 422);
  assert.match(r4.body.error, /Xaero 命名/);

  // 完全不重叠 → 500（mergeTileSets 报错）
  const r5 = await analyze([{ name: '0_0_x10000_z10000.png', data: solidPng(TS, RED) }]);
  assert.equal(r5.status, 500);
  assert.match(r5.body.error, /完全不重叠/);

  // 没有分析结果就 apply → 409
  await fs.rm(path.join(ctx.dataDir, 'merge-staging', 'overworld'), { recursive: true, force: true });
  const r6 = await api('/api/merge-tiles/apply', json({ dim: 'overworld' }));
  assert.equal(r6.status, 409);
  assert.match(r6.body.error, /分析差异/);

  // apply 未知维度 → 404；未启用瓦片 → 422
  const r7 = await api('/api/merge-tiles/apply', json({ dim: 'nope' }));
  assert.equal(r7.status, 404);
  const r8 = await api('/api/merge-tiles/apply', json({ dim: 'nether' }));
  assert.equal(r8.status, 422);
});

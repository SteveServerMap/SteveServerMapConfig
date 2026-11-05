/**
 * merge-tiles-e2e.mjs —— 合并页「瓦片差分」模式端到端验收
 *
 * 场景：
 *   站点副本的 tiles/overworld 用夹具瓦片集（世界 0..192 × 0..192，3×3 网格：
 *   0_0 绿、2_2 蓝，其余未探索）替换，上传两个新图文件（1_1 黄 = 新增、2_2 红 = 变更），
 *   走真实页面：切模式 → 选维度 → 传文件 → 分析 → 改参数变 stale → 重分析 → 发布。
 *
 * 运行：node tests/merge-tiles-e2e.mjs [--keep] [--browser=<path>]
 * 依赖：本机 Edge/Chrome + 站点仓库（默认 ../SteveServerMap.github.io，用于复用 headless.mjs 与做临时副本）
 * 安全：只会写 %TEMP% 下的站点副本，绝不改真实站点。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../tools/xaero-decode.mjs';
import { generateXaeroTiles } from '../tools/xaero-tiles.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(TOOL_ROOT, 'tests', 'fixtures');
const ARTIFACTS = path.join(TOOL_ROOT, 'tests', 'artifacts');

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const KEEP = argv.includes('--keep');
const SITE_REPO = path.resolve(opt('site-repo', path.join(TOOL_ROOT, '..', 'SteveServerMap.github.io')));
const HEADLESS = opt('headless', path.join(SITE_REPO, 'tests', 'headless.mjs'));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

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

/** 站点副本 + 夹具瓦片集（替换副本里的 tiles/overworld） */
async function prepareSiteCopy() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssm-merge-tiles-e2e-site-'));
  for (const name of ['index.html', 'config.json', 'config.schema.json', '主世界.png', '下界.png', '末地.png']) {
    await fs.copyFile(path.join(SITE_REPO, name), path.join(dir, name)).catch(() => {});
  }
  await fs.cp(path.join(SITE_REPO, 'assets'), path.join(dir, 'assets'), { recursive: true });

  // 夹具基底瓦片集：与 tile-merge 单测同一套（0_0 绿 / 2_2 蓝）
  const src = path.join(dir, '_fixture-src');
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, '0_0_x0_z0.png'), solidPng(64, [0, 200, 60, 255]));
  await fs.writeFile(path.join(src, '0_2_x128_z128.png'), solidPng(64, [40, 80, 220, 255]));
  await generateXaeroTiles({ sourceDir: src, outDir: path.join(dir, 'tiles', 'overworld'), tileSize: 64 });
  await fs.rm(src, { recursive: true, force: true });
  return dir;
}

async function main() {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.writeFile(path.join(ARTIFACTS, '.gitignore'), '*\n!.gitignore\n', 'utf8').catch(() => {});
  await fs.stat(path.join(FIXTURES, 'base.png')).catch(() => {
    throw new Error(`缺少测试素材：tests/fixtures/base.png`);
  });
  await fs.stat(HEADLESS).catch(() => {
    throw new Error(`找不到 CDP 库：${HEADLESS}（用 --headless=<path> 指定）`);
  });

  const { launchBrowser, CDP, Page } = await import(`file://${HEADLESS.replace(/\\/g, '/')}`);

  // 新图上传夹具：1_1 黄（新增）、2_2 红（变更）
  const uploads = await fs.mkdtemp(path.join(os.tmpdir(), 'ssm-merge-tiles-e2e-uploads-'));
  const yellowPath = path.join(uploads, '0_1_x64_z64.png');
  const redPath = path.join(uploads, '0_2_x128_z128.png');
  await fs.writeFile(yellowPath, solidPng(64, [240, 220, 60, 255]));
  await fs.writeFile(redPath, solidPng(64, [220, 40, 40, 255]));

  const siteCopy = await prepareSiteCopy();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssm-merge-tiles-e2e-data-'));
  const port = await freePort();

  const server = spawn(
    process.execPath,
    [path.join(TOOL_ROOT, 'server.mjs'), `--port=${port}`, `--site=${siteCopy}`, `--data=${dataDir}`],
    { cwd: TOOL_ROOT, stdio: 'ignore', windowsHide: true },
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
    await sleep(200);
  }
  check('§1 工具服务器启动（/api/health 200）', healthy, `端口 ${port}`);

  const handle = await launchBrowser({ headless: true, windowSize: '1440,900' });
  const conn = await CDP.connect(handle.wsUrl);
  const page = await Page.open(conn, { url: 'about:blank' });
  const errors = [];
  const badRequests = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') errors.push((p.args || []).map((a) => a.value ?? a.description).join(' '));
  });
  page.on('Runtime.exceptionThrown', (p) => errors.push('EXC: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)));
  page.on('Network.responseReceived', (p) => {
    const status = p.response?.status ?? 0;
    if (status >= 400) {
      const url = p.response.url || '';
      // 瓦片 404 是正常情况（只导出了非全透明瓦片，对比图会请求空白格）
      if (status === 404 && /(\/tiles\/\d+\/|merge-staging\/[^/]+\/tiles\/)/.test(url)) return;
      badRequests.push(`${status} ${url}`);
    }
  });

  const setFile = async (inputId, filePaths) => {
    const { result } = await page.send('Runtime.evaluate', { expression: `document.getElementById('${inputId}')` });
    await page.send('DOM.setFileInputFiles', { files: filePaths, objectId: result.objectId });
    await sleep(800);
  };

  try {
    await page.navigate(`http://127.0.0.1:${port}/merge.html`);
    await page.waitFor(() => !!window.__merge, { timeout: 20000, label: 'merge 页面' });
    await sleep(1600);

    const boot = await page.evalFn(() => ({
      mode: window.__merge.mode,
      tilesCenterHidden: document.getElementById('mg-tiles-center')?.hidden,
      imageCenterHidden: document.getElementById('mg-image-center')?.hidden,
      analyzeDisabled: document.getElementById('mg-analyze')?.disabled,
    }));
    check(
      '§2 页面默认单图模式（瓦片面板隐藏）',
      boot.mode === 'image' && boot.tilesCenterHidden === true && boot.imageCenterHidden === false,
      JSON.stringify(boot),
    );

    // 真实点击「瓦片差分」模式按钮
    await page.evalFn(() => document.getElementById('mg-mode-tiles').click());
    await page.waitFor(
      () => window.__merge.mode === 'tiles' && window.__merge.tileDims().some((d) => d.ok),
      { timeout: 20000, interval: 200, label: '瓦片维度加载' },
    );
    await sleep(400);

    const tileBoot = await page.evalFn(() => ({
      mode: window.__merge.mode,
      dims: window.__merge.tileDims(),
      tiles: window.__merge.tiles(),
      baseInfo: document.getElementById('mg-tiles-base-info')?.textContent || '',
      baseBadge: (() => {
        const el = document.getElementById('mg-tiles-base-badge');
        return el ? { hidden: el.hidden, text: el.textContent } : null;
      })(),
      imageCenterHidden: document.getElementById('mg-image-center')?.hidden,
      analyzeDisabled: document.getElementById('mg-analyze')?.disabled,
      saveDisabled: document.getElementById('mg-save')?.disabled,
    }));
    check(
      '§3 瓦片模式：维度下拉含 overworld 并自动选中、基底摘要显示瓦片规格',
      tileBoot.mode === 'tiles' &&
        tileBoot.dims.some((d) => d.id === 'overworld') &&
        tileBoot.tiles.dim === 'overworld' &&
        /64/.test(tileBoot.baseInfo) &&
        /世界范围/.test(tileBoot.baseInfo) &&
        tileBoot.imageCenterHidden === true,
      JSON.stringify({ dims: tileBoot.dims, baseInfo: tileBoot.baseInfo }),
    );
    check('§3 未选文件时「分析差异」不可用', tileBoot.analyzeDisabled === true, `analyzeDisabled=${tileBoot.analyzeDisabled}`);
    check(
      '§3 瓦片更新日期徽标：显示本地日期与相对天数',
      tileBoot.baseBadge && tileBoot.baseBadge.hidden === false && /瓦片更新于 .+（今天|昨天）/.test(tileBoot.baseBadge.text),
      JSON.stringify(tileBoot.baseBadge),
    );

    // 上传两个新图文件
    await setFile('mg-tiles-file', [yellowPath, redPath]);
    await page.waitFor(() => window.__merge.tiles().files.length === 2, { timeout: 5000, label: '文件列表' });
    const files = await page.evalFn(() => ({
      files: window.__merge.tiles().files,
      li: document.querySelectorAll('#mg-tiles-files li').length,
      meta: document.getElementById('mg-tiles-inc-meta')?.textContent,
      coords: [...document.querySelectorAll('#mg-tiles-files .mg-file-coord')].map((el) => el.textContent),
      analyzeDisabled: document.getElementById('mg-analyze')?.disabled,
    }));
    check(
      '§3 文件列表 2 个且坐标解析正确、分析按钮可用',
      files.li === 2 && /2 个文件/.test(files.meta) &&
        files.coords.some((c) => c === 'x=64 z=64') && files.coords.some((c) => c === 'x=128 z=128') &&
        files.analyzeDisabled === false,
      JSON.stringify(files),
    );

    // 分析差异
    await page.evalFn(() => document.getElementById('mg-analyze').click());
    await page.waitFor(() => window.__merge.tiles().staged === true, { timeout: 60000, interval: 200, label: '分析完成' });
    await sleep(400);
    const analysis = await page.evalFn(() => ({
      counts: window.__merge.tiles().analysis?.counts,
      cells: [...document.querySelectorAll('#mg-tiles-stats .mg-stat b')].map((el) => el.textContent),
      canvas: { w: document.getElementById('mg-tiles-canvas')?.width, h: document.getElementById('mg-tiles-canvas')?.height },
      hintHidden: document.getElementById('mg-tiles-hint')?.hidden,
      stagedBadge: (() => {
        const el = document.getElementById('mg-tiles-staged-badge');
        return el ? { hidden: el.hidden, text: el.textContent } : null;
      })(),
      saveDisabled: document.getElementById('mg-save')?.disabled,
      status: document.getElementById('mg-status')?.textContent,
    }));
    check(
      '§4 分析结果：新增 1 / 变更 1 / 仅目标图 1 / 面积 8,192，预览与统计同步',
      analysis.counts?.onlyIncoming === 1 && analysis.counts?.changed === 1 && analysis.counts?.onlyBase === 1 &&
        analysis.cells[0] === '1' && analysis.cells[1] === '1' && analysis.cells[2] === '1' &&
        analysis.cells[3] === '8,192' && analysis.canvas.w === 3 && analysis.canvas.h === 3 &&
        analysis.hintHidden === true && analysis.saveDisabled === false,
      JSON.stringify(analysis),
    );
    check(
      '§4 合并结果徽标：分析后显示生成日期（今天/昨天）',
      analysis.stagedBadge && analysis.stagedBadge.hidden === false && /合并结果生成于 .+（今天|昨天）/.test(analysis.stagedBadge.text),
      JSON.stringify(analysis.stagedBadge),
    );

    // 对比滑块：旧图 vs 合并结果双画布
    await page.waitFor(() => window.__merge.compare().layers === true, { timeout: 20000, interval: 200, label: '对比图层加载' });
    await sleep(700);
    const cmp = await page.evalFn(() => ({
      info: window.__merge.compare(),
      base: { w: document.getElementById('mg-compare-base')?.width, h: document.getElementById('mg-compare-base')?.height },
      merged: { w: document.getElementById('mg-compare-merged')?.width, h: document.getElementById('mg-compare-merged')?.height },
      cssW: document.getElementById('mg-compare-base')?.style.width,
      cssH: document.getElementById('mg-compare-base')?.style.height,
      sliderValue: document.getElementById('mg-compare-slider')?.value,
    }));
    check(
      '§4 对比滑块：双画布已渲染、默认分割线 50%',
      cmp.info.layers === true && cmp.info.visible === true &&
        cmp.base.w >= 192 && cmp.merged.w >= 192 &&
        cmp.cssW && cmp.cssW !== '' && cmp.cssH && cmp.cssH !== '' &&
        cmp.info.value === '50' && cmp.info.clip.includes('50%') && cmp.info.divider === '50%',
      JSON.stringify({ info: cmp.info, base: cmp.base, merged: cmp.merged, cssW: cmp.cssW, cssH: cmp.cssH }),
    );

    // 拖动滑块 → 裁剪与分割线跟随
    await page.evalFn(() => {
      const s = document.getElementById('mg-compare-slider');
      s.value = '25';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const moved = await page.evalFn(() => ({
      clip: document.getElementById('mg-compare-merged')?.style.clipPath,
      divider: document.getElementById('mg-compare-divider')?.style.left,
    }));
    check(
      '§4 拖动滑块：合并结果只显示右 75%、分割线移到 25%',
      moved.clip === 'inset(0px 0px 0px 25%)' && moved.divider === '25%',
      JSON.stringify(moved),
    );

    // 改参数 → stale，保存按钮禁用
    await page.evalFn(() => {
      const el = document.getElementById('mg-diff-thr');
      el.value = '30';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitFor(() => window.__merge.tiles().stale === true, { timeout: 5000, label: 'stale 标记' });
    const stale = await page.evalFn(() => ({
      stale: window.__merge.tiles().stale,
      saveDisabled: document.getElementById('mg-save')?.disabled,
      status: document.getElementById('mg-status')?.textContent,
    }));
    check('§4 改参数后结果置为 stale、保存被拦', stale.stale === true && stale.saveDisabled === true, JSON.stringify(stale));

    // 重新分析 → 可保存
    await page.evalFn(() => document.getElementById('mg-analyze').click());
    await page.waitFor(
      () => window.__merge.tiles().staged === true && window.__merge.tiles().stale === false,
      { timeout: 60000, interval: 200, label: '重新分析' },
    );
    await sleep(300);
    const ready = await page.evalFn(() => ({
      saveDisabled: document.getElementById('mg-save')?.disabled,
      counts: window.__merge.tiles().analysis?.counts,
    }));
    check('§4 重新分析后计数一致、保存按钮恢复', ready.saveDisabled === false && ready.counts?.onlyIncoming === 1, JSON.stringify(ready));

    // 发布到站点（真实点击「保存到站点」）
    await page.evalFn(() => document.getElementById('mg-save').click());
    await page.waitFor(
      () => window.__merge.tiles().staged === false && /已发布/.test(document.getElementById('mg-status')?.textContent || ''),
      { timeout: 60000, interval: 300, label: '发布完成' },
    );
    await sleep(600);
    const published = await page.evalFn(() => ({
      status: document.getElementById('mg-status')?.textContent,
      dim: window.__merge.tiles().dim,
      files: window.__merge.tiles().files,
    }));
    check('§5 发布成功：状态栏提示已发布', published.status.includes('已发布'), JSON.stringify(published));

    const mergedManifest = JSON.parse(await fs.readFile(path.join(siteCopy, 'tiles', 'overworld', 'manifest.json'), 'utf8'));
    const backups = await fs.readdir(path.join(siteCopy, '.backups')).catch(() => []);
    const backupDirs = backups.filter((n) => n.startsWith('overworld.bak-'));
    const tile11 = await fs.stat(path.join(siteCopy, 'tiles', 'overworld', 'tiles', '0', '1_1.png')).catch(() => null);
    const uploadsLeft = await fs.readdir(path.join(dataDir, 'merge-uploads')).then((l) => l.filter((n) => n === 'overworld').length, () => 0);
    check(
      '§5 站点瓦片被替换（source=tile-merge）、新增瓦片落盘、备份生成、上传清理',
      mergedManifest.source === 'tile-merge' && mergedManifest.stats?.diff?.counts?.onlyIncoming === 1 &&
        !!tile11 && backupDirs.length >= 1 && uploadsLeft === 0,
      `backups=${backupDirs.length}`,
    );

    // 发布后分析结果作废，对比滑块跟着隐藏并释放图层；合并结果徽标隐藏，基底徽标随新 manifest 刷新
    const cmpGone = await page.evalFn(() => ({
      compare: window.__merge.compare(),
      stagedBadgeHidden: document.getElementById('mg-tiles-staged-badge')?.hidden,
      baseBadge: (() => {
        const el = document.getElementById('mg-tiles-base-badge');
        return el ? { hidden: el.hidden, text: el.textContent } : null;
      })(),
    }));
    check(
      '§5 发布后对比滑块已隐藏、图层已释放；合并结果徽标隐藏、基底徽标仍显示',
      cmpGone.compare.visible === false && cmpGone.compare.layers === false &&
        cmpGone.stagedBadgeHidden === true && cmpGone.baseBadge?.hidden === false,
      JSON.stringify(cmpGone),
    );

    // 单图模式未受影响
    await page.evalFn(() => document.getElementById('mg-mode-image').click());
    await page.waitFor(() => window.__merge.mode === 'image', { timeout: 5000, label: '切回单图模式' });
    await setFile('mg-base-file', [path.join(FIXTURES, 'base.png')]);
    const baseMeta = await page.evalFn(() => document.getElementById('mg-base-meta')?.textContent || '');
    check('§5 单图模式仍可载入目标图（256×256）', /256×256/.test(baseMeta), baseMeta);

    check('§6 页面无 console error / 异常 / HTTP≥400', errors.length === 0 && badRequests.length === 0, JSON.stringify({ errors: errors.slice(0, 3), bad: badRequests.slice(0, 3) }));

    if (fail > 0) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(ARTIFACTS, `fail-merge-tiles-${Date.now()}.png`);
      await fs.writeFile(file, Buffer.from(shot.data, 'base64'));
      console.log(`  失败截图：${file}`);
    }
  } finally {
    await handle.close().catch(() => {});
    try {
      server.kill();
    } catch {
      /* ignore */
    }
    await fs.rm(uploads, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    if (!KEEP) await fs.rm(siteCopy, { recursive: true, force: true }).catch(() => {});
    else console.log(`  临时站点副本（--keep）：${siteCopy}`);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

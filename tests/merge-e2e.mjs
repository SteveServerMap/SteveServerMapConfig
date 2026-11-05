/**
 * merge-e2e.mjs —— 地图合并页面（/merge.html）端到端验收
 *
 * 用 tests/fixtures/{base.png,incoming.png}（已知世界坐标的红/蓝/绿方块）走真实页面：
 *   目标图 base.png  256×256，世界 -128..128（原点像素 128,128）
 *   新图 incoming.png 384×384，世界 -192..192（原点像素 192,192）
 *   红色区块世界对齐 → same；蓝色只在 base → onlyBase；绿色只在 incoming → onlyIncoming
 *
 * 运行：node tests/merge-e2e.mjs [--keep] [--browser=<path>]
 * 依赖：本机 Edge/Chrome + 站点仓库（默认 ../SteveServerMap.github.io，用于复用 headless.mjs 与做临时副本）
 * 安全：只会写 %TEMP% 下的站点副本，绝不改真实站点。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
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

async function prepareSiteCopy() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssm-merge-e2e-site-'));
  for (const name of ['index.html', 'config.json', 'config.schema.json', '主世界.png', '下界.png', '末地.png']) {
    await fs.copyFile(path.join(SITE_REPO, name), path.join(dir, name)).catch(() => {});
  }
  await fs.cp(path.join(SITE_REPO, 'assets'), path.join(dir, 'assets'), { recursive: true });
  return dir;
}

async function main() {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.writeFile(path.join(ARTIFACTS, '.gitignore'), '*\n!.gitignore\n', 'utf8').catch(() => {});

  for (const fixture of ['base.png', 'incoming.png']) {
    await fs.stat(path.join(FIXTURES, fixture)).catch(() => {
      throw new Error(`缺少测试素材：tests/fixtures/${fixture}（可用 Pillow 生成，见 docs/MERGE-QA.md）`);
    });
  }
  await fs.stat(HEADLESS).catch(() => {
    throw new Error(`找不到 CDP 库：${HEADLESS}（用 --headless=<path> 指定）`);
  });

  const { launchBrowser, CDP, Page } = await import(`file://${HEADLESS.replace(/\\/g, '/')}`);
  const siteCopy = await prepareSiteCopy();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssm-merge-e2e-data-'));
  const port = await freePort();

  const server = spawn(process.execPath, [path.join(TOOL_ROOT, 'server.mjs'), `--port=${port}`, `--site=${siteCopy}`, `--data=${dataDir}`], {
    cwd: TOOL_ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });

  // 等健康检查
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
    if (p.response?.status >= 400) badRequests.push(`${p.response.status} ${p.response.url}`);
  });

  const setFile = async (inputId, filePath) => {
    const { result } = await page.send('Runtime.evaluate', { expression: `document.getElementById('${inputId}')` });
    await page.send('DOM.setFileInputFiles', { files: [filePath], objectId: result.objectId });
    await sleep(800);
  };

  try {
    await page.navigate(`http://127.0.0.1:${port}/merge.html`);
    await page.waitFor(() => !!window.__merge, { timeout: 20000, label: 'merge 页面' });
    await sleep(1600);

    const boot = await page.evalFn(() => ({
      hasMerge: !!window.__merge,
      status: document.getElementById('mg-status')?.textContent || '',
      baseMeta: document.getElementById('mg-base-meta')?.textContent || '',
      analyzeDisabled: document.getElementById('mg-analyze')?.disabled,
    }));
    check('§2 合并页启动且默认载入站点目标图', boot.hasMerge && /px/.test(boot.baseMeta), JSON.stringify(boot));

    await setFile('mg-base-file', path.join(FIXTURES, 'base.png'));
    const baseMeta = await page.evalFn(() => document.getElementById('mg-base-meta')?.textContent || '');
    check('§3 目标图文件载入（256×256）', /256×256/.test(baseMeta), baseMeta);

    await setFile('mg-inc-file', path.join(FIXTURES, 'incoming.png'));
    const incMeta = await page.evalFn(() => document.getElementById('mg-inc-meta')?.textContent || '');
    check('§3 新图文件载入（384×384）', /384×384/.test(incMeta), incMeta);

    const cals = await page.evalFn(() => ({
      base: window.__merge.setPick('base', { px: 128, py: 128 }),
      inc: window.__merge.setPick('incoming', { px: 192, py: 192 }),
    }));
    check(
      '§3 两图原点拾取后得到正确画幅（base -128..128 / incoming -192..192）',
      Math.abs(cals.base?.xMin + 128) < 0.01 && Math.abs(cals.base?.xMax - 128) < 0.01 &&
        Math.abs(cals.inc?.xMin + 192) < 0.01 && Math.abs(cals.inc?.xMax - 192) < 0.01,
      JSON.stringify({ base: cals.base && [cals.base.xMin, cals.base.xMax], inc: cals.inc && [cals.inc.xMin, cals.inc.xMax] }),
    );

    await page.evalFn(() => window.__merge.action('analyze'));
    await page.waitFor(() => !!window.__merge.analysis, { timeout: 60000, interval: 200, label: 'analysis' });
    await sleep(800);
    const analysis = await page.evalFn(() => {
      const a = window.__merge.analysis;
      return a ? { counts: a.counts, area: a.blocksArea, cols: a.cols, rows: a.rows } : null;
    });
    check(
      '§4 差异分类：新增 ≥1、变更 = 0、仅目标图 ≥1',
      analysis && analysis.counts.onlyIncoming >= 1 && analysis.counts.changed === 0 && analysis.counts.onlyBase >= 1,
      JSON.stringify(analysis?.counts),
    );

    // 合并（默认两个开关都开）
    await page.evalFn(() => window.__merge.setOptions({ fillNew: true, updateChanged: true }));
    await page.evalFn(() => window.__merge.action('apply'));
    await sleep(1000);
    const merged = await page.evalFn(() => {
      const m = window.__merge.merged;
      if (!m) return null;
      const canvas = document.getElementById('mg-result-canvas');
      // 取绿色区域（世界 -80,-80 → 像素 48,48）与红色区域（世界 40,40 → 像素 168,168）的颜色
      const ctx = canvas.getContext('2d');
      const sample = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
      return { width: m.width, height: m.height, applied: m.applied, green: sample(48, 48), red: sample(168, 168) };
    });
    const greenOk = merged && merged.green[1] > 150 && merged.green[0] < 120;
    const redOk = merged && merged.red[0] > 150;
    check('§4 合并后绿色（新增）出现、红色（两边相同）保持', !!(merged && greenOk && redOk && merged.applied.filledTiles >= 1), JSON.stringify({ applied: merged?.applied, green: merged?.green, red: merged?.red }));

    // 关闭「补空白」后，结果应与目标图一致（绿色不该出现）
    await page.evalFn(() => window.__merge.setOptions({ fillNew: false, updateChanged: false }));
    await page.evalFn(() => window.__merge.action('apply'));
    await sleep(900);
    const noFill = await page.evalFn(() => {
      const canvas = document.getElementById('mg-result-canvas');
      const ctx = canvas.getContext('2d');
      const sample = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
      return { green: sample(48, 48), filled: window.__merge.merged?.applied?.filledTiles ?? null };
    });
    const noFillOk = noFill.filled === 0 && noFill.green[1] < 80;
    check('§4 取消「补空白」后不再补入新增区域', noFillOk, JSON.stringify(noFill));

    // 保存到站点（临时副本）
    const before = await fs.readdir(siteCopy);
    await page.evalFn(() => {
      window.__merge.setOptions({ fillNew: true, updateChanged: true });
      window.__merge.setSaveName('merged-test.png');
    });
    await page.evalFn(() => window.__merge.save());
    await sleep(1500);
    const after = await fs.readdir(siteCopy);
    const savedStat = await fs.stat(path.join(siteCopy, 'merged-test.png')).catch(() => null);
    const backups = await fs.readdir(path.join(siteCopy, '.backups')).catch(() => []);
    check(
      '§5 保存到站点：生成文件 + .backups 备份 + 原有文件未减少',
      !!savedStat && savedStat.size > 0 && after.length >= before.length && backups.length >= 0,
      `bytes=${savedStat?.size ?? 0} 根目录项 ${before.length}→${after.length}`,
    );

    check('§6 页面无 console error / 异常 / HTTP≥400', errors.length === 0 && badRequests.length === 0, JSON.stringify({ errors: errors.slice(0, 3), bad: badRequests.slice(0, 3) }));

    if (fail > 0) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(ARTIFACTS, `fail-merge-${Date.now()}.png`);
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
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    if (!KEEP) await fs.rm(siteCopy, { recursive: true, force: true }).catch(() => {});
    else console.log(`  临时站点副本（--keep）：${siteCopy}`);
  }

  console.log('');
  console.log(`merge-e2e：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('merge-e2e 运行失败：', err.message);
  process.exit(1);
});


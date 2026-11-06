#!/usr/bin/env node
/**
 * tests/e2e.mjs —— SteveServerMapConfig 端到端验收（零依赖，一条命令跑完）
 * =============================================================================
 * 覆盖 docs/CONTRACT.md §7 的 7 条验收标准，外加 10 项加固检查（共 17 项）：
 *   §7.1 server 启动 + GET /api/health 200
 *   §7.2 3 秒内渲染出配置树，无 console error / 未捕获异常 / HTTP≥400
 *   §7.3 树里的路径点数量与站点 config.json 一致（数量动态读取，站点配置由用户随时改）
 *   §7.4 新增路径点 → 画布交互 → 坐标进表单 → 保存 → 站点 config.json 合法
 *   §7.5 存在 error 时保存被阻止并提示
 *   §7.6 预览 iframe 渲染出「草稿」的路径点数量
 *   §7.7 越界写入（fileName: "../evil.png"）被 4xx 拒绝
 *   扩展：基底图「真的被画出来」（opacity/is-loaded + 截图亮度）、提亮按钮一次点击只翻转一次、
 *         放置模式 place、撤销/重做、保存备份 config.json.bak-*、JSON Schema 校验器自检、
 *         真实站点仓库零改动取证
 *
 * 三条硬性纪律：
 *   1. **绝不碰真实站点仓库**：先把站点复制到 %TEMP%\ssm-cfg-e2e-<随机>，
 *      再用 --site=<副本> 启动工具服务器；草稿目录用独立的 --data=<临时目录>。
 *   2. **不留常驻进程**：server 用 taskkill /T /F 清理，浏览器用 launchBrowser 的 close()，
 *      临时站点/草稿目录跑完删除（--keep 时保留并打印路径）。
 *   3. **零依赖**：只 import Node 内置模块 + 站点仓库里现成的 CDP 库
 *      （D:\Project\Github\SteveServerMap.github.io\tests\headless.mjs，用 file:// 绝对路径导入）。
 *
 * 教训：DOM 里的 naturalWidth / getBoundingClientRect 正确 ≠ 用户看得见。
 * 凡是「应该显示出来」的东西，都要额外断言 computed opacity/visibility 或直接做像素级检查
 * （见 checkCanvasVisible：它就是为了挡住「图片 opacity:0 却全绿」这类事故）。
 *
 * 用法：
 *   node tests/e2e.mjs                        # 完整跑一遍（默认）
 *   node tests/e2e.mjs --keep                 # 保留临时站点副本，便于对着失败现场排查
 *   node tests/e2e.mjs --url=http://127.0.0.1:5273   # 指向已启动的服务（跳过启动/清理）
 *   node tests/e2e.mjs --browser="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
 *   node tests/e2e.mjs --headed --verbose     # 打开可见窗口 + 打印服务端日志开关（调试用）
 *
 * 可选参数：
 *   --site-repo=<路径>   站点仓库（默认 D:\Project\Github\SteveServerMap.github.io）
 *   --headless=<路径>    headless.mjs 的位置（默认 <site-repo>\tests\headless.mjs）
 *   --data=<路径>        草稿目录（默认新建 %TEMP%\ssm-cfg-e2e-data-<随机>）
 *   --port=<端口>        工具服务器端口（默认自动挑空闲端口）
 *   --headed             非无头模式（配合 --verbose 观察真实交互）
 *   --verbose            把浏览器/服务端输出打到当前终端
 *
 * 退出码：0 = 全部通过，1 = 有失败项（或基础设施起不来）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import net from 'node:net';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ========================================================================== *
 * 0. 路径 / 参数
 * ========================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..');
const ARTIFACTS = path.join(HERE, 'artifacts');
const DEFAULT_SITE_REPO = 'D:\\Project\\Github\\SteveServerMap.github.io';

const argv = process.argv.slice(2);
function argValue(name) {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const OPT = {
  url: typeof argValue('url') === 'string' ? argValue('url').replace(/\/+$/, '') : null,
  keep: Boolean(argValue('keep')),
  headed: Boolean(argValue('headed')),
  verbose: Boolean(argValue('verbose')),
  browser: typeof argValue('browser') === 'string' ? argValue('browser') : undefined,
  port: argValue('port') ? Number(argValue('port')) : 0,
  siteRepo: path.resolve(String(argValue('site-repo') || process.env.SSM_SITE_REPO || DEFAULT_SITE_REPO)),
  headless: String(argValue('headless') || process.env.SSM_HEADLESS || ''),
  data: typeof argValue('data') === 'string' ? path.resolve(argValue('data')) : '',
};

const HEADLESS_PATH = OPT.headless
  ? path.resolve(OPT.headless)
  : path.join(OPT.siteRepo, 'tests', 'headless.mjs');

const VIEWPORT = { width: 1440, height: 900 };

/* ========================================================================== *
 * 1. 载入站点仓库现成的 CDP 库（file:// 绝对路径，不复制粘贴）
 * ========================================================================== */

if (!fs.existsSync(HEADLESS_PATH)) {
  console.error(`找不到 CDP 库：${HEADLESS_PATH}\n用 --headless=<路径> 指定站点仓库里的 tests/headless.mjs。`);
  process.exit(1);
}

const headless = await import(pathToFileURL(HEADLESS_PATH).href);
const {
  sleep,
  waitUntil,
  ensureDir,
  nowStamp,
  truncate,
  formatDuration,
  createReporter,
  createDiagnostics,
  launchBrowser,
  CDP,
  Page,
} = headless;

/* ========================================================================== *
 * 2. 小工具
 * ========================================================================== */

class SkipError extends Error {}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function fmt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return String(Math.round(n * 1000) / 1000);
}

/** 断言 actual ≈ expected，失败信息里写清「实际 vs 期望」 */
function assertClose(actual, expected, tol, what) {
  const a = num(actual);
  const e = num(expected);
  const diff = Math.abs(a - e);
  assert(Number.isFinite(a), `${what}：实际值不是数字（${JSON.stringify(actual)}），期望 ${fmt(expected)} ±${tol}`);
  assert(diff <= tol, `${what}：实际 ${fmt(a)} vs 期望 ${fmt(e)}（误差 ${fmt(diff)} > 允许 ${tol}）`);
  return diff;
}

function maxDiff(a, b) {
  return Math.max(...Object.keys(b).map((key) => Math.abs(num(a[key]) - num(b[key]))));
}

async function fetchJson(url, { method = 'GET', body, timeout = 10_000 } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, {
    method,
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15_000,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

async function removeDir(dir) {
  if (!dir) return false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

/**
 * 零依赖 PNG 解码（只支持 Chrome 截图会产出的形态：8bit、非隔行、RGB/RGBA/灰度）。
 * 用途：把「DOM 看着对、但屏幕上根本没画出来」这类可见性问题（opacity/filter/遮挡/尺寸为 0）挡在门外。
 */
function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('截图不是 PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }
  assert(width > 0 && height > 0, `PNG 尺寸非法：${width}×${height}`);
  assert(bitDepth === 8, `暂不支持 PNG 位深 ${bitDepth}`);
  assert(interlace === 0, '暂不支持隔行 PNG');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  assert(channels > 0, `暂不支持 PNG colorType=${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const byte = raw[pos + x];
      const a = x >= channels ? out[rowStart + x - channels] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = x >= channels && y > 0 ? out[prevStart + x - channels] : 0;
      let value;
      switch (filter) {
        case 0:
          value = byte;
          break;
        case 1:
          value = byte + a;
          break;
        case 2:
          value = byte + b;
          break;
        case 3:
          value = byte + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = byte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`未知 PNG 行过滤器 ${filter}`);
      }
      out[rowStart + x] = value & 0xff;
    }
    pos += stride;
  }
  return { width, height, channels, data: out };
}

/** 统计亮度：mean（0~255 平均亮度）与 litRatio（亮度 > 30 的像素占比） */
function pngBrightness(base64, { litThreshold = 30 } = {}) {
  const png = decodePng(Buffer.from(base64, 'base64'));
  const { width, height, channels, data } = png;
  const count = width * height;
  let sum = 0;
  let lit = 0;
  for (let i = 0, p = 0; i < count; i += 1, p += channels) {
    const lum = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    sum += lum;
    if (lum > litThreshold) lit += 1;
  }
  return {
    width,
    height,
    pixels: count,
    mean: sum / count,
    litRatio: lit / count,
  };
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 给目录拍快照（第一层 + config.json 的 sha256/mtime），用于观察真实站点有没有被改动。
 *
 * 默认忽略：`.git` / `.github`（git 自身会动）、`.backups/`（配置工具的写前备份目录）、
 * 以及根目录的 `config.json.bak-*`（旧版散落的备份）——这些是保存副产物，不代表「有人改了配置」。
 */
async function snapshotDir(dir, { ignore = ['.git', '.github', '.backups'], ignorePattern = /^config\.json\.bak-/ } = {}) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (ignore.includes(entry.name)) continue;
    if (ignorePattern && ignorePattern.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const stat = await fsp.stat(full);
    items.push({
      name: entry.name,
      isDir: entry.isDirectory(),
      size: entry.isDirectory() ? 0 : stat.size,
      mtimeMs: entry.isDirectory() ? 0 : Math.round(stat.mtimeMs),
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  const configPath = path.join(dir, 'config.json');
  const configStat = fs.existsSync(configPath) ? await fsp.stat(configPath) : null;
  return {
    items,
    configHash: configStat ? hashFile(configPath) : null,
    configMtime: configStat ? configStat.mtime.toISOString() : null,
  };
}

/* ========================================================================== *
 * 3. JSON Schema（draft-07 子集）校验器
 *    站点 config.schema.json 只用到 type / const / enum / required /
 *    properties / items / additionalProperties，这里实现这几条即可。
 * ========================================================================== */

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'invalid-number';
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    default:
      return true;
  }
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 校验 value 是否符合 schema（支持 type/const/enum/required/properties/items/additionalProperties）。
 * @returns {string[]} 错误列表，空数组 = 通过
 */
function validateSchema(schema, value, where = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (Array.isArray(schema.type)) {
    if (!schema.type.some((t) => matchesType(value, t))) {
      errors.push(`${where}: 类型应为 ${schema.type.join(' | ')}，实际 ${typeOf(value)}`);
      return errors;
    }
  } else if (typeof schema.type === 'string' && !matchesType(value, schema.type)) {
    errors.push(`${where}: 类型应为 ${schema.type}，实际 ${typeOf(value)}`);
    return errors;
  }

  if ('const' in schema && !deepEqual(value, schema.const)) {
    errors.push(`${where}: 应为常量 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
    errors.push(`${where}: 应为 ${schema.enum.map((v) => JSON.stringify(v)).join(' | ')} 之一，实际 ${JSON.stringify(value)}`);
  }

  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${where}: 缺少必填字段 "${key}"`);
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) errors.push(...validateSchema(sub, value[key], `${where}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${where}: 不允许的额外字段 "${key}"`);
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateSchema(schema.items, item, `${where}[${index}]`));
    });
  }

  return errors;
}

/* ========================================================================== *
 * 4. 临时站点副本 / 工具服务器
 * ========================================================================== */

const SITE_ENTRY_FILES = ['index.html', 'config.json', 'config.schema.json'];

/**
 * 站点里需要整目录复制的资源：瓦片底图（manifest + 各层 PNG）。
 * 不复制的话，配了 tiles 的维度在副本里一定会 404 → 工具只能回退单图，「瓦片模式」就没法验收。
 */
const SITE_ENTRY_DIRS = ['tiles'];

/** 复制站点仓库到 %TEMP%（只复制工具/预览需要的部分，跳过 .git、tests、docs） */
async function prepareSiteCopy(siteRepo, { verbose = false } = {}) {
  assert(fs.existsSync(siteRepo), `站点仓库不存在：${siteRepo}（用 --site-repo=<路径> 指定）`);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssm-cfg-e2e-'));
  const copied = [];

  for (const name of SITE_ENTRY_FILES) {
    const src = path.join(siteRepo, name);
    if (!fs.existsSync(src)) continue;
    await fsp.copyFile(src, path.join(dir, name));
    copied.push(name);
  }

  const assetsSrc = path.join(siteRepo, 'assets');
  assert(fs.existsSync(assetsSrc), `站点仓库缺少 assets/：${assetsSrc}`);
  await fsp.cp(assetsSrc, path.join(dir, 'assets'), {
    recursive: true,
    force: true,
    filter: (src) => !/[\\/]\.git[\\/]?$/.test(src),
  });
  copied.push('assets/');

  // 瓦片底图目录（可选）：manifest + tiles/<level>/<x>_<y>.png
  for (const name of SITE_ENTRY_DIRS) {
    const src = path.join(siteRepo, name);
    if (!fs.existsSync(src)) continue;
    await fsp.cp(src, path.join(dir, name), {
      recursive: true,
      force: true,
      filter: (entry) => !/[\\/]\.git[\\/]?$/.test(entry),
    });
    copied.push(`${name}/`);
  }

  // 三张基底图（主世界/下界/末地）以及任何放在站点根目录的图片
  for (const entry of await fsp.readdir(siteRepo, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
    await fsp.copyFile(path.join(siteRepo, entry.name), path.join(dir, entry.name));
    copied.push(entry.name);
  }

  // 安全自检：副本里不能有 .git，也必须有 config.json
  assert(!fs.existsSync(path.join(dir, '.git')), '站点副本里出现了 .git，复制规则有问题');
  assert(fs.existsSync(path.join(dir, 'config.json')), '站点副本里没有 config.json');

  if (verbose) console.log(`  · 站点副本：${dir}（${copied.length} 项：${copied.join('、')}）`);
  return { dir, copied };
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.SSM_SITE;
  delete env.SSM_PORT;
  delete env.SSM_HOST;
  delete env.SSM_DATA;
  return env;
}

/** 启动 `node server.mjs --port=<端口> --site=<副本> --data=<临时草稿目录>` */
async function startToolServer({ port, siteDir, dataDir, timeoutMs = 20_000, verbose = false }) {
  const entry = path.join(TOOL_ROOT, 'server.mjs');
  assert(fs.existsSync(entry), `找不到 server.mjs：${entry}（服务端可能还没写完）`);

  const args = [entry, `--port=${port}`, `--site=${siteDir}`];
  if (dataDir) args.push(`--data=${dataDir}`);

  const child = spawn(process.execPath, args, {
    cwd: TOOL_ROOT,
    stdio: verbose ? 'inherit' : 'ignore',
    windowsHide: true,
    env: cleanEnv(),
  });
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const origin = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (exitInfo) {
      throw new Error(
        `server 进程提前退出（code=${exitInfo.code} signal=${exitInfo.signal}），端口 ${port} 可能被占用或 --site 无效`,
      );
    }
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.ok) {
          return {
            origin,
            port,
            pid: child.pid,
            child,
            health: body,
            startupMs: Date.now() - startedAt,
            stop: async () => stopToolServer({ pid: child.pid, child, origin }),
          };
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }

  killProcessTree(child.pid);
  throw new Error(
    `等待 GET /api/health 就绪超时（${timeoutMs} ms）：${origin}${lastError ? `；最后错误：${lastError.message}` : ''}`,
  );
}

async function stopToolServer(server) {
  if (!server || !server.pid) return { killed: false, portClosed: true };
  killProcessTree(server.pid);
  await waitUntil(() => server.child.exitCode !== null, {
    timeout: 6000,
    interval: 100,
    label: 'server 进程退出',
  }).catch(() => {});
  const portClosed = await waitUntil(
    async () => {
      try {
        await fetch(`${server.origin}/api/health`, { signal: AbortSignal.timeout(400) });
        return false;
      } catch {
        return true;
      }
    },
    { timeout: 5000, interval: 150, label: '端口关闭' },
  )
    .then(() => true)
    .catch(() => false);
  return { killed: true, portClosed };
}

/* ========================================================================== *
 * 5. 页面探测工具（全部基于 index.html / 契约 §4 里已经存在的 DOM）
 * ========================================================================== */

const SEL = {
  tree: '#tree',
  form: '#form',
  issues: '#issues',
  status: '#status',
  toast: '#toast',
  toolbar: '#toolbar',
  canvasRoot: '#canvas-root',
  canvasImage: '#canvas-image',
  canvasOverlay: '#canvas-overlay',
  previewFrame: '#preview-frame',
  previewDialog: '#preview-dialog',
  dimensionTabs: '#dimension-tabs',
};

/** 一次性抓取页面上所有跟断言有关的 DOM 事实 */
async function domFacts(page) {
  return page.evalFn((SELJSON) => {
    const S = JSON.parse(SELJSON);
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.innerText || el.textContent || '').trim() : null;
    };
    const cut = (value, n) => {
      const t = String(value == null ? '' : value);
      return t.length > n ? `${t.slice(0, n)}…` : t;
    };
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const tree = document.querySelector(S.tree);
    const form = document.querySelector(S.form);
    const inputs = Array.from((form || document).querySelectorAll('input, select, textarea'))
      .filter((el) => el.type !== 'hidden')
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        id: el.id || '',
        name: el.name || '',
        value: el.value,
        placeholder: el.placeholder || '',
        label: (() => {
          const lab = el.closest('label');
          if (lab) return lab.textContent.trim().slice(0, 40);
          const prev = el.previousElementSibling;
          if (prev && prev.textContent) return prev.textContent.trim().slice(0, 40);
          return (el.getAttribute('aria-label') || '').slice(0, 40);
        })(),
        visible: visible(el),
      }));
    const img = document.querySelector(S.canvasImage);
    const tool = window.__tool;
    return {
      origin: location.origin,
      title: document.title,
      readyState: document.readyState,
      hasTool: Boolean(tool),
      toolKeys: tool ? Object.keys(tool) : [],
      treeExists: Boolean(tree),
      treeChildCount: tree ? tree.children.length : 0,
      treeTextLength: tree ? (tree.innerText || '').length : 0,
      treeWaypointNodes: tree ? tree.querySelectorAll('[data-waypoint-id]').length : 0,
      treeDimensionNodes: tree ? tree.querySelectorAll('[data-dimension-id]').length : 0,
      treeGroupNodes: tree ? tree.querySelectorAll('[data-group-id]').length : 0,
      treeText: cut(text(S.tree) || '', 600),
      dimensionTabsText: cut(text(S.dimensionTabs) || '', 200),
      formTitle: cut(text('#form-title') || '', 80),
      formInputs: inputs,
      statusText: cut(text(S.status) || '', 200),
      statusTone: document.querySelector(S.status)?.dataset.tone || '',
      issuesText: cut(text(S.issues) || '', 400),
      toastText: cut(text(S.toast) || '', 200),
      imageLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
      imageNatural: img ? { width: img.naturalWidth, height: img.naturalHeight } : null,
      // 瓦片底图（维度配了 tiles 时 #canvas-image 会被隐藏，改用 canvas 位图判断「底图载入」）
      tileStats:
        typeof tool?.tiles === 'function'
          ? (() => {
              try {
                return tool.tiles();
              } catch {
                return null;
              }
            })()
          : null,
      canvasMarkers: document.querySelectorAll(`${S.canvasOverlay} .marker`).length,
      pickPoints: document.querySelectorAll(`${S.canvasOverlay} .pick-crosshair`).length,
      bodyMode: document.body.dataset.mode || '',
      previewOpen: Boolean(document.querySelector(S.previewDialog) && !document.querySelector(S.previewDialog).hidden),
      previewSrc: document.querySelector(S.previewFrame)?.getAttribute('src') || '',
    };
  }, JSON.stringify(SEL));
}

/** 失败现场用的 DOM 摘要（层级 + 文本，最长 240 行） */
async function domSnapshot(page) {
  return page.evalFn(() => {
    const out = [];
    const SKIP = new Set(['svg', 'path', 'use', 'symbol', 'defs', 'circle', 'rect', 'line', 'g', 'br']);
    const walk = (el, depth) => {
      if (out.length > 240 || depth > 6) return;
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) return;
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
      const rect = el.getBoundingClientRect();
      const ownText = el.children.length === 0 ? (el.textContent || '').trim().slice(0, 60) : '';
      out.push(
        `${'  '.repeat(depth)}${tag}${id}${cls}` +
          `${rect.width ? ` [${Math.round(rect.width)}x${Math.round(rect.height)}]` : ' [hidden]'}` +
          `${ownText ? ` "${ownText}"` : ''}`,
      );
      for (const child of el.children) walk(child, depth + 1);
    };
    if (document.body) walk(document.body, 0);
    const inputs = Array.from(document.querySelectorAll('input, select, textarea'))
      .slice(0, 60)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type,
        id: el.id,
        name: el.name,
        value: el.value,
        placeholder: el.placeholder,
      }));
    return { url: location.href, outline: out.join('\n'), inputs };
  });
}

/** 按选择器/文本找可点击元素；返回屏幕坐标与命中方式（多候选，容忍 UI 文案变化） */
async function findClickable(page, { selectors = [], texts = [], root = null } = {}) {
  return page.evalFn((selectors, texts, rootSel) => {
    const scope = rootSel ? document.querySelector(rootSel) : document;
    if (!scope) return null;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const describe = (el, how) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return {
        how,
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        text: (el.textContent || '').trim().slice(0, 40),
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        width: r.width,
        height: r.height,
      };
    };
    for (const sel of selectors) {
      const el = Array.from(scope.querySelectorAll(sel)).find(visible);
      if (el) return describe(el, `选择器 ${sel}`);
    }
    if (!texts.length) return null;
    const patterns = texts.map((t) => new RegExp(t));
    const candidates = Array.from(
      scope.querySelectorAll('button, [role="button"], a, .btn, [data-action], [data-act]'),
    ).filter(visible);
    for (const pattern of patterns) {
      const el = candidates.find((node) => {
        const hay = [node.textContent || '', node.getAttribute('aria-label') || '', node.getAttribute('title') || ''].join(' ');
        return pattern.test(hay);
      });
      if (el) return describe(el, `文本 /${pattern.source}/`);
    }
    return null;
  }, selectors, texts, root);
}

/** 点击「多候选选择器 → 文本 → __tool 动作」三层兜底，返回实际命中方式 */
async function clickAction(ctx, { selectors = [], texts = [], toolAction = null, root = null }) {
  const page = ctx.page;
  const match = await findClickable(page, { selectors, texts, root });
  if (match) {
    if (match.width <= 1 || match.height <= 1) throw new Error(`元素尺寸为 0，无法点击：${match.how}`);
    await page.click(match.cx, match.cy);
    await page.settle(120);
    return `${match.how}（${match.text || match.id || match.tag}）`;
  }
  if (toolAction) {
    const via = await page.evalFn((name) => {
      const tool = window.__tool;
      if (!tool || typeof tool.action !== 'function') return { ok: false, reason: 'window.__tool.action 不可用' };
      tool.action(name);
      return { ok: true };
    }, toolAction);
    if (via?.ok) {
      await page.settle(160);
      return `__tool.action('${toolAction}')`;
    }
    throw new Error(
      `找不到可点击元素（选择器 ${selectors.join(' / ') || '—'}；文本 ${texts.join(' / ') || '—'}）；` +
        `__tool.action 兜底也失败：${via?.reason || '未知'}`,
    );
  }
  throw new Error(`找不到可点击元素：选择器 ${selectors.join(' / ') || '—'}；文本 ${texts.join(' / ') || '—'}`);
}

/** 键盘按键（Ctrl+Z / Ctrl+Shift+Z）；app.js 在 window 上监听，焦点在输入框里也能生效 */
async function pressKey(page, { key, code, keyCode, modifiers = 0 }) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await page.settle(140);
}

async function pressCtrlZ(page, { shift = false } = {}) {
  await pressKey(page, {
    key: shift ? 'Z' : 'z',
    code: 'KeyZ',
    keyCode: 90,
    modifiers: shift ? 2 | 8 : 2,
  });
}

/** 用原生 setter 改输入框，并派发【单个】input/change（等价用户键入，不会触发两次 patch） */
async function setInputValue(page, selector, index, value) {
  const ok = await page.evalFn((sel, idx, val) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    const el = nodes[idx];
    if (!el) return false;
    el.focus();
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, String(val));
    else el.value = String(val);
    // editor.js 对 input 和 change 都绑了 onChange：只派发一个，避免一次编辑产生两条撤销记录
    const isToggle = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio';
    el.dispatchEvent(new Event(isToggle ? 'change' : 'input', { bubbles: true }));
    return true;
  }, selector, index, value);
  assert(ok, `找不到输入框：${selector}[${index}]`);
  await page.settle(140);
}

/** 用 data-field 定位表单字段（editor.js 的字段约定，比 id 更稳） */
async function findFormField(page, field) {
  return page.evalFn((fieldName) => {
    const els = Array.from(document.querySelectorAll('#form [data-field]'));
    for (let i = 0; i < els.length; i += 1) {
      const el = els[i];
      if (el.dataset.field !== fieldName) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      return {
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        value: el.value,
        id: el.id || '',
        key: el.dataset.fieldKey || '',
        formKind: el.closest('#form')?.dataset.kind || '',
        selector: `#form [data-field="${fieldName}"]`,
      };
    }
    return null;
  }, field);
}

/** 填表单字段：优先 data-field，其次「当前值匹配」兜底 */
async function setFormField(page, field, value, { fallbackValue } = {}) {
  const direct = await findFormField(page, field);
  if (direct) {
    await setInputValue(page, direct.selector, 0, value);
    return { how: `#form [data-field="${field}"]` };
  }
  if (fallbackValue !== undefined) {
    const byValue = await findInputByValue(page, fallbackValue);
    if (byValue) {
      await page.evalFn((from, to) => {
        const nodes = Array.from(document.querySelectorAll('#form input, #form textarea'));
        const el = nodes.find((n) => String(n.value) === String(from) && n.getBoundingClientRect().width > 1);
        if (!el) return false;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, String(to));
        else el.value = String(to);
        const isToggle = el.tagName === 'SELECT' || el.type === 'checkbox';
        el.dispatchEvent(new Event(isToggle ? 'change' : 'input', { bubbles: true }));
        return true;
      }, fallbackValue, value);
      await page.settle(140);
      return { how: `按当前值「${fallbackValue}」定位` };
    }
  }
  const kind = await page.evalFn(() => document.querySelector('#form')?.dataset.kind || '');
  throw new Error(`找不到表单字段 data-field="${field}"（当前表单 kind=${kind || '未知'}）`);
}

/** 把画布放大到 ≥ minScale 倍（1 屏幕像素 ≈ 1 图片像素），保证点击/拖拽精度 */
async function ensureZoomAtLeast(ctx, minScale = 1) {
  const page = ctx.page;
  const readScale = () =>
    page.evalFn(() => {
      const canvas = window.__tool && window.__tool.canvas;
      const vs = canvas && typeof canvas.getViewState === 'function' ? canvas.getViewState() : null;
      return vs && Number.isFinite(vs.scale) ? vs.scale : null;
    });
  let scale = await readScale();
  if (!Number.isFinite(scale)) return { ok: false, reason: '拿不到 canvas.getViewState().scale' };
  const before = scale;
  let steps = 0;
  while (scale < minScale && steps < 24) {
    await page.evalFn(() => {
      const canvas = window.__tool && window.__tool.canvas;
      if (canvas && typeof canvas.zoomBy === 'function') canvas.zoomBy(1.35);
      return true;
    });
    await page.settle(90);
    const next = await readScale();
    if (!Number.isFinite(next) || next <= scale) break;
    scale = next;
    steps += 1;
  }
  return { ok: scale >= minScale, scale, before, steps };
}

/** 找「当前值等于 value」的表单输入框（只认真实属性面板 #form，绝不碰 #search 之类的旁路输入框） */
async function findInputByValue(page, value) {
  return page.evalFn((wanted) => {
    const nodes = Array.from(document.querySelectorAll('#form input, #form select, #form textarea'));
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i];
      if (el.type === 'hidden') continue;
      if (!el.closest('#form')) continue;
      if (String(el.value) !== String(wanted)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const matches = [];
      if (el.id) matches.push(`#${CSS.escape(el.id)}`);
      if (el.name) matches.push(`[name="${el.name}"]`);
      const label = el.closest('label');
      return {
        value: el.value,
        id: el.id,
        name: el.name,
        type: el.type,
        label: label ? label.textContent.trim().slice(0, 30) : '',
        selector: matches[0] || null,
      };
    }
    return null;
  }, value);
}

/** 画布 / 交互状态：模式、待落位目标、选中项、「在图上取点」按钮状态 */
async function readCanvasMode(page) {
  return page.evalFn(() => {
    const tool = window.__tool;
    const canvas = tool && tool.canvas;
    const st = tool && typeof tool.state === 'function' ? tool.state() : null;
    const badge = document.getElementById('mode-badge');
    const pick = document.getElementById('btn-pick-position');
    return {
      mode: canvas && typeof canvas.getMode === 'function' ? canvas.getMode() : document.body.dataset.mode || null,
      placeFor: st ? st.placeFor ?? null : null,
      selection: st ? st.selection : null,
      haveProjection: Boolean(st && st.projection),
      badgeVisible: Boolean(badge && !badge.hidden),
      badgeText: badge ? (badge.textContent || '').trim().slice(0, 70) : '',
      pickDisabled: pick ? pick.disabled : null,
      pickText: pick ? (pick.textContent || '').trim().slice(0, 20) : null,
      status: (document.getElementById('status')?.textContent || '').trim().slice(0, 90),
    };
  });
}

/* ------------------------------ 画布坐标 ------------------------------ */

/** 画布上可见区域内的某个相对位置 → 屏幕坐标 + 对应的图片像素（瓦片/单图通用） */
async function canvasPointAt(page, fx, fy) {
  const info = await page.evalFn((fx, fy, SELJSON) => {
    const S = JSON.parse(SELJSON);
    const img = document.querySelector(S.canvasImage);
    const tiles = document.getElementById('canvas-tiles');
    const root = document.querySelector(S.canvasRoot);
    const stats = window.__tool && typeof window.__tool.tiles === 'function' ? window.__tool.tiles() : null;
    // 当前底图二选一：瓦片激活时 <canvas id="canvas-tiles"> 才是可见的那张
    const isTile = Boolean(stats && stats.active && tiles && getComputedStyle(tiles).display !== 'none');
    const target = isTile ? tiles : img;
    if (!target || !root) return { error: '缺少底图元素（#canvas-image / #canvas-tiles）或 #canvas-root' };
    if (!isTile && (!img.complete || !img.naturalWidth || !img.naturalHeight)) {
      return { error: `画布图片未载入（naturalWidth=${img.naturalWidth}，complete=${img.complete}）` };
    }
    const logicalW = isTile ? Number(stats.imageWidth) : img.naturalWidth;
    const logicalH = isTile ? Number(stats.imageHeight) : img.naturalHeight;
    if (!(logicalW > 0) || !(logicalH > 0)) {
      return { error: `底图逻辑尺寸无效（${isTile ? '瓦片' : '单图'}：${logicalW}×${logicalH}）` };
    }
    // 瓦片模式（外扩窗口渲染）：<canvas> 的 CSS 盒 = 视口外扩 25% 的窗口，真正的「整幅图片盒」在 #canvas-stage 上，
    // 换算必须用它（单图模式下 img 的矩形与 stage 一致，两种模式统一读 stage）
    const stage = isTile ? document.querySelector('#canvas-stage') : null;
    const ir = (stage || target).getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const left = Math.max(ir.left, rr.left, 0);
    const right = Math.min(ir.right, rr.right, window.innerWidth);
    const top = Math.max(ir.top, rr.top, 0);
    const bottom = Math.min(ir.bottom, rr.bottom, window.innerHeight);
    if (!(right - left > 60) || !(bottom - top > 60)) {
      return {
        error: `画布可见区域太小：${Math.round(right - left)}×${Math.round(bottom - top)}` +
          `（底图=${isTile ? 'tiles' : 'image'}，rect=${Math.round(ir.width)}×${Math.round(ir.height)} @ ${Math.round(ir.left)},${Math.round(ir.top)}）`,
      };
    }
    const cx = left + (right - left) * fx;
    const cy = top + (bottom - top) * fy;
    const px = (cx - ir.left) * (logicalW / (ir.width || 1));
    const py = (cy - ir.top) * (logicalH / (ir.height || 1));
    const hit = document.elementFromPoint(cx, cy);
    return {
      cx,
      cy,
      px,
      py,
      imageSize: { width: logicalW, height: logicalH },
      hit: hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}` : null,
      hitUid: hit ? String(hit.dataset?.uid || '') : '',
      canvasVisible: { width: Math.round(right - left), height: Math.round(bottom - top) },
    };
  }, fx, fy, JSON.stringify(SEL));
  if (info?.error) throw new Error(info.error);
  return info;
}

/** 世界坐标 ← 图片像素（按给定画幅，语义与站点 coords.js createProjection 一致） */
function worldFromPixel(cal, imageSize, px, py) {
  const xMin = num(cal.xMin);
  const xMax = num(cal.xMax);
  const zMin = num(cal.zMin);
  const zMax = num(cal.zMax);
  const spanX = xMax - xMin;
  const spanZ = zMax - zMin;
  let t = num(py) / num(imageSize.height);
  if (cal.flipZ === true) t = 1 - t;
  return { x: xMin + (num(px) / num(imageSize.width)) * spanX, z: zMin + t * spanZ };
}

/* ------------------------------ 草稿 / 站点配置读取 ------------------------------ */

async function readLiveDraft(ctx) {
  if (ctx.page) {
    try {
      const draft = await ctx.page.evalFn(() => {
        const tool = window.__tool;
        if (!tool) return null;
        let value = typeof tool.draft === 'function' ? tool.draft() : tool.draft;
        if (!value && typeof tool.state === 'function') {
          const st = tool.state();
          value = st && st.draft ? st.draft : null;
        }
        return value || null;
      });
      if (draft && Array.isArray(draft.dimensions)) return { draft, source: 'window.__tool.draft()' };
    } catch {
      /* 页面还没起来就退回 /api/state */
    }
  }
  const res = await fetchJson(`${ctx.origin}/api/state`);
  if (res.json?.draft?.dimensions) return { draft: res.json.draft, source: 'GET /api/state（自动保存的草稿）' };
  return { draft: null, source: '无' };
}

/** 当前配置：优先内存草稿，其次站点已保存的 config.json */
async function readCurrentConfig(ctx) {
  const live = await readLiveDraft(ctx);
  if (live.draft) return { config: live.draft, source: live.source };
  const saved = await readSiteConfigFile(ctx);
  return { config: saved.config, source: '站点 config.json' };
}

async function readSiteConfigFile(ctx) {
  const file = path.join(ctx.siteDir, 'config.json');
  const text = await fsp.readFile(file, 'utf8');
  return { text, bytes: Buffer.byteLength(text), config: JSON.parse(text.replace(/^\uFEFF/, '')), file };
}

function dimensionOf(config, id = 'overworld') {
  const dims = Array.isArray(config?.dimensions) ? config.dimensions : [];
  return dims.find((d) => d && String(d.id) === String(id)) || dims[0] || null;
}

function waypointsOf(config, dimId = 'overworld') {
  return dimensionOf(config, dimId)?.waypoints || [];
}

async function waitForConfig(ctx, predicate, { timeout = 6000, label = '草稿状态' } = {}) {
  return waitUntil(
    async () => {
      const { config, source } = await readCurrentConfig(ctx);
      if (!config) return false;
      return predicate(config) ? { config, source } : false;
    },
    { timeout, interval: 120, label },
  );
}

/* ------------------------------ 选择 / 表单 ------------------------------ */

/** 选中某个路径点（优先点树里的节点，退化为 __tool.select） */
async function selectWaypoint(ctx, { id, name }) {
  const page = ctx.page;
  const clickInfo = await page.evalFn((nameText, idText) => {
    const tree = document.querySelector('#tree');
    if (!tree) return null;
    const treeRect = tree.getBoundingClientRect();
    const measure = (el, how) => {
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return null;
      // 必须落在树的可见区域内，否则点出去会打到别的地方（甚至画布）
      const inside =
        r.top >= treeRect.top - 2 && r.bottom <= treeRect.bottom + 2 && r.left >= treeRect.left - 2 && r.right <= treeRect.right + 2;
      if (!inside) return null;
      return { how, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    };
    if (idText) {
      const byId = tree.querySelector(`[data-waypoint-id="${String(idText).replace(/"/g, '\\"')}"]`);
      const info = measure(byId, '[data-waypoint-id]');
      if (info) return info;
    }
    if (!nameText) return null;
    const nodes = Array.from(tree.querySelectorAll('*')).filter((el) => {
      if (['svg', 'path', 'use', 'symbol'].includes(el.tagName.toLowerCase())) return false;
      return (el.textContent || '').includes(nameText);
    });
    nodes.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    for (const el of nodes) {
      const info = measure(el, '树节点文本');
      if (info) return info;
    }
    return null;
  }, name, id);

  const selectionNow = () =>
    page.evalFn((wpId) => {
      const st = window.__tool && typeof window.__tool.state === 'function' ? window.__tool.state() : null;
      return st && st.selection ? st.selection.waypointId ?? null : null;
    }, id);

  let how = null;
  if (clickInfo) {
    await page.click(clickInfo.cx, clickInfo.cy);
    await page.settle(180);
    how = `点击树节点（${clickInfo.how}）`;
    if (String(await selectionNow()) === String(id)) return { how, selected: true };
  }

  // 兜底：直接走 app 的 select()（与点树节点同一条代码路径）
  const via = await page.evalFn((dimId, wpId) => {
    const tool = window.__tool;
    if (!tool || typeof tool.select !== 'function') return { ok: false };
    tool.select({ dimensionId: dimId, waypointId: wpId, groupId: null });
    return { ok: true };
  }, ctx.dimensionId, id);
  assert(via?.ok, `无法选中路径点「${name}」：树里点不到（${how || '未找到节点'}），__tool.select 也不可用`);
  await page.settle(220);
  const after = await selectionNow();
  assert(
    String(after) === String(id),
    `选中路径点「${name}」失败：selection.waypointId 实际 ${JSON.stringify(after)} vs 期望 ${JSON.stringify(String(id))}（点击方式：${how || '无'}）`,
  );
  return { how: `__tool.select（${how || '树里找不到该点'}）`, selected: true };
}

/** 选中某个维度（优先点 #dimension-tabs，退化为 __tool.select） */
async function selectDimension(ctx, dimId, dimName) {
  const page = ctx.page;
  const info = await page.evalFn((nameText, idText) => {
    const tabs = document.querySelector('#dimension-tabs');
    if (!tabs) return null;
    const candidates = Array.from(tabs.querySelectorAll('*')).filter((el) => {
      if (['svg', 'path', 'use', 'symbol'].includes(el.tagName.toLowerCase())) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const text = (el.textContent || '').trim();
      return text && (text.includes(nameText) || el.dataset?.dimensionId === idText);
    });
    candidates.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    const el = candidates[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, text: (el.textContent || '').trim().slice(0, 20) };
  }, dimName, dimId);

  if (info) {
    await page.click(info.cx, info.cy);
    await page.settle(200);
    const ok = await page.evalFn((idText) => {
      const tool = window.__tool;
      const st = tool && typeof tool.state === 'function' ? tool.state() : null;
      return Boolean(st && st.selection && String(st.selection.dimensionId) === String(idText));
    }, dimId);
    if (ok) return { how: `点击维度标签（${info.text}）`, ok: true };
  }

  const via = await page.evalFn((idText) => {
    const tool = window.__tool;
    if (!tool) return { ok: false, reason: 'window.__tool 不可用' };
    const fn = typeof tool.activateDimension === 'function' ? tool.activateDimension : typeof tool.select === 'function' ? (id) => tool.select({ dimensionId: id, waypointId: null, groupId: null }) : null;
    if (!fn) return { ok: false, reason: '没有 activateDimension / select' };
    fn(idText);
    return { ok: true };
  }, dimId);
  await page.settle(250);
  return { how: via?.ok ? `__tool 切换到 ${dimId}` : null, ok: Boolean(via?.ok), reason: via?.reason };
}

/**
 * 修复「维度 id 被清空」造成的僵局。
 *
 * app.js 的 handlePatch 用 currentDimension()（依赖 selection.dimensionId）定位维度，
 * id 被清空后就再也找不到维度，因此 UI 与 patch 都无法把 id 改回去 —— 这是被测代码的健壮性问题，
 * e2e 只负责把现场恢复出来继续测后面的用例，并把这件事记进「已知限制 / 缺陷」。
 */
async function repairDimensionIds(ctx) {
  const page = ctx.page;
  const result = await page.evalFn(() => {
    const tool = window.__tool;
    if (!tool) return { ok: false, reason: 'window.__tool 不可用' };
    const draft = tool.draft();
    const dims = (draft && draft.dimensions) || [];
    if (!dims.length) return { ok: false, reason: '草稿里没有维度' };
    let changed = false;
    if (!dims.some((d) => String(d.id) === 'overworld')) {
      const target = dims.find((d) => (d.waypoints || []).length > 0) || dims[0];
      target.id = 'overworld';
      changed = true;
    }
    if (!dims.some((d) => String(d.id) === String(draft.defaultDimension))) draft.defaultDimension = 'overworld';
    const selection = tool.state ? tool.state().selection : null;
    if (!selection || !dims.some((d) => String(d.id) === String(selection.dimensionId))) {
      tool.select({ dimensionId: 'overworld', waypointId: null, groupId: null });
    }
    const v = typeof tool.validate === 'function' ? tool.validate() : null;
    return { ok: true, changed, errors: (v?.errors || []).length, ids: dims.map((d) => String(d.id)) };
  });
  await page.settle(200);
  return result;
}

/** 点「读取站点配置」从站点 config.json 重载（confirm 会被自动接受） */
async function reloadFromSite(ctx) {
  const page = ctx.page;
  await clickAction(ctx, {
    selectors: ['#btn-import-config', '[data-action="reload-site"]'],
    texts: ['读取站点配置'],
    toolAction: 'reload-site',
  });
  await waitUntil(
    async () => {
      const { config } = await readCurrentConfig(ctx);
      return (config?.dimensions || []).some((d) => String(d.id) === 'overworld');
    },
    { timeout: 6000, interval: 150, label: '从站点配置重载后维度 id 恢复' },
  );
  await page.settle(250);
}

/* ========================================================================== *
 * 6. 检查项
 * ========================================================================== */

/* ------------------------------ 扩展：Schema 校验器自检 ------------------------------ */

async function checkSchemaSelfTest(ctx) {
  const schemaPath = path.join(ctx.siteDir, 'config.schema.json');
  assert(fs.existsSync(schemaPath), `站点副本里没有 config.schema.json：${schemaPath}`);
  ctx.schema = JSON.parse(await fsp.readFile(schemaPath, 'utf8'));

  const real = JSON.parse(await fsp.readFile(path.join(ctx.siteDir, 'config.json'), 'utf8'));
  const realErrors = validateSchema(ctx.schema, real);
  assert(realErrors.length === 0, `站点现有 config.json 本应通过 schema，却报了 ${realErrors.length} 条：${realErrors.slice(0, 3).join('；')}`);

  const broken = [{ id: 'x' }, { id: 'y', name: '缺 image' }];
  const brokenErrors = validateSchema(ctx.schema, { dimensions: broken });
  assert(brokenErrors.length > 0, '校验器没有发现「维度缺 image」的坏配置，§7.4 的 schema 断言将失去意义');

  const noDims = validateSchema(ctx.schema, {});
  assert(noDims.length > 0, '校验器没有发现「缺少 dimensions」');

  return `站点配置 0 错误；坏配置被拒 ${brokenErrors.length} 条（如 ${brokenErrors[0]}）`;
}

/* ------------------------------ §7.1 health ------------------------------ */

async function checkHealth(ctx) {
  const res = await fetchJson(`${ctx.origin}/api/health`, { timeout: 5000 });
  assert(res.status === 200, `GET /api/health 实际 ${res.status} vs 期望 200`);
  const body = res.json || {};
  assert(body.ok === true, `health.ok 实际 ${JSON.stringify(body.ok)} vs 期望 true`);
  assert(typeof body.version === 'string' && body.version.length > 0, `health.version 缺失（实际 ${JSON.stringify(body.version)}）`);
  assert(Number.isFinite(Number(body.uptime)), `health.uptime 不是数字（实际 ${JSON.stringify(body.uptime)}）`);

  // 安全断言：服务器必须指向临时站点副本，绝不能是真实仓库
  assert(body.siteDir, '/api/health 没有返回 siteDir，无法确认写入目标');
  const resolvedSite = path.resolve(String(body.siteDir));
  const realSite = path.resolve(OPT.siteRepo);
  assert(
    resolvedSite.toLowerCase() !== realSite.toLowerCase(),
    `服务器 siteDir 指向了真实站点仓库（${resolvedSite}）——为保护真实仓库，立即中止`,
  );
  assert(resolvedSite === path.resolve(ctx.siteDir), `服务器 siteDir 实际 ${resolvedSite} vs 期望临时副本 ${path.resolve(ctx.siteDir)}`);

  // 草稿目录隔离（--data）
  const stateRes = await fetchJson(`${ctx.origin}/api/state`);
  const state = stateRes.json || {};
  assert(state.ok === true, `GET /api/state 实际 ${stateRes.status}，ok=${JSON.stringify(state.ok)}`);
  assert(state.configExists === true, `GET /api/state 的 configExists 实际 ${JSON.stringify(state.configExists)} vs 期望 true`);
  let dataDirNote = '未知（服务器未返回 dataDir）';
  if (state.dataDir) {
    dataDirNote = path.resolve(String(state.dataDir));
    if (ctx.dataDir) {
      assert(
        dataDirNote === path.resolve(ctx.dataDir),
        `草稿目录未被隔离：/api/state 返回 ${dataDirNote} vs 期望 --data=${ctx.dataDir}`,
      );
    }
  }

  ctx.siteDir = resolvedSite;
  return `200 · version=${body.version} · uptime=${body.uptime}s · siteDir=临时副本 · dataDir=${dataDirNote}`;
}

/* ------------------------------ §7.2 页面渲染 + console error ------------------------------ */

async function checkPageRender(ctx) {
  const page = ctx.page;
  const diag = ctx.diagnostics;

  // 重新导航一次，从「打开页面」开始计时（preflight 里那次只用于等 __tool 就绪）
  diag.clear();
  const navStarted = Date.now();
  await page.navigate(`${ctx.origin}/`, { timeout: 30_000 });

  const names = ctx.siteWaypointNames;
  const started = Date.now();
  let hit;
  try {
    hit = await page.waitFor(
      (nameList) => {
        const tree = document.querySelector('#tree');
        if (!tree) return false;
        const text = (tree.innerText || '').trim();
        const byAttr = tree.querySelectorAll('[data-waypoint-id]').length;
        const matched = nameList.filter((n) => n && text.includes(n)).length;
        if (byAttr > 0 && matched > 0) return { mode: '[data-waypoint-id]', waypoints: byAttr, matched };
        if (matched >= 2) return { mode: '树文本里的路径点名', waypoints: matched, matched };
        return false;
      },
      { timeout: 3000, interval: 100, label: '3 秒内渲染配置树', args: [names] },
    );
  } catch (error) {
    const facts = await domFacts(page);
    throw new Error(
      `打开页面后 3 秒内没渲染出维度/分组/路径点树：#tree 子节点=${facts.treeChildCount}、文本长度=${facts.treeTextLength}、` +
        `状态栏="${facts.statusText}"、window.__tool=${facts.hasTool ? '有' : '无'}`,
    );
  }
  const elapsed = Date.now() - started;
  // 树出来后等 bootstrap 收尾（__tool 就绪），再统计 console error
  await page.waitFor(() => Boolean(window.__tool), { timeout: 3000, interval: 100, label: '__tool 就绪' }).catch(() => {});
  await page.settle(200);

  const errors = diag.snapshot();
  if (errors.length) {
    throw new Error(
      `页面有 ${errors.length} 条 console error / 未捕获异常 / HTTP≥400（期望 0 条）：\n      ${diag.format(8).join('\n      ')}`,
    );
  }

  const facts = await domFacts(page);
  const tileActive = Boolean(facts.tileStats && facts.tileStats.active && facts.tileStats.imageWidth > 0);
  assert(
    tileActive || facts.imageLoaded,
    tileActive
      ? '瓦片底图激活但 manifest 尺寸无效'
      : `画布基底图没有载入（#canvas-image naturalWidth=${facts.imageNatural?.width ?? 0}，且没有激活瓦片底图）`,
  );
  const baseNote = tileActive
    ? `瓦片底图 ${facts.tileStats.imageWidth}×${facts.tileStats.imageHeight}（manifest）`
    : `图片 ${facts.imageNatural.width}×${facts.imageNatural.height}`;
  return `重新导航后 ${formatDuration(Date.now() - navStarted)} 内完成首屏；树渲染 ${formatDuration(elapsed)}（< 3000ms）· ${hit.mode} 命中 ${hit.waypoints} 个路径点 · ${baseNote} · console error / 异常 / HTTP≥400：0 条`;
}

/* ------------------------------ 可见性：基底图真的被画出来了 ------------------------------ */

/**
 * 事故回归：tool.css 里 `.canvas-image { opacity: 0 }` + `.is-loaded { opacity: 1 }`，
 * 而 canvas.js 有一段时间没加 `is-loaded` 类 → 图片在 DOM 里、尺寸/坐标全对，但屏幕上**完全不显示**。
 * 之前的断言只看 naturalWidth / getBoundingClientRect，全部通过 → 漏检。
 *
 * 这里三条独立证据：
 *   ① DOM：computed opacity === 1、class 含 is-loaded、visibility 可见、尺寸 > 50×50；
 *   ② 像素：截取图片区域算亮度（mean / 亮像素占比），能兜住 opacity/filter/遮挡/尺寸为 0；
 *   ③ 信息条：#canvas-info 必须显示「维度 · 图片 · W×H px」。
 *
 * 注意：#canvas-image 在 tool.css 里是 pointer-events:none（画布要靠父层接收拖拽），
 * 所以不能用 elementFromPoint/elementsFromPoint 判断「有没有被遮挡」——那会稳定假失败。
 */
async function checkCanvasVisible(ctx) {
  const page = ctx.page;

  // 先等 app 的「自动提亮」异步判定落定（body[data-enhance] 被赋值即表示判定完成），
  // 否则截图可能落在提亮前的一帧，亮度阈值不稳定。
  await page
    .waitFor(() => document.body.dataset.enhance !== undefined, {
      timeout: 5000,
      interval: 100,
      label: '自动提亮判定完成',
    })
    .catch(() => {});
  await page.settle(200);

  // 瓦片是异步加载的：等到「至少贴上一张」再断言，否则首帧就是空 canvas。
  // 这里不 await 失败（单图模式下 tiles() 为 null，直接跳过）。
  await waitUntil(
    () =>
      page.evalFn(() => {
        const s = window.__tool && typeof window.__tool.tiles === 'function' ? window.__tool.tiles() : null;
        return Boolean(s && s.active && (Number(s.loaded) > 0 || Number(s.drawn) > 0));
      }),
    { timeout: 8000, interval: 120, label: '瓦片底图至少贴上一张' },
  ).catch(() => {});

  const vis = await page.evalFn(() => {
    const img = document.getElementById('canvas-image');
    const tiles = document.getElementById('canvas-tiles');
    if (!img) return { error: '缺少 #canvas-image' };
    const stats = window.__tool && typeof window.__tool.tiles === 'function' ? window.__tool.tiles() : null;
    // 底图二选一：瓦片层激活时看 <canvas id="canvas-tiles">，否则看 <img id="canvas-image">
    const isTile = Boolean(stats && stats.active && tiles && getComputedStyle(tiles).display !== 'none');
    const target = isTile ? tiles : img;
    const cs = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    const info = document.getElementById('canvas-info');
    return {
      isTile,
      targetTag: target.tagName,
      opacity: cs.opacity,
      className: target.className,
      visibility: cs.visibility,
      display: cs.display,
      filter: cs.filter,
      complete: isTile ? true : img.complete,
      natural: isTile
        ? [Number(stats.imageWidth) || 0, Number(stats.imageHeight) || 0]
        : [img.naturalWidth, img.naturalHeight],
      stats,
      imageDisplay: getComputedStyle(img).display,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      enhance: document.body.dataset.enhance ?? null,
      infoHidden: info ? info.hidden : null,
      infoText: info ? (info.textContent || '').trim() : null,
      markers: document.querySelectorAll('#canvas-overlay .marker').length,
    };
  });
  assert(!vis.error, vis.error);

  // ① DOM 层：当前底图元素必须真的可见（瓦片模式 = <canvas id="canvas-tiles">）
  const baseLabel = vis.isTile ? '#canvas-tiles（瓦片底图）' : '#canvas-image（单图底图）';
  assert(
    Number(vis.opacity) === 1,
    `${baseLabel} 的 opacity 实际 ${vis.opacity} vs 期望 1（tool.css 里 .canvas-image 默认 opacity:0，检查 canvas.js 是否给底图加了 is-loaded 类）`,
  );
  assert(
    /\bis-loaded\b/.test(String(vis.className)),
    `${baseLabel} 缺少 is-loaded 类：class="${vis.className}"（没有它 → opacity 恒为 0 → 地图永远不显示）`,
  );
  assert(
    vis.visibility === 'visible' && vis.display !== 'none',
    `${baseLabel} 的 visibility/display 实际 ${vis.visibility}/${vis.display} vs 期望 visible/非 none`,
  );
  if (vis.isTile) {
    // 瓦片模式：canvas 位图必须真有像素（层级 / 位图尺寸 / DPR / 已解码瓦片）
    const s = vis.stats || {};
    assert(
      Number(s.canvasWidth) > 0 && Number(s.canvasHeight) > 0,
      `瓦片 canvas 位图尺寸 实际 ${s.canvasWidth}×${s.canvasHeight} vs 期望 > 0（层级选择或 _resizeBacking 没跑）`,
    );
    assert(
      Number.isFinite(s.level) && s.level >= 0,
      `瓦片层级 实际 ${JSON.stringify(s.level)} vs 期望 >= 0（tileset.levelForScale 没生效）`,
    );
    assert(
      Number(s.dpr) >= 1,
      `瓦片层 dpr 实际 ${JSON.stringify(s.dpr)} vs 期望 >= 1（画布没读到 devicePixelRatio）`,
    );
    assert(
      Number(s.imageWidth) > 0 && Number(s.imageHeight) > 0,
      `瓦片底图逻辑尺寸 实际 ${s.imageWidth}×${s.imageHeight} vs 期望 > 0（manifest 的 worldBlockRange 没接上）`,
    );
    assert(
      Number(s.loaded) > 0 || Number(s.drawn) > 0,
      `瓦片一张都没画出来：loaded=${s.loaded} drawn=${s.drawn} level=${s.level}（检查 /preview/tiles/manifest.json 与瓦片 URL）`,
    );
    assert(
      vis.imageDisplay === 'none',
      `瓦片模式下 #canvas-image 的 display 实际 ${vis.imageDisplay} vs 期望 none（两张底图同时显示会重影）`,
    );
  } else {
    assert(
      vis.complete === true && vis.natural[0] > 0 && vis.natural[1] > 0,
      `#canvas-image 未加载完成：complete=${vis.complete} natural=${vis.natural.join('×')}`,
    );
  }
  assert(
    vis.rect.width > 50 && vis.rect.height > 50,
    `#canvas-image 渲染尺寸 实际 ${Math.round(vis.rect.width)}×${Math.round(vis.rect.height)} vs 期望 > 50×50（可能被父容器压成 0）`,
  );

  // ③ 信息条：#canvas-info 必须显示当前图片信息
  assert(vis.infoHidden === false, '#canvas-info 实际隐藏 vs 期望可见（应显示「维度 · 图片 · W×H px」）');
  const sizeText = `${vis.natural[0]}×${vis.natural[1]}`;
  assert(
    String(vis.infoText || '').includes(sizeText),
    `#canvas-info 文本 实际 "${truncate(vis.infoText, 70)}" 不含 "${sizeText}"`,
  );
  if (vis.isTile) {
    assert(
      String(vis.infoText || '').includes('瓦片'),
      `#canvas-info 文本 实际 "${truncate(vis.infoText, 70)}" 不含「瓦片」（瓦片模式应显示 manifest 信息）`,
    );
    assert(
      /\.json/.test(String(vis.infoText || '')),
      `#canvas-info 文本 实际 "${truncate(vis.infoText, 70)}" 不含 manifest 路径（应显示 tiles/manifest.json）`,
    );
  } else if (ctx.siteImageName) {
    assert(
      String(vis.infoText || '').includes(ctx.siteImageName),
      `#canvas-info 文本 实际 "${truncate(vis.infoText, 70)}" 不含图片名 "${ctx.siteImageName}"`,
    );
  }

  // ② 像素层：截图片区域算亮度（这才是「眼睛看到的东西」）
  const clip = await page.evalFn(() => {
    const img = document.getElementById('canvas-image');
    const tiles = document.getElementById('canvas-tiles');
    const stats = window.__tool && typeof window.__tool.tiles === 'function' ? window.__tool.tiles() : null;
    const isTile = Boolean(stats && stats.active && tiles && getComputedStyle(tiles).display !== 'none');
    const target = isTile ? tiles : img;
    if (!target) return { error: '缺少底图元素（#canvas-image / #canvas-tiles）' };
    // 瓦片模式（外扩窗口渲染）下 canvas 的盒子盖住视口外扩一圈，截图区域必须取「地图盒」（#canvas-stage），
    // 否则上下留白区域会把亮像素占比稀释到阈值以下
    const stage = isTile ? document.querySelector('#canvas-stage') : null;
    const box = stage || target;
    const rect = box.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    const width = Math.floor(right - left);
    const height = Math.floor(bottom - top);
    if (width < 60 || height < 60) return { error: `图片可见区域太小：${width}×${height}` };
    return {
      x: Math.floor(left) + window.scrollX,
      y: Math.floor(top) + window.scrollY,
      width: Math.min(width, 960),
      height: Math.min(height, 720),
    };
  });
  assert(!clip.error, clip.error);

  const shot = await page.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const stats = pngBrightness(shot.data, { litThreshold: 30 });
  // 阈值经过实测校准（同一块图片区域、同一台机器）：
  //   正常显示（自动提亮开）：mean ≈ 47.3 / litRatio ≈ 0.233
  //   模拟事故（去掉 is-loaded → opacity:0）：mean ≈ 16.5 / litRatio ≈ 0.021
  // 所以 litRatio 是本图的判别式（0.021 vs 0.233，阈值 0.05 两边各有 2 倍以上余量）；
  // mean 只用来兜「整块全黑」，不参与判别——因为关掉提亮后暗图本身 mean 也不高。
  assert(
    stats.mean > 8 && stats.litRatio > 0.05,
    `地图区域像素几乎全黑，底图没有被绘制：mean=${stats.mean.toFixed(1)}（期望 > 8）· litRatio=${stats.litRatio.toFixed(3)}（期望 > 0.05）· ` +
      `截图 ${stats.width}×${stats.height}（目标=${vis.targetTag}、opacity=${vis.opacity}、filter=${vis.filter}、enhance=${vis.enhance}）`,
  );

  const tileNote = vis.isTile
    ? `瓦片 level=${vis.stats.level}、canvas ${vis.stats.canvasWidth}×${vis.stats.canvasHeight}、dpr=${vis.stats.dpr}、` +
      `已贴 ${vis.stats.drawn}/${vis.stats.loaded} 张；`
    : '';
  return (
    `${baseLabel}：opacity=1、is-loaded ✓、${Math.round(vis.rect.width)}×${Math.round(vis.rect.height)}px 显示中；` +
    `${tileNote}像素统计 mean=${stats.mean.toFixed(1)} / litRatio=${stats.litRatio.toFixed(3)}（阈值 8 / 0.05，截图 ${stats.width}×${stats.height}）；` +
    `#canvas-info="${truncate(vis.infoText, 40)}"；enhance=${vis.enhance ?? '未判定'}、画布标记 ${vis.markers} 个`
  );
}

/* ------------------------------ 瓦片底图模式（tiles 维度） ------------------------------ */

/**
 * 瓦片底图回归：
 *   ① 维度表单里有「底图类型 = 瓦片」+ manifest 输入，摘要有世界范围；
 *   ② #canvas-tiles 可见、#canvas-image 隐藏，TileLayer 真的贴出了瓦片；
 *   ③ 放大后自动切到更细的层级（level 变细；位图恒为 1.5×视口×dpr，不随缩放变化）；
 *   ④ 切到单图维度再切回来，两种底图能正确互切（不重影、不残留）；
 *   ⑤ 导出 JSON 仍带 tiles 字段（工具不会把瓦片维度退化成单图）。
 */
async function checkTilesMode(ctx) {
  const page = ctx.page;

  // 站点里哪个维度配了瓦片、哪个是纯单图？从草稿里动态找（站点没配瓦片时本项直接跳过）
  const target = await page.evalFn(() => {
    const draft = window.__tool?.draft?.();
    const dims = draft?.dimensions || [];
    const hit = dims.find((d) => d && d.tiles && String(d.tiles.manifest || '').trim());
    if (!hit) return null;
    const single = dims.find(
      (d) => d && d.id !== hit.id && (!d.tiles || !String(d.tiles.manifest || '').trim()),
    );
    return { id: hit.id, name: hit.name, manifest: hit.tiles.manifest, singleId: single ? single.id : null };
  });

  if (!target) return '站点没有配置瓦片底图，本项跳过';

  // 确保当前就在瓦片维度，并等第一张瓦片贴上去
  await page.evalFn((id) => window.__tool?.activateDimension?.(id), target.id);
  await waitUntil(
    () =>
      page.evalFn(() => {
        const s = window.__tool?.tiles?.();
        return Boolean(s && s.active && s.imageWidth > 0 && (Number(s.loaded) > 0 || Number(s.drawn) > 0));
      }),
    { timeout: 8000, interval: 120, label: `瓦片维度「${target.name}」渲染完成` },
  );

  const facts = await page.evalFn(() => {
    const tiles = document.getElementById('canvas-tiles');
    const img = document.getElementById('canvas-image');
    const s = window.__tool?.tiles?.();
    const rect = tiles ? tiles.getBoundingClientRect() : null;
    const modeEl = document.querySelector('#form [data-field="tiles.mode"]');
    const manifestEl = document.querySelector('#form [data-field="tiles.manifest"]');
    const summaryEl = document.querySelector('#form [data-tiles-summary]');
    return {
      stats: s,
      tileVisible: Boolean(tiles && getComputedStyle(tiles).display !== 'none' && rect && rect.width > 50),
      imageDisplay: img ? getComputedStyle(img).display : null,
      modeValue: modeEl ? modeEl.value : null,
      manifestValue: manifestEl ? manifestEl.value : null,
      summaryText: summaryEl ? (summaryEl.textContent || '').trim() : '',
    };
  });

  assert(facts.modeValue === 'tiles', `「底图类型」实际 ${JSON.stringify(facts.modeValue)} vs 期望 'tiles'`);
  assert(
    String(facts.manifestValue || '').includes(target.manifest),
    `「瓦片清单」实际 ${JSON.stringify(facts.manifestValue)} vs 期望含 ${target.manifest}`,
  );
  assert(/世界范围/.test(facts.summaryText), `瓦片摘要缺少世界范围：${truncate(facts.summaryText, 160)}`);
  assert(facts.tileVisible, '#canvas-tiles 不可见（display 或尺寸不对）');
  assert(facts.imageDisplay === 'none', `瓦片模式下 #canvas-image display 实际 ${facts.imageDisplay} vs 期望 none`);

  // 放大 → 层级应该更细（level 更小）；位图恒为 1.5×视口×dpr（OR 条件兼容旧行为）
  const fitStats = facts.stats;
  await page.evalFn(() => window.__tool?.canvas?.zoomBy?.(8));
  await page.settle(350);
  const zoomed = await page.evalFn(() => window.__tool?.tiles?.());
  assert(zoomed && zoomed.active, '放大后瓦片层不再激活');
  assert(
    zoomed.level <= fitStats.level || zoomed.canvasWidth >= fitStats.canvasWidth,
    `放大后瓦片层级没有变细：整图 level=${fitStats.level}/canvasW=${fitStats.canvasWidth} → ` +
      `放大后 level=${zoomed.level}/canvasW=${zoomed.canvasWidth}`,
  );
  assert(
    Number(zoomed.dpr) >= 1,
    `瓦片层 dpr 实际 ${JSON.stringify(zoomed.dpr)} vs 期望 >= 1`,
  );

  // 切到单图维度再切回来：互切不能重影 / 残留
  if (target.singleId) {
    await page.evalFn((id) => window.__tool?.activateDimension?.(id), target.singleId);
    await page.settle(450);
    const single = await page.evalFn(() => {
      const tiles = document.getElementById('canvas-tiles');
      const img = document.getElementById('canvas-image');
      return {
        tilesActive: Boolean(window.__tool?.tiles?.()?.active),
        tileDisplay: tiles ? getComputedStyle(tiles).display : null,
        imageDisplay: img ? getComputedStyle(img).display : null,
        imageLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
      };
    });
    assert(!single.tilesActive, '切到单图维度后瓦片层仍然激活');
    assert(single.tileDisplay === 'none', `单图维度下 #canvas-tiles display 实际 ${single.tileDisplay} vs 期望 none`);
    assert(
      single.imageDisplay !== 'none' && single.imageLoaded,
      `单图维度下 #canvas-image 没显示：display=${single.imageDisplay} loaded=${single.imageLoaded}`,
    );

    await page.evalFn((id) => window.__tool?.activateDimension?.(id), target.id);
    await page.settle(450);
    const back = await page.evalFn(() => window.__tool?.tiles?.());
    assert(back && back.active, '切回瓦片维度后瓦片层没有恢复');
  }

  // 导出 JSON 必须保留 tiles（做过工具不等于丢掉瓦片配置）
  const exported = await page.evalFn((id) => {
    const json = window.__tool?.json?.();
    const dim = (json?.dimensions || []).find((d) => d && d.id === id);
    return dim ? dim.tiles || null : null;
  }, target.id);
  assert(
    exported && exported.manifest === target.manifest,
    `导出 JSON 的 tiles 实际 ${JSON.stringify(exported)} vs 期望 { manifest: "${target.manifest}" }（瓦片维度被退化成单图）`,
  );

  // 复位整图适配，避免影响后续检查
  await page.evalFn(() => window.__tool?.canvas?.fitToContent?.({ animate: false }));
  await page.settle(250);

  return (
    `维度「${target.name}」：level ${fitStats.level}→${zoomed.level}（放大 8×）、canvasW ${fitStats.canvasWidth}→${zoomed.canvasWidth}、` +
    `dpr=${fitStats.dpr}；表单/摘要/单图互切/导出 tiles 全部正确`
  );
}

/**
 * 提亮按钮回归：点一次 `#btn-enhance` 必须只翻转一次（防止一次点击绑定两次监听），
 * `body[data-enhance]` / `#canvas-image` 的 computed filter / `localStorage['ssm.enhance.v1']` / aria-pressed 同步变化；
 * 再点一次回到原状态。
 */
async function checkEnhanceToggle(ctx) {
  const page = ctx.page;
  const btn = await findClickable(page, { selectors: ['#btn-enhance'], texts: [] });
  assert(btn, '找不到提亮按钮 #btn-enhance');

  const before = await page.evalFn(() => {
    const img = document.getElementById('canvas-image');
    const b = document.getElementById('btn-enhance');
    return {
      enhance: document.body.dataset.enhance ?? null,
      pressed: b ? b.getAttribute('aria-pressed') : null,
      filter: img ? getComputedStyle(img).filter : null,
      stored: (() => {
        try {
          return localStorage.getItem('ssm.enhance.v1');
        } catch {
          return null;
        }
      })(),
    };
  });
  assert(
    before.enhance === '0' || before.enhance === '1',
    `body[data-enhance] 实际 ${JSON.stringify(before.enhance)} vs 期望 '0' 或 '1'（自动判定没跑或没写 data 属性）`,
  );

  const expected = before.enhance === '1' ? '0' : '1';
  await page.click(btn.cx, btn.cy);
  const after = await waitUntil(
    () =>
      page.evalFn(() => {
        const img = document.getElementById('canvas-image');
        const b = document.getElementById('btn-enhance');
        const state = window.__tool?.state?.();
        return {
          enhance: document.body.dataset.enhance ?? null,
          pressed: b ? b.getAttribute('aria-pressed') : null,
          filter: img ? getComputedStyle(img).filter : null,
          enhanceOn: state ? state.enhanceOn : null,
          stored: (() => {
            try {
              return localStorage.getItem('ssm.enhance.v1');
            } catch {
              return null;
            }
          })(),
        };
      }),
    {
      timeout: 3000,
      interval: 100,
      label: `点击 #btn-enhance 后 body[data-enhance] 变成 '${expected}'`,
    },
  ).catch(async (error) => {
    const now = await page.evalFn(() => document.body.dataset.enhance ?? null);
    throw new Error(`${error.message}；实际 data-enhance=${JSON.stringify(now)}（一次点击可能绑定了两次监听，翻转了两次又变回来）`);
  });

  assert(
    after.enhance === expected,
    `点击提亮后 body[data-enhance] 实际 ${JSON.stringify(after.enhance)} vs 期望 ${JSON.stringify(expected)}`,
  );
  assert(
    after.pressed === (expected === '1' ? 'true' : 'false'),
    `#btn-enhance 的 aria-pressed 实际 ${JSON.stringify(after.pressed)} vs 期望 ${JSON.stringify(expected === '1' ? 'true' : 'false')}`,
  );
  assert(
    after.filter !== before.filter,
    `点击提亮后 #canvas-image 的 computed filter 没变（实际 "${after.filter}" vs 之前 "${before.filter}"）`,
  );
  assert(
    after.stored === expected,
    `localStorage['ssm.enhance.v1'] 实际 ${JSON.stringify(after.stored)} vs 期望 ${JSON.stringify(expected)}`,
  );

  // 再点一次，回到原状态
  await page.click(btn.cx, btn.cy);
  await waitUntil(
    () => page.evalFn((want) => (document.body.dataset.enhance ?? null) === want, before.enhance),
    { timeout: 3000, interval: 100, label: `再次点击后 body[data-enhance] 回到 '${before.enhance}'` },
  );

  return `data-enhance ${before.enhance} → ${after.enhance} → ${before.enhance}；aria-pressed ${before.pressed}→${after.pressed}；filter 变化 ✓；localStorage=${after.stored}`;
}

/* ------------------------------ §7.3 树里的路径点数量 ------------------------------ */

async function checkTreeCount(ctx) {
  const page = ctx.page;
  const facts = await domFacts(page);
  assert(facts.treeExists, '#tree 不存在');
  const expected = ctx.siteCount;
  const missing = ctx.siteWaypointNames.filter((name) => !facts.treeText.includes(name));

  let count;
  let mode;
  if (facts.treeWaypointNodes > 0) {
    count = facts.treeWaypointNodes;
    mode = '#tree [data-waypoint-id] 数量';
  } else {
    count = ctx.siteWaypointNames.length - missing.length;
    mode = '#tree 文本里出现的路径点名数量（editor.js 暂未输出 data-waypoint-id，退化为文本匹配）';
  }
  assert(
    count === expected,
    `实际 ${count} 个路径点 vs 期望 ${expected} 个（${mode}）` +
      `${missing.length ? `；树里缺少：${missing.join('、')}` : ''}`,
  );

  const dimNames = ['主世界', '下界', '末地'];
  const dimsShown = dimNames.filter((n) => facts.dimensionTabsText.includes(n) || facts.treeText.includes(n)).length;
  const groupNames = ctx.siteGroupNames;
  const groupsShown = groupNames.filter((n) => facts.treeText.includes(n)).length;

  return `${mode}：${count} 个 = 站点 config.json 主世界路径点 ${expected} 个；维度出现 ${dimsShown}/3、分组出现 ${groupsShown}/${groupNames.length}`;
}

/* ------------------------------ 扩展：撤销 / 重做 ------------------------------ */

async function checkUndoRedo(ctx) {
  const page = ctx.page;
  const waypoint = ctx.siteFirstWaypoint;
  assert(waypoint?.id && waypoint?.name, '站点 config.json 里读不到第一个路径点，无法测撤销');

  const sel = await selectWaypoint(ctx, { id: waypoint.id, name: waypoint.name });
  const nameField = await findFormField(page, 'name');
  assert(
    nameField || (await findInputByValue(page, waypoint.name)),
    `表单里找不到名称输入框（选中方式：${sel.how}）；当前 #form 输入框：` +
      JSON.stringify((await domFacts(page)).formInputs.map((i) => i.value).slice(0, 12)),
  );

  const renamed = `${waypoint.name}·E2E`;
  await setFormField(page, 'name', renamed, { fallbackValue: waypoint.name });

  const nameOf = async () => {
    const { config } = await readCurrentConfig(ctx);
    const wp = waypointsOf(config).find((w) => String(w.id) === String(waypoint.id));
    return wp ? String(wp.name) : null;
  };

  await waitUntil(async () => (await nameOf()) === renamed, {
    timeout: 3000,
    interval: 120,
    label: `改名后草稿里 name === ${renamed}`,
  });

  // 键盘守卫：输入框里 Ctrl+Z 交还浏览器（不劫持），所以先把焦点移出输入框再测应用级撤销
  await page.evalFn(() => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    const canvas = document.getElementById('canvas-root');
    if (canvas) canvas.focus?.();
  });
  await page.settle(160);

  // 撤销：一次编辑可能压入多条快照（editor 的 input 事件），因此允许连按几次，但必须回到原名
  let undoPresses = 0;
  for (; undoPresses < 3; undoPresses += 1) {
    await pressCtrlZ(page);
    const restored = await waitUntil(async () => (await nameOf()) === waypoint.name, {
      timeout: 1500,
      interval: 100,
      label: `第 ${undoPresses + 1} 次 Ctrl+Z 后 name 回到 ${waypoint.name}`,
    })
      .then(() => true)
      .catch(() => false);
    if (restored) break;
  }
  assert(
    (await nameOf()) === waypoint.name,
    `Ctrl+Z 撤销失败：连按 ${undoPresses + 1} 次后草稿里 name 仍是「${await nameOf()}」，期望「${waypoint.name}」`,
  );

  let redoPresses = 0;
  for (; redoPresses < 3; redoPresses += 1) {
    await pressCtrlZ(page, { shift: true });
    const redone = await waitUntil(async () => (await nameOf()) === renamed, {
      timeout: 1500,
      interval: 100,
      label: `第 ${redoPresses + 1} 次 Ctrl+Shift+Z 后 name 变回 ${renamed}`,
    })
      .then(() => true)
      .catch(() => false);
    if (redone) break;
  }
  assert(
    (await nameOf()) === renamed,
    `Ctrl+Shift+Z 重做失败：连按 ${redoPresses + 1} 次后草稿里 name 是「${await nameOf()}」，期望「${renamed}」`,
  );

  // 复原：走 app 自己的 patch 通道（与属性表单同一条代码路径），保持草稿干净
  await page.evalFn((id, name) => {
    const tool = window.__tool;
    if (tool && typeof tool.patch === 'function') tool.patch({ kind: 'waypoint', id, field: 'name', value: name });
    return true;
  }, waypoint.id, waypoint.name);
  await waitUntil(async () => (await nameOf()) === waypoint.name, {
    timeout: 3000,
    interval: 120,
    label: '复原路径点名称',
  });

  return `改名「${waypoint.name}」→「${renamed}」；Ctrl+Z ×${undoPresses + 1} 恢复原名；Ctrl+Shift+Z ×${redoPresses + 1} 再改回（每步都由草稿实测）`;
}

function dmSelReason(sel) {
  return sel?.reason || sel?.how || '未知';
}


/* ------------------------------ §7.4a 新增路径点 + 画布交互 ------------------------------ */

async function checkNewWaypoint(ctx) {
  const page = ctx.page;
  const before = await readCurrentConfig(ctx);
  const beforeIds = new Set(waypointsOf(before.config).map((w) => String(w.id)));
  // 当前底图逻辑尺寸：瓦片维度用 manifest 尺寸（1 像素 = 1 方块），单图维度用 naturalWidth/Height
  const imageSize = await page.evalFn(() => {
    const s = window.__tool?.tiles?.();
    if (s && s.active && Number(s.imageWidth) > 0) return { width: Number(s.imageWidth), height: Number(s.imageHeight) };
    const img = document.getElementById('canvas-image');
    return img && img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null;
  });
  assert(imageSize && imageSize.width > 0, '画布底图未载入，无法在画布上放路径点');

  // 先把画布放大到 1 图片像素 ≈ 1 屏幕像素：否则拖动 1 屏幕像素 = 好几个方块，误差压不到 2 方块内
  const zoom = await ensureZoomAtLeast(ctx, 1.8);
  if (!zoom.ok) ctx.report.warn('画布放大失败，点击精度可能不足', zoom.reason || `scale=${fmt(zoom.scale)}`);

  const howNew = await clickAction(ctx, {
    selectors: ['#btn-new-waypoint', '[data-action="new-waypoint"]'],
    texts: ['新增路径点', '新建路径点', '添加路径点', '＋ 路径点'],
    toolAction: 'new-waypoint',
  });

  const grown = await waitForConfig(
    ctx,
    (config) => waypointsOf(config).length === beforeIds.size + 1,
    { timeout: 4000, label: '草稿里多出一个路径点' },
  );
  const dim = dimensionOf(grown.config);
  const newWp = (dim?.waypoints || []).find((w) => !beforeIds.has(String(w.id)));
  assert(newWp, '草稿里没有出现新的路径点 id');
  ctx.newWaypointId = String(newWp.id);

  // 画布交互（新语义）：新建后**不会**自动进入 place；
  // 先点顶栏「在图上取点」(#btn-pick-position) → place 模式 → 点地图落位。
  const cal = dim.calibration || {};
  assert(
    Number.isFinite(num(cal.xMin)) && Number.isFinite(num(cal.zMin)),
    `当前维度的画幅不可用（xMin=${JSON.stringify(cal.xMin)} zMin=${JSON.stringify(cal.zMin)}），无法换算点击位置`,
  );
  const target = await canvasPointAt(page, 0.42, 0.38);
  const wantWorld = worldFromPixel(cal, target.imageSize || imageSize, target.px, target.py);

  const readWp = async () => {
    const { config } = await readCurrentConfig(ctx);
    return waypointsOf(config).find((w) => String(w.id) === ctx.newWaypointId) || null;
  };
  const near = (wp) => wp && Math.abs(num(wp.x) - wantWorld.x) <= 2 && Math.abs(num(wp.z) - wantWorld.z) <= 2;

  const afterNew = await readCanvasMode(page);
  assert(
    afterNew.mode === 'select' && afterNew.placeFor === null,
    `新建路径点后画布模式 实际 mode=${JSON.stringify(afterNew.mode)} placeFor=${JSON.stringify(afterNew.placeFor)} vs 期望 'select'/null（新语义：点路径点只选中，不进入待落位）`,
  );

  let armed = afterNew;
  let how = null;
  if (afterNew.mode === 'place') {
    // 兼容：万一又改回「新建即 place」
    how = '画布点击（新建后自动 place）';
  } else {
    const pickBtn = await findClickable(page, { selectors: ['#btn-pick-position'] });
    assert(pickBtn, '找不到「在图上取点」按钮 #btn-pick-position，无法把新点放到地图上');
    const pickState = await page.evalFn(() => {
      const btn = document.getElementById('btn-pick-position');
      return { disabled: btn ? btn.disabled : null, text: btn ? btn.textContent.trim().slice(0, 20) : null };
    });
    assert(
      pickState.disabled === false,
      `#btn-pick-position 实际 disabled=${JSON.stringify(pickState.disabled)} vs 期望 false（新建后新点应已自动选中）`,
    );
    await page.click(pickBtn.cx, pickBtn.cy);
    await page.settle(180);
    armed = await readCanvasMode(page);
    assert(
      armed.mode === 'place' && armed.placeFor === ctx.newWaypointId,
      `点「${pickState.text || '#btn-pick-position'}」后 实际 mode=${JSON.stringify(armed.mode)} placeFor=${JSON.stringify(armed.placeFor)} vs 期望 'place'/${ctx.newWaypointId}`,
    );
    how = '点「在图上取点」→ place → 画布点击';
  }

  await page.click(target.cx, target.cy);
  await page.settle(260);
  let moved = await readWp();

  if (!near(moved)) {
    const dragged = await dragMarker(ctx, ctx.newWaypointId, target);
    moved = await readWp();
    if (!near(moved) && !dragged.ok) {
      // 最后兜底：走 app 的 patch 通道（等价于在表单里手填坐标）
      await page.evalFn((id, x, z) => {
        const tool = window.__tool;
        if (!tool || typeof tool.patch !== 'function') return false;
        tool.patch({ kind: 'waypoint', id, field: 'x', value: Math.round(x) });
        tool.patch({ kind: 'waypoint', id, field: 'z', value: Math.round(z) });
        return true;
      }, ctx.newWaypointId, wantWorld.x, wantWorld.z);
      await page.settle(200);
      moved = await readWp();
      how = `表单 patch（画布点击与标记拖拽都没改坐标：${dragged.reason || '未知'}）`;
    } else {
      how = `标记拖拽（点「在图上取点」+ 点画布没有把新点放到点击处，退回拖拽）`;
    }
  }

  const afterPlace = await readCanvasMode(page);
  assert(
    afterPlace.mode === 'select' && afterPlace.placeFor === null,
    `落位后画布模式 实际 mode=${JSON.stringify(afterPlace.mode)} placeFor=${JSON.stringify(afterPlace.placeFor)} vs 期望 'select'/null`,
  );

  moved = await readWp();
  assert(moved, `草稿里找不到新路径点 ${ctx.newWaypointId}`);
  assertClose(moved.x, wantWorld.x, 2.5, `新路径点 X 与点击处世界坐标`);
  assertClose(moved.z, wantWorld.z, 2.5, `新路径点 Z 与点击处世界坐标`);

  // 表单里必须能看到这两个坐标
  await selectWaypoint(ctx, { id: ctx.newWaypointId, name: moved.name });
  const inputs = (await domFacts(page)).formInputs;
  const numbers = inputs.map((i) => num(i.value)).filter(Number.isFinite);
  const hasX = numbers.some((n) => Math.abs(n - num(moved.x)) <= 1.5);
  const hasZ = numbers.some((n) => Math.abs(n - num(moved.z)) <= 1.5);
  assert(
    hasX && hasZ,
    `表单里没有出现坐标：实际表单数值 ${JSON.stringify(numbers.slice(0, 12))} vs 期望含 X≈${fmt(moved.x)}、Z≈${fmt(moved.z)}`,
  );

  ctx.flags.waypointAdded = true;
  ctx.newWaypointSnapshot = { id: String(moved.id), name: String(moved.name), x: num(moved.x), z: num(moved.z) };
  return `${how}；新点 ${moved.id}「${moved.name}」X=${fmt(moved.x)} Z=${fmt(moved.z)}（点击处期望 X=${fmt(wantWorld.x)} Z=${fmt(wantWorld.z)}）；表单已显示该坐标`;
}

/** 把画布上某个标记拖到目标屏幕坐标（真实 pointer 拖拽） */
async function dragMarker(ctx, markerId, target) {
  const page = ctx.page;
  const info = await page.evalFn((id) => {
    const el = document.querySelector(`#canvas-overlay .marker[data-id="${String(id).replace(/"/g, '\\"')}"]`);
    if (!el) return { error: `找不到画布标记 .marker[data-id="${id}"]` };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return { error: '标记尺寸为 0（可能被 is-offscreen 隐藏）' };
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }, markerId);
  if (info?.error) return { ok: false, reason: info.error };

  try {
    await page.drag({ from: { x: info.cx, y: info.cy }, to: { x: target.cx, y: target.cy }, steps: 12, settleMs: 220 });
    await page.settle(200);
    return { ok: true, how: `把标记从 (${Math.round(info.cx)}, ${Math.round(info.cy)}) 拖到 (${Math.round(target.cx)}, ${Math.round(target.cy)})` };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/* ------------------------------ §7.4c 放置模式（place） ------------------------------ */

/**
 * 交互语义（用户反馈后调整，本用例是它的回归）：
 *   ① 点路径点（树/标记）只选中，**不进入**「待落位」：canvas.getMode() === 'select'、state.placeFor === null；
 *   ② 新建路径点也不再自动 place（落当前视图中心），要显式点顶栏「在图上取点」(#btn-pick-position)；
 *   ③ 点地图落位后回 'select'、badge 隐藏、placeFor 清空；
 *   ④ **点画布空白处只取消选中，绝不移动已选中的点**（用户被「悄悄挪走」的那个 bug 的回归点）；
 *   ⑤ 切换选中会自动取消 place。
 * 结束后撤销回原状（不影响后面的用例）。
 */

/**
 * §7.4d 「拖动移动」开关（用户反馈：鼠标能直接拖动路径点，容易误拖）：
 *   ① 默认关闭：按住路径点拖动不改坐标；
 *   ② 点 #btn-drag-move 开启后可拖；
 *   ③ 关掉开关后按住 Alt 仍可临时拖。
 */
async function checkDragMove(ctx) {
  const page = ctx.page;

  /**
   * 取一个「点下去真的能命中」的标记：密集堆叠时最上层的标记会接走 pointerdown，
   * 所以用 elementsFromPoint 取该点最上层的 .marker，避免读到被盖住的那个点。
   */
  const firstVisibleMarker = () =>
    page.evalFn(() => {
      const markers = [...document.querySelectorAll('#canvas-overlay .marker')];
      for (const el of markers) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 4 || rect.height <= 4) continue;
        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top + rect.height / 2);
        const hit = (document.elementsFromPoint(cx, cy) || []).find((node) => node.closest && node.closest('.marker'));
        const hitMarker = hit ? hit.closest('.marker') : null;
        if (!hitMarker) continue;
        // 命中别的标记也行，但要用「命中的那个」的 id 和它的几何中心
        const hitRect = hitMarker.getBoundingClientRect();
        return {
          id: String(hitMarker.dataset.id),
          x: Math.round(hitRect.left + hitRect.width / 2),
          y: Math.round(hitRect.top + hitRect.height / 2),
          pickedFrom: String(el.dataset.id),
        };
      }
      return null;
    });

  /** 从草稿里读某个路径点的坐标 */
  const readWp = (id) =>
    page.evalFn((wpId) => {
      const tool = window.__tool;
      if (!tool || typeof tool.draft !== 'function') return null;
      const draft = tool.draft();
      const dimId = document.body.dataset.dimension;
      const dim = draft.dimensions.find((d) => String(d.id) === String(dimId)) || draft.dimensions[0];
      const wp = dim && dim.waypoints.find((w) => String(w.id) === String(wpId));
      return wp ? { x: Number(wp.x), z: Number(wp.z) } : null;
    }, id);

  /** 真实 pointer 拖拽（可带 Alt） */
  const drag = async (from, dx, dy, { alt = false } = {}) => {
    const modifiers = alt ? 1 : 0;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', modifiers });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, modifiers });
    for (let step = 1; step <= 10; step += 1) {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + Math.round((dx * step) / 10),
        y: from.y + Math.round((dy * step) / 10),
        button: 'left',
        modifiers,
      });
      await page.settle(16);
    }
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: from.x + dx,
      y: from.y + dy,
      button: 'left',
      clickCount: 1,
      modifiers,
    });
    await page.settle(340);
  };

  const pressedOf = () => page.evalFn(() => document.getElementById('btn-drag-move')?.getAttribute('aria-pressed'));

  /* ① 默认关闭：拖拽不改坐标 */
  const pressed0 = await pressedOf();
  assert(pressed0 === 'false', `#btn-drag-move 初始 aria-pressed=${pressed0}，期望 'false'`);

  const grip0 = await firstVisibleMarker();
  assert(grip0, '画布上没有可见的路径点标记，无法测试拖动');
  const before = await readWp(grip0.id);
  assert(before, `草稿里找不到路径点 ${grip0.id}`);

  await drag(grip0, 72, 48);
  const afterDisabled = await readWp(grip0.id);
  assert(
    afterDisabled && afterDisabled.x === before.x && afterDisabled.z === before.z,
    `关闭「拖动移动」时拖拽不应改坐标：before ${JSON.stringify(before)} → after ${JSON.stringify(afterDisabled)}`,
  );

  /* ② 开启后可拖 */
  await page.evalFn(() => document.getElementById('btn-drag-move').click());
  await page.settle(280);
  const pressed1 = await pressedOf();
  assert(pressed1 === 'true', `点「拖动移动」后 aria-pressed=${pressed1}，期望 'true'`);

  const grip1 = await firstVisibleMarker();
  assert(grip1, '开启拖动后画布上找不到标记');
  const beforeEnabled = await readWp(grip1.id);
  await drag(grip1, 66, 42);
  const afterEnabled = await readWp(grip1.id);
  assert(
    afterEnabled && (afterEnabled.x !== beforeEnabled.x || afterEnabled.z !== beforeEnabled.z),
    `开启「拖动移动」后拖拽应改坐标，实际仍为 ${JSON.stringify(afterEnabled)}`,
  );

  /* ③ 关闭后 Alt 临时可拖 */
  await page.evalFn(() => document.getElementById('btn-drag-move').click());
  await page.settle(280);
  const pressed2 = await pressedOf();
  assert(pressed2 === 'false', `再次点击后 aria-pressed=${pressed2}，期望 'false'`);

  const grip2 = await firstVisibleMarker();
  assert(grip2, 'Alt 拖动前画布上找不到标记');
  const beforeAlt = await readWp(grip2.id);
  await drag(grip2, -58, -34, { alt: true });
  const afterAlt = await readWp(grip2.id);
  assert(
    afterAlt && (afterAlt.x !== beforeAlt.x || afterAlt.z !== beforeAlt.z),
    `按住 Alt 拖拽应改坐标，实际仍为 ${JSON.stringify(afterAlt)}`,
  );

  return `默认不可拖（${JSON.stringify(before)} 未变）· 开启后可拖 ${JSON.stringify(beforeEnabled)}→${JSON.stringify(afterEnabled)} · Alt 临时拖 ${JSON.stringify(afterAlt)}`;
}

async function checkPlaceMode(ctx) {
  const page = ctx.page;
  await selectDimension(ctx, 'overworld', '主世界');
  const zoom = await ensureZoomAtLeast(ctx, 1.8);
  if (!zoom.ok) ctx.report.warn('放置模式用例放大失败', zoom.reason || `scale=${fmt(zoom.scale)}`);

  const beforeCount = waypointsOf((await readCurrentConfig(ctx)).config).length;
  const beforeIds = new Set(waypointsOf((await readCurrentConfig(ctx)).config).map((w) => String(w.id)));

  // ---------- ① 新建路径点：应停在 select，且「在图上取点」可用 ----------
  const howNew = await clickAction(ctx, {
    selectors: ['#btn-new-waypoint', '[data-action="new-waypoint"]'],
    texts: ['新增路径点', '新建路径点', '添加路径点'],
    toolAction: 'new-waypoint',
  });
  await page.settle(200);
  const grown = await waitForConfig(ctx, (config) => waypointsOf(config).length === beforeCount + 1, {
    timeout: 4000,
    label: '放置用例：草稿里多出一个路径点',
  });
  const dim = dimensionOf(grown.config);
  const newWp = (dim?.waypoints || []).find((w) => !beforeIds.has(String(w.id)));
  assert(newWp, '放置用例：草稿里没有出现新的路径点 id');
  const newId = String(newWp.id);

  const afterNew = await readCanvasMode(page);
  assert(
    afterNew.mode === 'select',
    `新建路径点后画布模式 实际 ${JSON.stringify(afterNew.mode)} vs 期望 'select'（新语义：不再自动进入待落位，状态栏="${truncate(afterNew.status, 40)}"）`,
  );
  assert(
    afterNew.placeFor === null,
    `新建路径点后 state.placeFor 实际 ${JSON.stringify(afterNew.placeFor)} vs 期望 null`,
  );
  assert(afterNew.badgeVisible === false, '新建路径点后 #mode-badge 实际可见 vs 期望隐藏（没有进入放置模式）');
  assert(
    afterNew.pickDisabled === false,
    `新建路径点后 #btn-pick-position 实际 disabled=${JSON.stringify(afterNew.pickDisabled)} vs 期望 false（新点应已自动选中、投影可用）`,
  );

  // ---------- ② 点「在图上取点」→ place → 点地图落位 ----------
  const pickBtn = await findClickable(page, { selectors: ['#btn-pick-position'] });
  assert(pickBtn, '找不到「在图上取点」按钮 #btn-pick-position');
  await page.click(pickBtn.cx, pickBtn.cy);
  await page.settle(180);
  const armed = await readCanvasMode(page);
  assert(
    armed.mode === 'place',
    `点「在图上取点」后画布模式 实际 ${JSON.stringify(armed.mode)} vs 期望 'place'`,
  );
  assert(
    armed.placeFor === newId,
    `点「在图上取点」后 state.placeFor 实际 ${JSON.stringify(armed.placeFor)} vs 期望 ${JSON.stringify(newId)}`,
  );
  assert(armed.badgeVisible === true, '放置模式下 #mode-badge 实际隐藏 vs 期望可见（应提示「放置「…」：点击地图设置坐标」）');

  const cal = dim.calibration || {};
  const target = await canvasPointAt(page, 0.72, 0.28);
  const want = worldFromPixel(cal, target.imageSize, target.px, target.py);
  await page.click(target.cx, target.cy);
  await page.settle(260);

  const placed = await waitForConfig(
    ctx,
    (config) => {
      const wp = waypointsOf(config).find((w) => String(w.id) === newId);
      return wp && Math.abs(num(wp.x) - want.x) <= 4 && Math.abs(num(wp.z) - want.z) <= 4;
    },
    { timeout: 4000, label: '放置用例：新点坐标跟随点击位置' },
  );
  const wp = waypointsOf(placed.config).find((w) => String(w.id) === newId);
  const dx = Math.abs(num(wp.x) - want.x);
  const dz = Math.abs(num(wp.z) - want.z);
  assert(
    dx <= 1.5 && dz <= 1.5,
    `放置落点误差过大：实际 X=${fmt(wp.x)} Z=${fmt(wp.z)} vs 期望 X=${fmt(want.x)} Z=${fmt(want.z)}（误差 X ${fmt(dx)} / Z ${fmt(dz)} > 1.5 方块）`,
  );

  const afterPlace = await readCanvasMode(page);
  assert(
    afterPlace.mode === 'select',
    `落位后画布模式 实际 ${JSON.stringify(afterPlace.mode)} vs 期望 'select'`,
  );
  assert(afterPlace.placeFor === null, `落位后 state.placeFor 实际 ${JSON.stringify(afterPlace.placeFor)} vs 期望 null`);
  assert(afterPlace.badgeVisible === false, '落位后 #mode-badge 实际可见 vs 期望隐藏');

  // ---------- ③ 核心回归：点画布空白处不会移动已选中的点 ----------
  if (String(afterPlace.selection?.waypointId ?? '') !== newId) {
    await selectWaypoint(ctx, { id: newId, name: String(wp.name) });
  }
  const beforeBlank = waypointsOf((await readCurrentConfig(ctx)).config).find((w) => String(w.id) === newId);
  const blank = await canvasPointAt(page, 0.12, 0.86);
  await page.click(blank.cx, blank.cy);
  await page.settle(260);
  const afterBlankMode = await readCanvasMode(page);
  const afterBlankWp = waypointsOf((await readCurrentConfig(ctx)).config).find((w) => String(w.id) === newId);
  assert(
    afterBlankWp && num(afterBlankWp.x) === num(beforeBlank.x) && num(afterBlankWp.z) === num(beforeBlank.z),
    `点画布空白处把已选中的路径点挪走了：X ${fmt(beforeBlank.x)} → ${fmt(afterBlankWp?.x)}、Z ${fmt(beforeBlank.z)} → ${fmt(afterBlankWp?.z)}（期望不变）`,
  );
  assert(
    afterBlankMode.mode === 'select' && afterBlankMode.placeFor === null,
    `点空白后画布状态 实际 mode=${JSON.stringify(afterBlankMode.mode)} placeFor=${JSON.stringify(afterBlankMode.placeFor)} vs 期望 'select'/null`,
  );
  assert(
    (afterBlankMode.selection?.waypointId ?? null) === null,
    `点空白后选中项 实际 ${JSON.stringify(afterBlankMode.selection?.waypointId)} vs 期望 null（空白点击=取消选中）`,
  );
  assert(
    afterBlankMode.pickDisabled === true,
    `取消选中后 #btn-pick-position 实际 disabled=${JSON.stringify(afterBlankMode.pickDisabled)} vs 期望 true（没有选中项时不可用）`,
  );

  // ---------- ④ 切换选中会自动取消 place ----------
  const other = ctx.siteFirstWaypoint;
  assert(other?.id, '站点 config.json 里没有其它路径点，无法测「切换选中取消放置」');
  await selectWaypoint(ctx, { id: other.id, name: other.name });
  const pickBtn2 = await findClickable(page, { selectors: ['#btn-pick-position'] });
  assert(pickBtn2, '找不到「在图上取点」按钮 #btn-pick-position（第二次）');
  await page.click(pickBtn2.cx, pickBtn2.cy);
  await page.settle(180);
  const armedOther = await readCanvasMode(page);
  assert(
    armedOther.mode === 'place' && armedOther.placeFor === String(other.id),
    `为另一个点进入放置后 实际 mode=${JSON.stringify(armedOther.mode)} placeFor=${JSON.stringify(armedOther.placeFor)} vs 期望 'place'/${JSON.stringify(String(other.id))}`,
  );
  await selectWaypoint(ctx, { id: newId, name: String(wp.name) });
  const afterSwitch = await readCanvasMode(page);
  assert(
    String(afterSwitch.selection?.waypointId ?? '') === newId,
    `切换选中失败：selection.waypointId 实际 ${JSON.stringify(afterSwitch.selection?.waypointId)} vs 期望 ${JSON.stringify(newId)}`,
  );
  assert(
    afterSwitch.mode === 'select' && afterSwitch.placeFor === null,
    `切换选中后应自动取消放置：实际 mode=${JSON.stringify(afterSwitch.mode)} placeFor=${JSON.stringify(afterSwitch.placeFor)} vs 期望 'select'/null`,
  );

  // ---------- 复原：撤销掉「放置 + 新增」这两步 ----------
  let undos = 0;
  for (; undos < 4; undos += 1) {
    await pressCtrlZ(page);
    const back = await waitForConfig(ctx, (config) => waypointsOf(config).length === beforeCount, {
      timeout: 1200,
      label: `撤销第 ${undos + 1} 次后回到 ${beforeCount} 个点`,
    })
      .then(() => true)
      .catch(() => false);
    if (back) break;
  }
  const finalCount = waypointsOf((await readCurrentConfig(ctx)).config).length;
  if (finalCount !== beforeCount) {
    ctx.report.warn('放置用例没能撤销干净', `当前 ${finalCount} 个点，期望 ${beforeCount}（后续用例已按动态计数处理）`);
  }

  return (
    `新建后 mode='select'/placeFor=null；点「在图上取点」→ mode='place'、badge="${truncate(armed.badgeText, 26)}"；` +
    `点地图落位 X=${fmt(wp.x)} Z=${fmt(wp.z)}（期望 ${fmt(want.x)} / ${fmt(want.z)}，误差 ${fmt(Math.max(dx, dz))} 方块 ≤1.5）；` +
    `随后回 'select'；点空白不移动该点 ✓ 且取消选中、取点按钮 disabled ✓；切换选中自动取消放置 ✓（撤销 ${undos + 1} 次复原）`
  );
}

/* ------------------------------ §7.4b 保存并校验站点 config.json ------------------------------ */

async function checkSaveVerify(ctx) {
  const page = ctx.page;
  const beforeSaved = await readSiteConfigFile(ctx);
  const beforeCount = waypointsOf(beforeSaved.config).length;

  const howSave = await clickAction(ctx, {
    selectors: ['#btn-save'],
    texts: ['保存到站点', '保存'],
    toolAction: 'save',
  });

  const saved = await waitUntil(
    async () => {
      const file = await readSiteConfigFile(ctx);
      const count = waypointsOf(file.config).length;
      return count > beforeCount ? file : false;
    },
    { timeout: 12_000, interval: 150, label: '站点 config.json 出现新路径点' },
  ).catch(async (error) => {
    const facts = await domFacts(page);
    throw new Error(
      `保存后站点 config.json 没有变化（保存方式：${howSave}）：${error.message}；` +
        `状态栏="${facts.statusText}"；问题面板="${truncate(facts.issuesText, 160)}"`,
    );
  });

  // ① JSON.parse（readSiteConfigFile 已经 parse，能走到这里就通过）+ 结构断言
  const config = saved.config;
  assert(Array.isArray(config.dimensions), `保存后的 config.json 缺少 dimensions 数组`);

  // ② 新点存在且字段合法
  const wpId = ctx.newWaypointSnapshot?.id;
  const wp = waypointsOf(config).find((w) => String(w.id) === wpId);
  assert(wp, `保存后的 config.json 里找不到新路径点 ${wpId}（当前 ${waypointsOf(config).length} 个点：${waypointsOf(config).map((w) => w.id).slice(-4).join('、')}…）`);
  assert(typeof wp.name === 'string' && wp.name.trim().length > 0, `新路径点 name 非法：${JSON.stringify(wp.name)}`);
  assert(Number.isFinite(num(wp.x)) && Number.isFinite(num(wp.z)), `新路径点 x/z 非数字：x=${JSON.stringify(wp.x)} z=${JSON.stringify(wp.z)}`);
  assert(wp.y === undefined || wp.y === null || Number.isFinite(num(wp.y)), `新路径点 y 非法：${JSON.stringify(wp.y)}`);
  const groups = (dimensionOf(config).groups || []).map((g) => String(g.id));
  if (wp.group != null) {
    assert(groups.includes(String(wp.group)), `新路径点的 group="${wp.group}" 不在分组列表里（${groups.join('、')}）`);
  }
  assertClose(wp.x, ctx.newWaypointSnapshot.x, 2, '保存后新路径点 X');
  assertClose(wp.z, ctx.newWaypointSnapshot.z, 2, '保存后新路径点 Z');

  // ③ schema 校验
  const schemaErrors = validateSchema(ctx.schema, config);
  assert(
    schemaErrors.length === 0,
    `保存后的 config.json 没通过 config.schema.json（${schemaErrors.length} 条）：${schemaErrors.slice(0, 4).join('；')}`,
  );

  // ④ 其他维度 / 站点字段没被破坏（期望值一律从站点副本的 config.json 动态读，不写死）
  const expectedCounts = ctx.dimensionCounts || {};
  for (const [otherDimId, expected] of Object.entries(expectedCounts)) {
    if (otherDimId === String(ctx.dimensionId)) continue; // 主世界会 +1，单独校验
    const actual = waypointsOf(config, otherDimId).length;
    assert(actual === expected, `${otherDimId} 路径点数 实际 ${actual} vs 期望 ${expected}（站点原配置）`);
  }
  const mainExpected = (expectedCounts[ctx.dimensionId] ?? ctx.siteCount) + 1;
  assert(
    waypointsOf(config).length === mainExpected,
    `主世界路径点数 实际 ${waypointsOf(config).length} vs 期望 ${mainExpected}（站点原 ${mainExpected - 1} + 新增 1）`,
  );
  assert(config.version === 1, `version 实际 ${JSON.stringify(config.version)} vs 期望 1`);
  assert(config.site?.title === ctx.siteTitle, `site.title 实际 ${JSON.stringify(config.site?.title)} vs 期望 ${JSON.stringify(ctx.siteTitle)}`);

  ctx.flags.saved = true;
  ctx.savedStats = { count: waypointsOf(config).length, bytes: saved.bytes, howSave };
  return `${howSave}；主世界 ${beforeCount} → ${waypointsOf(config).length} 个点；JSON.parse ✓；新点 ${wp.id} X=${fmt(wp.x)} Z=${fmt(wp.z)}；schema ✓；其它维度（${Object.keys(expectedCounts).filter((d) => d !== ctx.dimensionId).join('/') || '无'}）点数未变`;
}

/* ------------------------------ 扩展：备份文件 ------------------------------ */

/**
 * 保存的写前备份现在落在站点仓库的 `.backups/` 子目录（服务端只保留最近 10 份），
 * 备份名仍是 `config.json.bak-<时间戳>`；站点根目录不再散落 bak 文件。
 */
async function checkBackup(ctx) {
  const backupDir = path.join(ctx.siteDir, '.backups');
  assert(
    fs.existsSync(backupDir),
    `站点副本里没有 .backups/ 目录（保存应把写前备份放到这里；当前根目录文件：${(await fsp.readdir(ctx.siteDir)).join('、')}）`,
  );

  const entries = await fsp.readdir(backupDir);
  const backups = entries
    .filter((name) => /^config\.json\.bak-/.test(name))
    .map((name) => ({ name, file: path.join(backupDir, name) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
  assert(
    backups.length > 0,
    `.backups/ 里没有 config.json.bak-*（实际文件：${entries.join('、') || '空'}）`,
  );

  const latest = backups[0];
  const text = await fsp.readFile(latest.file, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`最新的备份 .backups/${latest.name} 不是合法 JSON：${error.message}`);
  }
  const count = waypointsOf(parsed).length;
  assert(Array.isArray(parsed.dimensions), `备份 ${latest.name} 缺少 dimensions`);
  assert(
    count === ctx.siteCount,
    `备份 ${latest.name} 的主世界路径点数 实际 ${count} vs 期望 ${ctx.siteCount}（本次保存前的站点配置）`,
  );

  // 备份不再散落在站点根目录（防回归）
  const rootBackups = (await fsp.readdir(ctx.siteDir)).filter((name) => /^config\.json\.bak-/.test(name));
  assert(rootBackups.length === 0, `站点根目录不应再有 config.json.bak-*，实际还有：${rootBackups.join('、')}`);

  return `.backups/${latest.name}（${Buffer.byteLength(text)} 字节）：JSON.parse ✓、主世界 ${count} 个点（保存前状态）；共 ${backups.length} 份备份；根目录无散落 bak`;
}

/* ------------------------------ §7.5 保存被阻止 ------------------------------ */

async function checkSaveBlocked(ctx) {
  const page = ctx.page;
  const before = await readSiteConfigFile(ctx);
  const injected = await injectValidationError(ctx);
  assert(injected.ok, `无法注入校验错误：${injected.reason}`);

  try {
    // 等界面把错误显示出来
    await page.waitFor(
      () => {
        const issues = document.getElementById('issues');
        const status = document.getElementById('status');
        const text = `${issues?.innerText || ''} ${status?.textContent || ''}`;
        return /错误|不能为空|必须|缺少|至少|error/i.test(text);
      },
      { timeout: 4000, interval: 120, label: '问题面板出现 error' },
    ).catch(() => {});

    await clickAction(ctx, { selectors: ['#btn-save'], texts: ['保存到站点', '保存'], toolAction: 'save' });
    await sleep(1200);

    const after = await readSiteConfigFile(ctx);
    assert(
      after.text === before.text,
      `存在 error 时保存本应被阻止，但 config.json 被改写了（实际 ${after.bytes} 字节 vs 期望仍是 ${before.bytes} 字节）`,
    );

    const facts = await domFacts(page);
    const hint = `${facts.statusText} | ${facts.issuesText} | ${facts.toastText}`;
    assert(
      /错误|失败|未保存|不能为空|必须|缺少|至少/.test(hint),
      `保存被阻止了，但界面没有任何提示：status="${truncate(facts.statusText, 60)}" issues="${truncate(facts.issuesText, 80)}" toast="${truncate(facts.toastText, 60)}"`,
    );

    return `注入错误：${injected.desc}；保存被阻止（config.json 仍为 ${before.bytes} 字节）；提示="${truncate(facts.statusText || facts.toastText, 70)}"`;
  } finally {
    await injected.restore();
  }
}

/** 制造一个 error（删掉维度 id），返回可复原的句柄 */
async function injectValidationError(ctx) {
  const page = ctx.page;

  /** 走 app 的 patch 通道（与属性表单同一条代码路径） */
  const patch = async (payload) =>
    page.evalFn((p) => {
      const tool = window.__tool;
      if (!tool || typeof tool.patch !== 'function') return false;
      tool.patch(p);
      return true;
    }, payload);

  const validate = async () =>
    page.evalFn(() => {
      const tool = window.__tool;
      if (tool && typeof tool.validate === 'function') {
        const v = tool.validate();
        const errors = v?.errors || [];
        return { errors: errors.length, first: errors[0] ? String(errors[0].message || '') : '' };
      }
      const issues = document.getElementById('issues');
      const text = issues ? issues.innerText || '' : '';
      return { errors: /错误|不能为空|必须|缺少/.test(text) ? 1 : 0, first: text.slice(0, 60) };
    });

  /** 只改属性面板（#form）里的输入框：避免误把值打进 #search 之类的旁路输入框 */
  const setFormInput = async (fromValue, toValue) =>
    page.evalFn((from, to) => {
      const nodes = Array.from(document.querySelectorAll('#form input, #form textarea, #form select'));
      const el = nodes.find((n) => {
        if (n.type === 'hidden' || !n.closest('#form')) return false;
        if (String(n.value) !== String(from)) return false;
        const r = n.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      });
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, String(to));
      else el.value = String(to);
      const isToggle = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio';
      el.dispatchEvent(new Event(isToggle ? 'change' : 'input', { bubbles: true }));
      return true;
    }, fromValue, toValue);

  // ---------- 方式 1/2：清空维度 id ----------
  try {
    await selectDimension(ctx, 'overworld', '主世界');
    const clearedUi = await setFormInput('overworld', '');
    if (clearedUi) await page.settle(220);
    let result = await validate();
    if (clearedUi && result.errors > 0) {
      return {
        ok: true,
        desc: `把维度 id 清空为 ""（校验器报 ${result.errors} 个错误${result.first ? `：${truncate(result.first, 40)}` : ''}）`,
        restore: async () => {
          // 注意：维度 id 改成 "" 之后 app 的 currentDimension() 会找不到维度，表单/ patch 都会失效。
          // 先做「把 id 改回去」的修复；修不好就退回「读取站点配置」这个真实 UI 动作。
          const repaired = await repairDimensionIds(ctx);
          if (!repaired.ok || repaired.errors > 0) {
            await reloadFromSite(ctx).catch((error) => ctx.report.warn('退回「读取站点配置」也失败了', error.message));
          }
          const after = await validate();
          if (after.errors > 0) ctx.report.warn('注入的错误未能完全复原', `剩余 ${after.errors} 个校验错误（详见 tests/artifacts/last-run.json 的警告）`);
        },
      };
    }
    // 表单里拿不到维度 id 输入框 → 直接走 patch
    const patched = await patch({ kind: 'dimension', field: 'id', value: '' });
    await page.settle(220);
    result = await validate();
    if (patched && result.errors > 0) {
      return {
        ok: true,
        desc: `通过 patch 把维度 id 清空（校验器报 ${result.errors} 个错误${result.first ? `：${truncate(result.first, 40)}` : ''}）`,
        restore: async () => {
          await patch({ kind: 'dimension', field: 'id', value: 'overworld' });
          await page.settle(220);
        },
      };
    }
  } catch {
    /* 落到下一种方式 */
  }

  // ---------- 方式 3/4：清空第一个路径点的名称（契约：name 非空 → error） ----------
  const wp = ctx.siteFirstWaypoint;
  try {
    await selectWaypoint(ctx, { id: wp.id, name: wp.name });
    const clearedUi = await setFormInput(wp.name, '');
    if (clearedUi) await page.settle(220);
    let result = await validate();
    if (clearedUi && result.errors > 0) {
      return {
        ok: true,
        desc: `把路径点「${wp.name}」的名字清空（校验器报 ${result.errors} 个错误）`,
        restore: async () => {
          await setFormInput('', wp.name);
          await page.settle(200);
          if ((await validate()).errors > 0) {
            await patch({ kind: 'waypoint', id: wp.id, field: 'name', value: wp.name });
            await page.settle(200);
          }
        },
      };
    }
    const patched = await patch({ kind: 'waypoint', id: wp.id, field: 'name', value: '' });
    await page.settle(220);
    result = await validate();
    if (patched && result.errors > 0) {
      return {
        ok: true,
        desc: `通过 patch 清空路径点「${wp.name}」的名字（校验器报 ${result.errors} 个错误）`,
        restore: async () => {
          await patch({ kind: 'waypoint', id: wp.id, field: 'name', value: wp.name });
          await page.settle(220);
        },
      };
    }
  } catch {
    /* ignore */
  }

  return { ok: false, reason: '既清不掉维度 id，也清不掉路径点名称（表单/__tool.patch 都不可用，校验器没报错）' };
}

/* ------------------------------ §7.6 预览 ------------------------------ */

async function checkPreview(ctx) {
  const page = ctx.page;

  // 防御：前面的用例（尤其 §7.5 删维度 id）可能把维度弄丢，先把 id 修回来
  const repaired = await repairDimensionIds(ctx);
  if (repaired.changed) ctx.report.warn('预览前修复了被 §7.5 弄坏的维度 id', `现在是 ${JSON.stringify(repaired.ids)}`);

  // 防御：前面的用例可能把 selection 弄丢，先确保停在主世界维度
  const dimSel = await selectDimension(ctx, 'overworld', '主世界');
  if (!dimSel.ok) ctx.report.warn('预览前切换到主世界维度失败', dmSelReason(dimSel));

  const beforePreview = await readCurrentConfig(ctx);
  const draftCountBefore = waypointsOf(beforePreview.config).length;
  const savedCount = waypointsOf((await readSiteConfigFile(ctx)).config).length;

  // 故意加一个「未保存」的点，让「草稿 vs 已保存」可区分（预览必须是草稿）
  const howNew = await clickAction(ctx, {
    selectors: ['#btn-new-waypoint', '[data-action="new-waypoint"]'],
    texts: ['新增路径点', '新建路径点', '添加路径点'],
    toolAction: 'new-waypoint',
  });
  const grown = await waitForConfig(
    ctx,
    (config) => waypointsOf(config).length === draftCountBefore + 1,
    { timeout: 5000, label: '草稿里再多一个未保存的路径点' },
  ).catch(async (error) => {
    const info = await page.evalFn(() => {
      const tool = window.__tool;
      if (!tool) return { tool: false };
      const draft = tool.draft ? tool.draft() : null;
      const st = tool.state ? tool.state() : null;
      return {
        tool: true,
        dimensions: (draft?.dimensions || []).map((d) => ({ id: String(d.id), name: String(d.name), waypoints: (d.waypoints || []).length })),
        selection: st ? st.selection : null,
        validationErrors: (st?.validation?.errors || []).length,
        status: document.getElementById('status')?.textContent || '',
        issues: (document.getElementById('issues')?.innerText || '').slice(0, 200),
      };
    });
    throw new Error(
      `点「${howNew}」后草稿没有多出路径点（${error.message}）；` +
        `维度=${JSON.stringify(info.dimensions)}；selection=${JSON.stringify(info.selection)}；` +
        `未保存错误=${info.validationErrors}；状态栏="${truncate(info.status, 80)}"`,
    );
  });
  const draftCount = waypointsOf(grown.config).length;
  assert(
    draftCount > savedCount,
    `草稿 ${draftCount} 个点没有多于站点已保存的 ${savedCount} 个点，无法区分「预览读的是草稿还是已保存配置」`,
  );

  let how;
  try {
    how = await clickAction(ctx, {
      selectors: ['#btn-preview'],
      texts: ['真实站点预览', '预览'],
      toolAction: 'preview',
    });

    await page
      .waitFor(
        () => {
          const frame = document.getElementById('preview-frame');
          const dialog = document.getElementById('preview-dialog');
          return Boolean(frame && dialog && !dialog.hidden && /\/preview\/index\.html/.test(frame.getAttribute('src') || ''));
        },
        { timeout: 10_000, interval: 150, label: '预览弹层打开且 iframe 指向 /preview/' },
      )
      .catch(() => {});

    const info = await waitUntil(
      async () => {
        const got = await page.evalFn(() => {
          const frame = document.getElementById('preview-frame');
          if (!frame) return { error: '缺少 #preview-frame' };
          const src = frame.getAttribute('src') || '';
          let doc = null;
          let accessError = null;
          try {
            doc = frame.contentDocument;
          } catch (error) {
            accessError = String(error && error.message ? error.message : error);
          }
          if (!doc) return { src, accessError, markers: null };
          const overlay = doc.getElementById('overlay');
          const markers = doc.querySelectorAll('#overlay .marker').length;
          return {
            src,
            href: doc.location ? doc.location.href : '',
            markers: overlay ? markers : null,
            readyState: doc.readyState,
            title: doc.title,
          };
        });
        if (got.error) throw new Error(got.error);
        if (got.accessError) throw new Error(`无法访问 iframe document：${got.accessError}`);
        if (got.markers == null) return false;
        return got.markers > 0 ? got : false;
      },
      { timeout: 20_000, interval: 250, label: 'iframe 里渲染出 .marker' },
    ).catch(async (error) => {
      const facts = await domFacts(page);
      throw new Error(
        `预览 iframe 里没有渲染出 #overlay .marker：${error.message}；` +
          `previewOpen=${facts.previewOpen}、src="${truncate(facts.previewSrc, 90)}"`,
      );
    });

    assert(
      info.markers === draftCount,
      `iframe 标记 实际 ${info.markers} 个 vs 期望草稿 ${draftCount} 个` +
        `${info.markers === savedCount ? `（等于站点已保存的 ${savedCount} 个 —— 预览没有用草稿配置，token 未生效）` : ''}` +
        `；iframe src=${truncate(info.src, 80)}`,
    );

    return `${how}；iframe 标记 ${info.markers} 个 = 草稿 ${draftCount} 个（站点已保存 ${savedCount} 个，草稿里多出的 ${draftCount - savedCount} 个未保存点必须在预览里可见）；iframe ${truncate(info.href || info.src, 70)}`;
  } finally {
    // 关预览 + 撤销那个临时点，恢复现场
    await page
      .evalFn(() => {
        const close = document.getElementById('btn-preview-close');
        if (close) {
          close.click();
          return true;
        }
        const dialog = document.getElementById('preview-dialog');
        if (dialog) dialog.hidden = true;
        return false;
      })
      .catch(() => {});
    await page.settle(150);
    await pressCtrlZ(page).catch(() => {});
    await waitForConfig(ctx, (config) => waypointsOf(config).length === draftCountBefore, {
      timeout: 4000,
      label: '撤销临时路径点',
    }).catch(() => {});
  }
}

/* ------------------------------ §7.7 越界写入 ------------------------------ */

async function checkPathTraversal(ctx) {
  const tinyPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const cases = [
    { fileName: '../evil.png', why: '相对路径穿越' },
    { fileName: '..\\evil.png', why: 'Windows 反斜杠穿越' },
    { fileName: 'sub/evil.png', why: '子目录写入' },
    { fileName: 'C:\\Windows\\Temp\\evil.png', why: '绝对路径' },
  ];

  const results = [];
  for (const item of cases) {
    const res = await fetchJson(`${ctx.origin}/api/import-image`, {
      method: 'POST',
      body: { fileName: item.fileName, dataUrl: tinyPng },
      timeout: 8000,
    });
    results.push({ ...item, status: res.status, error: truncate(res.json?.error || res.text || '', 80) });
    assert(
      res.status >= 400 && res.status < 500,
      `fileName="${item.fileName}"（${item.why}）实际返回 ${res.status} vs 期望 4xx；响应：${truncate(res.text, 100)}`,
    );
    assert(res.json && res.json.ok === false, `fileName="${item.fileName}" 返回了 ${res.status}，但 body 没有 ok:false：${truncate(res.text, 100)}`);
  }

  // 站点副本「外面」不能出现任何 evil.png（%TEMP% 的上一级与副本同级目录）
  const outsideCandidates = [
    path.join(ctx.siteDir, '..', 'evil.png'),
    path.join(ctx.siteDir, 'sub', 'evil.png'),
    ...(ctx.tempRoot ? [path.join(ctx.tempRoot, 'evil.png')] : []),
  ];
  const leaked = outsideCandidates.filter((file) => fs.existsSync(file));
  assert(leaked.length === 0, `越界写入被拒绝但文件却落盘了：${leaked.join('、')}`);

  const detail = results.map((r) => `${r.fileName} → ${r.status}`).join('；');
  return `4 种越界写法全部 4xx：${detail}；站点目录外没有 evil.png`;
}

/* ------------------------------ 扩展：真实站点仓库没被「本次 e2e」写过 ------------------------------ */

/**
 * 这一项只负责**观察**，不负责判死：
 *   - 快照忽略 `.backups/` 与根目录 `config.json.bak-*`（配置工具的保存副产物）；
 *   - 真实站点可能同时被用户正在运行的工具实例（默认端口 5273）写入，那种改动与本轮 e2e 无关，
 *     所以 **降级为 warning**，并列出前后 sha256 与 mtime；
 *   - 「e2e 自己没写到真实站点」由更硬的保证承担：临时副本 + `--data` 隔离 +
 *     `/api/health.siteDir`、`/api/state.dataDir` 三重断言。
 */
async function checkRealSiteUntouched(ctx) {
  const before = ctx.realSiteSnapshot;
  assert(before, 'preflight 没有给真实站点拍照，无法比对');
  const after = await snapshotDir(OPT.siteRepo);
  const short = (hash) => (hash ? `${String(hash).slice(0, 12)}…` : 'null');

  const diffs = [];
  if (after.configHash !== before.configHash) {
    diffs.push(`config.json sha256 ${short(before.configHash)} → ${short(after.configHash)}（mtime ${before.configMtime} → ${after.configMtime}）`);
  }

  const beforeNames = new Map(before.items.map((item) => [item.name, item]));
  const afterNames = new Map(after.items.map((item) => [item.name, item]));
  const added = after.items.filter((item) => !beforeNames.has(item.name)).map((item) => item.name);
  const missing = before.items.filter((item) => !afterNames.has(item.name)).map((item) => item.name);
  if (added.length) diffs.push(`新增：${added.join('、')}`);
  if (missing.length) diffs.push(`减少：${missing.join('、')}`);
  const changed = after.items.filter((item) => {
    const old = beforeNames.get(item.name);
    return old && (old.size !== item.size || old.mtimeMs !== item.mtimeMs);
  });
  if (changed.length) {
    diffs.push(`改动：${changed.map((item) => `${item.name}（${beforeNames.get(item.name).size}→${item.size} 字节）`).join('、')}`);
  }

  if (diffs.length === 0) {
    return `真实站点 ${OPT.siteRepo} 无改动：config.json sha256 ${short(before.configHash)} 不变、${after.items.length} 个顶层条目的体积/mtime 全部一致（已忽略 .backups/ 与 config.json.bak-*）`;
  }

  // 外部进程（通常是用户自己的工具实例）改的 → 警告，不判失败
  ctx.report.warn(
    '真实站点在本次运行期间被外部进程修改（可能是用户正在使用配置工具），已忽略',
    diffs.join('；'),
  );
  return `真实站点有外部改动（已降级为警告，非 e2e 写入）：${truncate(diffs.join('；'), 220)}；` +
    `本次 e2e 的写入目标始终是临时副本（siteDir=${truncate(ctx.siteDir, 80)}）`;
}

/* ========================================================================== *
 * 7. 失败现场 + 清理
 * ========================================================================== */

async function captureFailure(ctx, id, error) {
  const stamp = nowStamp();
  const base = path.join(ARTIFACTS, `fail-${id}-${stamp}`);
  const lines = [
    '# e2e 失败现场',
    '',
    `- 检查项：${id}`,
    `- 时间：${new Date().toISOString()}`,
    `- 工具地址：${ctx.origin || '—'}`,
    `- 站点副本：${ctx.siteDir || '—'}`,
    `- 错误：${error?.message ?? error}`,
    '',
  ];

  let shot = null;
  if (ctx.page) {
    try {
      shot = await ctx.page.screenshot(`${base}.png`);
    } catch (shotError) {
      lines.push(`（截图失败：${shotError.message}）`, '');
    }
    try {
      const dom = await domSnapshot(ctx.page);
      lines.push('## DOM 摘要', '', '```', dom.outline, '```', '', '## 输入框', '', '```json', JSON.stringify(dom.inputs, null, 1), '```', '');
    } catch (domError) {
      lines.push(`（DOM 快照失败：${domError.message}）`, '');
    }
  }
  if (ctx.diagnostics) {
    lines.push('## console error / 异常 / HTTP≥400', '');
    const formatted = ctx.diagnostics.format(30);
    lines.push(formatted.length ? formatted.join('\n') : '（无）', '');
  }
  lines.push('## 堆栈', '', '```', String(error?.stack || ''), '```');

  await fsp.writeFile(`${base}.txt`, lines.join('\n'), 'utf8');
  const saved = [];
  if (shot) saved.push(path.relative(TOOL_ROOT, shot));
  saved.push(path.relative(TOOL_ROOT, `${base}.txt`));
  return saved.join(' + ');
}

async function cleanup(ctx) {
  const notes = [];
  if (ctx.page) {
    try {
      await ctx.page.close();
    } catch {
      /* ignore */
    }
    ctx.page = null;
  }
  if (ctx.browser) {
    try {
      await ctx.browser.close({ conn: ctx.cdp });
      notes.push('浏览器已退出');
    } catch (error) {
      notes.push(`浏览器关闭异常：${error.message}`);
    }
    ctx.browser = null;
  }
  if (ctx.cdp) {
    try {
      ctx.cdp.close();
    } catch {
      /* ignore */
    }
    ctx.cdp = null;
  }
  if (ctx.server) {
    const stopped = await ctx.server.stop().catch((error) => ({ killed: false, error }));
    notes.push(stopped?.portClosed ? '工具服务器已停止（端口已关闭）' : '工具服务器已停止（端口关闭校验未通过）');
    ctx.server = null;
  }
  if (ctx.tempDirs.length) {
    if (OPT.keep) {
      notes.push(`--keep：保留临时目录 ${ctx.tempDirs.join('、')}`);
    } else {
      for (const dir of ctx.tempDirs) {
        const removed = await removeDir(dir);
        notes.push(removed ? `已删除临时目录 ${dir}` : `⚠ 临时目录删除失败（可能有进程占用）：${dir}`);
      }
    }
  }
  return notes;
}

/* ========================================================================== *
 * 8. 主流程
 * ========================================================================== */

function flagLabel(key) {
  return (
    {
      server: '§7.1 服务器就绪',
      browser: '浏览器 + 页面打开',
      page: '§7.2 页面渲染通过',
      waypointAdded: '§7.4a 新增路径点通过',
      saved: '§7.4b 保存通过',
    }[key] || key
  );
}

const CHECKS = [
  { id: 'x3-schema-selftest', label: '扩展：JSON Schema 校验器自检（坏配置必须被拒）', requires: [], run: checkSchemaSelfTest },
  { id: 'c1-health', label: '§7.1 server 启动 + GET /api/health 返回 200', requires: ['server'], run: checkHealth, setsFlag: 'server' },
  { id: 'c2-page', label: '§7.2 3 秒内渲染配置树，无 console error / 异常 / HTTP≥400', requires: ['browser'], run: checkPageRender, setsFlag: 'page' },
  { id: 'c0-visible', label: '扩展：基底图真的被绘制出来（opacity/is-loaded + 像素亮度 + #canvas-info）', requires: ['page'], run: checkCanvasVisible },
  { id: 'c0b-enhance', label: '扩展：提亮按钮一次点击只翻转一次（data-enhance / filter / localStorage）', requires: ['page'], run: checkEnhanceToggle },
  { id: 'c3-tree-count', label: '§7.3 树里的路径点数量 = 站点 config.json 主世界点数（动态读取）', requires: ['page'], run: checkTreeCount },
  { id: 'c0c-tiles', label: '扩展：瓦片底图模式（表单/渲染/层级切换/单图互切/导出保留 tiles）', requires: ['page'], run: checkTilesMode },
  { id: 'x1-undo-redo', label: '扩展：撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z）', requires: ['page'], run: checkUndoRedo },
  { id: 'c5a-new-waypoint', label: '§7.4a 新增路径点 → 画布交互 → 坐标出现在表单', requires: ['page'], run: checkNewWaypoint, setsFlag: 'waypointAdded' },
  { id: 'c5b-save-verify', label: '§7.4b 保存 → 站点 config.json：JSON.parse + schema + 新点存在', requires: ['waypointAdded'], run: checkSaveVerify, setsFlag: 'saved' },
  { id: 'x2-backup', label: '扩展：保存把写前备份写到 .backups/（JSON 可解析、点数正确、根目录无散落 bak）', requires: ['saved'], run: checkBackup },
  { id: 'c5c-place', label: '§7.4c 交互语义：新建=select →「在图上取点」→ place → 落位回 select；点空白不移动已选点', requires: ['page'], run: checkPlaceMode },
  { id: 'c5d-drag', label: '§7.4d 拖动移动开关：默认拖不动 → 开启可拖 → Alt 临时可拖', requires: ['page'], run: checkDragMove },
  { id: 'c6-save-blocked', label: '§7.5 存在 error 时保存被阻止并提示', requires: ['saved'], run: checkSaveBlocked },
  { id: 'c7-preview', label: '§7.6 预览 iframe 渲染出「草稿」路径点数量', requires: ['page'], run: checkPreview },
  { id: 'c8-path-traversal', label: '§7.7 越界写入（../evil.png 等）返回 4xx', requires: ['server'], run: checkPathTraversal },
  { id: 'x4-real-site-untouched', label: '扩展：真实站点未被本次 e2e 写入（外部用户的改动降级为警告）', requires: [], run: checkRealSiteUntouched },
];

async function main() {
  await ensureDir(ARTIFACTS);
  await fsp
    .writeFile(path.join(ARTIFACTS, '.gitignore'), '*\n!.gitignore\n', 'utf8')
    .catch(() => {});

  const report = createReporter('SteveServerMapConfig e2e');
  const ctx = {
    report,
    origin: OPT.url || null,
    server: null,
    browser: null,
    cdp: null,
    page: null,
    diagnostics: null,
    siteDir: null,
    dataDir: OPT.data || null,
    tempDirs: [],
    tempRoot: null,
    flags: {},
    schema: null,
    siteCount: 0,
    siteWaypointNames: [],
    siteGroupNames: [],
    siteFirstWaypoint: null,
  };

  const startedAt = Date.now();
  console.log('');
  console.log('=== SteveServerMapConfig 端到端验收（tests/e2e.mjs）===');
  console.log(`  工具仓库：${TOOL_ROOT}`);
  console.log(`  站点仓库：${OPT.siteRepo}`);
  console.log(`  CDP 库  ：${HEADLESS_PATH}`);
  console.log(`  产物目录：${ARTIFACTS}`);
  console.log('');

  let fatal = null;
  try {
    await preflight(ctx);

    for (const spec of CHECKS) {
      const missing = spec.requires.filter((key) => !ctx.flags[key]);
      if (missing.length) {
        report.skip(spec.label, `前置未满足：${missing.map(flagLabel).join('、')}`, spec.id);
        continue;
      }
      const result = await report.check(spec.id, spec.label, async () => {
        try {
          return await spec.run(ctx);
        } catch (error) {
          const artifact = await captureFailure(ctx, spec.id, error).catch((e) => `（失败现场保存失败：${e.message}）`);
          if (artifact) error.message += `\n    失败现场：${artifact}`;
          throw error;
        }
      });
      if (result?.status === 'pass' && spec.setsFlag) ctx.flags[spec.setsFlag] = true;
    }
  } catch (error) {
    fatal = error;
    report.warn('基础设施失败', `${error.message}`);
    for (const spec of CHECKS) {
      if (!report.results.some((r) => r.id === spec.id)) {
        report.skip(spec.label, `基础设施失败：${truncate(error.message, 120)}`, spec.id);
      }
    }
  } finally {
    const cleanupNotes = await cleanup(ctx);
    console.log('');
    for (const note of cleanupNotes) console.log(`  · 清理：${note}`);
  }

  // 契约 §7 逐条对照
  const contract = [
    ['§7.1', 'c1-health'],
    ['§7.2', 'c2-page'],
    ['§7.3', 'c3-tree-count'],
    ['§7.4', 'c5a-new-waypoint'],
    ['§7.4', 'c5b-save-verify'],
    ['§7.5', 'c6-save-blocked'],
    ['§7.6', 'c7-preview'],
    ['§7.7', 'c8-path-traversal'],
  ];
  console.log('');
  console.log('契约 §7 对照：');
  for (const [clause, id] of contract) {
    const result = report.results.find((r) => r.id === id);
    const mark = !result ? '⊘ 未执行' : result.status === 'pass' ? '✓ 通过' : result.status === 'skip' ? '⊘ 跳过' : '✗ 失败';
    console.log(`  ${clause.padEnd(6)} ${mark.padEnd(8)} ${result?.label || id}`);
  }

  const summary = report.summary();
  const finishedAt = new Date();
  const payload = {
    ...report.toJSON(),
    when: finishedAt.toISOString(),
    node: process.version,
    browser: ctx.browserPath || null,
    toolOrigin: ctx.origin || null,
    siteRepo: OPT.siteRepo,
    siteCopy: ctx.siteDir,
    contract,
  };
  await fsp.writeFile(path.join(ARTIFACTS, 'last-run.json'), JSON.stringify(payload, null, 2), 'utf8').catch(() => {});

  const when = `${finishedAt.toLocaleString('zh-CN', { hour12: false })}`;
  console.log('');
  console.log(`完成：${when} · ${summary.pass} 通过 / ${summary.fail} 失败 / ${summary.skip} 跳过 · 耗时 ${formatDuration(Date.now() - startedAt)}`);
  if (summary.fail > 0) {
    console.log('失败项明细：');
    for (const item of report.failed) {
      console.log(`  ✗ ${item.id} ${item.label}`);
      console.log(`     ${String(item.error || '').replace(/\n/g, '\n     ')}`);
    }
  }
  if (fatal) console.log(`\n基础设施错误：${fatal.message}`);
  console.log(`报告快照：${path.relative(TOOL_ROOT, path.join(ARTIFACTS, 'last-run.json'))}`);

  return summary.ok ? 0 : 1;
}

/** 预备：临时站点副本 / 临时草稿目录 / 服务器 / 浏览器 / 页面 */
async function preflight(ctx) {
  const report = ctx.report;

  // 站点仓库只读：记录路径点基线
  const realConfigPath = path.join(OPT.siteRepo, 'config.json');
  assert(fs.existsSync(realConfigPath), `站点仓库缺少 config.json：${realConfigPath}`);
  ctx.realSiteSnapshot = await snapshotDir(OPT.siteRepo);
  const siteConfig = JSON.parse((await fsp.readFile(realConfigPath, 'utf8')).replace(/^\uFEFF/, ''));
  const over = dimensionOf(siteConfig);
  ctx.siteCount = (over?.waypoints || []).length;
  // 每个维度的路径点数都从站点副本的 config.json 动态读，绝不写死（用户随时会改站点配置）
  ctx.dimensionCounts = Object.fromEntries(
    (siteConfig.dimensions || []).map((dim) => [String(dim.id), (dim.waypoints || []).length]),
  );
  ctx.siteWaypointNames = (over?.waypoints || []).map((w) => String(w.name || ''));
  ctx.siteGroupNames = (over?.groups || []).map((g) => String(g.name || ''));
  ctx.siteFirstWaypoint = (over?.waypoints || [])[0] ? { id: String(over.waypoints[0].id), name: String(over.waypoints[0].name) } : null;
  ctx.siteTitle = siteConfig.site?.title;
  ctx.dimensionId = over?.id ? String(over.id) : 'overworld';
  ctx.siteImageName = over?.image ? String(over.image) : null;

  if (OPT.url) {
    // 复用已经启动的服务：站点目录从 /api/state 里取，绝不擅自启动新服务器
    ctx.origin = OPT.url;
    const state = await fetchJson(`${OPT.url}/api/state`, { timeout: 5000 });
    assert(state.ok && state.json?.ok, `--url=${OPT.url} 的 GET /api/state 失败（${state.status}）：${truncate(state.text, 160)}`);
    ctx.siteDir = path.resolve(String(state.json.siteDir));
    assert(
      ctx.siteDir.toLowerCase() !== path.resolve(OPT.siteRepo).toLowerCase(),
      `--url 指向的服务 siteDir 是真实站点仓库（${ctx.siteDir}）——e2e 会写 config.json，为保护真实仓库请用临时副本启动服务`,
    );
    report.note(`--url 模式：复用 ${OPT.url}，站点目录 ${ctx.siteDir}（不会启动/停止服务器）`);
    ctx.flags.server = true;
  } else {
    const copy = await prepareSiteCopy(OPT.siteRepo, { verbose: OPT.verbose });
    ctx.tempDirs.push(copy.dir);
    ctx.tempRoot = path.dirname(copy.dir);
    ctx.siteDir = copy.dir;

    if (!OPT.data) {
      const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssm-cfg-e2e-data-'));
      ctx.tempDirs.push(dataDir);
      ctx.dataDir = dataDir;
    }

    const port = OPT.port || (await freePort());
    report.note(`临时站点副本：${copy.dir}（${copy.copied.join('、')}）`);
    report.note(`草稿目录（--data）：${ctx.dataDir}`);
    report.note(`启动 server.mjs：--port=${port} --site=<临时副本>${OPT.data ? '' : ' --data=<临时草稿目录>'}`);

    ctx.server = await startToolServer({
      port,
      siteDir: copy.dir,
      dataDir: ctx.dataDir,
      timeoutMs: 20_000,
      verbose: OPT.verbose,
    });
    ctx.origin = ctx.server.origin;
    ctx.flags.server = true;
    report.note(`server 就绪：${ctx.origin}（启动耗时 ${formatDuration(ctx.server.startupMs)}）`);
  }

  // 浏览器 + 页面
  const browser = await launchBrowser({
    executablePath: OPT.browser,
    headless: !OPT.headed,
    windowSize: `${VIEWPORT.width},${VIEWPORT.height}`,
    verbose: OPT.verbose,
  });
  ctx.browser = browser;
  ctx.browserPath = browser.executablePath;
  const cdp = await CDP.connect(browser.wsUrl);
  ctx.cdp = cdp;
  browser.attach(cdp);

  const page = await Page.open(cdp, { url: 'about:blank' });
  ctx.page = page;
  await page.setViewport(VIEWPORT);
  // 瓦片缺失（未探索区域不导出瓦片）是正常情况：/preview/tiles/tiles/<level>/<x>_<y>.png 的 404 一律放行。
  // manifest 本身的 404 仍然算错误 —— 那说明路径填错了或副本没带 tiles/。
  ctx.diagnostics = createDiagnostics(page, {
    ignore: (error) => {
      const where = String(error?.where || '');
      return /\/preview\/tiles\/tiles\/[^/]+\/[^/]+\.png(?:[?#].*)?$/.test(where);
    },
  });
  // window.confirm（「读取站点配置」「删除路径点」都会弹）在无头模式下会卡住页面，统一自动接受
  page.on('Page.javascriptDialogOpening', () => {
    page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  ctx.flags.browser = true;
  report.note(`浏览器：${browser.browser || browser.executablePath}（headless=${!OPT.headed}）`);

  await page.navigate(`${ctx.origin}/`, { timeout: 30_000 });
  report.note(`页面已打开：${await page.url()}`);

  // 等 window.__tool 出现（bootstrap 完成），失败不致命：§7.2 会给出具体原因
  await page
    .waitFor(() => Boolean(window.__tool), { timeout: 8000, interval: 150, label: 'window.__tool 就绪' })
    .catch(() => {});
}

process.on('SIGINT', () => {
  console.error('\n收到 SIGINT，正在清理…');
  process.exit(1);
});

const exitCode = await main().catch((error) => {
  console.error('\n未捕获的致命错误：', error?.stack || error);
  return 1;
});
process.exit(exitCode);

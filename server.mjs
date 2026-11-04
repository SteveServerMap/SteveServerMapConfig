#!/usr/bin/env node
/**
 * server.mjs —— SteveServerMapConfig 的零依赖本地服务器
 *
 * 职责（详见 docs/CONTRACT.md §5）：
 *   1. 托管工具自己的页面与静态资源（/ 与 /assets/*）
 *   2. 把「站点仓库」只读挂到 /preview/*，让工具能用**真实站点**预览当前草稿
 *      · /preview/config.json?token=xxx 返回内存里的草稿配置
 *   3. 提供读写 API：读站点 config.json、导入图片、保存 config.json（写前自动备份）
 *   4. 草稿自动保存到本仓库 .data/draft.json
 *
 * 只用 Node 内置模块，不依赖 npm 包。默认只监听 127.0.0.1。
 *
 * 用法：
 *   node server.mjs
 *   node server.mjs --port=5300 --site="D:/Project/Github/SteveServerMap.github.io"
 *   node server.mjs --data="D:/tmp/draft"     # 草稿目录（默认 ./.data，测试用临时目录隔离）
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = __dirname;
const STARTED_AT = Date.now();
const VERSION = '1.0.0';

/* ============================== 命令行参数 ============================== */

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.SSM_PORT || 5273);
const HOST = String(args.host || process.env.SSM_HOST || '127.0.0.1');
const SITE_DIR = path.resolve(
  String(args.site || process.env.SSM_SITE || path.join(TOOL_DIR, '..', 'SteveServerMap.github.io')),
);
/** 站点仓库里的备份目录（放在子目录里，配合 .gitignore 避免误提交） */
const SITE_BACKUP_DIR = path.join(SITE_DIR, ".backups");
const KEEP_BACKUPS = 10;

const DATA_DIR = path.resolve(
  String(args.data || process.env.SSM_DATA || path.join(TOOL_DIR, '.data')),
);
const DRAFT_FILE = path.join(DATA_DIR, 'draft.json');

/* ============================== 常量 ============================== */

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}));

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_BODY = 64 * 1024 * 1024; // 64 MB：足够装下 3~4 MB 的 PNG（base64 后约 5 MB）
const PREVIEW_TOKEN_TTL = 10 * 60 * 1000;

/** 预览 token → { config, expires } */
const previewTokens = new Map();

/** 最近一次「预览」用的配置：让 /preview/config.json 在没有 token 参数时也能拿到草稿
 *  （站点代码里写的是 fetch('config.json')，不会带上 iframe URL 的查询参数；
 *   本地单用户工具，用「最近一次预览」+ Referer 里的 token 兜底即可，无需改站点代码） */
let currentPreview = null; // { config, expires }

/* ============================== 小工具 ============================== */

const log = (...args2) => console.log('[server]', ...args2);

function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

/** 把请求体读成 Buffer，超限直接中断 */
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error(`请求体过大（> ${Math.round(limit / 1024 / 1024)} MB）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new HttpError(400, `请求体不是合法 JSON：${err.message}`);
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 只允许在 baseDir 内解析出的单层文件名 */
function resolveInsideSite(name) {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, '文件名不能为空');
  const cleaned = name.trim();
  if (cleaned.includes('/') || cleaned.includes('\\') || cleaned.includes('..')) {
    throw new HttpError(400, `非法文件名：${cleaned}（不允许包含路径分隔符或 ..）`);
  }
  if (path.basename(cleaned) !== cleaned) throw new HttpError(400, `非法文件名：${cleaned}`);
  const ext = path.extname(cleaned).toLowerCase();
  if (!IMAGE_EXT.has(ext)) throw new HttpError(400, `不支持的图片类型：${ext || '(无扩展名)'}`);
  const full = path.resolve(SITE_DIR, cleaned);
  if (full !== path.join(SITE_DIR, cleaned)) throw new HttpError(400, `路径越界：${cleaned}`);
  if (!full.startsWith(SITE_DIR + path.sep)) throw new HttpError(400, `路径越界：${cleaned}`);
  return full;
}

/** 解析图片原始尺寸：PNG / JPEG / WEBP 头解析，失败返回 null */
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG：签名 + IHDR
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height, type: 'png' };
    return null;
  }
  // JPEG：扫 SOF 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      const len = buf.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) return { width, height, type: 'jpeg' };
        return null;
      }
      offset += 2 + len;
    }
    return null;
  }
  // WEBP
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const format = buf.toString('ascii', 12, 16);
    if (format === 'VP8X') {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { width, height, type: 'webp' };
    }
    if (format === 'VP8 ') {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height, type: 'webp' };
    }
    if (format === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
    }
  }
  return null;
}

/* ============================== 静态文件 ============================== */

async function serveFile(res, filePath, { cache = 'no-store', extraHeaders = {} } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME.get(ext) || 'application/octet-stream';
  const head = {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': cache,
    ...extraHeaders,
  };
  res.writeHead(200, head);
  if (res.req && res.req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

/** 站点目录里只有这些后缀允许通过 /preview 暴露 */
const PREVIEW_ALLOW = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.map', '.txt', '.md']);

async function handlePreview(req, res, url) {
  if (!SITE_DIR) return sendText(res, 500, '未配置站点目录');
  const rel = decodeURIComponent(url.pathname.replace(/^\/preview\/?/, ''));
  const target = rel === '' ? 'index.html' : rel;

  // 预览配置：?token= 命中内存草稿
  if (target === 'config.json') {
    const tokenFromQuery = url.searchParams.get('token');
    let tokenFromReferer = null;
    const referer = req.headers.referer || '';
    const refMatch = /[?&]token=([0-9a-f]{8,})/.exec(referer);
    if (refMatch) tokenFromReferer = refMatch[1];

    for (const token of [tokenFromQuery, tokenFromReferer]) {
      if (!token) continue;
      const entry = previewTokens.get(token);
      if (!entry) continue;
      if (entry.expires < Date.now()) {
        previewTokens.delete(token);
        return sendJson(res, 410, { ok: false, error: '预览 token 已过期，请重新点「预览」' });
      }
      return sendJson(res, 200, entry.config);
    }

    // 兜底：站点代码请求 config.json 时不带 token，用「最近一次预览」的配置
    if (currentPreview && currentPreview.expires > Date.now()) {
      return sendJson(res, 200, currentPreview.config);
    }
    // 再兜底：回落到站点仓库里真实的 config.json（保持 /preview/ 可独立打开）
  }

  // 越界防护：只允许站点目录内的白名单后缀
  const resolved = path.resolve(SITE_DIR, `.${path.sep}${target}`);
  if (!resolved.startsWith(SITE_DIR + path.sep)) return sendText(res, 403, '403 Forbidden');
  if (!PREVIEW_ALLOW.has(path.extname(resolved).toLowerCase())) return sendText(res, 403, '403 Forbidden');

  const ok = await serveFile(res, resolved, { cache: 'no-store' });
  if (!ok) sendText(res, 404, `404 Not Found: /preview/${target}`);
}

/* ============================== API ============================== */

async function listSiteImages() {
  const out = [];
  try {
    const entries = await fsp.readdir(SITE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fsp.stat(path.join(SITE_DIR, entry.name));
      out.push({ name: entry.name, size: stat.size, mtime: stat.mtime.toISOString() });
    }
  } catch {
    /* 站点目录不存在：返回空列表 */
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/**
 * 把 filePath 复制到站点仓库的 .backups/ 下，返回相对站点目录的备份路径；文件不存在返回 null。
 * 只保留最近 KEEP_BACKUPS 份，避免无限膨胀。
 */
async function backupInto(filePath, kind) {
  if (!fs.existsSync(filePath)) return null;
  await fsp.mkdir(SITE_BACKUP_DIR, { recursive: true });
  const base = path.basename(filePath);
  const target = path.join(SITE_BACKUP_DIR, base + ".bak-" + stamp());
  await fsp.copyFile(filePath, target);
  try {
    const entries = (await fsp.readdir(SITE_BACKUP_DIR))
      .filter((name) => name.startsWith(base + ".bak-"))
      .sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - KEEP_BACKUPS))) {
      await fsp.rm(path.join(SITE_BACKUP_DIR, name), { force: true });
    }
  } catch (err) {
    console.warn("[server] 清理旧备份失败：", err.message);
  }
  if (kind) log("已备份 " + base + " → .backups/" + path.basename(target) + "（" + kind + "）");
  return ".backups/" + path.basename(target);
}

/** 统计文件里各维度的路径点数量（文件不存在返回 0） */
async function countWaypointsOfFile(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return countWaypointsOfConfig(JSON.parse(raw.replace(/^\uFEFF/, '')));
  } catch {
    return { total: 0, byDim: {} };
  }
}

function countWaypointsOfConfig(config) {
  const byDim = {};
  let total = 0;
  for (const dim of (config && config.dimensions) || []) {
    const n = Array.isArray(dim.waypoints) ? dim.waypoints.length : 0;
    byDim[String(dim.id)] = n;
    total += n;
  }
  return { total, byDim };
}

/** 保存审计日志：谁知道哪个实例往哪个目录写了什么（排查误覆盖用） */
async function appendSaveLog(entry) {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, port: PORT, ...entry }) + '\n';
    await fsp.appendFile(path.join(DATA_DIR, 'save.log'), line, 'utf8');
  } catch (err) {
    console.warn('[server] 写 save.log 失败：', err.message);
  }
}

async function readDraft() {
  try {
    const raw = await fsp.readFile(DRAFT_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const route = url.pathname;

  if (route === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      uptime: Math.round((Date.now() - STARTED_AT) / 1000),
      siteDir: SITE_DIR,
      port: PORT,
    });
  }

  if (route === '/api/state' && method === 'GET') {
    const siteExists = fs.existsSync(SITE_DIR);
    const configPath = path.join(SITE_DIR, 'config.json');
    let configExists = false;
    let lastSaved = null;
    try {
      const stat = await fsp.stat(configPath);
      configExists = stat.isFile();
      lastSaved = stat.mtime.toISOString();
    } catch {
      /* ignore */
    }
    const sitePkg = fs.existsSync(path.join(SITE_DIR, 'assets', 'js', 'coords.js'));
    return sendJson(res, 200, {
      ok: true,
      siteDir: SITE_DIR,
      toolDir: TOOL_DIR,
      dataDir: DATA_DIR,
      siteExists,
      sitePackage: sitePkg,
      configExists,
      lastSaved,
      images: await listSiteImages(),
      draft: await readDraft(),
      host: HOST,
      port: PORT,
    });
  }

  if (route === '/api/site-config' && method === 'GET') {
    const configPath = path.join(SITE_DIR, 'config.json');
    try {
      const raw = await fsp.readFile(configPath, 'utf8');
      const config = JSON.parse(raw.replace(/^\uFEFF/, ''));
      return sendJson(res, 200, { ok: true, config, path: configPath });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: `读取站点 config.json 失败：${err.message}`, path: configPath });
    }
  }

  if (route === '/api/draft' && method === 'PUT') {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || !body.draft) throw new HttpError(400, '缺少 draft 字段');
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const text = JSON.stringify(body.draft, null, 2) + '\n';
    await fsp.writeFile(DRAFT_FILE, text, 'utf8');
    return sendJson(res, 200, { ok: true, savedAt: new Date().toISOString(), bytes: Buffer.byteLength(text) });
  }

  if (route === '/api/draft' && method === 'DELETE') {
    await fsp.rm(DRAFT_FILE, { force: true });
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/image-meta' && method === 'GET') {
    const name = url.searchParams.get('name') || '';
    const full = resolveInsideSite(name);
    try {
      const buf = await fsp.readFile(full);
      const size = imageSize(buf);
      if (!size) return sendJson(res, 422, { ok: false, error: '无法识别图片尺寸（仅支持 PNG/JPEG/WEBP）' });
      return sendJson(res, 200, { ok: true, name, bytes: buf.length, ...size });
    } catch (err) {
      return sendJson(res, 404, { ok: false, error: `读取失败：${err.message}` });
    }
  }

  if (route === '/api/import-image' && method === 'POST') {
    const body = await readJsonBody(req);
    const full = resolveInsideSite(body.fileName);
    const dataUrl = String(body.dataUrl || '');
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
    if (!m) throw new HttpError(400, 'dataUrl 格式不正确（需要 data:image/png;base64,...）');
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'binary');
    if (!buf.length) throw new HttpError(400, '图片内容为空');
    const size = imageSize(buf);

    await fsp.mkdir(SITE_DIR, { recursive: true });
    const backup = await backupInto(full, "import-image");
    await fsp.writeFile(full, buf);
    log(`导入图片 ${path.basename(full)}（${buf.length} 字节）${backup ? `，原文件备份为 ${path.basename(backup)}` : ''}`);
    return sendJson(res, 200, {
      ok: true,
      name: path.basename(full),
      bytes: buf.length,
      backup,
      width: size ? size.width : null,
      height: size ? size.height : null,
    });
  }

  if (route === '/api/save' && method === 'POST') {
    const body = await readJsonBody(req);
    const config = body.config;
    if (!config || typeof config !== 'object' || !Array.isArray(config.dimensions)) {
      throw new HttpError(400, 'config 必须是包含 dimensions 数组的对象');
    }
    const configPath = path.join(SITE_DIR, 'config.json');

    // ---- 写前防呆：如果这次保存会「大量减少」路径点，必须显式确认 ----
    // （工具是本地单用户，但误点一次「保存到站点」不该把几十个路径点冲掉）
    if (!body.confirm) {
      const before = await countWaypointsOfFile(configPath);
      const after = countWaypointsOfConfig(config);
      const removed = before.total - after.total;
      if (before.total > 0 && removed >= 3 && removed / before.total > 0.2) {
        await appendSaveLog({ event: 'refused', before: before.total, after: after.total, siteDir: SITE_DIR });
        return sendJson(res, 409, {
          ok: false,
          code: 'CONFIRM_REQUIRED',
          error: `这次保存会删除 ${removed} 个路径点（${before.total} → ${after.total}），已拦住`,
          before,
          after,
        });
      }
    }
    await fsp.mkdir(SITE_DIR, { recursive: true });
    const backup = await backupInto(configPath, "config.json");
    const text = JSON.stringify(config, null, 2) + '\n';
    await fsp.writeFile(configPath, text, 'utf8');
    await appendSaveLog({
      event: 'saved',
      siteDir: SITE_DIR,
      counts: countWaypointsOfConfig(config),
      bytes: Buffer.byteLength(text),
      confirmed: body.confirm === true,
    });
    log(`已写入 ${configPath}（${Buffer.byteLength(text)} 字节）${backup ? `，备份 ${backup}` : ''}`);
    return sendJson(res, 200, {
      ok: true,
      path: configPath,
      backup,
      bytes: Buffer.byteLength(text),
      savedAt: new Date().toISOString(),
    });
  }

  if (route === '/api/preview-token' && method === 'POST') {
    const body = await readJsonBody(req);
    const config = body.config;
    if (!config || typeof config !== 'object' || !Array.isArray(config.dimensions)) {
      throw new HttpError(400, 'config 必须是包含 dimensions 数组的对象');
    }
    const token = randomBytes(8).toString('hex');
    const expires = Date.now() + PREVIEW_TOKEN_TTL;
    previewTokens.set(token, { config, expires });
    currentPreview = { config, expires };
    // 顺手清理过期的
    for (const [key, entry] of previewTokens) {
      if (entry.expires < Date.now()) previewTokens.delete(key);
    }
    return sendJson(res, 200, { ok: true, token, ttl: PREVIEW_TOKEN_TTL });
  }

  throw new HttpError(404, `未知接口：${method} ${route}`);
}

/* ============================== 请求分发 ============================== */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    return sendText(res, 400, '400 Bad Request');
  }

  const method = req.method || 'GET';
  const finish = () => log(`${method} ${decodeURIComponent(url.pathname)}${url.search ? '?…' : ''} ${res.statusCode} ${Date.now() - started}ms`);
  res.on('finish', finish);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname === '/preview' || url.pathname.startsWith('/preview/')) {
      await handlePreview(req, res, url);
      return;
    }

    // 工具自身静态资源
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const resolved = path.resolve(TOOL_DIR, `.${rel}`);
    if (!resolved.startsWith(TOOL_DIR + path.sep)) return sendText(res, 403, '403 Forbidden');
    if (resolved.startsWith(DATA_DIR + path.sep)) return sendText(res, 403, '403 Forbidden'); // .data 不对外
    if (!MIME.has(path.extname(resolved).toLowerCase())) return sendText(res, 403, '403 Forbidden');

    const ok = await serveFile(res, resolved);
    if (!ok) sendText(res, 404, `404 Not Found: ${rel}`);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message || String(err) });
    else res.end();
    if (status >= 500) console.error('[server] 未处理错误：', err);
  }
});

server.listen(PORT, HOST, () => {
  const siteOk = fs.existsSync(SITE_DIR);
  log(`配置工具已启动：http://${HOST}:${PORT}/`);
  log(`工具目录：${TOOL_DIR}`);
  log(`站点目录：${SITE_DIR}${siteOk ? '' : '  ⚠ 不存在（保存会失败，用 --site= 指定）'}`);
  if (!fs.existsSync(path.join(SITE_DIR, 'assets', 'js', 'coords.js'))) {
    log('⚠ 站点目录里没找到 assets/js/coords.js：预览与投影会不可用，请检查 --site 是否指向 SteveServerMap.github.io');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[server] 端口 ${PORT} 已被占用。换一个端口：node server.mjs --port=5300\n`);
  } else {
    console.error('[server] 启动失败：', err);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}


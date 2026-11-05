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
import { generateXaeroTiles, inspectXaeroSource } from './tools/xaero-tiles.mjs';
import { mergeTileSets } from './tools/tile-merge.mjs';

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

/** xaero 源目录：每个一级子目录代表一个维度（如 xaero/主世界、xaero/地狱、xaero/末地） */
const XAERO_DIR = path.resolve(
  String(args.xaero || process.env.SSM_XAERO || path.join(TOOL_DIR, 'xaero')),
);

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
const MERGE_UPLOAD_LIMIT = 256 * 1024 * 1024; // 瓦片差分上传多张 Xaero 导出，上限放宽
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
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${p(date.getMilliseconds(), 3)}`;
}

let mutationQueue = Promise.resolve();

/** 请求体立即读取，但读盘、校验与写盘都按请求进入队列的顺序执行。 */
function enqueueMutation(operation, body = Promise.resolve()) {
  // 等待前一个操作时，请求体解析可能已经失败，先接住拒绝，轮到它时仍向调用方报错。
  body.catch(() => {});
  const result = mutationQueue.then(async () => operation(await body));
  mutationQueue = result.catch(() => {});
  return result;
}

/** 同目录独占创建临时文件，关闭后原子替换；失败不改动原文件。 */
async function atomicWriteFile(filePath, text) {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${randomBytes(8).toString('hex')}`);
  const file = await fsp.open(tmpPath, 'wx');
  try {
    try {
      await file.writeFile(text, 'utf8');
    } finally {
      await file.close();
    }
    await fsp.rename(tmpPath, filePath);
  } finally {
    await fsp.rm(tmpPath, { force: true });
  }
}

/** 替换瓦片时保留旧目录，发布失败则回滚；回滚失败也不删除旧数据。 */
async function replaceDirectory(tmpDir, outDir) {
  const backupDir = path.join(path.dirname(outDir), `.bak-${path.basename(outDir)}-${randomBytes(8).toString('hex')}`);
  let movedOld = false;
  try {
    await fsp.rename(outDir, backupDir);
    movedOld = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    await fsp.rename(tmpDir, outDir);
  } catch (err) {
    if (movedOld) {
      try {
        await fsp.rename(backupDir, outDir);
      } catch (rollbackErr) {
        throw new AggregateError([err, rollbackErr], `替换瓦片及回滚失败，原瓦片保留在 ${backupDir}：${err.message}；${rollbackErr.message}`);
      }
    }
    throw err;
  }
  if (movedOld) {
    await fsp.rm(backupDir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[server] 清理旧瓦片失败，保留在 ${backupDir}：`, err.message);
    });
  }
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

/**
 * 极简 multipart/form-data 解析（零依赖）。头按 latin1 解析：浏览器对非 ASCII 文件名
 * 会直接塞 UTF-8 字节，但本接口只接受 ASCII 的 x<X>_z<Z>.png / <rx>_<rz>.zip 文件名。
 * @returns {Array<{name:string, filename:string|null, contentType:string, data:Buffer}>}
 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = m ? (m[1] || m[2]).trim() : '';
  if (!boundary) throw new HttpError(400, 'multipart 请求缺少 boundary');
  const delim = Buffer.from(`--${boundary}`, 'latin1');
  const parts = [];
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const end = buf.indexOf(delim, pos + delim.length);
    if (end === -1) break;
    let body = buf.subarray(pos + delim.length, end);
    if (body.length >= 2 && body[0] === 0x0d && body[1] === 0x0a) body = body.subarray(2);
    pos = end;
    const sep = body.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const headText = body.subarray(0, sep).toString('latin1');
    let data = body.subarray(sep + 4);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.subarray(0, data.length - 2);
    }
    const nameM = /name="([^"]*)"/i.exec(headText);
    if (!nameM) continue;
    const fileM = /filename="([^"]*)"/i.exec(headText);
    const ctM = /content-type:\s*([^\r\n]+)/i.exec(headText);
    parts.push({
      name: nameM[1],
      filename: fileM ? fileM[1] : null,
      contentType: ctM ? ctM[1].trim() : '',
      data: Buffer.from(data),
    });
  }
  return parts;
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

/** xaero 子目录名 / 维度 id 都只允许单层名字，禁止路径穿越 */
function resolveXaeroFolder(folder) {
  const cleaned = String(folder == null ? '' : folder).trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new HttpError(400, 'xaero 维度目录名不能为空');
  if (cleaned.includes('/') || cleaned.includes('\\') || cleaned.includes('\0')) {
    throw new HttpError(400, `非法的 xaero 维度目录名：${cleaned}`);
  }
  const full = path.resolve(XAERO_DIR, cleaned);
  if (path.dirname(full) !== XAERO_DIR) throw new HttpError(400, `路径越界：${cleaned}`);
  return full;
}

/** 维度 id 直接用来做 tiles/<id>/ 目录名，必须能安全落盘 */
function safeDimensionId(id) {
  const cleaned = String(id == null ? '' : id).trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new HttpError(400, '缺少维度 id');
  if (cleaned.includes('/') || cleaned.includes('\\') || cleaned.includes('\0') || /[\r\n]/.test(cleaned)) {
    throw new HttpError(400, `维度 id 不能用作目录名：${cleaned}`);
  }
  return cleaned;
}

/** 扫描 xaero/ 下的一级子目录，返回每个维度的源信息（不解码整图） */
async function listXaeroSources() {
  let entries = [];
  try {
    entries = await fsp.readdir(XAERO_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceDir = path.join(XAERO_DIR, entry.name);
    const scan = await inspectXaeroSource(sourceDir);
    out.push({
      folder: entry.name,
      kind: scan.kind,
      images: scan.images,
      regions: scan.regions,
      bounds: scan.bounds,
      bytes: scan.bytes,
    });
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder, 'zh-CN'));
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

let backupSequence = 0;

/**
 * 把 filePath 复制到站点仓库的 .backups/ 下，返回相对站点目录的备份路径；文件不存在返回 null。
 * 只保留最近 KEEP_BACKUPS 份，避免无限膨胀。
 */
async function backupInto(filePath, kind) {
  if (!fs.existsSync(filePath)) return null;
  await fsp.mkdir(SITE_BACKUP_DIR, { recursive: true });
  const base = path.basename(filePath);
  const suffix = `${String(++backupSequence).padStart(10, '0')}-${randomBytes(6).toString('hex')}`;
  const target = path.join(SITE_BACKUP_DIR, base + ".bak-" + stamp() + '-' + suffix);
  await fsp.copyFile(filePath, target, fs.constants.COPYFILE_EXCL);
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

/** 目录级备份（瓦片差分合并发布前用）：整树复制到 .backups/，只保留最近 KEEP_BACKUPS 份 */
async function backupTreeInto(dirPath, kind) {
  if (!fs.existsSync(dirPath)) return null;
  await fsp.mkdir(SITE_BACKUP_DIR, { recursive: true });
  const base = path.basename(dirPath);
  const suffix = `${String(++backupSequence).padStart(10, '0')}-${randomBytes(6).toString('hex')}`;
  const target = path.join(SITE_BACKUP_DIR, base + ".bak-" + stamp() + '-' + suffix);
  await fsp.cp(dirPath, target, { recursive: true });
  try {
    const entries = (await fsp.readdir(SITE_BACKUP_DIR))
      .filter((name) => name.startsWith(base + ".bak-"))
      .sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - KEEP_BACKUPS))) {
      await fsp.rm(path.join(SITE_BACKUP_DIR, name), { recursive: true, force: true });
    }
  } catch (err) {
    console.warn("[server] 清理旧备份失败：", err.message);
  }
  log(`已备份 ${base}/ → .backups/${path.basename(target)}/（${kind}）`);
  return ".backups/" + path.basename(target);
}

/** 读取站点 config.json（BOM 容忍）；失败抛 HttpError */
async function readSiteConfig() {
  const configPath = path.join(SITE_DIR, 'config.json');
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new HttpError(500, `读取站点 config.json 失败：${err.message}`);
  }
}

/** 维度是否启用了瓦片底图（与合并页/主编辑器同一口径） */
function dimHasTiles(dim) {
  const tiles = dim?.tiles;
  return !!String((typeof tiles === 'string' ? tiles : tiles?.manifest) || '').trim();
}

/** 从站点配置里取瓦片维度（不存在/未启用瓦片时抛 HttpError） */
async function requireTileDimension(dimensionId) {
  const config = await readSiteConfig();
  const dim = Array.isArray(config?.dimensions)
    ? config.dimensions.find((d) => String(d?.id) === dimensionId)
    : null;
  if (!dim) throw new HttpError(404, `站点配置里没有维度「${dimensionId}」`);
  if (!dimHasTiles(dim)) {
    throw new HttpError(422, `维度「${dimensionId}」没有启用瓦片底图，请先在主编辑器里为它生成瓦片`);
  }
  return dim;
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
    let draftMtime = null;
    try {
      draftMtime = (await fsp.stat(DRAFT_FILE)).mtime.toISOString();
    } catch {
      /* 没有草稿 */
    }
    return sendJson(res, 200, {
      ok: true,
      siteDir: SITE_DIR,
      toolDir: TOOL_DIR,
      dataDir: DATA_DIR,
      xaeroDir: XAERO_DIR,
      siteExists,
      sitePackage: sitePkg,
      configExists,
      lastSaved,
      draftMtime,
      images: await listSiteImages(),
      draft: await readDraft(),
      xaero: await listXaeroSources(),
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
    return enqueueMutation(async (body) => {
      if (!body || typeof body !== 'object' || !body.draft) throw new HttpError(400, '缺少 draft 字段');
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const text = JSON.stringify(body.draft, null, 2) + '\n';
      await atomicWriteFile(DRAFT_FILE, text);
      return sendJson(res, 200, { ok: true, savedAt: new Date().toISOString(), bytes: Buffer.byteLength(text) });
    }, readJsonBody(req));
  }

  if (route === '/api/draft' && method === 'DELETE') {
    return enqueueMutation(async () => {
      await fsp.rm(DRAFT_FILE, { force: true });
      return sendJson(res, 200, { ok: true });
    });
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
    return enqueueMutation(async (body) => {
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
      await atomicWriteFile(configPath, text);
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
    }, readJsonBody(req));
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

  if (route === '/api/xaero/sources' && method === 'GET') {
    return sendJson(res, 200, { ok: true, root: XAERO_DIR, sources: await listXaeroSources() });
  }

  if (route === '/api/xaero/generate' && method === 'POST') {
    const body = await readJsonBody(req);
    const folder = String(body.folder == null ? '' : body.folder).trim();
    const dimensionId = safeDimensionId(body.dimensionId);
    const sourceDir = resolveXaeroFolder(folder);
    const sourceStat = await fsp.stat(sourceDir).catch(() => null);
    if (!sourceStat || !sourceStat.isDirectory()) {
      throw new HttpError(404, `xaero 源目录不存在：${folder}`);
    }
    const scan = await inspectXaeroSource(sourceDir);
    if (scan.kind === 'empty') {
      throw new HttpError(422, `xaero/${folder} 里没有可用的导出 PNG（文件名需带 x<X>_z<Z>）或区域 zip`);
    }
    const tileSize = Math.max(64, Math.min(1024, Math.round(Number(body.tileSize) || 256) & ~1));
    const outRel = `tiles/${dimensionId}`;
    const outDir = path.join(SITE_DIR, 'tiles', dimensionId);
    const tmpDir = path.join(SITE_DIR, 'tiles', `.tmp-${dimensionId}-${stamp()}-${randomBytes(3).toString('hex')}`);
    const started = Date.now();
    try {
      // 先生成到临时目录，成功后再替换：生成失败不会把站点上已有的瓦片弄坏。
      const manifest = await generateXaeroTiles({
        sourceDir,
        outDir: tmpDir,
        tileSize,
        keepBlack: body.keepBlack === true,
      });
      // 发布也串行，避免同一维度的两个生成请求在替换或回滚时互相覆盖。
      await enqueueMutation(() => replaceDirectory(tmpDir, outDir));
      const summary = {
        ok: true,
        folder,
        dimensionId,
        manifest: `${outRel}/manifest.json`,
        outDir: outRel,
        bounds: manifest.worldBlockRange,
        width: manifest.worldBlockRange.xMax - manifest.worldBlockRange.xMin,
        height: manifest.worldBlockRange.zMax - manifest.worldBlockRange.zMin,
        levels: manifest.levels.length,
        stats: manifest.stats,
        durationMs: Date.now() - started,
      };
      log(
        `已生成 xaero/${folder} → ${outRel}（${manifest.stats.tilesWritten} 张瓦片，` +
          `${manifest.levels.length} 层，${summary.durationMs}ms）`,
      );
      await appendSaveLog({
        event: 'xaero-generate',
        siteDir: SITE_DIR,
        folder,
        dimensionId,
        manifest: summary.manifest,
        stats: manifest.stats,
      });
      return sendJson(res, 200, summary);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (route === '/api/merge-tiles/analyze' && method === 'POST') {
    const buf = await readBody(req, MERGE_UPLOAD_LIMIT);
    const parts = parseMultipart(buf, req.headers['content-type']);
    const field = (name) => {
      const part = parts.find((p) => p.name === name && !p.filename);
      return part ? part.data.toString('utf8') : '';
    };
    const files = parts.filter((p) => p.filename);
    const dim = safeDimensionId(field('dim'));
    if (!files.length) throw new HttpError(400, '没有上传任何新图文件');
    const fillNew = String(field('fillNew') || '1') === '1';
    const updateChanged = String(field('updateChanged') || '1') === '1';
    const clamp255 = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.min(255, Math.max(0, n)) : fallback;
    };
    const voidLuminance = clamp255(field('voidLuminance'), 8);
    const diffThreshold = clamp255(field('diffThreshold'), 24);

    await requireTileDimension(dim);
    const baseDir = path.join(SITE_DIR, 'tiles', dim);
    const manifestPath = path.join(baseDir, 'manifest.json');
    const stat = await fsp.stat(manifestPath).catch(() => null);
    if (!stat || !stat.isFile()) throw new HttpError(404, `维度「${dim}」的瓦片不存在：${manifestPath}`);

    // 上传文件落盘（只收 PNG / 区域 zip，文件名必须是 Xaero 命名，避免路径穿越）
    const uploadDir = path.join(DATA_DIR, 'merge-uploads', dim);
    await fsp.rm(uploadDir, { recursive: true, force: true });
    await fsp.mkdir(uploadDir, { recursive: true });
    let savedFiles = 0;
    for (const part of files) {
      const name = path.basename(String(part.filename || '')).trim();
      if (!name || name.includes('\0')) continue;
      const ext = path.extname(name).toLowerCase();
      // 与 tools/xaero-tiles.mjs 的 parseExportName/parseRegionName 同一口径
      if (ext === '.png') {
        if (!/x(-?\d+)_z(-?\d+)\.png$/i.test(name)) {
          throw new HttpError(422, `文件名不符合 Xaero 命名：${name}（PNG 需带 x<X>_z<Z>）`);
        }
      } else if (ext === '.zip') {
        if (!/(-?\d+)_(-?\d+)\.zip$/i.test(name)) {
          throw new HttpError(422, `文件名不符合 Xaero 命名：${name}（zip 需为 <rx>_<rz>.zip）`);
        }
      } else {
        continue;
      }
      await fsp.writeFile(path.join(uploadDir, name), part.data, { flag: 'wx' });
      savedFiles += 1;
    }
    if (!savedFiles) throw new HttpError(422, '上传的文件里没有可用的 PNG 或区域 zip');

    // 合成到临时目录，成功后入队原子替换 staging（同维度重复分析最后提交的生效）
    const stagingTmp = path.join(DATA_DIR, 'merge-staging', `.tmp-${dim}-${stamp()}-${randomBytes(3).toString('hex')}`);
    const stagingDir = path.join(DATA_DIR, 'merge-staging', dim);
    const started = Date.now();
    let result;
    try {
      result = await mergeTileSets({
        baseDir,
        incomingDir: uploadDir,
        outDir: stagingTmp,
        voidLuminance,
        diffThreshold,
        fillNew,
        updateChanged,
      });
      await enqueueMutation(() => replaceDirectory(stagingTmp, stagingDir));
    } finally {
      await fsp.rm(stagingTmp, { recursive: true, force: true }).catch(() => {});
    }

    const summary = {
      ok: true,
      dim,
      staged: true,
      stagingManifestUrl: `/api/merge-staging/${dim}/manifest.json`,
      fillNew,
      updateChanged,
      counts: result.counts,
      blocksArea: result.blocksArea,
      grid: result.grid,
      incoming: {
        kind: result.manifest.stats.kind,
        images: result.manifest.stats.images,
        regions: result.manifest.stats.regions,
        decoded: result.manifest.stats.decoded,
        skipped: result.manifest.stats.skipped,
      },
      base: {
        tileSize: result.manifest.tileSize,
        bounds: result.manifest.worldBlockRange,
        levels: result.manifest.levels.length,
        baseTiles: result.manifest.stats.baseTiles,
      },
      stagedGeneratedAt: result.manifest.generatedAt,
      durationMs: result.durationMs,
    };
    log(`瓦片差分分析完成：${dim} 新增 ${result.counts.onlyIncoming} · 变更 ${result.counts.changed} · 仅目标图 ${result.counts.onlyBase}（${summary.durationMs}ms）`);
    return sendJson(res, 200, summary);
  }

  if (route === '/api/merge-tiles/apply' && method === 'POST') {
    return enqueueMutation(async (body) => {
      const dim = safeDimensionId(body.dim);
      await requireTileDimension(dim);
      const stagingDir = path.join(DATA_DIR, 'merge-staging', dim);
      const stagingManifest = path.join(stagingDir, 'manifest.json');
      const stat = await fsp.stat(stagingManifest).catch(() => null);
      if (!stat || !stat.isFile()) {
        throw new HttpError(409, '还没有分析结果：请先在合并页点「分析差异」，再保存');
      }
      let manifest;
      try {
        manifest = JSON.parse(await fsp.readFile(stagingManifest, 'utf8'));
      } catch (err) {
        throw new HttpError(500, `暂存结果损坏，请重新分析：${err.message}`);
      }
      if (
        !(Number.isInteger(manifest.tileSize) && manifest.tileSize > 0) ||
        !Array.isArray(manifest.levels) || !manifest.levels.length ||
        !manifest.worldBlockRange || !(manifest.worldBlockRange.xMax > manifest.worldBlockRange.xMin)
      ) {
        throw new HttpError(500, '暂存结果结构无效，请重新分析');
      }

      const outDir = path.join(SITE_DIR, 'tiles', dim);
      const tmpDir = path.join(SITE_DIR, 'tiles', `.tmp-merge-${dim}-${stamp()}-${randomBytes(3).toString('hex')}`);
      await fsp.cp(stagingDir, tmpDir, { recursive: true });
      const backup = await backupTreeInto(outDir, 'merge-tiles');
      try {
        await replaceDirectory(tmpDir, outDir);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
      await fsp.rm(path.join(DATA_DIR, 'merge-uploads', dim), { recursive: true, force: true }).catch(() => {});
      await appendSaveLog({
        event: 'merge-tiles-apply',
        siteDir: SITE_DIR,
        dimensionId: dim,
        backup,
        stats: manifest.stats,
      });
      log(
        `已发布瓦片差分合并结果 → tiles/${dim}/（${manifest.stats.tilesWritten} 张瓦片，` +
          `${manifest.levels.length} 层）${backup ? `，原瓦片备份为 ${backup}/` : ''}`,
      );
      return sendJson(res, 200, {
        ok: true,
        dim,
        tiles: `tiles/${dim}`,
        backup,
        tileSize: manifest.tileSize,
        levels: manifest.levels.length,
        tilesWritten: manifest.stats.tilesWritten,
        appliedAt: new Date().toISOString(),
      });
    }, readJsonBody(req));
  }

  // 只读暴露暂存的合并结果（合并页「旧图 vs 合并结果」对比滑块用）：
  // /api/merge-staging/<dim>/manifest.json 或 /api/merge-staging/<dim>/tiles/<level>/<x>_<y>.png
  if (route.startsWith('/api/merge-staging/') && method === 'GET') {
    let decoded;
    try {
      decoded = decodeURIComponent(route);
    } catch {
      throw new HttpError(400, '400 Bad Request');
    }
    const rest = decoded.slice('/api/merge-staging/'.length);
    const slash = rest.indexOf('/');
    const dim = safeDimensionId(slash === -1 ? rest : rest.slice(0, slash));
    const rel = slash === -1 ? '' : rest.slice(slash + 1);
    if (!/^(manifest\.json|tiles\/\d+\/-?\d+_-?\d+\.png)$/.test(rel)) {
      throw new HttpError(404, '暂存结果里没有这个文件');
    }
    const stagingDir = path.join(DATA_DIR, 'merge-staging', dim);
    const resolved = path.resolve(stagingDir, rel);
    if (!resolved.startsWith(stagingDir + path.sep)) throw new HttpError(403, '403 Forbidden');
    const ok = await serveFile(res, resolved, { cache: 'no-store' });
    if (!ok) throw new HttpError(404, `暂存结果不存在：${rel}`);
    return;
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
  let logPath = url.pathname;
  const finish = () => log(`${method} ${logPath}${url.search ? '?…' : ''} ${res.statusCode} ${Date.now() - started}ms`);
  res.on('finish', finish);

  try {
    try {
      logPath = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, '400 Bad Request');
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname === '/preview' || url.pathname.startsWith('/preview/')) {
      await handlePreview(req, res, url);
      return;
    }

    // 工具自身静态资源
    let rel = logPath;
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
  log(`xaero 源目录：${XAERO_DIR}${fs.existsSync(XAERO_DIR) ? '' : '  ⚠ 不存在（瓦片生成不可用）'}`);
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


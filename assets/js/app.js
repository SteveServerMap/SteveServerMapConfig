/**
 * app.js —— 配置工具装配层（Lead 拥有）
 *
 * 职责：载入站点配置/草稿 → 创建画布与编辑面板 → 处理编辑（含撤销重做）→
 *      实时校验 → 自动保存草稿 → 保存到站点仓库 / 用真实站点预览。
 *
 * 数据流永远是单向的：
 *   面板 onChange(patch) → app 修改 draft → 校验 → 刷新画布/面板 → 自动保存
 * 画布只负责「渲染 + 交互」，不持有业务状态。
 */

import * as model from './model.js';
import { EditorCanvas } from './canvas.js';
import { EditorPanel } from './editor.js';

// 让 index.html 的兜底提示能区分「模块压根没跑起来」和「模块在跑、只是慢」：
// 只要这一行执行了，说明 ES Module 加载成功，不需要再提示 file:// 那一套。
window.__toolBooting = true;

/* ============================== DOM 小工具 ============================== */

const $ = (id) => document.getElementById(id);

/* ============================== 运行时状态 ============================== */

const state = {
  /** 站点信息（来自 /api/state） */
  siteDir: '',
  toolDir: '',
  xaeroDir: '',
  images: [],
  /** xaero/ 下的一级子目录扫描结果（每个子目录 = 一个维度） */
  xaeroSources: [],
  siteExists: false,
  configExists: false,
  lastSaved: null,

  /** 草稿（站点 config.json 的超集） */
  draft: null,

  /** 选中：{ dimensionId, waypointId, groupId } */
  selection: { dimensionId: null, waypointId: null, groupId: null },

  validation: { errors: [], warnings: [] },
  dirty: false,
  saving: false,
  reloading: false,
  loadToken: 0,
  loadingDimension: false,
  draftPending: false,
  draftRevision: 0,
  draftWrite: Promise.resolve(),

  /** 撤销栈 */
  history: { past: [], future: [], limit: 50 },

  /** 暗图提亮：enhancePref = null 表示按图片亮度自动判断 */
  enhancePref: null,
  enhanceOn: false,

  /** 拖动移动开关（默认关闭，从 localStorage 恢复） */
  dragMove: false,
  /** 放置模式：placeFor = 正在等待点击落位的路径点 id */
  placeFor: null,
  /** 在图上新建：true 时下一次点地图会新建路径点 */
  createArmed: false,

  /** 站点 config.json 里原有的 $schema 提示，保存时原样带回 */
  schemaRef: null,

  /** 站点投影模块（来自 /preview/assets/js/coords.js） */
  coords: null,

  /** 站点瓦片模块（来自 /preview/assets/js/tiles.js）：manifest 解析 + 分层贴图 */
  tileModule: null,

  /** 预览 token */
  previewToken: null,

  search: '',
  autosaveTimer: 0,
  toastTimer: 0,
};

let canvas = null;
let panel = null;

/**
 * 当前维度：优先按 id 找；id 被改名/清空（编辑中）时按上次的索引兜底，
 * 避免「维度 id 一改，编辑器就找不到维度、什么都不能做」。
 */
function currentDimension() {
  if (!state.draft) return null;
  const dims = state.draft.dimensions || [];
  const byId = model.dimensionById(state.draft, state.selection.dimensionId);
  if (byId) {
    state.dimensionIndex = dims.indexOf(byId);
    return byId;
  }
  const byIndex = dims[state.dimensionIndex ?? 0] || dims[0] || null;
  if (byIndex) state.selection.dimensionId = byIndex.id;
  return byIndex;
}

/* ============================== 启动 ============================== */

bootstrap().catch((err) => {
  console.error('[tool] 启动失败：', err);
  setStatus(`启动失败：${err.message}`, 'error');
  toast(`启动失败：${err.message}`, 'error');
  // 画布区给出可操作提示，避免「一片空白不知道哪里错了」
  showCanvasEmpty(
    `应用没有启动成功：${err.message} —— 请确认页面是用 node server.mjs 启动后通过 http://127.0.0.1:5273/ 打开的（不要双击 index.html）`,
  );
});

async function bootstrap() {
  setStatus('加载中…', 'info');

  // 1) 站点投影模块（唯一的坐标数学来源）+ 瓦片模块（manifest → Tileset / TileLayer）
  await loadSiteCoords();
  await loadSiteTiles();

  // 2) 站点状态 + 草稿
  const info = await api('/api/state');
  Object.assign(state, {
    siteDir: info.siteDir,
    toolDir: info.toolDir,
    xaeroDir: info.xaeroDir || '',
    images: info.images || [],
    xaeroSources: Array.isArray(info.xaero) ? info.xaero : [],
    siteExists: info.siteExists,
    configExists: info.configExists,
    lastSaved: info.lastSaved,
  });
  $('footer-site').textContent = `站点目录：${state.siteDir}${state.siteExists ? '' : '（不存在！）'}`;

  // 草稿可能比站点 config.json 还旧（例如站点后来切到了瓦片底图）。
  // 这种情况下优先站点配置，否则工具会一直拿旧草稿里的 image: 主世界.png 当底图。
  let siteConfig = null;
  if (info.configExists) {
    try {
      const res = await api('/api/site-config');
      state.schemaRef = typeof res.config.$schema === 'string' ? res.config.$schema : null;
      siteConfig = res.config;
    } catch (err) {
      if (!Array.isArray(info.draft?.dimensions)) throw err;
      console.warn('[tool] 读取站点 config.json 失败，改用草稿：', err);
    }
  }
  const draftTime = info.draftMtime ? Date.parse(info.draftMtime) : NaN;
  const configTime = info.lastSaved ? Date.parse(info.lastSaved) : NaN;
  // 同一秒内保存时 mtime 可能相等或差几毫秒，留 1 秒容差，避免误判「草稿过期」
  const draftOlderThanSite =
    Number.isFinite(draftTime) && Number.isFinite(configTime) && draftTime < configTime - 1000;

  let restored = false;
  let staleDraftIgnored = false;
  if (info.draft && info.draft.dimensions && (!draftOlderThanSite || !siteConfig)) {
    const { draft, warnings } = model.normalizeDraft(info.draft);
    state.draft = draft;
    restored = true;
    state.dirty = !siteConfig || JSON.stringify(model.toConfigJson(draft)) !== JSON.stringify(model.toConfigJson(siteConfig));
    if (warnings.length) console.warn('[tool] 草稿规范化提示：', warnings);
  } else if (siteConfig) {
    const { draft, warnings } = model.normalizeDraft(siteConfig);
    state.draft = draft;
    staleDraftIgnored = Boolean(info.draft && draftOlderThanSite);
    if (warnings.length) console.warn('[tool] 站点配置规范化提示：', warnings);
  }
  if (!state.draft) {
    state.draft = model.createEmptyDraft();
    setStatus('已新建空白配置（站点没有 config.json）', 'warn');
  }

  // 3) 界面
  initPanel();
  initCanvas();
  state.enhancePref = readEnhancePref();
  setDragMove(readDragMovePref(), { silent: true });
  panel?.setImages?.(state.images);
  panel?.setXaeroSources?.(state.xaeroSources);

  const firstDim =
    model.dimensionById(state.draft, state.draft.defaultDimension) || state.draft.dimensions[0];
  state.selection = { dimensionId: firstDim ? firstDim.id : null, waypointId: null, groupId: null };

  await activateDimension(state.selection.dimensionId);
  refreshEditor();
  runValidation();
  updateMeta();
  bindKeyboard();

  if (staleDraftIgnored) {
    setStatus('草稿早于站点 config.json，已载入站点配置（旧草稿仍保留在 .data/draft.json）', 'ok');
    toast('草稿早于站点配置，已载入站点 config.json', 'info', 3600);
  } else {
    setStatus(
      restored
        ? '已恢复上次编辑的草稿（点「读取站点配置」可丢弃）'
        : state.configExists
          ? '已载入站点 config.json'
          : '空白配置',
      restored ? 'warn' : 'ok',
    );
    if (restored) toast('已恢复上次编辑的草稿', 'info', 2600);
  }

  window.__tool = api2tool();
}

/** 动态载入站点的 coords.js（服务端把站点仓库挂在 /preview/） */
async function loadSiteCoords() {
  try {
    state.coords = await import('/preview/assets/js/coords.js');
  } catch (err) {
    console.error('[tool] 载入站点 coords.js 失败：', err);
    state.coords = null;
    toast('无法载入站点坐标模块（/preview/assets/js/coords.js），请检查 --site 参数', 'error', 8000);
  }
}

/**
 * 动态载入站点的 tiles.js（瓦片底图：manifest 解析 / 层级选择 / canvas 贴图）。
 * 站点仓库较老、没有这个模块时不要整页崩溃：瓦片维度会回退到单张 image。
 */
async function loadSiteTiles() {
  try {
    state.tileModule = await import('/preview/assets/js/tiles.js');
    if (typeof state.tileModule.loadTileset !== 'function') {
      state.tileModule = null;
      console.warn('[tool] 站点 tiles.js 没有导出 loadTileset，瓦片底图不可用');
    }
  } catch (err) {
    state.tileModule = null;
    console.warn('[tool] 载入站点 tiles.js 失败，瓦片维度将回退为单张图片：', err);
  }
}

/* ============================== 面板 / 画布 ============================== */

function initPanel() {
  panel = new EditorPanel($('app'), {
    onAction: (name, actionEl) => handleAction(name, actionEl),
    onChange: handlePatch,
    onSelect: handleSelect,
    onImportImage: (file) => importImage(file),
  });
  panel.setDraft?.(state.draft);
}

function initCanvas() {
  canvas = new EditorCanvas($('canvas-root'), {
    onViewChange: (vs) => {
      const el = $('zoom-level');
      if (el && vs) el.textContent = `${Math.round((vs.scale || 0) * 100)}%`;
    },
    onMarkerClick: (id) => {
      handleSelect({
        dimensionId: state.selection.dimensionId,
        waypointId: id,
        groupId: null,
      });
    },
    onMarkerDragEnd: ({ id, world }) => {
      const dim = currentDimension();
      const wp = dim && model.waypointById(dim, id);
      if (!wp || !world) return;
      pushHistory();
      wp.x = Math.round(world.x);
      wp.z = Math.round(world.z);
      commit({ structural: false });
      toast(`已移动到 X ${wp.x} · Z ${wp.z}`, 'ok', 1500);
    },
    onEmptyClick: ({ world }) => {
      if (state.createArmed) {
        const created = createWaypointAt(world, { prefix: '新路径点' });
        disarmCreate();
        if (created) {
          toast(`已新建「${created.name}」（X ${created.x} · Z ${created.z}）`, 'ok', 3000);
          setStatus('已在地图上新建路径点，右侧可改名称/图标/分组', 'ok');
        }
        return;
      }
      if (state.placeFor) {
        placeAt(world);
        return;
      }
      handleSelect({ dimensionId: state.selection.dimensionId, waypointId: null, groupId: null });
    },
    onHover: (world) => {
      const el = $('coord-readout');
      if (!el) return;
      if (!world || !Number.isFinite(world.x)) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.textContent = `X ${Math.round(world.x)}  Z ${Math.round(world.z)}`;
    },
  });
  canvas.setGrid(state.draft.ui?.grid === true);
  canvas.setLabelMode(state.draft.ui?.labelMode || 'hover');
}

/* ============================== 维度 / 投影 ============================== */

function projectionFor(dim) {
  const coords = state.coords;
  const meta = (dim && dim.imageMeta) || {};
  if (state.loadingDimension || !coords || !dim || !(meta.width > 0) || !(meta.height > 0)) return null;

  // 瓦片底图：世界范围来自 manifest 的 worldBlockRange（1 像素 = 1 方块），
  // 和站点一致 —— 此时 calibration 只是单图兜底用的，不参与换算。
  const tile = dim.tileMeta;
  if (tile && !tile.error && tile.bounds && Number.isFinite(tile.imageWidth) && Number.isFinite(tile.imageHeight)) {
    const b = tile.bounds;
    try {
      const proj = coords.createProjection({
        xMin: Number(b.xMin),
        xMax: Number(b.xMax),
        zMin: Number(b.zMin),
        zMax: Number(b.zMax),
        imageWidth: tile.imageWidth,
        imageHeight: tile.imageHeight,
        flipZ: false,
      });
      return proj && proj.isValid !== false ? proj : null;
    } catch (err) {
      console.warn('[tool] 瓦片投影创建失败：', err);
      return null;
    }
  }

  const cal = coords.normalizeCalibration(dim.calibration, { imageWidth: meta.width, imageHeight: meta.height });
  if (!cal) return null;
  try {
    const proj = coords.createProjection({
      ...cal,
      imageWidth: meta.width,
      imageHeight: meta.height,
    });
    return proj && proj.isValid !== false ? proj : null;
  } catch (err) {
    console.warn('[tool] 创建投影失败：', err);
    return null;
  }
}

/** 维度是否配置了瓦片底图（dim.tiles 由 model 规范化成 { manifest } 或 null） */
function hasTiles(dim) {
  return Boolean(dim && dim.tiles && String(dim.tiles.manifest || '').trim());
}

/** 站点相对路径 → 工具可访问的 /preview/ 地址（也接受已是 /preview/* 或 http(s) 的绝对地址） */
function previewStaticUrl(target) {
  const raw = String(target || '').trim();
  if (!raw) return '';
  if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith('/')) return raw;
  return `/preview/${encodeURI(raw)}`;
}

async function activateDimension(dimensionId) {
  const token = ++state.loadToken;
  disarmCreate();
  disarmPlacement();
  state.loadingDimension = true;
  state.projection = null;
  state.imageSize = null;
  state.calibration = null;
  canvas?.setImage({ src: '', width: 0, height: 0 });
  canvas?.setProjection(null);
  canvas?.setData({ waypoints: [], groups: [], projection: null });
  const dim =
    model.dimensionById(state.draft, dimensionId) ||
    state.draft.dimensions.find((d) => d.id === dimensionId) ||
    state.draft.dimensions[state.dimensionIndex ?? 0] ||
    state.draft.dimensions[0];
  if (!dim) {
    state.loadingDimension = false;
    updatePickPositionButton();
    showCanvasEmpty('还没有维度，请先新建一个维度');
    return;
  }
  state.dimensionIndex = state.draft.dimensions.indexOf(dim);
  state.selection.dimensionId = dim.id;
  state.selection.waypointId = null;
  state.selection.groupId = null;
  updatePickPositionButton();

  let size = null;
  let usedTiles = false;
  if (hasTiles(dim)) {
    size = await loadTilesFor(dim, token);
    if (token !== state.loadToken) return;
    usedTiles = Boolean(size);
    if (!usedTiles) size = await loadImageFor(dim, token);
  } else {
    dim.tileMeta = null;
    size = await loadImageFor(dim, token);
  }
  if (token !== state.loadToken) return;
  state.loadingDimension = false;

  if (!size) {
    showCanvasEmpty(
      hasTiles(dim)
        ? `瓦片清单加载失败：${dim.tiles?.manifest || '（未填写）'}；${dim.image ? `已尝试回退单图「${dim.image}」` : '且该维度没有兜底图'}`
        : dim.image
          ? `找不到基底图「${dim.image}」——把图片放到站点目录，或用右侧「导入本地图片」`
          : '该维度还没有选择基底图',
    );
  } else {
    hideCanvasEmpty();
  }
  syncAppProjection();
  refreshCanvas();
  refreshEditor();
  runValidation();
  updateMeta();
  updateCanvasInfo(size ? dim : null);
  // 不同维度的图幅可能差很多：切维度后整图适配，避免沿用上一个维度的缩放导致只看到一角
  if (size) canvas?.fitToContent?.({ animate: false });
  return { size, usedTiles };
}

async function loadImageFor(dim, token) {
  if (token !== state.loadToken) return null;
  if (!dim.image) {
    canvas.setImage({ src: '', width: 0, height: 0 });
    dim.imageMeta = { width: 0, height: 0, missing: true };
    return null;
  }
  const src = `/preview/${encodeURIComponent(dim.image)}`;
  const size = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
  if (token !== state.loadToken) return null;
  if (!size || !size.width) {
    dim.imageMeta = { width: 0, height: 0, missing: true };
    canvas.setImage({ src: '', width: 0, height: 0 });
    updateCanvasInfo(null);
    return null;
  }
  dim.imageMeta = { width: size.width, height: size.height, missing: false };
  ensureCalibration(dim, size);
  canvas.setImage({ src, width: size.width, height: size.height });
  updateCanvasInfo(dim);
  autoEnhanceFor(src, token);
  return size;
}

/**
 * 加载瓦片底图：
 *   1. 用站点 tiles.js 的 loadTileset() 拉取并校验 manifest；
 *   2. 世界范围 / 底图尺寸直接来自 manifest（1 像素 = 1 方块）；
 *   3. 把 Tileset 交给 EditorCanvas 渲染（canvas.setTileset）。
 * 失败时返回 null，由调用方回退到单张 image（与站点行为一致）。
 */
async function loadTilesFor(dim, token) {
  if (token !== state.loadToken) return null;
  const manifest = dim && dim.tiles ? String(dim.tiles.manifest || '').trim() : '';
  if (!manifest) {
    dim.tileMeta = { manifest: '', error: '没有填写瓦片清单路径' };
    return null;
  }
  const url = previewStaticUrl(manifest);
  if (!state.tileModule || typeof state.tileModule.loadTileset !== 'function') {
    dim.tileMeta = { manifest, url, error: '站点没有可用的 tiles.js（/preview/assets/js/tiles.js），已回退单图' };
    toast('站点缺少瓦片模块：该维度将回退为单张图片显示', 'warn', 5000);
    return null;
  }
  try {
    const tileset = await state.tileModule.loadTileset(url);
    if (token !== state.loadToken) return null;
    dim.tileMeta = {
      manifest,
      url,
      imageWidth: tileset.imageWidth,
      imageHeight: tileset.imageHeight,
      bounds: { ...tileset.bounds },
      levels: tileset.levels.map((entry) => ({
        level: entry.level,
        blocksPerPixel: entry.blocksPerPixel,
        minX: entry.minX,
        maxX: entry.maxX,
        minZ: entry.minZ,
        maxZ: entry.maxZ,
      })),
      source: tileset.source || '',
      error: null,
    };
    dim.imageMeta = { width: tileset.imageWidth, height: tileset.imageHeight, missing: false };
    ensureCalibrationFromTiles(dim, tileset);
    if (typeof canvas?.setTileset === 'function') canvas.setTileset(tileset);
    else console.warn('[tool] EditorCanvas 还没有 setTileset，瓦片底图无法显示');
    updateCanvasInfo(dim);
    // 瓦片底图不做「暗图自动提亮」的亮度分析（瓦片是异步拼的），
    // 但必须给 body[data-enhance] 一个明确值：有偏好就沿用，没有就关掉。
    applyEnhance(readEnhancePref() === true);
    return { width: tileset.imageWidth, height: tileset.imageHeight };
  } catch (err) {
    if (token !== state.loadToken) return null;
    const message = err && err.message ? err.message : String(err);
    console.warn(`[tool] 瓦片底图加载失败：${url}`, err);
    dim.tileMeta = { manifest, url, error: message };
    toast(`瓦片清单加载失败，已回退单图：${message}`, 'warn', 6000);
    return null;
  }
}

/**
 * 瓦片维度没有有效画幅时，用 manifest 的世界范围补一份 calibration。
 * （只影响单图兜底；标记定位本身走 manifest 投影。）
 */
function ensureCalibrationFromTiles(dim, tileset) {
  const cal = dim.calibration || {};
  const valid = state.coords?.normalizeCalibration(cal, { imageWidth: tileset.imageWidth, imageHeight: tileset.imageHeight });
  if (valid) return;
  const { xMin, xMax, zMin, zMax } = tileset.bounds;
  dim.calibration = {
    calibrated: true,
    xMin,
    xMax,
    zMin,
    zMax,
    flipZ: false,
    note: `瓦片底图：世界范围来自 ${tileset.manifestUrl || 'manifest.json'}（1 像素 = 1 方块）`,
  };
}

/** 新维度/坏画幅时给一组合理默认值（1 像素 = 1 方块、图片中心 = 世界原点），保证标记可见 */
function ensureCalibration(dim, size) {
  const cal = dim.calibration || {};
  const valid = state.coords?.normalizeCalibration(cal, { imageWidth: size.width, imageHeight: size.height });
  if (valid) return;
  dim.calibration = {
    calibrated: false,
    xMin: -Math.round(size.width / 2),
    xMax: Math.round(size.width / 2),
    zMin: -Math.round(size.height / 2),
    zMax: Math.round(size.height / 2),
    flipZ: cal.flipZ === true,
    note: '按「1 像素 = 1 方块、图片中心 = 世界 (0,0)」自动推定；瓦片底图可忽略本字段',
  };
}

/**
 * 同步 app 侧的投影状态。
 * 画布内部也会算投影，但「坐标读数 / 列表定位 / 在图上取点」这些功能读的是 state.projection，
 * 之前切换维度后没有重新赋值（一直是 null），导致它们静默失效。
 */
function syncAppProjection() {
  const dim = currentDimension();
  if (state.loadingDimension || !dim) {
    state.imageSize = null;
    state.calibration = null;
    state.projection = null;
    updatePickPositionButton();
    return null;
  }
  const meta = (dim && dim.imageMeta) || {};
  state.imageSize = meta.width > 0 && meta.height > 0 ? { width: meta.width, height: meta.height } : null;
  // 瓦片维度：世界范围以 manifest 为准，state.calibration 同步成 manifest 的范围（供网格/读数使用）
  const tile = dim && dim.tileMeta && !dim.tileMeta.error ? dim.tileMeta : null;
  if (tile && tile.bounds) {
    state.calibration = {
      xMin: Number(tile.bounds.xMin),
      xMax: Number(tile.bounds.xMax),
      zMin: Number(tile.bounds.zMin),
      zMax: Number(tile.bounds.zMax),
      flipZ: false,
      calibrated: true,
      note: '瓦片底图：世界范围来自 manifest',
    };
  } else {
    state.calibration = state.coords?.normalizeCalibration(dim.calibration, {
      imageWidth: meta.width,
      imageHeight: meta.height,
    }) || null;
  }
  state.projection = projectionFor(dim);
  updatePickPositionButton();
  return state.projection;
}

function refreshCanvas() {
  if (!canvas || !state.draft) return;
  const dim = currentDimension();
  if (!dim) return;
  const proj = syncAppProjection();
  canvas.setProjection(proj);
  canvas.setData({ waypoints: dim.waypoints, groups: dim.groups, projection: proj });
  canvas.setSelection(state.selection.waypointId);
  canvas.setGroupVisibilityAll
    ? canvas.setGroupVisibilityAll(dim.groups)
    : dim.groups.forEach((g) => canvas.setGroupVisible(g.id, g.visible !== false));
  canvas.setGrid(state.draft.ui?.grid === true);
  canvas.setLabelMode(state.draft.ui?.labelMode || 'hover');
  canvas.setFilter(state.search ? (wp) => model.waypointMatchesQuery(wp, state.search) : null);
}

/* ------------------------------ 暗图提亮 / 画布信息 ------------------------------ */

/** 很多离线渲染的地图大部分是未探索的纯黑，在深色界面上看起来像“没有地图”。
 *  这里按需给基底图加一个 brightness filter（纯黑仍是黑，不会失真），并记住用户选择。 */
const ENHANCE_FILTER = 'brightness(2.8) saturate(1.15) contrast(1.02)';
const ENHANCE_KEY = 'ssm.enhance.v1';
/** 「拖动移动」开关：默认关闭，避免不小心把路径点拖走 */
const DRAG_MOVE_KEY = 'ssm.dragMove.v1';

function readDragMovePref() {
  try {
    return localStorage.getItem(DRAG_MOVE_KEY) === '1';
  } catch {
    return false;
  }
}

function readEnhancePref() {
  try {
    const value = localStorage.getItem(ENHANCE_KEY);
    if (value === '1') return true;
    if (value === '0') return false;
    return null; // 未选择过 → 按图片亮度自动判断
  } catch {
    return null;
  }
}

function applyEnhance(on) {
  // 底图可能是单图 <img>，也可能是瓦片 <canvas>：两套都套同一个 filter
  for (const el of document.querySelectorAll('#canvas-image, #canvas-tiles')) {
    el.style.filter = on ? ENHANCE_FILTER : 'none';
  }
  document.body.dataset.enhance = on ? '1' : '0';
  state.enhanceOn = on;
  const btn = $('btn-enhance');
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-active', on);
    btn.title = on ? '已提亮：点击关闭（纯黑的是未探索区域）' : '提亮基底图（很多离线地图渲染很暗）';
  }
}

/** 缩略图统计：平均亮度 + “有内容像素”占比，用来判断这张图是不是暗图 */
function analyzeImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 64;
        const cv = document.createElement('canvas');
        cv.width = size;
        cv.height = size;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let sum = 0;
        let lit = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          sum += lum;
          if (lum > 26) lit += 1;
          n += 1;
        }
        resolve({ mean: sum / n, litRatio: lit / n });
      } catch (err) {
        console.warn('[tool] 图片亮度分析失败：', err);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function autoEnhanceFor(src, token) {
  const pref = state.enhancePref;
  if (pref !== null && pref !== undefined) {
    applyEnhance(pref === true);
    return;
  }
  analyzeImage(src).then((stats) => {
    if (!stats || token !== state.loadToken || state.enhancePref !== null) return;
    const dark = stats.litRatio < 0.45 || stats.mean < 42;
    applyEnhance(dark);
    if (dark) {
      toast(
        `这张基底图很暗（约 ${Math.round((1 - stats.litRatio) * 100)}% 是未探索的纯黑区域），已自动提亮显示；可用顶栏「提亮」关闭`,
        'info',
        7000,
      );
    }
  });
}

function toggleDragMove() {
  return setDragMove(!(state.dragMove === true));
}

/**
 * 「拖动移动」开关：
 *   · 默认关闭 —— 按住路径点拖动不会改坐标（避免误拖），想定位请用「在图上取点」；
 *   · 开启后可以按住标记直接拖；按住 Alt 键可随时临时拖动，不用先开开关。
 */
function setDragMove(enabled, { silent = false } = {}) {
  state.dragMove = enabled === true;
  canvas?.setDragMoveEnabled?.(state.dragMove);
  const btn = $('btn-drag-move');
  if (btn) {
    btn.setAttribute('aria-pressed', state.dragMove ? 'true' : 'false');
    btn.classList.toggle('is-active', state.dragMove);
  }
  try {
    localStorage.setItem(DRAG_MOVE_KEY, state.dragMove ? '1' : '0');
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
  if (state.dragMove) {
    if (!silent) toast('拖动移动已开启：按住画布上的路径点即可拖动改坐标（再点一次关闭）', 'ok', 3600);
    setStatus('拖动移动已开启（按住 Alt 也能临时拖）', 'ok');
  } else if (!silent) {
    toast('拖动移动已关闭：拖动不会移动路径点，定位请用「在图上取点」', 'info', 3600);
    setStatus('拖动移动已关闭');
  }
  return state.dragMove;
}

function toggleEnhance() {
  const next = !state.enhanceOn;
  state.enhancePref = next;
  try {
    localStorage.setItem(ENHANCE_KEY, next ? '1' : '0');
  } catch {
    /* ignore */
  }
  applyEnhance(next);
  toast(next ? '已提亮基底图（纯黑的是未探索区域）' : '已关闭提亮，显示原始亮度', 'info', 2600);
}

let confirmResolver = null;

/**
 * 应用内确认弹窗（替代 window.confirm）：
 *   const ok = await showConfirm({ title, message, okText, danger });
 * Esc / 取消 = false，确定 = true。
 */
function showConfirm({ title = '确认操作', message = '', okText = '确定', cancelText = '取消', danger = false } = {}) {
  const dialog = $('confirm-dialog');
  if (!dialog) return Promise.resolve(window.confirm(message || title)); // 兜底：结构缺失时退回原生
  const titleEl = $('confirm-title-text');
  const msgEl = $('confirm-message');
  const okBtn = $('confirm-ok');
  const cancelBtn = $('confirm-cancel');
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (okBtn) {
    okBtn.textContent = okText;
    okBtn.classList.toggle('danger', danger === true);
  }
  if (cancelBtn) cancelBtn.textContent = cancelText;
  dialog.hidden = false;
  dialog.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => (danger ? cancelBtn : okBtn)?.focus());
  return new Promise((resolve) => {
    confirmResolver = (value) => {
      confirmResolver = null;
      dialog.hidden = true;
      dialog.setAttribute('aria-hidden', 'true');
      resolve(value);
    };
  });
}

function settleConfirm(value) {
  if (confirmResolver) confirmResolver(value === true);
}

/** 焦点是否在输入框 / 可编辑区域（键盘快捷键要放行给浏览器） */
function isTypingTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!target.closest('input, textarea, select, [contenteditable="true"]');
}

/** 画布左上角信息条：明确告诉用户当前显示的是哪张图 / 哪套瓦片、多大 */
function updateCanvasInfo(dim) {
  const el = $('canvas-info');
  if (!el) return;
  const meta = (dim && dim.imageMeta) || {};
  if (!dim || !meta.width) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const tile = dim.tileMeta && !dim.tileMeta.error ? dim.tileMeta : null;
  if (tile) {
    const levels = Array.isArray(tile.levels) ? tile.levels.length : 0;
    el.textContent = `${dim.name} · 瓦片 ${tile.manifest} · ${meta.width}×${meta.height}px · ${levels} 层`;
  } else if (dim.tileMeta && dim.tileMeta.error) {
    el.textContent = `${dim.name} · 瓦片加载失败，已回退单图 ${dim.image || '（无）'}`;
  } else {
    el.textContent = `${dim.name} · ${dim.image} · ${meta.width}×${meta.height}px`;
  }
}

function refreshEditor() {
  updatePickPositionButton();
  if (!panel) return;
  panel.setDraft?.(state.draft);
  panel.setSelection?.(state.selection);
  panel.setValidation?.(state.validation);
  panel.refresh?.();
}

/* ============================== 编辑 ============================== */

const NUMBER_FIELDS = new Set(['x', 'y', 'z', 'xMin', 'xMax', 'zMin', 'zMax']);

function coerce(field, value) {
  const key = String(field).split('.').pop();
  if (!NUMBER_FIELDS.has(key)) return value;
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? (key === 'y' || !Number.isInteger(n) ? n : Math.round(n)) : null;
}

function handlePatch(patch) {
  if (!patch || !patch.kind) return;
  const dim = currentDimension();
  pushHistory(`${patch.kind}:${patch.id || ''}:${patch.field}`);

  switch (patch.kind) {
    case 'site':
      state.draft.site = state.draft.site || {};
      state.draft.site[patch.field] = patch.value;
      break;
    case 'ui':
      state.draft.ui = state.draft.ui || {};
      state.draft.ui[patch.field] = patch.value;
      if (patch.field === 'labelMode' && canvas) canvas.setLabelMode(patch.value);
      if (patch.field === 'grid' && canvas) canvas.setGrid(patch.value === true);
      break;
    case 'dimension': {
      if (!dim) return;
      if (patch.field === 'tiles.mode' || patch.field === 'tiles.manifest') {
        handleTilesPatch(dim, patch);
        return;
      }
      if (patch.field === 'defaultDimension') {
        state.draft.defaultDimension = patch.value;
      } else {
        if (patch.field === 'id' && state.draft.defaultDimension === dim.id) {
          state.draft.defaultDimension = patch.value;
        }
        dim[patch.field] = patch.value;
      }
      break;
    }
    case 'group': {
      if (!dim) return;
      const group = dim.groups.find((g) => g.id === patch.id);
      if (group) group[patch.field] = patch.value;
      break;
    }
    case 'waypoint': {
      if (!dim) return;
      const wp = dim.waypoints.find((w) => w.id === patch.id);
      if (wp) {
        wp[patch.field] = coerce(patch.field, patch.value);
        if (patch.field === 'group' && wp.group === '') wp.group = 'default';
      }
      break;
    }
    default:
      console.debug('[tool] 未知 patch kind：', patch.kind);
      return;
  }
  commit({ structural: false });
  if (patch.kind === 'dimension' && patch.field === 'image') activateDimension(dim.id);
}

/**
 * 「底图类型 / 瓦片清单」修改：直接改维度字段，然后重新加载底图。
 * 瓦片加载是异步的，activateDimension 内部自己 await，不阻塞本次点击。
 */
function handleTilesPatch(dim, patch) {
  if (!dim) return;
  const wasTiles = hasTiles(dim);
  if (patch.field === 'tiles.mode') {
    if (patch.value === 'tiles') {
      dim.tiles = wasTiles ? dim.tiles : { manifest: 'tiles/manifest.json' };
    } else {
      dim.tiles = null;
    }
  } else {
    const manifest = String(patch.value == null ? '' : patch.value).trim();
    dim.tiles = manifest ? { manifest } : null;
  }
  const nowTiles = hasTiles(dim);
  if (!nowTiles) dim.tileMeta = null;
  commit({ structural: true });
  activateDimension(dim.id);
  if (wasTiles !== nowTiles) {
    toast(
      nowTiles ? '已切换到瓦片底图，正在读取 manifest…' : '已切换到单图底图（PNG）',
      'info',
      2600,
    );
  }
}

/** 提交一次修改：校验 → 刷新 → 标脏 → 自动保存 */
function commit({ structural = false } = {}) {
  state.dirty = true;
  runValidation();
  syncAppProjection();
  refreshCanvas();
  if (structural) refreshEditor();
  else {
    panel?.setDraft?.(state.draft);
    panel?.setValidation?.(state.validation);
    panel?.refresh?.();
  }
  updateMeta();
  scheduleAutosave();
}

function handleSelect(sel) {
  if (!sel) return;
  const prevDim = currentDimension();
  if (typeof sel.dimensionId === 'string') state.selection.dimensionId = sel.dimensionId;
  state.selection.waypointId = sel.waypointId ?? null;
  state.selection.groupId = sel.groupId ?? null;
  const nextDim = currentDimension(); // 内部会做「id 失效 → 按索引兜底」
  const dimensionChanged = !!nextDim && prevDim !== nextDim;

  if (dimensionChanged) {
    state.selection.dimensionId = nextDim.id;
    activateDimension(nextDim.id);
    return;
  }
  // 只要选中的目标变了，就取消「等待点击落位」状态，
  // 否则用户点了 A 再去点地图，会把之前预备好的那个点悄悄挪走。
  if (state.placeFor && state.placeFor !== state.selection.waypointId) disarmPlacement();
  if (state.createArmed) disarmCreate();
  canvas?.setSelection(state.selection.waypointId);
  panel?.setSelection?.(state.selection);
  updatePickPositionButton();
  if (state.selection.waypointId) canvas?.focusWaypoint?.(state.selection.waypointId);
  panel?.refresh?.();
}

/* ============================== 撤销 / 重做 ============================== */

function pushHistory(mergeKey = null) {
  if (!state.draft) return;
  const now = Date.now();
  state.history.future.length = 0;
  // 同一个字段的连续输入（<700ms）合并成一次撤销步骤，否则打一个字就要撤销一次
  if (mergeKey && state.history.lastMergeKey === mergeKey && now - state.history.lastPushAt < 700) {
    state.history.lastPushAt = now;
    return;
  }
  const snapshot = JSON.stringify(state.draft);
  const past = state.history.past;
  if (past.length && past[past.length - 1] === snapshot) {
    state.history.lastMergeKey = mergeKey;
    state.history.lastPushAt = now;
    return;
  }
  past.push(snapshot);
  if (past.length > state.history.limit) past.shift();
  state.history.future.length = 0;
  state.history.lastMergeKey = mergeKey;
  state.history.lastPushAt = now;
}

function restoreDraft(json) {
  state.history.lastMergeKey = null;
  state.history.lastPushAt = 0;
  const { draft } = model.normalizeDraft(JSON.parse(json));
  state.draft = draft;
  if (!model.dimensionById(draft, state.selection.dimensionId)) {
    state.selection.dimensionId = draft.dimensions[0] ? draft.dimensions[0].id : null;
  }
  state.selection.waypointId = null;
  state.dirty = true;
  runValidation();
  activateDimension(state.selection.dimensionId);
  updateMeta();
  scheduleAutosave();
}

function undo() {
  const { past, future } = state.history;
  if (!past.length) {
    toast('没有可撤销的操作', 'info', 1400);
    return;
  }
  future.push(JSON.stringify(state.draft));
  restoreDraft(past.pop());
  toast('已撤销', 'info', 1200);
}

function redo() {
  const { past, future } = state.history;
  if (!future.length) {
    toast('没有可重做的操作', 'info', 1400);
    return;
  }
  past.push(JSON.stringify(state.draft));
  restoreDraft(future.pop());
  toast('已重做', 'info', 1200);
}

/* ============================== 校验 ============================== */

function runValidation() {
  if (!state.draft || !model) return;
  const ctx = {
    imageNames: state.images.map((img) => img.name),
    imageSizeOf: (dim) => (dim.imageMeta && dim.imageMeta.width ? dim.imageMeta : null),
  };
  try {
    state.validation = model.validateDraft(state.draft, ctx);
  } catch (err) {
    console.error('[tool] 校验异常：', err);
    state.validation = { errors: [{ path: '', message: `校验器异常：${err.message}`, level: 'error' }], warnings: [] };
  }
  const { errors, warnings } = state.validation;
  panel?.setValidation?.(state.validation);
  const count = $('issues-count');
  if (count) {
    const total = errors.length + warnings.length;
    count.hidden = total === 0;
    count.textContent = String(total);
    count.dataset.tone = errors.length ? 'error' : 'warn';
  }
  document.body.dataset.invalid = errors.length ? '1' : '0';
}

/* ============================== 自动保存 ============================== */

function scheduleAutosave() {
  state.draftRevision += 1;
  state.draftPending = true;
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(persistDraft, 800);
}

function persistDraft() {
  const revision = ++state.draftRevision;
  state.draftPending = true;
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = 0;
  const snapshot = JSON.stringify(state.draft);
  const write = state.draftWrite.then(() => api('/api/draft', {
    method: 'PUT',
    body: { draft: JSON.parse(snapshot) },
  }));
  state.draftWrite = write.then(() => {
    state.draftPending = revision !== state.draftRevision ||
      JSON.stringify(model.toConfigJson(state.draft)) !== JSON.stringify(model.toConfigJson(JSON.parse(snapshot)));
    if (!state.draftPending) {
      const meta = $('draft-meta');
      if (meta) meta.textContent = `${state.dirty ? '未保存到站点 · ' : ''}草稿已自动保存 · ${new Date().toLocaleTimeString('zh-CN')}`;
    }
    return true;
  }, (err) => {
    console.warn('[tool] 草稿自动保存失败：', err);
    setStatus(`草稿自动保存失败：${err.message}，请暂勿关闭页面`, 'error');
    return false;
  });
  return state.draftWrite;
}

function updateMeta() {
  const meta = $('draft-meta');
  if (!meta || !state.draft) return;
  const dim = currentDimension();
  const counts = state.draft.dimensions.map((d) => `${d.name}:${d.waypoints.length}`).join(' · ');
  meta.textContent = `${state.dirty ? '未保存修改' : '与站点配置一致'}${dim ? ` · 当前 ${dim.name}` : ''} · ${counts}`;
  document.title = `${state.dirty ? '● ' : ''}地图配置工具`;
}

/* ============================== 动作 ============================== */

async function handleAction(name, actionEl) {
  switch (name) {
    case 'save':
      return saveToSite();
    case 'reload-site':
    case 'import-config':
      // index.html 里 #btn-import-config 的文案是「读取站点配置」，所以它走站点读取；
      // 本地 JSON 文件导入用 #file-config（拖拽 .json 到窗口也会触发）
      return reloadFromSite();
    case 'import-local-json':
      return $('file-config')?.click();
    case 'export-json':
      return exportJson();
    case 'preview':
      return openPreview();
    case 'undo':
      return undo();
    case 'redo':
      return redo();
    case 'new-dimension':
      return newDimension();
    case 'delete-dimension':
      return deleteDimension();
    case 'new-group':
      return newGroup();
    case 'delete-group':
      return deleteGroup();
    case 'new-waypoint':
      return newWaypoint();
    case 'delete-waypoint':
      return deleteWaypoint();
    case 'duplicate-waypoint':
      return duplicateWaypoint();
    case 'import-image':
      return $('file-image')?.click();
    case 'fit':
      return canvas?.fitToContent?.();
    case 'grid':
      return toggleGrid();
    case 'toggle-labels':
      return cycleLabels();
    case 'pick-position':
      return pickPositionForSelected();
    case 'create-on-map':
      return armCreateOnMap();
    case 'drag-move':
      return toggleDragMove();
    case 'generate-xaero-tiles':
      return generateXaeroTilesFromSource(actionEl && actionEl.dataset ? actionEl.dataset.xaeroFolder : '');
    case 'refresh-xaero':
      return refreshXaeroSources({ announce: true });
    case 'copy-command':
      return copyCommand();
    case 'open-site-folder':
      return toast(`站点目录：${state.siteDir}（在资源管理器里打开这个路径即可）`, 'info', 5000);
    default:
      console.debug('[tool] 未处理的动作：', name);
      return undefined;
  }
}

/* ------------------------------ 保存 / 读取 ------------------------------ */

async function saveToSite() {
  if (state.saving || state.reloading) return { ok: false, error: '正在保存或读取站点配置' };
  runValidation();
  const { errors } = state.validation;
  if (errors.length) {
    const message = `有 ${errors.length} 个错误，未保存：${errors[0].message}`;
    setStatus(message, 'error');
    toast(`配置有 ${errors.length} 个错误，未保存。先看左下「检查结果」。`, 'error', 4000);
    return { ok: false, error: message, errors };
  }
  if (!state.siteExists) {
    const message = `站点目录不存在：${state.siteDir}`;
    setStatus(message, 'error');
    toast(message, 'error', 5000);
    return { ok: false, error: message };
  }
  state.saving = true;
  setStatus('正在保存…', 'info');
  try {
    let config = model.toConfigJson(state.draft);
    const savedSnapshot = JSON.stringify(config);
    // 站点 config.json 首行的 $schema 只用于编辑器补全；model 会剥掉未知字段，这里补回去
    if (state.schemaRef) config = { $schema: state.schemaRef, ...config };
    const res = await saveWithGuard(config);
    state.dirty = savedSnapshot !== JSON.stringify(model.toConfigJson(state.draft));
    state.configExists = true;
    state.lastSaved = res.savedAt;
    updateMeta();
    const message = state.dirty
      ? '已保存提交时的版本；保存期间的新修改仍未写入站点'
      : `已保存到站点 config.json${res.backup ? `（原文件备份 ${res.backup}）` : ''}`;
    setStatus(message, state.dirty ? 'warn' : 'ok');
    toast(message, state.dirty ? 'warn' : 'ok', 3200);
    await persistDraft();
    return { ok: true, ...res, config };
  } catch (err) {
    if (err.cancelled) {
      setStatus('已取消保存：这次保存会大量删除路径点', 'warn');
      toast('已取消保存。想回到站点真实配置请点「读取站点配置」。', 'warn', 5000);
      return { ok: false, error: err.message, cancelled: true };
    }
    setStatus(`保存失败：${err.message}`, 'error');
    toast(`保存失败：${err.message}`, 'error', 5000);
    return { ok: false, error: err.message, payload: err.payload };
  } finally {
    state.saving = false;
  }
}

/**
 * 保存到站点。服务端有「大量删点」防呆：如果一次保存会删掉超过 20%（且 ≥3 个）路径点，
 * 会返回 409 CONFIRM_REQUIRED，这里弹确认框，用户确认后带 confirm:true 重试。
 */
async function saveWithGuard(config) {
  try {
    return await api('/api/save', { method: 'POST', body: { config } });
  } catch (err) {
    const payload = err.payload;
    if (!payload || payload.code !== 'CONFIRM_REQUIRED') throw err;
    const before = payload.before || { total: 0, byDim: {} };
    const after = payload.after || { total: 0, byDim: {} };
    const lines = Object.keys(after.byDim || {})
      .filter((id) => (before.byDim[id] || 0) !== (after.byDim[id] || 0))
      .map((id) => `  ${id}: ${before.byDim[id] || 0} → ${after.byDim[id] || 0}`);
    const ok = await showConfirm({
      title: '这次保存会大量删除路径点',
      message:
        `路径点总数 ${before.total} → ${after.total}\n\n${lines.join('\n')}\n\n` +
        '如果这不是你想要的，点「取消」，然后点「读取站点配置」重新载入。',
      okText: '仍然保存',
      danger: true,
    });
    if (!ok) {
      const cancelErr = new Error('已取消保存（检测到会大量删除路径点）');
      cancelErr.cancelled = true;
      throw cancelErr;
    }
    return api('/api/save', { method: 'POST', body: { config, confirm: true } });
  }
}

async function reloadFromSite() {
  if (state.saving || state.reloading) return toast('正在保存或读取站点配置，请稍候', 'warn');
  state.reloading = true;
  try {
    if (state.dirty) {
      const ok = await showConfirm({
        title: '读取站点配置',
        message: '当前有未保存的修改，确定要用站点 config.json 覆盖吗？',
        okText: '覆盖',
        danger: true,
      });
      if (!ok) return;
    }
    const previous = JSON.stringify(model.toConfigJson(state.draft));
    const res = await api('/api/site-config');
    if (previous !== JSON.stringify(model.toConfigJson(state.draft))) {
      return toast('读取期间出现了新修改，已取消覆盖；请重新读取', 'warn', 4000);
    }
    const { draft, warnings } = model.normalizeDraft(res.config);
    pushHistory();
    state.schemaRef = typeof res.config.$schema === 'string' ? res.config.$schema : null;
    state.draft = draft;
    state.dirty = false;
    const persisted = persistDraft();
    if (warnings.length) console.warn('[tool] 规范化提示：', warnings);
    const first = model.dimensionById(draft, draft.defaultDimension) || draft.dimensions[0];
    state.selection = { dimensionId: first ? first.id : null, waypointId: null, groupId: null };
    await activateDimension(state.selection.dimensionId);
    if (!await persisted) {
      return toast('已读取站点，但草稿更新失败；刷新前请重新读取', 'error', 5000);
    }
    setStatus(`已从站点读取 config.json${warnings.length ? `（${warnings.length} 条提示）` : ''}`, 'ok');
    toast('已读取站点配置', 'ok', 2200);
  } catch (err) {
    toast(`读取失败：${err.message}`, 'error', 4000);
  } finally {
    state.reloading = false;
  }
}

function exportJson() {
  const config = model.toConfigJson(state.draft);
  const text = JSON.stringify(config, null, 2) + '\n';
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'config.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('已导出 config.json', 'ok', 2000);
}

async function importImage(file) {
  if (!file) return;
  const { errors } = state.validation;
  const dim = currentDimension();
  if (!dim) return toast('先选一个维度', 'warn');
  void errors;

  // 文件名：沿用原名；若与该维度当前图片同名则直接覆盖
  let name = file.name || 'map.png';
  if (!/\.(png|jpe?g|webp)$/i.test(name)) {
    toast('只支持 PNG / JPEG / WEBP', 'error');
    return;
  }
  const dataUrl = await readFileAsDataUrl(file);
  setStatus(`正在导入 ${name}…`, 'info');
  try {
    const res = await api('/api/import-image', { method: 'POST', body: { fileName: name, dataUrl } });
  pushHistory();
  dim.image = res.name;
  await refreshImageList();
  const result = currentDimension() === dim ? await activateDimension(dim.id) : null;
  const size = result?.size;
  commit({ structural: true });
  setStatus(`已导入 ${res.name}（${res.width}×${res.height}${res.backup ? `，原文件备份 ${res.backup}` : ''}）`, size ? 'ok' : 'warn');
  toast(`已导入 ${res.name}`, 'ok', 4000);
  } catch (err) {
    setStatus(`导入失败：${err.message}`, 'error');
    toast(`导入失败：${err.message}`, 'error', 5000);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取本地文件失败'));
    reader.readAsDataURL(file);
  });
}

async function refreshImageList() {
  try {
    const info = await api('/api/state');
    state.images = info.images || [];
    panel?.setImages?.(state.images);
  } catch (err) {
    console.warn('[tool] 刷新图片列表失败：', err);
  }
}

/* ------------------------------ XAERO 瓦片生成 ------------------------------ */

/** 重新扫描 xaero/ 下的一级子目录（每个子目录 = 一个维度）。 */
async function refreshXaeroSources({ announce = false } = {}) {
  try {
    const res = await api('/api/xaero/sources');
    state.xaeroSources = Array.isArray(res.sources) ? res.sources : [];
    // 点击「重新扫描」后焦点还在按钮上；先失焦，表单才会重建并显示最新结果
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    panel?.setXaeroSources?.(state.xaeroSources);
    if (announce) {
      const usable = state.xaeroSources.filter((item) => item.kind !== 'empty').length;
      toast(
        usable
          ? `已扫描 xaero/：${usable} 个可用源目录（共 ${state.xaeroSources.length} 个）`
          : `已扫描 xaero/：没有可用源（把导出 PNG 放进 xaero/<维度名>/）`,
        usable ? 'ok' : 'warn',
        3600,
      );
    }
    return state.xaeroSources;
  } catch (err) {
    console.warn('[tool] 扫描 xaero 源失败：', err);
    if (announce) toast(`扫描 xaero 源失败：${err.message}`, 'error', 5000);
    return [];
  }
}

/** 从 xaero/<folder> 生成当前维度的站点瓦片，并切换到瓦片底图。 */
async function generateXaeroTilesFromSource(folder) {
  const dim = currentDimension();
  if (!dim) return toast('先选一个维度', 'warn');
  const name = String(folder || '').trim();
  const source = state.xaeroSources.find((item) => item.folder === name);
  if (!source) {
    return toast('找不到这个 xaero 源目录，先点「重新扫描 xaero」', 'warn', 4000);
  }
  if (source.kind === 'empty') {
    return toast(`xaero/${name} 还是空的：先放导出 PNG 或区域 zip`, 'warn', 4500);
  }
  const kindText = source.kind === 'png'
    ? `${source.images} 张导出 PNG`
    : `${source.regions} 个区域 zip`;
  const outRel = `tiles/${dim.id}`;
  const ok = await showConfirm({
    title: '从 XAERO 生成瓦片',
    message:
      `源：xaero/${name}（${kindText}）\n` +
      `输出：${outRel}/manifest.json\n\n` +
      `会覆盖 ${outRel}/ 里已有的瓦片，并在生成后自动把「${dim.name}」切换到瓦片底图。` +
      `确认后开始生成。`,
    okText: '开始生成',
  });
  if (!ok) return;

  setStatus(`正在从 xaero/${name} 生成瓦片…`, 'warn');
  toast('正在解码并切瓦片，可能需要几秒，请不要关闭页面…', 'info', 8000);
  try {
    const res = await api('/api/xaero/generate', {
      method: 'POST',
      body: { folder: name, dimensionId: dim.id },
    });
    pushHistory();
    dim.tiles = { manifest: res.manifest };
    dim.tileMeta = null;
    commit({ structural: true });
    await activateDimension(dim.id);
    await refreshXaeroSources();
    const stats = res.stats && typeof res.stats === 'object' ? res.stats : {};
    const seconds = Number.isFinite(res.durationMs) ? (res.durationMs / 1000).toFixed(1) : '?';
    setStatus(`已生成 ${res.manifest}（${res.levels} 层，${stats.tilesWritten ?? '?'} 张瓦片）`, 'ok');
    toast(
      `瓦片已生成：${res.manifest}（${res.levels} 层 / ${stats.tilesWritten ?? '?'} 张，${seconds}s）；` +
        `记得点「保存到站点」写入 config.json`,
      'ok',
      7000,
    );
    return res;
  } catch (err) {
    setStatus(`生成瓦片失败：${err.message}`, 'error');
    toast(`生成瓦片失败：${err.message}`, 'error', 6500);
    return null;
  }
}

/* ------------------------------ 结构操作 ------------------------------ */

/**
 * 取「当前视图中心」对应的世界坐标（而不是整张图的中心）：
 * 图上中心可能远在屏幕外，新建的点会看不见，看起来像没创建。
 */
function worldAtViewCenter() {
  const dim = currentDimension();
  const proj = projectionFor(dim);
  if (!proj || !canvas) return null;
  const vs = canvas.getViewState?.();
  if (!vs || !(vs.scale > 0)) return null;
  const imgX = (vs.viewWidth / 2 - vs.tx) / vs.scale;
  const imgY = (vs.viewHeight / 2 - vs.ty) / vs.scale;
  const world = proj.imageToWorld(imgX, imgY);
  if (!world || !Number.isFinite(world.x) || !Number.isFinite(world.z)) return null;
  return { x: Math.round(world.x), z: Math.round(world.z) };
}

/** 在指定世界坐标新建一个路径点（不进入任何待落位状态） */
function createWaypointAt(world, { prefix = '新路径点' } = {}) {
  const dim = currentDimension();
  if (!dim) return null;
  pushHistory();
  const wp = model.createWaypoint(state.draft, dim.id, { name: `${prefix} ${dim.waypoints.length + 1}` });
  const fallback = worldAtViewCenter() || { x: 0, z: 0 };
  const target = world && Number.isFinite(world.x) && Number.isFinite(world.z) ? world : fallback;
  wp.x = Math.round(target.x);
  wp.z = Math.round(target.z);
  state.selection = { dimensionId: dim.id, waypointId: wp.id, groupId: null };
  commit({ structural: true });
  canvas?.focusWaypoint?.(wp.id);
  canvas?.setSelection?.(wp.id);
  updatePickPositionButton();
  return wp;
}

function newWaypoint() {
  const dim = currentDimension();
  if (!dim) return;
  const wp = createWaypointAt(worldAtViewCenter());
  if (!wp) return;
  toast(
    `已在当前视图中心新建「${wp.name}」（X ${wp.x} · Z ${wp.z}）。想直接点哪建哪，用顶栏「在图上新建」`,
    'ok',
    5200,
  );
}

/** 显式「在图上新建」：下一次点地图 = 在点击处新建一个路径点 */
function armCreateOnMap() {
  const dim = currentDimension();
  if (!dim) return false;
  if (!projectionFor(dim)) {
    toast('该维度还没有可用的画幅/基底图，无法在图上网点', 'warn', 4000);
    return false;
  }
  state.placeFor = null;
  state.createArmed = true;
  canvas?.setMode?.('place');
  const badge = $('mode-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = '在图上新建：点击地图即在该处新建路径点 · Esc 取消';
  }
  setStatus('在图上新建：在地图上点一下，就会在那里新建一个路径点（Esc 取消）', 'warn');
  return true;
}

function disarmCreate() {
  if (!state.createArmed) return;
  state.createArmed = false;
  if (!state.placeFor) canvas?.setMode?.('select');
  const badge = $('mode-badge');
  if (badge) badge.hidden = true;
}

/** 放置模式：下一次点击画布 = 把该路径点移到点击处 */
function armPlacement(waypointId, name) {
  disarmCreate();
  state.placeFor = waypointId;
  canvas?.setMode?.('place');
  const badge = $('mode-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = `放置「${name}」：点击地图设置坐标 · Esc 取消`;
  }
  setStatus(`放置模式：在地图上点一下设置「${name}」的坐标（拖拽平移不会误触，Esc 取消）`, 'warn');
}

/** 顶栏「在图上取点」：为当前选中的路径点显式进入放置模式 */
function pickPositionForSelected() {
  const dim = currentDimension();
  const id = state.selection.waypointId;
  const wp = dim && id ? model.waypointById(dim, id) : null;
  if (!wp) {
    toast('先在左侧列表或地图上选中一个路径点，再点「在图上取点」', 'warn', 4000);
    return false;
  }
  if (!state.projection) {
    toast('该维度还没有可用的画幅/基底图，无法在图上取点', 'warn', 4000);
    return false;
  }
  armPlacement(wp.id, wp.name);
  return true;
}

/** 「在图上取点」按钮的可用状态：只有选中了路径点、且有投影时才可点 */
function updatePickPositionButton() {
  const btn = $('btn-pick-position');
  if (!btn) return;
  const dim = currentDimension();
  const hasSelection = !!(dim && state.selection.waypointId && model.waypointById(dim, state.selection.waypointId));
  const canPick = hasSelection && !!state.projection;
  btn.disabled = !canPick;
  btn.setAttribute('aria-disabled', canPick ? 'false' : 'true');
  btn.title = canPick
    ? '在图上取点：把选中的路径点移到地图上点击的位置（Esc 取消）'
    : '先在左侧或地图上选中一个路径点';
}

function disarmPlacement() {
  if (!state.placeFor) return;
  state.placeFor = null;
  canvas?.setMode?.('select');
  const badge = $('mode-badge');
  if (badge) badge.hidden = true;
  updatePickPositionButton();
}

function placeAt(world) {
  const dim = currentDimension();
  const wp = dim && model.waypointById(dim, state.placeFor);
  if (!wp || !world || !Number.isFinite(world.x)) return;
  const name = wp.name;
  pushHistory();
  wp.x = Math.round(world.x);
  wp.z = Math.round(world.z);
  disarmPlacement();
  commit({ structural: true });
  setStatus(`已把「${name}」放到 X ${wp.x} · Z ${wp.z}`, 'ok');
  toast(`已放置到 X ${wp.x} · Z ${wp.z}`, 'ok', 2200);
}

async function deleteWaypoint(id) {
  const dim = currentDimension();
  const targetId = id || state.selection.waypointId;
  if (!dim || !targetId) return toast('先选中一个路径点', 'warn');
  const wp = model.waypointById(dim, targetId);
  if (!wp) return;
  const ok = await showConfirm({
    title: '删除路径点',
    message: `确定删除路径点「${wp.name}」？（可用 Ctrl+Z 撤销）`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  pushHistory();
  dim.waypoints = dim.waypoints.filter((w) => w.id !== targetId);
  state.selection.waypointId = null;
  commit({ structural: true });
  toast('已删除', 'info', 1600);
}

function duplicateWaypoint() {
  const dim = currentDimension();
  if (!dim || !state.selection.waypointId) return toast('先选中一个路径点', 'warn');
  pushHistory();
  const copy = model.duplicateWaypoint(state.draft, dim.id, state.selection.waypointId);
  if (!copy) return toast('复制失败：找不到该路径点', 'error');
  state.selection = { dimensionId: dim.id, waypointId: copy.id, groupId: null };
  commit({ structural: true });
  canvas?.focusWaypoint?.(copy.id);
  toast(`已复制为「${copy.name}」`, 'ok', 2000);
}

function newGroup() {
  const dim = currentDimension();
  if (!dim) return;
  pushHistory();
  const group = model.createGroup(state.draft, dim.id, { name: `新分组 ${dim.groups.length + 1}` });
  state.selection = { dimensionId: dim.id, waypointId: null, groupId: group.id };
  commit({ structural: true });
  toast(`已新建分组「${group.name}」`, 'ok', 2000);
}

async function deleteGroup(id) {
  const dim = currentDimension();
  const targetId = id || state.selection.groupId;
  if (!dim || !targetId) return toast('先选中一个分组', 'warn');
  const group = dim.groups.find((g) => g.id === targetId);
  if (!group) return;
  const used = dim.waypoints.filter((w) => w.group === targetId).length;
  if (used) {
    const ok = await showConfirm({
      title: '删除分组',
      message: `分组「${group.name}」下还有 ${used} 个路径点，删除后它们会归入「未分组」。继续？`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
  }
  pushHistory();
  dim.groups = dim.groups.filter((g) => g.id !== targetId);
  const fallback = dim.groups.find((g) => g.id === 'default') || model.createGroup(state.draft, dim.id, { id: 'default', name: '未分组' });
  dim.waypoints.forEach((w) => {
    if (w.group === targetId) w.group = fallback.id;
  });
  state.selection.groupId = null;
  commit({ structural: true });
  toast('已删除分组', 'info', 1600);
}

function newDimension() {
  pushHistory();
  const dim = model.createDimension(state.draft, { name: `新维度 ${state.draft.dimensions.length + 1}` });
  state.selection = { dimensionId: dim.id, waypointId: null, groupId: null };
  commit({ structural: true });
  activateDimension(dim.id);
  toast('已新建维度：先在右侧选基底图（瓦片底图无需画幅校准）', 'ok', 4000);
}

async function deleteDimension() {
  const dim = currentDimension();
  if (!dim) return;
  if (state.draft.dimensions.length <= 1) return toast('至少要保留一个维度', 'warn');
  const ok = await showConfirm({
    title: '删除维度',
    message: `删除维度「${dim.name}」及其 ${dim.waypoints.length} 个路径点？`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  pushHistory();
  state.draft.dimensions = state.draft.dimensions.filter((d) => d.id !== dim.id);
  if (state.draft.defaultDimension === dim.id) {
    state.draft.defaultDimension = state.draft.dimensions[0].id;
  }
  state.selection = { dimensionId: state.draft.dimensions[0].id, waypointId: null, groupId: null };
  commit({ structural: true });
  activateDimension(state.selection.dimensionId);
  toast('已删除维度', 'info', 1600);
}

function toggleGrid() {
  pushHistory();
  state.draft.ui = state.draft.ui || {};
  state.draft.ui.grid = !(state.draft.ui.grid === true);
  canvas?.setGrid(state.draft.ui.grid);
  commit({ structural: true });
}

function cycleLabels() {
  const order = ['hover', 'always', 'never'];
  const now = state.draft.ui?.labelMode || 'hover';
  pushHistory();
  state.draft.ui = state.draft.ui || {};
  state.draft.ui.labelMode = order[(order.indexOf(now) + 1) % order.length];
  canvas?.setLabelMode(state.draft.ui.labelMode);
  commit({ structural: true });
  toast({ hover: '标签：悬停显示', always: '标签：始终显示', never: '标签：全部隐藏' }[state.draft.ui.labelMode], 'info', 1600);
}

/* ------------------------------ 预览 ------------------------------ */

async function openPreview() {
  runValidation();
  const config = model.toConfigJson(state.draft);
  try {
    const res = await api('/api/preview-token', { method: 'POST', body: { config } });
    state.previewToken = res.token;
    const frame = $('preview-frame');
    $('preview-dialog').hidden = false;
    const loaded = await new Promise((resolve) => {
      if (!frame) return resolve(false);
      const timer = setTimeout(() => done(false), 20000);
      const done = (ok) => {
        clearTimeout(timer);
        frame.removeEventListener('load', onLoad);
        resolve(ok);
      };
      const onLoad = () => done(true);
      frame.addEventListener('load', onLoad, { once: true });
      frame.src = `/preview/index.html?token=${res.token}`;
    });
    setStatus(
      loaded ? '预览已打开（读取当前草稿，不会写入站点）' : '预览 iframe 加载超时，请检查站点目录',
      loaded ? 'info' : 'warn',
    );
    return loaded;
  } catch (err) {
    toast(`预览失败：${err.message}`, 'error', 4000);
    setStatus(`预览失败：${err.message}`, 'error');
    return false;
  }
}

function closePreview() {
  const dialog = $('preview-dialog');
  if (dialog) dialog.hidden = true;
  const frame = $('preview-frame');
  if (frame) frame.src = 'about:blank';
}

/* ------------------------------ 其它 ------------------------------ */

function copyCommand() {
  const cmd = `git -C "${state.siteDir}" add -A && git -C "${state.siteDir}" commit -m "update config" && git -C "${state.siteDir}" push`;
  copyText(cmd).then(
    () => toast('已复制 git 提交命令，粘到终端即可发布', 'ok', 4000),
    () => toast(`复制失败，请手动执行：${cmd}`, 'warn', 8000),
  );
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('当前环境不支持剪贴板'));
}

function setStatus(text, tone = 'info') {
  const el = $('status');
  if (el) {
    el.textContent = text;
    el.dataset.tone = tone;
  }
  panel?.setStatus?.(text, tone);
}

function toast(message, tone = 'info', duration = 2600) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
  el.classList.add('is-show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.classList.remove('is-show');
    setTimeout(() => {
      el.hidden = true;
    }, 220);
  }, duration);
  panel?.setStatus?.(message, tone);
}

function showCanvasEmpty(html) {
  const el = $('canvas-empty');
  if (!el) return;
  el.hidden = false;
  el.textContent = html;
}

function hideCanvasEmpty() {
  const el = $('canvas-empty');
  if (el) el.hidden = true;
}

/* ============================== 通用事件 ============================== */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${path} 返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (!res.ok || (data && data.ok === false)) {
    const error = new Error((data && data.error) || `${method} ${path} 失败（HTTP ${res.status}）`);
    error.status = res.status;
    error.payload = data; // 让调用方拿到结构化信息（例如 CONFIRM_REQUIRED 的前后点数）
    throw error;
  }
  return data;
}

function bindKeyboard() {
  window.addEventListener('beforeunload', (event) => {
    if (!state.draftPending && !state.saving && !state.reloading) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.autosaveTimer) persistDraft();
  });
  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const typing = isTypingTarget(event.target);
    // Ctrl+S 即使在输入框里也接管（草稿本身是自动保存的，这里=保存到站点），但提示更明确
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveToSite();
      return;
    }
    // 输入框 / 可编辑区域里，撤销与重做交还给浏览器（否则文本撤销失效、输入框还会和草稿不同步）
    if (mod && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
      if (typing) return;
      event.preventDefault();
      if (event.shiftKey || event.key.toLowerCase() === 'y') redo();
      else undo();
      return;
    }
    if (event.key === 'Escape') {
      if (state.placeFor) {
        disarmPlacement();
        setStatus('已退出放置模式（路径点仍在原位）', 'info');
      }
      if (state.createArmed) {
        disarmCreate();
        setStatus('已退出「在图上新建」', 'info');
      }
      const dialog = $('preview-dialog');
      if (dialog && !dialog.hidden) closePreview();
      if (state.selection.waypointId) {
        handleSelect({ dimensionId: state.selection.dimensionId, waypointId: null, groupId: state.selection.groupId });
      }
    }
    if (event.key === 'Delete' && state.selection.waypointId && !event.target.closest('input, textarea, select')) {
      deleteWaypoint();
    }
  });

  // 确认弹窗按钮
  $('confirm-ok')?.addEventListener('click', () => settleConfirm(true));
  $('confirm-cancel')?.addEventListener('click', () => settleConfirm(false));
  $('confirm-dialog')?.addEventListener('click', (event) => {
    if (event.target === $('confirm-dialog')) settleConfirm(false);
  });

  // 文件选择器
  $('file-image')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) importImage(file);
  });
  $('file-config')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      const { draft, warnings } = model.normalizeDraft(raw);
      pushHistory();
      state.draft = draft;
      state.schemaRef = typeof raw.$schema === 'string' ? raw.$schema : null;
      state.dirty = true;
      scheduleAutosave();
      const first = model.dimensionById(draft, draft.defaultDimension) || draft.dimensions[0];
      state.selection = { dimensionId: first ? first.id : null, waypointId: null, groupId: null };
      await activateDimension(state.selection.dimensionId);
      setStatus(`已导入本地配置${warnings.length ? `（${warnings.length} 条提示）` : ''}`, 'ok');
      toast('已导入配置文件；记得保存到站点', 'ok', 3000);
    } catch (err) {
      toast(`导入失败：${err.message}`, 'error', 5000);
    }
  });

  $('preview-dialog')?.addEventListener('click', (event) => {
    if (event.target.id === 'preview-dialog') closePreview();
  });
  $('btn-preview-close')?.addEventListener('click', closePreview);
  $('btn-preview-reload')?.addEventListener('click', openPreview);
  $('btn-fit')?.addEventListener('click', () => canvas?.fitToContent?.());
  $('zoom-in')?.addEventListener('click', () => canvas?.zoomBy?.(1.35));
  $('zoom-out')?.addEventListener('click', () => canvas?.zoomBy?.(1 / 1.35));
  $('btn-enhance')?.addEventListener('click', toggleEnhance);
  $('btn-pick-position')?.addEventListener('click', () => handleAction('pick-position'));
  $('btn-create-on-map')?.addEventListener('click', () => handleAction('create-on-map'));
  $('btn-drag-move')?.addEventListener('click', () => toggleDragMove());

  $('search')?.addEventListener('input', (event) => {
    state.search = String(event.target.value || '').trim();
    canvas?.setFilter?.(state.search ? (wp) => model.waypointMatchesQuery(wp, state.search) : null);
    panel?.setSearch?.(state.search);
  });
}

/* ============================== 调试接口（供 QA / 控制台使用） ============================== */

/**
 * 调试/自动化接口。QA（tests/e2e.mjs）用它读取草稿、调用同一套保存/预览代码路径，
 * 真实交互（按钮点击、画布点击）仍然走 DOM 事件。
 */
function api2tool() {
  return {
    /* ---- QA 约定的形状 ---- */
    draft: () => state.draft,
    state: () => state,
    canvas,
    save: () => saveToSite(),
    preview: () => openPreview(),
    action: (name) => handleAction(name),
    armPlacement: (id) => {
      const dim = currentDimension();
      const wp = dim && model.waypointById(dim, id || state.selection.waypointId);
      if (!wp) return false;
      armPlacement(wp.id, wp.name);
      return true;
    },
    disarmPlacement: () => disarmPlacement(),
    pickPosition: () => pickPositionForSelected(),
    createOnMap: () => armCreateOnMap(),
    createWaypointAt: (world) => createWaypointAt(world),
    worldAtViewCenter: () => worldAtViewCenter(),

    /* ---- 额外便利 ---- */
    model,
    api,
    json: () => model.toConfigJson(state.draft),
    /** 当前瓦片渲染状态（层级 / canvas 位图 / DPR / 缓存），单图模式返回 null */
    tiles: () => (typeof canvas?.getTileStats === 'function' ? canvas.getTileStats() : null),
    /** 当前维度的瓦片元信息（manifest / worldBlockRange / 层级 / 错误） */
    tileMeta: () => {
      const dim = currentDimension();
      return dim && dim.tileMeta ? dim.tileMeta : null;
    },
    validate: () => {
      runValidation();
      return state.validation;
    },
    select: (sel) => handleSelect(sel),
    patch: (patch) => handlePatch(patch),
    activateDimension: (id) => activateDimension(id),
    newWaypoint,
    deleteWaypoint,
    duplicateWaypoint,
    newGroup,
    deleteGroup,
    newDimension,
    deleteDimension,
    undo,
    redo,
    toast,
    get panel() {
      return panel;
    },
  };
}

export { state, api, saveToSite as save };












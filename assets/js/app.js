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
  images: [],
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

  /** 撤销栈 */
  history: { past: [], future: [], limit: 50 },

  /** 校准拾取：pendingPick = 'a' | 'b' | null；picks = { a:{px,py}, b:{px,py} } */
  pendingPick: null,
  pickHandler: null,
  pickExitHook: null,
  picks: { a: null, b: null },

  /** 暗图提亮：enhancePref = null 表示按图片亮度自动判断 */
  enhancePref: null,
  enhanceOn: false,

  /** 放置模式：placeFor = 正在等待点击落位的路径点 id */
  placeFor: null,

  /** 站点 config.json 里原有的 $schema 提示，保存时原样带回 */
  schemaRef: null,

  /** 站点投影模块（来自 /preview/assets/js/coords.js） */
  coords: null,

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

  // 1) 站点投影模块（唯一的坐标数学来源）
  await loadSiteCoords();

  // 2) 站点状态 + 草稿
  const info = await api('/api/state');
  Object.assign(state, {
    siteDir: info.siteDir,
    toolDir: info.toolDir,
    images: info.images || [],
    siteExists: info.siteExists,
    configExists: info.configExists,
    lastSaved: info.lastSaved,
  });
  $('footer-site').textContent = `站点目录：${state.siteDir}${state.siteExists ? '' : '（不存在！）'}`;

  let restored = false;
  if (info.draft && info.draft.dimensions) {
    const { draft, warnings } = model.normalizeDraft(info.draft);
    state.draft = draft;
    restored = true;
    if (warnings.length) console.warn('[tool] 草稿规范化提示：', warnings);
  } else if (info.configExists) {
    const res = await api('/api/site-config');
    if (res.ok) {
      state.schemaRef = typeof res.config.$schema === 'string' ? res.config.$schema : null;
      const { draft, warnings } = model.normalizeDraft(res.config);
      state.draft = draft;
      if (warnings.length) console.warn('[tool] 站点配置规范化提示：', warnings);
    }
  }
  if (!state.draft) {
    state.draft = model.createEmptyDraft();
    setStatus('已新建空白配置（站点没有 config.json）', 'warn');
  }

  // 3) 界面
  initPanel();
  initCanvas();
  state.enhancePref = readEnhancePref();
  panel?.setImages?.(state.images);

  const firstDim =
    model.dimensionById(state.draft, state.draft.defaultDimension) || state.draft.dimensions[0];
  state.selection = { dimensionId: firstDim ? firstDim.id : null, waypointId: null, groupId: null };

  await activateDimension(state.selection.dimensionId);
  refreshEditor();
  runValidation();
  updateMeta();
  bindKeyboard();

  setStatus(
    restored
      ? '已恢复上次编辑的草稿（点「读取站点配置」可丢弃）'
      : state.configExists
        ? '已载入站点 config.json'
        : '空白配置',
    restored ? 'warn' : 'ok',
  );
  if (restored) toast('已恢复上次编辑的草稿', 'info', 2600);

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

/* ============================== 面板 / 画布 ============================== */

function initPanel() {
  panel = new EditorPanel($('app'), {
    onAction: handleAction,
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
    onPickPoint: ({ px, py, world }) => handlePickPoint({ px, py, world }),
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
      if (state.pendingPick) return;
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
  if (!coords || !dim || !(meta.width > 0) || !(meta.height > 0)) return null;
  const cal = dim.calibration || {};
  const nums = [cal.xMin, cal.xMax, cal.zMin, cal.zMax].map(Number);
  if (!nums.every(Number.isFinite) || nums[1] <= nums[0] || nums[3] <= nums[2]) return null;
  try {
    const proj = coords.createProjection({
      xMin: nums[0],
      xMax: nums[1],
      zMin: nums[2],
      zMax: nums[3],
      imageWidth: meta.width,
      imageHeight: meta.height,
      flipZ: cal.flipZ === true,
    });
    return proj && proj.isValid !== false ? proj : null;
  } catch (err) {
    console.warn('[tool] 创建投影失败：', err);
    return null;
  }
}

async function activateDimension(dimensionId) {
  const dim =
    model.dimensionById(state.draft, dimensionId) ||
    state.draft.dimensions.find((d) => d.id === dimensionId) ||
    state.draft.dimensions[state.dimensionIndex ?? 0] ||
    state.draft.dimensions[0];
  if (!dim) return;
  state.dimensionIndex = state.draft.dimensions.indexOf(dim);
  state.selection.dimensionId = dim.id;
  state.selection.waypointId = null;
  state.selection.groupId = null;
  state.picks = { a: null, b: null };
  exitPickMode();

  const size = await loadImageFor(dim);
  if (!size) {
    showCanvasEmpty(
      dim.image
        ? `找不到基底图「${dim.image}」——把图片放到站点目录，或用右侧「导入本地图片」`
        : '该维度还没有选择基底图',
    );
  } else {
    hideCanvasEmpty();
  }
  refreshCanvas();
  refreshEditor();
  runValidation();
  updateMeta();
}

async function loadImageFor(dim) {
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
  autoEnhanceFor(src);
  return size;
}

/** 新维度/坏画幅时给一组合理默认值（1 像素 = 1 方块、图片中心 = 世界原点），保证标记可见 */
function ensureCalibration(dim, size) {
  const cal = dim.calibration || {};
  const nums = [cal.xMin, cal.xMax, cal.zMin, cal.zMax].map(Number);
  const valid = nums.every(Number.isFinite) && nums[1] > nums[0] && nums[3] > nums[2];
  if (valid) return;
  dim.calibration = {
    calibrated: false,
    xMin: -Math.round(size.width / 2),
    xMax: Math.round(size.width / 2),
    zMin: -Math.round(size.height / 2),
    zMax: Math.round(size.height / 2),
    flipZ: cal.flipZ === true,
    note: '按「1 像素 = 1 方块、图片中心 = 世界 (0,0)」自动推定，请用两点校准核对',
  };
}

function refreshCanvas() {
  if (!canvas || !state.draft) return;
  const dim = currentDimension();
  if (!dim) return;
  const proj = projectionFor(dim);
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
  const img = $('canvas-image');
  if (img) img.style.filter = on ? ENHANCE_FILTER : 'none';
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

function autoEnhanceFor(src) {
  const pref = state.enhancePref;
  if (pref !== null && pref !== undefined) {
    applyEnhance(pref === true);
    return;
  }
  analyzeImage(src).then((stats) => {
    if (!stats) return;
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

/** 画布左上角信息条：明确告诉用户当前显示的是哪张图、多大 */
function updateCanvasInfo(dim) {
  const el = $('canvas-info');
  if (!el) return;
  const meta = (dim && dim.imageMeta) || {};
  if (!dim || !meta.width) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = `${dim.name} · ${dim.image} · ${meta.width}×${meta.height}px`;
}

function refreshEditor() {
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
  if (value === '' || value === null || value === undefined) return key === 'y' ? null : 0;
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
      if (String(patch.field).startsWith('calibration.')) {
        const key = String(patch.field).slice('calibration.'.length);
        dim.calibration = dim.calibration || {};
        dim.calibration[key] = key === 'flipZ' ? patch.value === true : key === 'calibrated' ? patch.value === true : coerce(key, patch.value);
      } else if (patch.field === 'defaultDimension') {
        state.draft.defaultDimension = patch.value;
      } else {
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
}

/** 提交一次修改：校验 → 刷新 → 标脏 → 自动保存 */
function commit({ structural = false } = {}) {
  state.dirty = true;
  runValidation();
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
  canvas?.setSelection(state.selection.waypointId);
  panel?.setSelection?.(state.selection);
  if (state.selection.waypointId) canvas?.focusWaypoint?.(state.selection.waypointId);
  panel?.refresh?.();
}

/* ============================== 撤销 / 重做 ============================== */

function pushHistory(mergeKey = null) {
  if (!state.draft) return;
  const now = Date.now();
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
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(async () => {
    try {
      await api('/api/draft', { method: 'PUT', body: { draft: state.draft } });
      const meta = $('draft-meta');
      if (meta) meta.textContent = `草稿已自动保存 · ${new Date().toLocaleTimeString('zh-CN')}`;
    } catch (err) {
      console.warn('[tool] 草稿自动保存失败：', err);
    }
  }, 800);
}

function updateMeta() {
  const meta = $('draft-meta');
  if (!meta || !state.draft) return;
  const dim = currentDimension();
  const counts = state.draft.dimensions.map((d) => `${d.name}:${d.waypoints.length}`).join(' · ');
  meta.textContent = `未保存修改${dim ? ` · 当前 ${dim.name}` : ''} · ${counts}`;
  document.title = `${state.dirty ? '● ' : ''}地图配置工具`;
}

/* ============================== 动作 ============================== */

async function handleAction(name) {
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
    case 'goto-calibrate':
      return openCalibrationDialog();
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
  if (state.saving) return { ok: false, error: '正在保存中' };
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
    // 站点 config.json 首行的 $schema 只用于编辑器补全；model 会剥掉未知字段，这里补回去
    if (state.schemaRef) config = { $schema: state.schemaRef, ...config };
    const res = await api('/api/save', { method: 'POST', body: { config } });
    state.dirty = false;
    state.configExists = true;
    state.lastSaved = res.savedAt;
    updateMeta();
    setStatus(`已保存到站点 config.json${res.backup ? `（原文件备份 ${res.backup}）` : ''}`, 'ok');
    toast(`已写入 config.json（${res.bytes} 字节）`, 'ok', 3200);
    const meta = $('draft-meta');
    if (meta) meta.textContent = `已保存到站点 · ${new Date().toLocaleTimeString('zh-CN')}`;
    document.title = '地图配置工具';
    return { ok: true, ...res, config };
  } catch (err) {
    setStatus(`保存失败：${err.message}`, 'error');
    toast(`保存失败：${err.message}`, 'error', 5000);
    return { ok: false, error: err.message };
  } finally {
    state.saving = false;
  }
}

async function reloadFromSite() {
  if (state.dirty && !window.confirm('当前有未保存的修改，确定要用站点 config.json 覆盖吗？')) return;
  const res = await api('/api/site-config');
  if (!res.ok) {
    toast(`读取失败：${res.error || '站点没有 config.json'}`, 'error', 4000);
    return;
  }
  const { draft, warnings } = model.normalizeDraft(res.config);
  pushHistory();
  state.schemaRef = typeof res.config.$schema === 'string' ? res.config.$schema : state.schemaRef;
  state.draft = draft;
  state.dirty = false;
  if (warnings.length) console.warn('[tool] 规范化提示：', warnings);
  const first = model.dimensionById(draft, draft.defaultDimension) || draft.dimensions[0];
  state.selection = { dimensionId: first ? first.id : null, waypointId: null, groupId: null };
  await activateDimension(state.selection.dimensionId);
  setStatus(`已从站点读取 config.json${warnings.length ? `（${warnings.length} 条提示）` : ''}`, 'ok');
  toast('已读取站点配置', 'ok', 2200);
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
    dim.calibration = dim.calibration || {};
    await refreshImageList();
    const size = await loadImageFor(dim);
    canvas?.fitToContent?.();
    commit({ structural: true });
    setStatus(`已导入 ${res.name}（${res.width}×${res.height}${res.backup ? `，原文件备份 ${res.backup}` : ''}）`, size ? 'ok' : 'warn');
    toast(`已导入 ${res.name}；记得重新校准画幅`, 'ok', 4000);
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

/* ------------------------------ 结构操作 ------------------------------ */

function newWaypoint() {
  const dim = currentDimension();
  if (!dim) return;
  pushHistory();
  const wp = model.createWaypoint(state.draft, dim.id, { name: `新路径点 ${dim.waypoints.length + 1}` });
  const proj = projectionFor(dim);
  // 先放在当前视图中心对应的世界坐标（拿不到就用图片中点），随后进入「放置模式」，点地图即可定位
  let center = { x: 0, z: 0 };
  if (proj && dim.imageMeta?.width) {
    center = proj.imageToWorld(dim.imageMeta.width / 2, dim.imageMeta.height / 2) || center;
  }
  wp.x = Math.round(center.x);
  wp.z = Math.round(center.z);
  state.selection = { dimensionId: dim.id, waypointId: wp.id, groupId: null };
  commit({ structural: true });
  canvas?.focusWaypoint?.(wp.id);
  canvas?.setSelection?.(wp.id);
  armPlacement(wp.id, wp.name);
}

/** 放置模式：下一次点击画布 = 把该路径点移到点击处 */
function armPlacement(waypointId, name) {
  state.placeFor = waypointId;
  state.pendingPick = null;
  state.pickHandler = null;
  canvas?.setMode?.('place');
  const badge = $('mode-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = `放置「${name}」：点击地图设置坐标 · Esc 取消`;
  }
  setStatus(`放置模式：在地图上点一下设置「${name}」的坐标（拖拽平移不会误触，Esc 取消）`, 'warn');
}

function disarmPlacement() {
  if (!state.placeFor) return;
  state.placeFor = null;
  canvas?.setMode?.('select');
  const badge = $('mode-badge');
  if (badge) badge.hidden = true;
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

function deleteWaypoint(id) {
  const dim = currentDimension();
  const targetId = id || state.selection.waypointId;
  if (!dim || !targetId) return toast('先选中一个路径点', 'warn');
  const wp = model.waypointById(dim, targetId);
  if (!wp) return;
  if (!window.confirm(`删除路径点「${wp.name}」？`)) return;
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

function deleteGroup(id) {
  const dim = currentDimension();
  const targetId = id || state.selection.groupId;
  if (!dim || !targetId) return toast('先选中一个分组', 'warn');
  const group = dim.groups.find((g) => g.id === targetId);
  if (!group) return;
  const used = dim.waypoints.filter((w) => w.group === targetId).length;
  if (used && !window.confirm(`分组「${group.name}」下还有 ${used} 个路径点，删除后它们会归入「未分组」。继续？`)) return;
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
  toast('已新建维度：先在右侧选基底图，再校准画幅', 'ok', 4000);
}

function deleteDimension() {
  const dim = currentDimension();
  if (!dim) return;
  if (state.draft.dimensions.length <= 1) return toast('至少要保留一个维度', 'warn');
  if (!window.confirm(`删除维度「${dim.name}」及其 ${dim.waypoints.length} 个路径点？`)) return;
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

/* ------------------------------ 校准 ------------------------------ */

function openCalibrationDialog() {
  const dim = currentDimension();
  if (!dim) return toast('先选一个维度', 'warn');
  if (!dim.imageMeta?.width) return toast('该维度还没有基底图，先导入图片', 'warn');

  const coords = state.coords;
  if (!coords) return toast('站点坐标模块未载入，无法校准', 'error');

  state.picks = { a: null, b: null };
  const modal = buildCalibrationDialog(dim, coords);
  document.body.appendChild(modal);
}

/** 校准对话框（自包含，样式内联，避免依赖 tool.css 的类名） */
function buildCalibrationDialog(dim, coords) {
  const overlay = document.createElement('div');
  overlay.className = 'cal-dialog';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '80',
    display: 'grid', placeItems: 'center',
    background: 'rgba(6, 9, 7, .72)', backdropFilter: 'blur(6px)',
  });

  const box = document.createElement('div');
  overlay.appendChild(box);
  Object.assign(box.style, {
    width: 'min(560px, 92vw)', maxHeight: '86vh', overflow: 'auto',
    background: 'var(--panel, #141a15)', color: 'var(--text, #e8efe8)',
    border: '1px solid var(--border, #2b352c)', borderRadius: '16px',
    padding: '18px 20px', boxShadow: '0 24px 70px rgba(0,0,0,.6)',
    font: '13px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  });
  box.innerHTML = `
    <h2 style="margin:0 0 6px;font-size:16px;display:flex;gap:8px;align-items:center">🎯 校准「${escapeHtml(dim.name)}」的画幅</h2>
    <p style="margin:0 0 12px;color:var(--muted,#93a394);font-size:12px;line-height:1.7">
      在图上点两个<b>你知道精确世界坐标</b>的地标（出生点、传送门、主城中心…），填入它们的 X / Z。
      两个点要尽量拉开，且不要在同一行或同一列。
    </p>
    <div style="display:grid;gap:10px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button data-act="pick-a" style="padding:7px 12px;border-radius:9px;border:1px solid var(--accent,#5ad26f);background:transparent;color:var(--accent,#5ad26f);cursor:pointer">拾取 A</button>
        <span data-slot="a-px" style="color:var(--muted,#93a394);font-variant-numeric:tabular-nums">尚未拾取</span>
        <label style="display:flex;gap:6px;align-items:center">X <input data-slot="a-x" type="number" style="width:96px;padding:6px 8px;border-radius:8px;border:1px solid var(--border,#2b352c);background:#0e130f;color:inherit">
        </label>
        <label style="display:flex;gap:6px;align-items:center">Z <input data-slot="a-z" type="number" style="width:96px;padding:6px 8px;border-radius:8px;border:1px solid var(--border,#2b352c);background:#0e130f;color:inherit">
        </label>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button data-act="pick-b" style="padding:7px 12px;border-radius:9px;border:1px solid var(--accent,#5ad26f);background:transparent;color:var(--accent,#5ad26f);cursor:pointer">拾取 B</button>
        <span data-slot="b-px" style="color:var(--muted,#93a394);font-variant-numeric:tabular-nums">尚未拾取</span>
        <label style="display:flex;gap:6px;align-items:center">X <input data-slot="b-x" type="number" style="width:96px;padding:6px 8px;border-radius:8px;border:1px solid var(--border,#2b352c);background:#0e130f;color:inherit">
        </label>
        <label style="display:flex;gap:6px;align-items:center">Z <input data-slot="b-z" type="number" style="width:96px;padding:6px 8px;border-radius:8px;border:1px solid var(--border,#2b352c);background:#0e130f;color:inherit">
        </label>
      </div>
    </div>
    <div data-slot="result" style="margin-top:12px;padding:10px 12px;border-radius:10px;background:#10150f;border:1px solid var(--border,#2b352c);color:var(--muted,#93a394);font-size:12px;font-variant-numeric:tabular-nums">填入两点后自动计算</div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
      <button data-act="cancel" style="padding:8px 14px;border-radius:9px;border:1px solid var(--border,#2b352c);background:transparent;color:inherit;cursor:pointer">取消</button>
      <button data-act="apply" style="padding:8px 14px;border-radius:9px;border:1px solid var(--accent,#5ad26f);background:var(--accent,#5ad26f);color:#0b110c;font-weight:600;cursor:pointer" disabled>应用并关闭</button>
    </div>`;

  const slot = (name) => box.querySelector(`[data-slot="${name}"]`);
  const applyBtn = box.querySelector('[data-act="apply"]');
  let solved = null;

  const close = () => {
    exitPickMode();
    setPickingUI(false);
    if (hintEl) {
      hintEl.remove();
      hintEl = null;
    }
    overlay.remove();
  };

  /**
   * 拾取模式下让对话框「让路」：整层 pointer-events:none + 面板淡化，
   * 这样点击能落到画布上；同时底部浮出一个小提示条（唯一可点元素）。
   */
  let hintEl = null;
  const setPickingUI = (on, label = '') => {
    overlay.style.pointerEvents = on ? 'none' : 'auto';
    box.style.pointerEvents = on ? 'none' : 'auto';
    box.style.opacity = on ? '0.12' : '1';
    box.style.filter = on ? 'blur(1px)' : 'none';
    box.style.transition = 'opacity .18s ease, filter .18s ease';
    if (on) {
      if (!hintEl) {
        hintEl = document.createElement('div');
        Object.assign(hintEl.style, {
          position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)',
          zIndex: '90', pointerEvents: 'auto', display: 'flex', gap: '10px', alignItems: 'center',
          padding: '10px 16px', borderRadius: '999px', border: '1px solid #2b352c',
          background: 'rgba(18, 24, 19, .94)', color: '#e8efe8',
          font: '13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
          boxShadow: '0 12px 36px rgba(0,0,0,.55)',
        });
        hintEl.innerHTML =
          '<span style="width:8px;height:8px;border-radius:50%;background:#5ad26f"></span>' +
          '<span data-slot="hint-text"></span>' +
          '<button data-act="cancel-pick" type="button" style="padding:4px 10px;border-radius:999px;border:1px solid #2b352c;background:transparent;color:#93a394;cursor:pointer">取消拾取</button>';
        document.body.appendChild(hintEl);
        hintEl.querySelector('[data-act="cancel-pick"]').addEventListener('click', () => exitPickMode());
      }
      hintEl.hidden = false;
      hintEl.querySelector('[data-slot="hint-text"]').textContent = `点击地图拾取地标 ${label} · Esc 取消`;
    } else if (hintEl) {
      hintEl.hidden = true;
    }
  };

  const recompute = () => {
    const a = state.picks.a;
    const b = state.picks.b;
    const ax = Number(slot('a-x').value);
    const az = Number(slot('a-z').value);
    const bx = Number(slot('b-x').value);
    const bz = Number(slot('b-z').value);
    const result = slot('result');
    if (!a || !b) {
      result.textContent = '先拾取 A、B 两个点';
      result.style.color = 'var(--muted, #93a394)';
      applyBtn.disabled = true;
      solved = null;
      return;
    }
    if (![ax, az, bx, bz].every(Number.isFinite)) {
      result.textContent = '请填写 A、B 两点的世界 X / Z';
      result.style.color = 'var(--muted, #93a394)';
      applyBtn.disabled = true;
      solved = null;
      return;
    }
    let res = null;
    try {
      res = coords.calibrationFromTwoPoints(
        { px: a.px, py: a.py, x: ax, z: az },
        { px: b.px, py: b.py, x: bx, z: bz },
        { imageWidth: dim.imageMeta.width, imageHeight: dim.imageMeta.height },
      );
    } catch (err) {
      console.warn('[tool] 两点解算失败：', err);
    }
    if (!res) {
      result.textContent = '两个点在图片上的 X 或 Y 几乎重合，解不出画幅；请换一对更分散的地标';
      result.style.color = 'var(--danger, #ff6b6b)';
      applyBtn.disabled = true;
      solved = null;
      return;
    }
    const ppbX = dim.imageMeta.width / (res.xMax - res.xMin);
    const ppbZ = dim.imageMeta.height / (res.zMax - res.zMin);
    const ratio = ppbX / ppbZ;
    const suspicious = ratio < 0.85 || ratio > 1.18;
    result.innerHTML =
      `X：${res.xMin.toFixed(1)} → ${res.xMax.toFixed(1)}　` +
      `${(1 / ppbX).toFixed(3)} 方块/像素<br>` +
      `Z：${res.zMin.toFixed(1)} → ${res.zMax.toFixed(1)}　` +
      `${(1 / ppbZ).toFixed(3)} 方块/像素` +
      (suspicious ? '<br><span style="color:#ffbc4b">⚠ 两个方向的像素比例差得较多，检查地标坐标是否填错</span>' : '') +
      (res.flipZ ? '<br><span style="color:#ffbc4b">检测到南北翻转，将自动置 flipZ = true</span>' : '');
    result.style.color = 'var(--text, #e8efe8)';
    solved = res;
    applyBtn.disabled = false;
  };

  // 手填 / 修改 X、Z 时实时重算（否则「应用」永远不可用）
  for (const name of ['a-x', 'a-z', 'b-x', 'b-z']) {
    const el = slot(name);
    if (!el) continue;
    el.addEventListener('input', recompute);
    el.addEventListener('change', recompute);
  }
  recompute();

  box.addEventListener('click', (event) => {
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'cancel') return close();
    if (act === 'pick-a' || act === 'pick-b') {
      const which = act === 'pick-a' ? 'a' : 'b';
      // 拾取时必须让对话框「隐形让路」，否则全屏遮罩会把画布点击全吃掉
      state.pickExitHook = () => setPickingUI(false);
      setPickingUI(true, which.toUpperCase());
      beginPick(which, (point) => {
        slot(`${which}-px`).textContent = `图片像素 (${Math.round(point.px)}, ${Math.round(point.py)})`;
        canvas?.setPickPoints?.([state.picks.a, state.picks.b].filter(Boolean));
        setPickingUI(false);
        recompute();
      });
      return;
    }
    if (act === 'apply' && solved) {
      pushHistory();
      dim.calibration = {
        calibrated: true,
        xMin: Number(solved.xMin.toFixed(3)),
        xMax: Number(solved.xMax.toFixed(3)),
        zMin: Number(solved.zMin.toFixed(3)),
        zMax: Number(solved.zMax.toFixed(3)),
        flipZ: solved.flipZ === true,
        note: `两点校准 · 图片 ${dim.imageMeta.width}×${dim.imageMeta.height}px · 由配置工具生成`,
      };
      canvas?.setPickPoints?.([]);
      commit({ structural: true });
      toast('画幅已更新；点「保存到站点」写入 config.json', 'ok', 4000);
      close();
      return;
    }
    if (act === 'close') close();
  });

  box.querySelector('[data-act="cancel"]').addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  const onKey = (event) => {
    if (event.key === 'Escape') {
      if (state.pendingPick) {
        // 拾取中按 Esc：只退出拾取，不关闭对话框
        exitPickMode();
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
      close();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('keydown', onKey, true);
  return overlay;
}

/** 进入拾取模式：下一次画布点击会回调 point 并自动退出 */
function beginPick(which, cb) {
  state.pendingPick = which;
  state.pickHandler = cb;
  canvas?.setMode?.('pick');
  setStatus(`拾取模式：在地图上点「地标 ${which.toUpperCase()}」的位置（拖拽平移不会误触）`, 'warn');
  const badge = $('mode-badge');
  if (badge) {
    badge.hidden = false;
    badge.textContent = `拾取地标 ${which.toUpperCase()}：点击地图 · Esc 取消`;
  }
}

function exitPickMode() {
  if (!state.pendingPick) return;
  state.pendingPick = null;
  state.pickHandler = null;
  canvas?.setMode?.('select');
  const badge = $('mode-badge');
  if (badge) badge.hidden = true;
  const hook = state.pickExitHook;
  state.pickExitHook = null;
  if (typeof hook === 'function') {
    try {
      hook();
    } catch (err) {
      console.warn('[tool] 拾取退出回调出错：', err);
    }
  }
}

function handlePickPoint({ px, py }) {
  if (!state.pendingPick) return;
  const which = state.pendingPick;
  state.picks[which] = { px, py };
  const cb = state.pickHandler;
  exitPickMode();
  setStatus(`已拾取地标 ${which.toUpperCase()}，填它的世界坐标`, 'info');
  if (cb) cb({ px, py });
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
      const timer = setTimeout(() => resolve(false), 20000);
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

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
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
    throw new Error((data && data.error) || `${method} ${path} 失败（HTTP ${res.status}）`);
  }
  return data;
}

function bindKeyboard() {
  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveToSite();
      return;
    }
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (event.key === 'Escape') {
      if (state.pendingPick) {
        exitPickMode();
        setStatus('已退出拾取模式', 'info');
      }
      if (state.placeFor) {
        disarmPlacement();
        setStatus('已退出放置模式（路径点仍在原位）', 'info');
      }
      const dialog = $('preview-dialog');
      if (dialog && !dialog.hidden) closePreview();
    }
    if (event.key === 'Delete' && state.selection.waypointId && !event.target.closest('input, textarea, select')) {
      deleteWaypoint();
    }
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
      state.dirty = true;
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
  $('btn-preview-reload')?.addEventListener('click', () => {
    const frame = $('preview-frame');
    if (frame && state.previewToken) frame.src = `/preview/index.html?token=${state.previewToken}&t=${Date.now()}`;
  });
  $('btn-fit')?.addEventListener('click', () => canvas?.fitToContent?.());
  $('zoom-in')?.addEventListener('click', () => canvas?.zoomBy?.(1.35));
  $('zoom-out')?.addEventListener('click', () => canvas?.zoomBy?.(1 / 1.35));
  $('btn-enhance')?.addEventListener('click', toggleEnhance);

  $('search')?.addEventListener('input', (event) => {
    state.search = String(event.target.value || '').trim();
    canvas?.setFilter?.(state.search ? (wp) => model.waypointMatchesQuery(wp, state.search) : null);
    panel?.setSearch?.(state.search);
  });
}

/* ============================== 调试接口（供 QA / 控制台使用） ============================== */

/**
 * 调试/自动化接口。QA（tests/e2e.mjs）用它读取草稿、调用同一套保存/预览/校准代码路径，
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
    calibrate: (a, b) => calibrateFromPoints(a, b),

    /* ---- 额外便利 ---- */
    model,
    api,
    json: () => model.toConfigJson(state.draft),
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
    openCalibration: openCalibrationDialog,
    setCalibration: (cal) => {
      const dim = currentDimension();
      if (!dim) return null;
      pushHistory();
      dim.calibration = { ...dim.calibration, ...cal };
      commit({ structural: true });
      return dim.calibration;
    },
    undo,
    redo,
    toast,
    get panel() {
      return panel;
    },
  };
}

/** 两点反解并直接应用（与校准对话框同一套数学），供自动化测试/控制台调用 */
function calibrateFromPoints(a, b) {
  const dim = currentDimension();
  const coords = state.coords;
  if (!dim || !coords || !dim.imageMeta?.width) return { ok: false, error: '缺少维度或图片尺寸' };
  const res = coords.calibrationFromTwoPoints(
    { px: Number(a.px), py: Number(a.py), x: Number(a.x), z: Number(a.z) },
    { px: Number(b.px), py: Number(b.py), x: Number(b.x), z: Number(b.z) },
    { imageWidth: dim.imageMeta.width, imageHeight: dim.imageMeta.height },
  );
  if (!res) return { ok: false, error: '两个点在图片上的同一轴几乎重合，解不出画幅' };
  pushHistory();
  dim.calibration = {
    calibrated: true,
    xMin: Number(res.xMin.toFixed(3)),
    xMax: Number(res.xMax.toFixed(3)),
    zMin: Number(res.zMin.toFixed(3)),
    zMax: Number(res.zMax.toFixed(3)),
    flipZ: res.flipZ === true,
    note: `两点校准 · 图片 ${dim.imageMeta.width}×${dim.imageMeta.height}px · 由配置工具生成`,
  };
  commit({ structural: true });
  return { ok: true, calibration: dim.calibration };
}

export { state, api, saveToSite as save };








/**
 * merge.js —— 地图合并页面的控制器
 *
 * 两种模式：
 *   单图合并（默认）：
 *     1. 载入站点 config.json，把「第一个单图维度的地图」作为目标图（也可自己选文件）；
 *     2. 在新图上点一下世界 (0,0) + 填「每方块像素数」→ 得到它的校准；
 *     3. 「分析差异」= 把新图重采样到目标图网格 → 按 tile 分类 → 画叠加层 + 统计；
 *     4. 「按策略合并」= 按当前勾选合成 → 中间预览；
 *     5. 「下载 PNG」/「保存到站点」（写前自动备份到 .backups/）。
 *     所有图像运算都在浏览器里完成；写盘只用已有的 /api/import-image。
 *   瓦片差分：
 *     1. 选择站点瓦片维度 + 拖入另一套 Xaero 导出（x<X>_z<Z>.png / 区域 zip）；
 *     2. 「分析差异」= 上传文件，服务端逐瓦片差分并把合并结果暂存；
 *     3. 「保存到站点」= 整体替换 tiles/<维度>/（写前自动备份，失败自动回滚）。
 */

import { MergeUI } from './merge-ui.js';
import {
  TILE,
  calibrationFromOrigin,
  calibrationFromBounds,
  worldToPixel,
  resampleToBase,
  analyzeDiff,
  composeMerged,
} from './merge-core.js';

const $ = (id) => document.getElementById(id);
const MAX_AREA = 268_000_000; // 浏览器 canvas 面积软上限

const state = {
  ui: null,
  api: { siteDir: '', images: [] },
  base: { image: null, width: 0, height: 0, cal: null, fileName: '', label: '' },
  incoming: { image: null, width: 0, height: 0, cal: null, fileName: '', label: '' },
  baseData: null,      // { data, width, height, cal }
  incomingData: null,  // { data, width, height, cal }（原图）
  resampled: null,     // incoming 重采样到 base 网格后的结果
  analysis: null,
  merged: null,        // { data, width, height }
  analysisStale: false,
  mode: 'image',       // 'image' | 'tiles'
  tiles: {
    dims: [],          // [{ id, name, manifestPath, manifest, error }]
    dim: null,
    files: [],         // 新图文件（File 对象）
    analysis: null,    // /api/merge-tiles/analyze 的响应
    staged: false,     // 服务端有该维度的暂存合并结果
    stale: false,      // 分析后参数/文件又变了，保存需重新分析
  },
};

/* ============================== 启动 ============================== */

bootstrap().catch((err) => {
  console.error('[merge] 启动失败：', err);
  $('mg-status').textContent = `启动失败：${err.message}`;
  $('mg-status').dataset.tone = 'error';
});

async function bootstrap() {
  state.ui = new MergeUI($('merge-app'), {
    onPickBase: (point) => handlePick('base', point),
    onPickIncoming: (point) => handlePick('incoming', point),
    onBaseImage: (file) => loadBaseFromFile(file),
    onIncomingImage: (file) => loadIncomingFromFile(file),
    onParamsChange: () => {
      if (state.mode === 'tiles') markTilesStale();
      else markAnalysisStale('分析参数已改，请重新点「分析差异」');
    },
    onOptionChange: () => {
      if (state.mode === 'tiles') markTilesStale();
      else recomposeIfPossible();
    },
    onAction: handleAction,
    onOriginChange: (which, point) => handleOriginChange(which, point),
    onPpbChange: (which, ppb) => handlePpbChange(which, ppb),
    onModeChange: (mode) => switchMode(mode),
    onTileDimChange: (id) => selectTileDim(id),
    onTileFiles: (files) => setTileFiles(files),
    onTileClear: () => setTileFiles([]),
    onTileReload: () => loadTileDims(),
  });

  bindKeyboard();

  try {
    const info = await api('/api/state');
    state.api.siteDir = info.siteDir;
    state.api.images = info.images || [];
    $('mg-subtitle').textContent = `把别人给的地图与你站点的地图对齐 → 找出新增/变更 → 合并　·　站点目录：${info.siteDir}`;
  } catch (err) {
    console.warn('[merge] 读取站点状态失败：', err);
    state.ui.setStatus('读取站点状态失败，可手动选择两张图片', 'warn');
  }

  await loadDefaultBase();
}

function bindKeyboard() {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      state.ui?.cancelPick();
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      handleAction('analyze');
    }
  });
}

/* ============================== 载入地图 ============================== */

function hasTiles(dim) {
  const tiles = dim?.tiles;
  return !!String((typeof tiles === 'string' ? tiles : tiles?.manifest) || '').trim();
}

// 兼容站点相对路径写法及 Windows 的大小写不敏感文件名。
function imageKey(name) {
  return String(name || '').trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '').toLowerCase();
}

function tiledFallback(config, fileName) {
  const key = imageKey(fileName);
  return config?.dimensions?.find((dim) => hasTiles(dim) && dim.image && imageKey(dim.image) === key);
}

/** 仅用单图维度作为默认目标图；瓦片维度的 image 只是回退图。 */
async function loadDefaultBase() {
  let config = null;
  try {
    const res = await api('/api/site-config');
    if (res.ok) config = res.config;
  } catch (err) {
    console.warn('[merge] 读取站点 config.json 失败：', err);
  }
  const dimensions = Array.isArray(config?.dimensions) ? config.dimensions : [];
  const usesTiles = dimensions.some(hasTiles);
  const dim = dimensions.find((d) => d?.image && !hasTiles(d) && !tiledFallback(config, d.image));
  if (!dim) {
    state.ui.setStatus(usesTiles
      ? '站点地图使用瓦片：可切到「瓦片差分」模式合并瓦片，或返回主编辑器重新生成瓦片；也可手动选择独立图片合并并下载。'
      : '站点没有可用的地图，请手动选择目标图', 'warn');
    return;
  }
  try {
    const image = await loadImage(`/preview/${encodeURIComponent(dim.image)}`);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const cal = calibrationFromBounds({
      xMin: Number(dim.calibration?.xMin),
      xMax: Number(dim.calibration?.xMax),
      zMin: Number(dim.calibration?.zMin),
      zMax: Number(dim.calibration?.zMax),
      imageWidth: width,
      imageHeight: height,
      flipZ: dim.calibration?.flipZ === true,
    });
    applyBase({ image, width, height, cal, fileName: dim.image, label: dim.name || dim.id });
    // 目标图的「每方块像素数」默认填进输入框，新图可继承
    const ppb = cal ? Number(cal.pxPerBlock.toFixed(6)) : 1;
    $('mg-base-ppb').value = String(ppb);
    $('mg-inc-ppb').value = String(ppb);
    state.ui.setStatus(`目标图已载入：${dim.image}（${width}×${height}）` +
      (usesTiles ? '；已跳过瓦片地图，更新瓦片请返回主编辑器重新生成。' : ''), usesTiles ? 'warn' : 'ok');
  } catch (err) {
    state.ui.setStatus(`载入站点地图失败：${err.message}`, 'error');
  }
}

async function loadBaseFromFile(file) {
  try {
    const image = await fileToImage(file);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    applyBase({ image, width, height, cal: null, fileName: file.name, label: '本地文件（请拾取 (0,0)）' });
    state.ui.setStatus('目标图已更换：请点「拾取 (0,0)」在新图上标出世界原点', 'warn');
  } catch (err) {
    state.ui.setStatus(`载入失败：${err.message}`, 'error');
  }
}

async function loadIncomingFromFile(file) {
  try {
    const image = await fileToImage(file);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    state.incoming = { image, width, height, cal: null, fileName: file.name, label: '本地文件' };
    // 默认沿用目标图的每方块像素数（大多数情况下两张图比例一致）
    const basePpb = Number($('mg-base-ppb').value) || 1;
    $('mg-inc-ppb').value = String(basePpb);
    state.ui.setIncomingImage({ image, width, height, calibration: null, label: '待拾取原点' });
    syncCalibrationInputs('incoming');
    state.ui.setStatus('新图已载入：在新图上点一下世界 (0,0) 的位置', 'warn');
    invalidateAll();
  } catch (err) {
    state.ui.setStatus(`载入失败：${err.message}`, 'error');
  }
}

function applyBase({ image, width, height, cal, fileName, label }) {
  state.base = { image, width, height, cal, fileName, label };
  state.ui.setBaseImage({ image, width, height, calibration: cal, label });
  syncCalibrationInputs('base');
  state.ui.setSaveName(fileName || 'merged.png');
  invalidateAll();
}

/* ============================== 拾取原点 ============================== */

function syncCalibrationInputs(which) {
  const { cal } = which === 'base' ? state.base : state.incoming;
  const prefix = which === 'base' ? 'mg-base' : 'mg-inc';
  const origin = cal ? worldToPixel(cal, 0, 0) : null;
  state.ui.setPickMarker(which, origin);
  $(`${prefix}-ox`).value = origin ? String(Math.round(origin.px)) : '';
  $(`${prefix}-oy`).value = origin ? String(Math.round(origin.py)) : '';
  if (cal) $(`${prefix}-ppb`).value = String(Number(cal.pxPerBlock.toFixed(6)));
}

function handlePick(which, { px, py }) {
  handleOriginChange(which, { px, py }, { fromCanvas: true });
}

/** 统一的「设置原点像素 → 重算校准」入口（画布拾取 / 数字输入 / 方向键微调都走这里） */
function handleOriginChange(which, point, { fromCanvas = false } = {}) {
  const target = which === 'base' ? state.base : state.incoming;
  if (!target.image) return;
  const px = Math.round(Number(point.px));
  const py = Math.round(Number(point.py));
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    state.ui.setStatus('原点像素必须是数字', 'error');
    return;
  }
  const ppbInput = $(which === 'base' ? 'mg-base-ppb' : 'mg-inc-ppb');
  const pxPerBlock = Number(ppbInput.value);
  if (!(pxPerBlock > 0)) {
    state.ui.setStatus('「每方块像素数」要大于 0', 'error');
    return;
  }
  const cal = calibrationFromOrigin({
    originPx: px,
    originPy: py,
    pxPerBlock,
    imageWidth: target.width,
    imageHeight: target.height,
    flipZ: target.cal?.flipZ === true,
  });
  if (!cal) {
    state.ui.setStatus('无法根据当前参数计算校准', 'error');
    return;
  }
  target.cal = cal;
  state.ui.setPickMarker(which, { px, py });
  state.ui[which === 'base' ? 'setBaseImage' : 'setIncomingImage']({
    image: target.image,
    width: target.width,
    height: target.height,
    calibration: cal,
    label: which === 'base' ? state.base.label : state.incoming.label,
    origin: { px, py },
  });
  // 画布拾取后自动放大到能看清像素的级别，方便继续用 ←↑↓→ 微调
  if (fromCanvas) state.ui.focusOrigin(which, 6);
  state.ui.setStatus(
    `${which === 'base' ? '目标图' : '新图'}原点 = px(${px}, ${py}) → X ${Math.round(cal.xMin)} → ${Math.round(cal.xMax)} · Z ${Math.round(cal.zMin)} → ${Math.round(cal.zMax)}`,
    'ok',
  );
  invalidateAll();
}

/** 改「每方块像素数」后，如果已有原点就立即重算校准 */
function handlePpbChange(which, pxPerBlock) {
  const target = which === 'base' ? state.base : state.incoming;
  const prefix = which === 'base' ? 'mg-base' : 'mg-inc';
  const pick = {
    px: Number($(`${prefix}-ox`)?.value.trim() || NaN),
    py: Number($(`${prefix}-oy`)?.value.trim() || NaN),
  };
  markAnalysisStale('比例已改，请重新点「分析差异」');
  if (!(pxPerBlock > 0) || !Number.isFinite(pxPerBlock)) {
    state.ui.setStatus('「每方块像素数」要大于 0', 'error');
    return;
  }
  if (!Number.isFinite(pick.px) || !Number.isFinite(pick.py) || !target.image) {
    state.ui.setStatus('已记录比例；设置原点后会立刻算出画幅', 'info');
    return;
  }
  handleOriginChange(which, pick);
}

/** 参数/图片变化后，之前的分析与合并结果都作废 */
function invalidateAll() {
  state.analysis = null;
  state.merged = null;
  state.resampled = null;
  state.baseData = null;
  state.incomingData = null;
  state.analysisStale = false;
  state.ui.setAnalysis(null);
  state.ui.setMergedPreview(null);
}

function markAnalysisStale(message) {
  const hadAnalysis = !!state.analysis;
  invalidateAll();
  state.analysisStale = true;
  if (hadAnalysis) state.ui.setStatus(message, 'warn');
}

/* ============================== 分析 / 合并 ============================== */

async function handleAction(name) {
  switch (name) {
    case 'analyze':
      return state.mode === 'tiles' ? runAnalyzeTiles() : runAnalyze();
    case 'apply':
      return state.mode === 'tiles' ? undefined : runCompose();
    case 'download':
      return state.mode === 'tiles' ? undefined : downloadMerged();
    case 'save':
      return state.mode === 'tiles' ? saveTilesToSite() : saveToSite();
    case 'back':
      window.location.href = '/';
      return undefined;
    default:
      return undefined;
  }
}

async function runAnalyze() {
  const { base, incoming } = state;
  if (!base.image || !incoming.image) {
    state.ui.setStatus('需要先载入两张地图', 'warn');
    return;
  }
  if (!base.cal) {
    state.ui.setStatus('目标图还没有校准：点「拾取 (0,0)」在目标图上标出世界原点', 'warn');
    return;
  }
  if (!incoming.cal) {
    state.ui.setStatus('新图还没有校准：点「拾取 (0,0)」在新图上标出世界原点', 'warn');
    return;
  }
  if (base.width * base.height > MAX_AREA) {
    state.ui.setStatus(`目标图太大（${base.width}×${base.height}），超出浏览器 canvas 处理能力`, 'error');
    return;
  }

  invalidateAll();
  state.ui.setBusy(true);
  await nextFrame();
  try {
    const t0 = performance.now();
    state.baseData = imageToPixelData(base.image, base.width, base.height, base.cal);
    state.incomingData = imageToPixelData(incoming.image, incoming.width, incoming.height, incoming.cal);
    const t1 = performance.now();

    const resampled = resampleToBase({ base: state.baseData, incoming: state.incomingData });
    if (!resampled.coverage) {
      state.ui.setStatus('两张图在世界坐标上完全不重叠：检查两张图的原点/比例是否设置正确', 'error');
      state.ui.setBusy(false);
      return;
    }
    state.resampled = resampled;
    const t2 = performance.now();

    const params = state.ui.getParams();
    const analysis = analyzeDiff({ base: state.baseData, incoming: resampled, ...params });
    state.analysis = analysis;
    state.analysisStale = false;
    state.ui.setAnalysis(analysis);
    const t3 = performance.now();

    // 分析完立刻按当前策略合成，便于马上看效果
    runCompose({ keepBusy: true });
    const t4 = performance.now();
    console.info(
      `[merge] 解码 ${(t1 - t0).toFixed(0)}ms · 重采样 ${(t2 - t1).toFixed(0)}ms · 分析 ${(t3 - t2).toFixed(0)}ms · 合成 ${(t4 - t3).toFixed(0)}ms`,
    );
    state.ui.setStatus(
      `分析完成：新增 ${analysis.counts.onlyIncoming} 格 · 变更 ${analysis.counts.changed} 格 · 仅目标图 ${analysis.counts.onlyBase} 格（耗时 ${Math.round(t4 - t0)}ms）`,
      'ok',
    );
  } catch (err) {
    console.error('[merge] 分析失败：', err);
    state.ui.setStatus(`分析失败：${err.message}`, 'error');
  } finally {
    state.ui.setBusy(false);
  }
}

function runCompose({ keepBusy = false } = {}) {
  if (state.analysisStale || !state.analysis) {
    state.ui.setStatus('请重新点「分析差异」后再合并', 'warn');
    return;
  }
  state.merged = null;
  state.ui.setMergedPreview(null);
  if (!keepBusy) state.ui.setBusy(true);
  try {
    const options = state.ui.getOptions();
    const merged = composeMerged({
      base: state.baseData,
      incoming: state.resampled,
      analysis: state.analysis,
      options,
    });
    state.merged = merged;
    state.ui.setMergedPreview({ data: merged.data, width: merged.width, height: merged.height });
    state.ui.setStatus(
      `合并完成：补入 ${merged.applied.filledTiles} 格新增、覆盖 ${merged.applied.updatedTiles} 格变更` +
        `${options.updateChanged ? '' : '（未覆盖变更）'}`,
      'ok',
    );
  } catch (err) {
    console.error('[merge] 合并失败：', err);
    state.ui.setStatus(`合并失败：${err.message}`, 'error');
  } finally {
    if (!keepBusy) state.ui.setBusy(false);
  }
}

function recomposeIfPossible() {
  if (state.analysis && state.resampled && state.baseData) runCompose();
}

/* ============================== 输出 ============================== */

function mergedToCanvas() {
  const m = state.merged;
  if (state.analysisStale || !m) {
    state.ui.setStatus('请重新分析并合并后再输出 PNG', 'warn');
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = m.width;
  canvas.height = m.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(m.data), m.width, m.height), 0, 0);
  return canvas;
}

async function downloadMerged() {
  const canvas = mergedToCanvas();
  if (!canvas) return;
  const name = state.ui.getSaveName() || 'merged.png';
  const merged = state.merged;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (state.analysisStale || state.merged !== merged) return;
  if (!blob) {
    state.ui.setStatus('导出 PNG 失败', 'error');
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  state.ui.setStatus(`已导出 ${name}（${Math.round(blob.size / 1024)} KB）`, 'ok');
  state.ui.toast('已导出合并结果', 'ok');
}

async function saveToSite() {
  const canvas = mergedToCanvas();
  if (!canvas) return;
  const fileName = (state.ui.getSaveName() || state.base.fileName || 'merged.png').trim();
  if (!/\.(png|jpe?g|webp)$/i.test(fileName)) {
    state.ui.setStatus('保存文件名必须以 .png / .jpg / .webp 结尾', 'error');
    return;
  }
  const merged = state.merged;
  state.ui.setBusy(true);
  try {
    // 保存前重读配置：主编辑器可能已启用瓦片，不能只检查启动时的配置。
    const { config } = await api('/api/site-config');
    if (!Array.isArray(config?.dimensions)) throw new Error('无法确认站点瓦片配置，请修复 config.json 后重试，或下载 PNG');
    if (tiledFallback(config, fileName)) {
      throw new Error('此文件是瓦片维度的回退图，不能在合并页覆盖。请返回主编辑器重新生成瓦片，或换文件名保存独立图片');
    }
    if (state.analysisStale || state.merged !== merged) return;
    const dataUrl = canvas.toDataURL('image/png');
    const res = await api('/api/import-image', { method: 'POST', body: { fileName, dataUrl } });
    state.ui.setStatus(
      `已保存 ${res.name}（${Math.round(res.bytes / 1024)} KB）${res.backup ? `，原图备份为 ${res.backup}` : ''}`,
      'ok',
    );
    state.ui.toast(`已写入站点目录：${res.name}`, 'ok', 3600);
    if (state.base.fileName === res.name) {
      // 目标图被覆盖，重新载入以显示最新内容
      await reloadBaseImage(res.name);
    }
    // 底图换了，之前的差异分析/合并预览已经过时（叠加层会画在旧底图的判断上）→ 清掉并提示
    invalidateAll();
    state.ui.setStatus(`已保存 ${res.name}，底图已更新；可再点「分析差异」确认结果`, 'ok');
  } catch (err) {
    console.error('[merge] 保存失败：', err);
    state.ui.setStatus(`保存失败：${err.message}`, 'error');
    state.ui.toast(`保存失败：${err.message}`, 'error', 5000);
  } finally {
    state.ui.setBusy(false);
  }
}

async function reloadBaseImage(fileName) {
  try {
    const image = await loadImage(`/preview/${encodeURIComponent(fileName)}?t=${Date.now()}`);
    state.base.image = image;
    state.base.width = image.naturalWidth;
    state.base.height = image.naturalHeight;
    state.ui.setBaseImage({
      image,
      width: state.base.width,
      height: state.base.height,
      calibration: state.base.cal,
      label: fileName,
    });
  } catch (err) {
    console.warn('[merge] 重新载入目标图失败：', err);
  }
}

/* ============================== 瓦片差分模式 ============================== */

async function switchMode(mode) {
  state.mode = mode === 'tiles' ? 'tiles' : 'image';
  state.ui.setMode(state.mode);
  if (state.mode === 'tiles') {
    if (!state.tiles.dims.length) await loadTileDims();
    state.ui.setStatus(
      state.tiles.dims.length
        ? '瓦片差分：选择站点维度并拖入新图文件，然后点「分析差异」'
        : '站点没有任何瓦片维度，请先在主编辑器里用 Xaero 导出生成瓦片',
      state.tiles.dims.length ? 'info' : 'warn',
    );
  } else {
    state.ui.setStatus('单图合并模式', 'info');
  }
}

/** 读取站点配置里的瓦片维度 + 各自的 manifest 摘要 */
async function loadTileDims() {
  let config = null;
  try {
    const res = await api('/api/site-config');
    config = res.ok ? res.config : null;
  } catch (err) {
    console.warn('[merge] 读取站点配置失败：', err);
    state.ui.setStatus(`读取站点配置失败：${err.message}`, 'error');
    return state.tiles.dims;
  }
  const dims = [];
  for (const dim of config?.dimensions || []) {
    if (!hasTiles(dim)) continue;
    const manifestPath = typeof dim.tiles === 'string'
      ? dim.tiles
      : (dim.tiles?.manifest || `tiles/${dim.id}/manifest.json`);
    let manifest = null;
    let error = '';
    try {
      const res = await fetch(`/preview/${encodeURIComponent(manifestPath)}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      error = err.message;
    }
    dims.push({ id: dim.id, name: dim.name || dim.id, manifestPath, manifest, error });
  }
  state.tiles.dims = dims;
  const keep = state.tiles.dim && dims.some((d) => d.id === state.tiles.dim);
  state.ui.setTileDims(dims.map((d) => ({ id: d.id, name: d.name })), keep ? state.tiles.dim : null);
  await selectTileDim(state.ui.getTileDim());
  if (!dims.length && state.mode === 'tiles') {
    state.ui.setStatus('站点没有任何瓦片维度：请先在主编辑器里用 Xaero 导出生成瓦片', 'warn');
  }
  return dims;
}

async function selectTileDim(id) {
  state.tiles.dim = id || null;
  const dim = state.tiles.dims.find((d) => d.id === id);
  invalidateTiles();
  state.ui.setTileState({ dim: id || null, dimReady: false, staged: false, stale: false });
  if (!dim) {
    state.ui.setTileBaseInfo({ error: '未选择维度' });
    if (state.mode === 'tiles') state.ui.setStatus('请选择站点瓦片维度', 'warn');
    return;
  }
  if (dim.error) {
    state.ui.setTileBaseInfo({ error: `读取瓦片 manifest 失败：${dim.error}（该维度的瓦片可能还没生成）` });
    if (state.mode === 'tiles') state.ui.setStatus(`维度「${dim.name}」的瓦片 manifest 读取失败：${dim.error}`, 'warn');
    return;
  }
  const m = dim.manifest;
  state.ui.setTileBaseInfo({
    manifest: m,
    label: dim.name,
    tileSize: m.tileSize,
    bounds: m.worldBlockRange,
    levels: m.levels?.length,
    tilesWritten: m.stats?.tilesWritten,
    generatedAt: m.generatedAt,
  });
  state.ui.setTileState({ dim: id, dimReady: true });
  if (state.mode === 'tiles') {
    state.ui.setStatus(`目标瓦片集「${dim.name}」已就绪（${m.stats?.tilesWritten ?? 0} 张瓦片）`, 'ok');
  }
}

function setTileFiles(files) {
  const list = [...(files || [])];
  state.tiles.files = list;
  invalidateTiles();
  state.ui.setTileFiles(list);
  state.ui.setTileState({ files: list.length, staged: false, stale: false });
  if (state.mode === 'tiles') {
    state.ui.setStatus(list.length ? `已选 ${list.length} 个新图文件，点「分析差异」开始逐瓦片对比` : '已清空新图文件', 'info');
  }
}

/** 瓦片模式的分析/暂存结果作废 */
function invalidateTiles() {
  teardownCompare();
  state.tiles.analysis = null;
  state.tiles.staged = false;
  state.tiles.stale = false;
  state.ui.setTileAnalysis(null);
}

/** 分析之后改了参数/选项：暂存结果还在，但保存前必须重新分析 */
function markTilesStale() {
  if (!state.tiles.analysis) return;
  state.tiles.stale = true;
  state.ui.setTileState({ stale: true });
  state.ui.setStatus('参数已改，请重新点「分析差异」后再保存', 'warn');
}

async function runAnalyzeTiles() {
  const dim = state.ui.getTileDim();
  if (!dim) {
    state.ui.setStatus('先选择目标瓦片维度', 'warn');
    return;
  }
  const dimInfo = state.tiles.dims.find((d) => d.id === dim);
  if (!dimInfo || dimInfo.error) {
    state.ui.setStatus('该维度的瓦片不可用，请先在主编辑器生成瓦片', 'warn');
    return;
  }
  if (!state.tiles.files.length) {
    state.ui.setStatus('先拖入新图文件（XAERO 导出 PNG / 区域 zip）', 'warn');
    return;
  }
  invalidateTiles();
  state.ui.setBusy(true);
  try {
    const params = state.ui.getParams();
    const options = state.ui.getOptions();
    const fd = new FormData();
    fd.append('dim', dim);
    fd.append('fillNew', options.fillNew ? '1' : '0');
    fd.append('updateChanged', options.updateChanged ? '1' : '0');
    fd.append('voidLuminance', String(params.voidLuminance));
    fd.append('diffThreshold', String(params.diffThreshold));
    for (const file of state.tiles.files) fd.append('files', file, file.name);
    const res = await apiUpload('/api/merge-tiles/analyze', fd);
    state.tiles.analysis = res;
    state.tiles.staged = true;
    state.tiles.stale = false;
    state.ui.setTileAnalysis({
      counts: res.counts,
      blocksArea: res.blocksArea,
      grid: res.grid,
      stagedGeneratedAt: res.stagedGeneratedAt,
    });
    state.ui.setTileState({ staged: true, stale: false });
    state.ui.setStatus(
      `分析完成：新增 ${res.counts.onlyIncoming} 瓦片 · 变更 ${res.counts.changed} 瓦片 · 仅目标图 ${res.counts.onlyBase} 瓦片（耗时 ${(res.durationMs / 1000).toFixed(1)}s）`,
      'ok',
    );
    await loadCompareView(dim, res.stagingManifestUrl);
  } catch (err) {
    console.error('[merge] 瓦片分析失败：', err);
    state.ui.setStatus(`分析失败：${err.message}`, 'error');
    state.ui.toast(`分析失败：${err.message}`, 'error', 5000);
  } finally {
    state.ui.setBusy(false);
  }
}

/* ============================== 瓦片差分：对比滑块 ============================== */

/** @type {null | { baseLayer: any, mergedLayer: any, onResize: () => void }} */
let compare = null;

function teardownCompare() {
  const box = $('mg-compare');
  if (box) box.hidden = true;
  if (!compare) return;
  if (compare.onResize) window.removeEventListener('resize', compare.onResize);
  try { compare.baseLayer?.destroy(); } catch { /* 忽略 */ }
  try { compare.mergedLayer?.destroy(); } catch { /* 忽略 */ }
  compare = null;
}

/**
 * 分析成功后加载「旧图 vs 合并结果」对比：
 * 复用站点 assets/js/tiles.js（经 /preview 提供）的 parseManifest + TileLayer，
 * 两个 canvas 用同一视图状态叠加，滑块裁掉合并结果 canvas 的左侧。
 */
async function loadCompareView(dim, stagingManifestUrl) {
  teardownCompare();
  const stageEl = $('mg-compare-stage');
  if (!stageEl || !stagingManifestUrl) return;
  const dimInfo = state.tiles.dims.find((d) => d.id === dim);
  const baseUrl = dimInfo?.manifestPath
    ? `/preview/${dimInfo.manifestPath}`
    : `/preview/tiles/${dim}/manifest.json`;

  let mod;
  let baseTileset;
  let mergedTileset;
  try {
    mod = await import('/preview/assets/js/tiles.js');
    const [baseRes, stagedRes] = await Promise.all([
      fetch(baseUrl, { cache: 'no-store' }),
      fetch(stagingManifestUrl, { cache: 'no-store' }),
    ]);
    if (!baseRes.ok) throw new Error(`旧图 manifest 读取失败：HTTP ${baseRes.status}`);
    if (!stagedRes.ok) throw new Error(`合并结果 manifest 读取失败：HTTP ${stagedRes.status}`);
    baseTileset = mod.parseManifest(await baseRes.json(), { manifestUrl: baseUrl });
    mergedTileset = mod.parseManifest(await stagedRes.json(), { manifestUrl: stagingManifestUrl });
    if (!baseTileset || !mergedTileset) throw new Error('manifest 结构不合法，无法对比');
  } catch (err) {
    console.warn('[merge] 对比滑块初始化失败：', err);
    state.ui.toast(`对比图加载失败：${err.message}`, 'error', 5000);
    return;
  }

  // 服务端保证暂存结果沿用站点瓦片集的 worldBlockRange，两图逐像素对齐
  const { imageWidth, imageHeight } = baseTileset;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const baseCanvas = $('mg-compare-base');
  const mergedCanvas = $('mg-compare-merged');
  if (!baseCanvas || !mergedCanvas) return;
  const baseLayer = new mod.TileLayer(baseCanvas, { tileset: baseTileset, dpr });
  const mergedLayer = new mod.TileLayer(mergedCanvas, { tileset: mergedTileset, dpr });
  baseLayer.setActive(true);
  mergedLayer.setActive(true);

  const layout = () => {
    const cw = stageEl.clientWidth;
    const ch = stageEl.clientHeight;
    if (!(cw > 0) || !(ch > 0)) return;
    const scale = Math.min(cw / imageWidth, ch / imageHeight);
    const cssW = Math.round(imageWidth * scale);
    const cssH = Math.round(imageHeight * scale);
    const tx = (cw - cssW) / 2;
    const ty = (ch - cssH) / 2;
    const viewState = { scale, tx, ty, viewWidth: cw, viewHeight: ch };
    for (const [canvas, layer] of [[baseCanvas, baseLayer], [mergedCanvas, mergedLayer]]) {
      canvas.style.left = `${tx}px`;
      canvas.style.top = `${ty}px`;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      layer.update(viewState);
    }
  };

  const applyDivider = (value) => {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    mergedCanvas.style.clipPath = `inset(0 0 0 ${v}%)`;
    const divider = $('mg-compare-divider');
    if (divider) divider.style.left = `${v}%`;
  };

  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  const slider = $('mg-compare-slider');
  if (slider) slider.addEventListener('input', () => applyDivider(slider.value));

  compare = { baseLayer, mergedLayer, onResize };
  const box = $('mg-compare');
  if (box) box.hidden = false;
  applyDivider(slider ? slider.value : 50);
  layout();
}

async function saveTilesToSite() {
  const { tiles } = state;
  if (!tiles.staged || !tiles.analysis) {
    state.ui.setStatus('请先点「分析差异」再保存', 'warn');
    return;
  }
  if (tiles.stale) {
    state.ui.setStatus('参数已改，请重新点「分析差异」后再保存', 'warn');
    return;
  }
  const dim = state.ui.getTileDim();
  if (!dim) {
    state.ui.setStatus('先选择目标瓦片维度', 'warn');
    return;
  }
  state.ui.setBusy(true);
  try {
    const res = await api('/api/merge-tiles/apply', { method: 'POST', body: { dim } });
    const msg = `已发布到 tiles/${res.dim}/（${res.tilesWritten} 张瓦片，${res.levels} 层）` +
      `${res.backup ? `，原瓦片备份为 ${res.backup}/` : ''}`;
    invalidateTiles();
    state.ui.setTileState({ staged: false, stale: false });
    // 基底已换，重新读 manifest 摘要
    await loadTileDims();
    state.ui.setStatus(msg, 'ok');
    state.ui.toast('瓦片差分合并已保存到站点', 'ok', 3600);
  } catch (err) {
    console.error('[merge] 瓦片保存失败：', err);
    state.ui.setStatus(`保存失败：${err.message}`, 'error');
    state.ui.toast(`保存失败：${err.message}`, 'error', 5000);
  } finally {
    state.ui.setBusy(false);
  }
}

/* ============================== 工具函数 ============================== */

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败：${src}`));
    img.src = src;
  });
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve(img);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`无法解码图片：${file.name}`));
    };
    img.src = url;
  });
}

/** 把图片画到离屏 canvas 取出 RGBA（附带校准） */
function imageToPixelData(image, width, height, cal) {
  if (width * height > MAX_AREA) throw new Error('图片过大，超出浏览器 canvas 处理能力');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  const imgData = ctx.getImageData(0, 0, width, height);
  return { data: imgData.data, width, height, cal };
}

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
    throw new Error(`${method} ${path} 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || `${method} ${path} 失败（HTTP ${res.status}）`);
  }
  return data;
}

/** multipart 上传版 api()：body 用 FormData，不手动设 Content-Type（让浏览器带 boundary） */
async function apiUpload(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData, cache: 'no-store' });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`POST ${path} 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || `POST ${path} 失败（HTTP ${res.status}）`);
  }
  return data;
}

/* 调试接口（自动化测试用） */
window.__merge = {
  state,
  get mode() {
    return state.mode;
  },
  get base() {
    return state.base;
  },
  get incoming() {
    return state.incoming;
  },
  get analysis() {
    return state.analysis;
  },
  get merged() {
    return state.merged;
  },
  TILE,
  calibrationFromOrigin,
  calibrationFromBounds,
  analyze: () => runAnalyze(),
  compose: (opts) => runCompose(opts),
  download: () => downloadMerged(),
  save: () => saveToSite(),
  action: (name) => handleAction(name),
  switchMode: (mode) => switchMode(mode),
  tileDims: () => state.tiles.dims.map((d) => ({ id: d.id, name: d.name, ok: !d.error })),
  tiles: () => ({
    dim: state.tiles.dim,
    files: state.tiles.files.map((f) => f.name),
    staged: state.tiles.staged,
    stale: state.tiles.stale,
    analysis: state.tiles.analysis
      ? { counts: state.tiles.analysis.counts, blocksArea: state.tiles.analysis.blocksArea }
      : null,
  }),
  compare: () => ({
    visible: !($('mg-compare')?.hidden ?? true),
    layers: !!compare,
    value: $('mg-compare-slider')?.value ?? null,
    clip: $('mg-compare-merged')?.style.clipPath || '',
    divider: $('mg-compare-divider')?.style.left || '',
  }),
  setTileFiles: (files) => setTileFiles(files),
  setParams: (params) => {
    state.ui.setParams(params);
    markAnalysisStale('参数已改');
  },
  setOptions: ({ fillNew, updateChanged }) => {
    if (typeof fillNew === 'boolean') $('mg-opt-fill').checked = fillNew;
    if (typeof updateChanged === 'boolean') $('mg-opt-update').checked = updateChanged;
    recomposeIfPossible();
    return state.ui.getOptions();
  },
  setCalibration: (which, cal) => {
    const target = which === 'base' ? state.base : state.incoming;
    target.cal = cal;
    state.ui[which === 'base' ? 'setBaseImage' : 'setIncomingImage']({
      image: target.image,
      width: target.width,
      height: target.height,
      calibration: cal,
      label: target.label,
    });
    syncCalibrationInputs(which);
    invalidateAll();
    return cal;
  },
  setPick: (which, point) => {
    handleOriginChange(which, point);
    return (which === 'base' ? state.base : state.incoming).cal;
  },
  setOriginPx: (which, point) => handleOriginChange(which, point),
  setPpb: (which, ppb) => {
    $(which === 'base' ? 'mg-base-ppb' : 'mg-inc-ppb').value = String(ppb);
    handlePpbChange(which, Number(ppb));
  },
  setSaveName: (name) => state.ui.setSaveName(name),
  getSaveName: () => state.ui.getSaveName(),
};

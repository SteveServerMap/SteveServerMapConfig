/**
 * merge.js —— 地图合并页面的控制器
 *
 * 流程：
 *   1. 载入站点 config.json，把「第一个维度的地图」作为目标图（也可自己选文件）；
 *   2. 在新图上点一下世界 (0,0) + 填「每方块像素数」→ 得到它的校准；
 *   3. 「分析差异」= 把新图重采样到目标图网格 → 按 tile 分类 → 画叠加层 + 统计；
 *   4. 「按策略合并」= 按当前勾选合成 → 中间预览；
 *   5. 「下载 PNG」/「保存到站点」（写前自动备份到 .backups/）。
 *
 * 所有图像运算都在浏览器里完成；写盘只用已有的 /api/import-image。
 */

import { MergeUI } from './merge-ui.js';
import {
  TILE,
  calibrationFromOrigin,
  calibrationFromBounds,
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
    onParamsChange: () => markAnalysisStale('分析参数已改，请重新点「分析差异」'),
    onOptionChange: () => recomposeIfPossible(),
    onAction: handleAction,
    onOriginChange: (which, point) => handleOriginChange(which, point),
    onPpbChange: (which, ppb) => handlePpbChange(which, ppb),
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

/** 用站点 config.json 里第一个维度的地图作为默认目标图 */
async function loadDefaultBase() {
  let config = null;
  try {
    const res = await api('/api/site-config');
    if (res.ok) config = res.config;
  } catch (err) {
    console.warn('[merge] 读取站点 config.json 失败：', err);
  }
  const dim = config?.dimensions?.find((d) => d?.image) || null;
  if (!dim) {
    state.ui.setStatus('站点没有可用的地图，请手动选择目标图', 'warn');
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
    state.ui.setStatus(`目标图已载入：${dim.image}（${width}×${height}）`, 'ok');
  } catch (err) {
    state.ui.setStatus(`载入站点地图失败：${err.message}`, 'error');
  }
}

async function loadBaseFromFile(file) {
  try {
    const image = await fileToImage(file);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    let cal = state.base.cal;
    if (!cal) {
      // 新载入的自定义目标图：如果之前有校准就沿用比例，原点待拾取
      cal = null;
    }
    applyBase({ image, width, height, cal: null, fileName: file.name, label: '本地文件' });
    state.ui.setBaseImage({ image, width, height, calibration: cal, label: '本地文件（请拾取 (0,0)）' });
    state.ui.setSaveName(file.name);
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
    state.ui.setStatus('新图已载入：在新图上点一下世界 (0,0) 的位置', 'warn');
    invalidateAll();
  } catch (err) {
    state.ui.setStatus(`载入失败：${err.message}`, 'error');
  }
}

function applyBase({ image, width, height, cal, fileName, label }) {
  state.base = { image, width, height, cal, fileName, label };
  state.ui.setBaseImage({ image, width, height, calibration: cal, label });
  state.ui.setSaveName(fileName || 'merged.png');
  invalidateAll();
}

/* ============================== 拾取原点 ============================== */

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
    flipZ: false,
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
    px: Number($(`${prefix}-ox`)?.value),
    py: Number($(`${prefix}-oy`)?.value),
  };
  if (!(pxPerBlock > 0)) {
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
  state.analysisStale = true;
  if (state.analysis) state.ui.setStatus(message, 'warn');
}

/* ============================== 分析 / 合并 ============================== */

async function handleAction(name) {
  switch (name) {
    case 'analyze':
      return runAnalyze();
    case 'apply':
      return runCompose();
    case 'download':
      return downloadMerged();
    case 'save':
      return saveToSite();
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
  if (!state.analysis) {
    state.ui.setStatus('先点「分析差异」', 'warn');
    return;
  }
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
  if (!m) return null;
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
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
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
  state.ui.setBusy(true);
  try {
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

/* 调试接口（自动化测试用） */
window.__merge = {
  state,
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
  setParams: (params) => {
    state.ui.setParams(params);
    markAnalysisStale('参数已改');
  },
  setOptions: ({ fillNew, updateChanged }) => {
    if (typeof fillNew === 'boolean') $('mg-opt-fill').checked = fillNew;
    if (typeof updateChanged === 'boolean') $('mg-opt-update').checked = updateChanged;
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
    invalidateAll();
    return cal;
  },
  setPick: (which, point) => {
    const target = which === 'base' ? state.base : state.incoming;
    target.cal = calibrationFromOrigin({
      originPx: point.px,
      originPy: point.py,
      pxPerBlock: Number($(which === 'base' ? 'mg-base-ppb' : 'mg-inc-ppb').value) || 1,
      imageWidth: target.width,
      imageHeight: target.height,
    });
    state.ui.setPickMarker(which, point);
    state.ui[which === 'base' ? 'setBaseImage' : 'setIncomingImage']({
      image: target.image,
      width: target.width,
      height: target.height,
      calibration: target.cal,
      label: target.label,
    });
    invalidateAll();
    return target.cal;
  },
  setOriginPx: (which, point) => handleOriginChange(which, point),
  setPpb: (which, ppb) => {
    $(which === 'base' ? 'mg-base-ppb' : 'mg-inc-ppb').value = String(ppb);
    handlePpbChange(which, Number(ppb));
  },
  setSaveName: (name) => state.ui.setSaveName(name),
  getSaveName: () => state.ui.getSaveName(),
};

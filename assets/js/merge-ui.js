/**
 * merge-ui.js —— 地图合并页面的界面层
 *
 * 只做三件事：
 *   1. 把两张图 + 合并结果画到 3 个 canvas 上（letterbox 居中，点击换算成图片原始像素）；
 *   2. 把统计/校准/状态/提示写到既有 DOM 节点；
 *   3. 把用户操作通过回调交给 merge.js（控制器），自己不发网络请求、不做算法。
 *
 * DOM 全部来自 merge.html（Lead 拥有），这里只按 id 取用。
 */

const $ = (id) => document.getElementById(id);

/** 把 RGBA 数组画到 canvas（自动按需设置 canvas 尺寸） */
function putRGBA(canvas, data, width, height) {
  if (!canvas || !data || !width || !height) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgData = new ImageData(new Uint8ClampedArray(data), width, height);
  ctx.putImageData(imgData, 0, 0);
}

export class MergeUI {
  constructor(rootEl, {
    onPickBase = null,
    onPickIncoming = null,
    onBaseImage = null,
    onIncomingImage = null,
    onParamsChange = null,
    onOptionChange = null,
    onAction = null,
  } = {}) {
    this.root = rootEl || document;
    this.callbacks = { onPickBase, onPickIncoming, onBaseImage, onIncomingImage, onParamsChange, onOptionChange, onAction };

    /** @type {{image:HTMLImageElement|null,width:number,height:number,scale:number,offsetX:number,offsetY:number}} */
    this.base = { image: null, width: 0, height: 0, scale: 1, offsetX: 0, offsetY: 0 };
    this.incoming = { image: null, width: 0, height: 0, scale: 1, offsetX: 0, offsetY: 0 };
    this.baseCal = null;
    this.incomingCal = null;
    this.picks = { base: null, incoming: null };
    this.pickMode = null; // 'base' | 'incoming' | null
    this.analysis = null;
    this.merged = null;
    this.busy = false;

    this._bind();
    this._bindDrop('mg-base-drop', 'mg-base-file', 'base');
    this._bindDrop('mg-inc-drop', 'mg-inc-file', 'incoming');
    this.setStatus('等待载入地图', 'info');
    this._syncButtons();
  }

  /* ------------------------------ 绑定 ------------------------------ */

  _bind() {
    const act = (id, name) => $(id)?.addEventListener('click', () => {
      if (this.busy && id !== 'mg-back') return;
      this.callbacks.onAction?.(name);
    });
    act('mg-analyze', 'analyze');
    act('mg-apply', 'apply');
    act('mg-download', 'download');
    act('mg-save', 'save');
    act('mg-back', 'back');

    $('mg-base-pick')?.addEventListener('click', () => this._togglePick('base'));
    $('mg-inc-pick')?.addEventListener('click', () => this._togglePick('incoming'));

    $('mg-base-canvas')?.addEventListener('click', (event) => this._handleCanvasClick('base', event));
    $('mg-inc-canvas')?.addEventListener('click', (event) => this._handleCanvasClick('incoming', event));

    for (const [id, key] of [['mg-tile-size', 'tileSize'], ['mg-void-lum', 'voidLuminance'], ['mg-diff-thr', 'diffThreshold']]) {
      $(id)?.addEventListener('change', () => this.callbacks.onParamsChange?.(this.getParams()));
      $(id)?.addEventListener('input', () => this.callbacks.onParamsChange?.(this.getParams()));
      void key;
    }
    for (const [id, key] of [['mg-opt-fill', 'fillNew'], ['mg-opt-update', 'updateChanged']]) {
      $(id)?.addEventListener('change', () => this.callbacks.onOptionChange?.(this.getOptions()));
      void key;
    }
  }

  _bindDrop(dropId, inputId, which) {
    const drop = $(dropId);
    const input = $(inputId);
    if (drop) {
      const open = () => input?.click();
      drop.addEventListener('click', open);
      drop.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      drop.addEventListener('dragover', (event) => {
        event.preventDefault();
        drop.classList.add('is-over');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
      drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('is-over');
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) {
          this.setStatus('只能拖入图片文件（PNG/JPEG/WEBP）', 'error');
          return;
        }
        if (which === 'base') this.callbacks.onBaseImage?.(file);
        else this.callbacks.onIncomingImage?.(file);
      });
    }
    input?.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (which === 'base') this.callbacks.onBaseImage?.(file);
      else this.callbacks.onIncomingImage?.(file);
    });
  }

  _handleCanvasClick(which, event) {
    const side = which === 'base' ? this.base : this.incoming;
    if (!side.image) return;
    const canvas = $(which === 'base' ? 'mg-base-canvas' : 'mg-inc-canvas');
    const rect = canvas.getBoundingClientRect();
    // 画布 CSS 尺寸可能被缩放：换算回 canvas 像素坐标
    const cssScaleX = canvas.width / Math.max(1, rect.width);
    const cssScaleY = canvas.height / Math.max(1, rect.height);
    const canvasX = (event.clientX - rect.left) * cssScaleX;
    const canvasY = (event.clientY - rect.top) * cssScaleY;
    const px = (canvasX - side.offsetX) / (side.scale || 1);
    const py = (canvasY - side.offsetY) / (side.scale || 1);
    if (!(px >= 0 && px <= side.width && py >= 0 && py <= side.height)) {
      this.setStatus('点在图片外面了，请点在图片区域内', 'warn');
      return;
    }
    if (this.pickMode === which) {
      this._setPickMode(null);
      if (which === 'base') this.callbacks.onPickBase?.({ px, py });
      else this.callbacks.onPickIncoming?.({ px, py });
      return;
    }
    // 非拾取模式下点击 = 报告当前位置（便于微调，不改变任何状态）
    this.setStatus(`图片像素 (${Math.round(px)}, ${Math.round(py)})`, 'info');
  }

  _togglePick(which) {
    if (!(which === 'base' ? this.base.image : this.incoming.image)) {
      this.setStatus(`先载入${which === 'base' ? '目标图' : '新图'}`, 'warn');
      return;
    }
    this._setPickMode(this.pickMode === which ? null : which);
  }

  _setPickMode(which) {
    this.pickMode = which;
    for (const side of ['base', 'incoming']) {
      const btn = $(side === 'base' ? 'mg-base-pick' : 'mg-inc-pick');
      const canvas = $(side === 'base' ? 'mg-base-canvas' : 'mg-inc-canvas');
      const hint = $(side === 'base' ? 'mg-base-hint' : 'mg-inc-hint');
      const active = which === side;
      btn?.classList.toggle('is-active', active);
      btn?.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (canvas) canvas.style.cursor = active ? 'crosshair' : 'default';
      if (hint) {
        hint.hidden = !active;
        if (active) hint.textContent = '点击图片上世界 (0,0) 的位置（Esc 取消）';
      }
    }
    if (which) this.setStatus(`拾取模式：在${which === 'base' ? '目标图' : '新图'}上点一下世界 (0,0) 的位置`, 'warn');
    else this.setStatus('已退出拾取模式', 'info');
  }

  /* ------------------------------ 绘制 ------------------------------ */

  _drawSide(which) {
    const side = which === 'base' ? this.base : this.incoming;
    const canvas = $(which === 'base' ? 'mg-base-canvas' : 'mg-inc-canvas');
    const hint = $(which === 'base' ? 'mg-base-hint' : 'mg-inc-hint');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!side.image) {
      // 占位：深色棋盘
      const size = 16;
      for (let y = 0; y < canvas.height; y += size) {
        for (let x = 0; x < canvas.width; x += size) {
          ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#0e130f' : '#0a0d0b';
          ctx.fillRect(x, y, size, size);
        }
      }
      if (hint) hint.hidden = false;
      return;
    }
    if (hint) hint.hidden = true;

    const scale = Math.min(canvas.width / side.width, canvas.height / side.height);
    side.scale = scale;
    side.offsetX = (canvas.width - side.width * scale) / 2;
    side.offsetY = (canvas.height - side.height * scale) / 2;
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(side.image, side.offsetX, side.offsetY, side.width * scale, side.height * scale);

    // 目标图上叠加差异色块（只有在还没有合并结果时）
    if (which === 'base' && this.analysis && !this.merged) {
      this._drawAnalysisOverlay(ctx, side);
    }

    // 拾取标记
    const pick = this.picks[which];
    if (pick && Number.isFinite(pick.px)) {
      const x = side.offsetX + pick.px * side.scale;
      const y = side.offsetY + pick.py * side.scale;
      ctx.save();
      ctx.strokeStyle = '#5ad26f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 12, y);
      ctx.lineTo(x + 12, y);
      ctx.moveTo(x, y - 12);
      ctx.lineTo(x, y + 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(90,210,111,.9)';
      ctx.font = '12px ui-monospace, Consolas, monospace';
      ctx.fillText('(0,0)', x + 8, y - 8);
      ctx.restore();
    }
  }

  _drawAnalysisOverlay(ctx, side) {
    const a = this.analysis;
    const tile = a.tileSize;
    const colors = { 1: null, 2: 'rgba(90,210,111,.55)', 3: 'rgba(255,188,75,.55)' };
    ctx.save();
    for (let ty = 0; ty < a.rows; ty += 1) {
      for (let tx = 0; tx < a.cols; tx += 1) {
        const cls = a.map[ty * a.cols + tx];
        const color = colors[cls];
        if (!color) continue;
        const x = side.offsetX + tx * tile * side.scale;
        const y = side.offsetY + ty * tile * side.scale;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, tile * side.scale, tile * side.scale);
      }
    }
    ctx.restore();
  }

  /* ------------------------------ 对外 API ------------------------------ */

  setStatus(text, tone = 'info') {
    const el = $('mg-status');
    if (el) {
      el.textContent = text;
      el.dataset.tone = tone;
    }
  }

  toast(message, tone = 'info', duration = 2600) {
    const el = $('mg-toast');
    if (!el) return;
    el.textContent = message;
    el.dataset.tone = tone;
    el.hidden = false;
    el.classList.add('is-show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.classList.remove('is-show');
      setTimeout(() => {
        el.hidden = true;
      }, 220);
    }, duration);
  }

  setBaseImage({ image, width, height, calibration = null, label = '' } = {}) {
    this.base = { ...this.base, image: image || null, width: width || 0, height: height || 0 };
    this.baseCal = calibration;
    const meta = $('mg-base-meta');
    if (meta) meta.textContent = image ? `${width}×${height}px${label ? ` · ${label}` : ''}` : '未载入';
    this._updateCalText('base');
    this._drawSide('base');
    this.setStatus(image ? '目标图已载入' : '未载入目标图', image ? 'ok' : 'info');
  }

  setIncomingImage({ image, width, height, calibration = null, label = '' } = {}) {
    this.incoming = { ...this.incoming, image: image || null, width: width || 0, height: height || 0 };
    this.incomingCal = calibration;
    const meta = $('mg-inc-meta');
    if (meta) meta.textContent = image ? `${width}×${height}px${label ? ` · ${label}` : ''}` : '未载入';
    this._updateCalText('incoming');
    this._drawSide('incoming');
    if (image) this.setStatus('新图已载入，接下来在新图上点一下世界 (0,0)', 'ok');
  }

  _updateCalText(which) {
    const cal = which === 'base' ? this.baseCal : this.incomingCal;
    const el = $(which === 'base' ? 'mg-base-cal' : 'mg-inc-cal');
    if (!el) return;
    if (!cal) {
      el.textContent = '尚未设置原点';
      return;
    }
    const fmt = (v) => (Number.isFinite(v) ? Math.round(v) : '—');
    el.textContent = `X ${fmt(cal.xMin)} → ${fmt(cal.xMax)} · Z ${fmt(cal.zMin)} → ${fmt(cal.zMax)}`;
  }

  setPickMarker(which, point) {
    if (which === 'base') this.picks.base = point || null;
    else this.picks.incoming = point || null;
    this._drawSide(which);
    this._updateCalText(which);
  }

  setAnalysis(analysis) {
    this.analysis = analysis || null;
    this.merged = null;
    const stats = $('mg-stats');
    if (stats) {
      const cells = stats.querySelectorAll('.mg-stat');
      if (cells.length >= 4) {
        const setCell = (i, value, unit) => {
          const b = cells[i].querySelector('b');
          const span = cells[i].querySelector('span');
          if (b) b.textContent = String(value);
          if (span && unit) span.textContent = unit;
        };
        setCell(0, analysis ? analysis.counts.onlyIncoming : '—', '新增');
        setCell(1, analysis ? analysis.counts.changed : '—', '变更');
        setCell(2, analysis ? analysis.counts.onlyBase : '—', '仅目标图');
        const area = analysis ? Math.round(analysis.blocksArea.onlyIncoming + analysis.blocksArea.changed) : null;
        setCell(3, area == null ? '—' : area.toLocaleString('zh-CN'), '方块²');
      }
    }
    const hint = $('mg-result-hint');
    if (hint) hint.hidden = !!analysis;
    if (analysis) {
      this.setStatus(
        `分析完成：新增 ${analysis.counts.onlyIncoming} 格 · 变更 ${analysis.counts.changed} 格 · 仅目标图 ${analysis.counts.onlyBase} 格`,
        'ok',
      );
    }
    this._drawSide('base');
    this._syncButtons();
  }

  setMergedPreview(payload = {}) {
    const { data, width, height } = payload || {};
    if (!data) {
      this.merged = null;
      const canvas = $('mg-result-canvas');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      const hint = $('mg-result-hint');
      if (hint) hint.hidden = false;
      this._syncButtons();
      return;
    }
    this.merged = { width, height };
    putRGBA($('mg-result-canvas'), data, width, height);
    const hint = $('mg-result-hint');
    if (hint) hint.hidden = true;
    // 合并后 target 图上的差异叠加层就不需要了
    this._drawSide('base');
    this._syncButtons();
  }

  setParams(params = {}) {
    if (Number.isFinite(params.tileSize)) $('mg-tile-size').value = String(params.tileSize);
    if (Number.isFinite(params.voidLuminance)) $('mg-void-lum').value = String(params.voidLuminance);
    if (Number.isFinite(params.diffThreshold)) $('mg-diff-thr').value = String(params.diffThreshold);
  }

  getParams() {
    return {
      tileSize: Number($('mg-tile-size')?.value) || 16,
      voidLuminance: Number($('mg-void-lum')?.value) || 0,
      diffThreshold: Number($('mg-diff-thr')?.value) || 24,
    };
  }

  getOptions() {
    return {
      fillNew: $('mg-opt-fill')?.checked !== false,
      updateChanged: $('mg-opt-update')?.checked !== false,
    };
  }

  setSaveName(name) {
    const el = $('mg-save-name');
    if (el && name) el.value = name;
  }

  getSaveName() {
    return String($('mg-save-name')?.value || '').trim();
  }

  setBusy(busy) {
    this.busy = !!busy;
    this._syncButtons();
    if (busy) this.setStatus('处理中…', 'info');
  }

  _syncButtons() {
    const hasAnalysis = !!this.analysis;
    const hasMerged = !!this.merged;
    const apply = $('mg-apply');
    const download = $('mg-download');
    const save = $('mg-save');
    if (apply) apply.disabled = this.busy || !hasAnalysis;
    if (download) download.disabled = this.busy || !hasMerged;
    if (save) save.disabled = this.busy || !hasMerged;
    const analyze = $('mg-analyze');
    if (analyze) analyze.disabled = this.busy || !(this.base.image && this.incoming.image);
  }

  /** 退出拾取模式（Esc 用） */
  cancelPick() {
    if (this.pickMode) this._setPickMode(null);
  }

  get pickModeName() {
    return this.pickMode;
  }

  /** 让控制器也能刷新画布（例如改变缩放后） */
  redraw() {
    this._drawSide('base');
    this._drawSide('incoming');
  }

  destroy() {
    clearTimeout(this._toastTimer);
  }
}

export default MergeUI;

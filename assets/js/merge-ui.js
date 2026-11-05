/**
 * merge-ui.js —— 地图合并页面的界面层
 *
 * 三个 canvas（目标图 / 新图 / 合并结果）共用一个小型视图器 CanvasView：
 *   · 滚轮以光标为锚点缩放、拖拽平移、双击放大、按钮 +/−/适应、键盘 +/- 与方向键平移；
 *   · 画布右下角实时显示「图片像素」坐标，配合缩放可以精确到 1 像素；
 *   · 原点还可以直接输入数字，或用方向键 / 微调按钮挪 1 像素 —— 不用凭感觉点。
 *
 * 本模块只负责显示与交互，不做算法，也不发网络请求。
 */

const $ = (id) => document.getElementById(id);

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** 单张图片的缩放/平移视图器 */
class CanvasView {
  constructor(canvas, { onPick = null, onHover = null, onZoom = null, allowPick = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.onPick = onPick;
    this.onHover = onHover;
    this.onZoom = onZoom;
    this.allowPick = allowPick;

    this.image = null;
    this.width = 0;
    this.height = 0;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.minScale = 0.01;
    this.maxScale = 40;
    this.pick = null;
    this.overlay = null;
    this.cursor = null;
    this.userAdjusted = false;
    this.dpr = 1;
    this._drag = null;

    this._bind();
    this._observeSize();
  }

  _bind() {
    const canvas = this.canvas;

    canvas.addEventListener('wheel', (event) => {
      if (!this.image) return;
      event.preventDefault();
      this.zoomAt(Math.exp(-event.deltaY * 0.0016), this._localPoint(event));
    }, { passive: false });

    canvas.addEventListener('pointerdown', (event) => {
      if (!this.image) return;
      canvas.setPointerCapture?.(event.pointerId);
      this._drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        startTx: this.tx,
        startTy: this.ty,
      };
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (event) => {
      const local = this._localPoint(event);
      this.cursor = local;
      if (this._drag && this._drag.id === event.pointerId) {
        const dx = event.clientX - this._drag.x;
        const dy = event.clientY - this._drag.y;
        if (!this._drag.moved && Math.hypot(dx, dy) > 3) this._drag.moved = true;
        if (this._drag.moved) {
          this.tx = this._drag.startTx + dx;
          this.ty = this._drag.startTy + dy;
          this.userAdjusted = true;
          this.draw();
        }
        return;
      }
      this.draw();
      this.onHover?.(this.toImagePoint(local));
    });

    const endDrag = (event) => {
      if (!this._drag || this._drag.id !== event.pointerId) return;
      const drag = this._drag;
      this._drag = null;
      canvas.style.cursor = this.allowPick ? 'crosshair' : 'grab';
      if (!drag.moved) {
        const local = this._localPoint(event);
        this.onPick?.(this.toImagePoint(local), local);
      }
      this.draw();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', () => {
      this._drag = null;
      canvas.style.cursor = this.allowPick ? 'crosshair' : 'grab';
    });
    canvas.addEventListener('pointerleave', () => {
      this.cursor = null;
      this.draw();
      this.onHover?.(null);
    });

    canvas.addEventListener('dblclick', (event) => {
      if (!this.image) return;
      event.preventDefault();
      this.zoomAt(1.6, this._localPoint(event));
    });

    canvas.addEventListener('keydown', (event) => {
      if (!this.image) return;
      const step = 24;
      const center = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
      switch (event.key) {
        case '+':
        case '=':
          event.preventDefault();
          this.zoomAt(1.25, center);
          break;
        case '-':
        case '_':
          event.preventDefault();
          this.zoomAt(1 / 1.25, center);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          this.tx -= step;
          this.userAdjusted = true;
          this.draw();
          break;
        case 'ArrowRight':
          event.preventDefault();
          this.tx += step;
          this.userAdjusted = true;
          this.draw();
          break;
        case 'ArrowUp':
          event.preventDefault();
          this.ty -= step;
          this.userAdjusted = true;
          this.draw();
          break;
        case 'ArrowDown':
          event.preventDefault();
          this.ty += step;
          this.userAdjusted = true;
          this.draw();
          break;
        default:
          break;
      }
    });
  }

  _observeSize() {
    const sync = () => {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      this.dpr = dpr;
      if (this.image && !this.userAdjusted) this.fit();
      else this.draw();
    };
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(sync);
      this._ro.observe(this.canvas);
    }
    requestAnimationFrame(sync);
  }

  _localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /* ------------------------------ 变换 ------------------------------ */

  setImage(image, width, height) {
    this.image = image || null;
    this.width = width || 0;
    this.height = height || 0;
    this.userAdjusted = false;
    if (this.image) {
      this.fit();
      this.canvas.style.cursor = this.allowPick ? 'crosshair' : 'grab';
    } else {
      this.pick = null;
      this.overlay = null;
      this.draw();
      this.canvas.style.cursor = 'default';
    }
  }

  fit() {
    const cw = this.canvas.clientWidth || this.canvas.width || 1;
    const ch = this.canvas.clientHeight || this.canvas.height || 1;
    if (!this.width || !this.height) {
      this.draw();
      return;
    }
    const pad = 10;
    const scale = Math.min((cw - pad * 2) / this.width, (ch - pad * 2) / this.height);
    this.scale = clamp(scale, this.minScale, this.maxScale);
    this.tx = (cw - this.width * this.scale) / 2;
    this.ty = (ch - this.height * this.scale) / 2;
    this.userAdjusted = false;
    this.draw();
    this.onZoom?.(this.scale);
  }

  zoomAt(factor, point) {
    const anchor = point || { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 };
    const next = clamp(this.scale * factor, this.minScale, this.maxScale);
    if (next === this.scale) return;
    const ratio = next / this.scale;
    this.tx = anchor.x - (anchor.x - this.tx) * ratio;
    this.ty = anchor.y - (anchor.y - this.ty) * ratio;
    this.scale = next;
    this.userAdjusted = true;
    this.draw();
    this.onZoom?.(this.scale);
  }

  zoomBy(factor) {
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    this.zoomAt(factor, this.cursor || { x: cw / 2, y: ch / 2 });
  }

  /** 让某个图片像素居中并（可选）设成指定比例 */
  focusPixel(px, py, scale = null) {
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    if (scale && scale > 0) this.scale = clamp(scale, this.minScale, this.maxScale);
    this.tx = cw / 2 - px * this.scale;
    this.ty = ch / 2 - py * this.scale;
    this.userAdjusted = true;
    this.draw();
    this.onZoom?.(this.scale);
  }

  toImagePoint(local) {
    if (!local || !(this.scale > 0)) return { px: NaN, py: NaN };
    return { px: (local.x - this.tx) / this.scale, py: (local.y - this.ty) / this.scale };
  }

  setPick(point) {
    this.pick = point && Number.isFinite(point.px) ? { px: point.px, py: point.py } : null;
    this.draw();
  }

  setOverlay(overlay) {
    this.overlay = overlay || null;
    this.draw();
  }

  /* ------------------------------ 绘制 ------------------------------ */

  draw() {
    const ctx = this.ctx;
    const cw = this.canvas.clientWidth || this.canvas.width / this.dpr || 1;
    const ch = this.canvas.clientHeight || this.canvas.height / this.dpr || 1;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    if (!this.image) {
      const size = 14;
      for (let y = 0; y < ch; y += size) {
        for (let x = 0; x < cw; x += size) {
          ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#0e130f' : '#0a0d0b';
          ctx.fillRect(x, y, size, size);
        }
      }
      return;
    }

    ctx.imageSmoothingEnabled = this.scale < 1;
    ctx.drawImage(this.image, this.tx, this.ty, this.width * this.scale, this.height * this.scale);

    if (this.overlay) {
      const { map, cols, rows, tileSize } = this.overlay;
      const colors = { 2: 'rgba(90,210,111,.55)', 3: 'rgba(255,188,75,.55)' };
      for (let ty = 0; ty < rows; ty += 1) {
        for (let tx = 0; tx < cols; tx += 1) {
          const color = colors[map[ty * cols + tx]];
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(
            this.tx + tx * tileSize * this.scale,
            this.ty + ty * tileSize * this.scale,
            tileSize * this.scale,
            tileSize * this.scale,
          );
        }
      }
    }

    if (this.pick) {
      const x = this.tx + this.pick.px * this.scale;
      const y = this.ty + this.pick.py * this.scale;
      ctx.save();
      ctx.strokeStyle = '#5ad26f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 14, y);
      ctx.lineTo(x + 14, y);
      ctx.moveTo(x, y - 14);
      ctx.lineTo(x, y + 14);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(90,210,111,.95)';
      ctx.font = '12px ui-monospace, Consolas, monospace';
      ctx.fillText(`(0,0) px ${Math.round(this.pick.px)}, ${Math.round(this.pick.py)}`, x + 10, y - 10);
      ctx.restore();
    }

    if (this.cursor) {
      const { x, y } = this.cursor;
      ctx.save();
      ctx.strokeStyle = 'rgba(200,220,205,.32)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, ch);
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(cw, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();
    }
  }

  destroy() {
    this._ro?.disconnect();
  }
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
    onOriginChange = null,
    onPpbChange = null,
  } = {}) {
    this.root = rootEl || document;
    this.callbacks = {
      onPickBase, onPickIncoming, onBaseImage, onIncomingImage,
      onParamsChange, onOptionChange, onAction, onOriginChange, onPpbChange,
    };

    this.pickMode = null;
    this.analysis = null;
    this.merged = null;
    this.busy = false;
    this.baseCal = null;
    this.incomingCal = null;

    this.baseView = new CanvasView($('mg-base-canvas'), {
      onPick: (point) => this._handleCanvasPick('base', point),
      onHover: (point) => this._updateCursorText('base', point),
      onZoom: (scale) => this._updateZoomText('base', scale),
    });
    this.incomingView = new CanvasView($('mg-inc-canvas'), {
      onPick: (point) => this._handleCanvasPick('incoming', point),
      onHover: (point) => this._updateCursorText('incoming', point),
      onZoom: (scale) => this._updateZoomText('incoming', scale),
    });
    this.resultView = new CanvasView($('mg-result-canvas'), {
      onHover: (point) => this._updateCursorText('result', point),
      onZoom: (scale) => this._updateZoomText('result', scale),
      allowPick: false,
    });

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

    for (const [side, view] of [['base', this.baseView], ['incoming', this.incomingView], ['result', this.resultView]]) {
      const prefix = side === 'incoming' ? 'mg-inc' : side === 'base' ? 'mg-base' : 'mg-result';
      $(`${prefix}-zoom-in`)?.addEventListener('click', () => view.zoomBy(1.35));
      $(`${prefix}-zoom-out`)?.addEventListener('click', () => view.zoomBy(1 / 1.35));
      $(`${prefix}-zoom-fit`)?.addEventListener('click', () => view.fit());
    }

    for (const side of ['base', 'incoming']) {
      const prefix = side === 'base' ? 'mg-base' : 'mg-inc';
      const fire = () => {
        const ox = Number($(`${prefix}-ox`)?.value);
        const oy = Number($(`${prefix}-oy`)?.value);
        if (Number.isFinite(ox) && Number.isFinite(oy)) this.callbacks.onOriginChange?.(side, { px: ox, py: oy });
      };
      $(`${prefix}-ox`)?.addEventListener('change', fire);
      $(`${prefix}-oy`)?.addEventListener('change', fire);
      $(`${prefix}-ppb`)?.addEventListener('change', () => {
        this.callbacks.onPpbChange?.(side, Number($(`${prefix}-ppb`)?.value));
      });
    }

    for (const btn of document.querySelectorAll('[data-nudge]')) {
      btn.addEventListener('click', () => {
        const [side, dx, dy] = String(btn.dataset.nudge).split(':');
        this._nudgeOrigin(side, Number(dx), Number(dy));
      });
    }

    // 焦点在图上时 Alt+方向键 = 微调原点 1 像素
    for (const [side, canvas] of [['base', $('mg-base-canvas')], ['incoming', $('mg-inc-canvas')]]) {
      canvas?.addEventListener('keydown', (event) => {
        if (!event.altKey) return;
        const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const delta = map[event.key];
        if (!delta) return;
        event.preventDefault();
        this._nudgeOrigin(side, delta[0], delta[1]);
      });
    }

    for (const id of ['mg-tile-size', 'mg-void-lum', 'mg-diff-thr']) {
      $(id)?.addEventListener('change', () => this.callbacks.onParamsChange?.(this.getParams()));
      $(id)?.addEventListener('input', () => this.callbacks.onParamsChange?.(this.getParams()));
    }
    for (const id of ['mg-opt-fill', 'mg-opt-update']) {
      $(id)?.addEventListener('change', () => this.callbacks.onOptionChange?.(this.getOptions()));
    }
  }

  _nudgeOrigin(side, dx, dy) {
    const view = side === 'base' ? this.baseView : this.incomingView;
    const prefix = side === 'base' ? 'mg-base' : 'mg-inc';
    const pick = view.pick || {
      px: Number($(`${prefix}-ox`)?.value),
      py: Number($(`${prefix}-oy`)?.value),
    };
    if (!Number.isFinite(pick.px) || !Number.isFinite(pick.py)) {
      this.setStatus('先拾取一次原点（或在「原点像素」里填数字），再用方向键微调', 'warn');
      return;
    }
    this.callbacks.onOriginChange?.(side, { px: Math.round(pick.px) + dx, py: Math.round(pick.py) + dy });
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

  _handleCanvasPick(which, point) {
    if (!point || !Number.isFinite(point.px)) return;
    if (this.pickMode === which) {
      this._setPickMode(null);
      const rounded = { px: Math.round(point.px), py: Math.round(point.py) };
      if (which === 'base') this.callbacks.onPickBase?.(rounded);
      else this.callbacks.onPickIncoming?.(rounded);
      return;
    }
    this.setStatus(
      `图片像素 (${Math.round(point.px)}, ${Math.round(point.py)}) —— 点「拾取 (0,0)」把它设为世界原点，或直接填右下角数字`,
      'info',
    );
  }

  _togglePick(which) {
    const view = which === 'base' ? this.baseView : this.incomingView;
    if (!view.image) {
      this.setStatus(`先载入${which === 'base' ? '目标图' : '新图'}`, 'warn');
      return;
    }
    this._setPickMode(this.pickMode === which ? null : which);
  }

  _setPickMode(which) {
    this.pickMode = which;
    for (const side of ['base', 'incoming']) {
      const btn = $(side === 'base' ? 'mg-base-pick' : 'mg-inc-pick');
      const hint = $(side === 'base' ? 'mg-base-hint' : 'mg-inc-hint');
      const active = which === side;
      btn?.classList.toggle('is-active', active);
      btn?.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (hint) {
        hint.hidden = !active;
        if (active) hint.textContent = '点击图片上世界 (0,0) 的位置（Esc 取消）· 可先滚轮放大到像素级';
      }
    }
    if (which) this.setStatus(`拾取模式：在${which === 'base' ? '目标图' : '新图'}上点一下世界 (0,0)（先滚轮放大更准）`, 'warn');
    else this.setStatus('已退出拾取模式', 'info');
  }

  /* ------------------------------ 文本 ------------------------------ */

  _updateCursorText(side, point) {
    const prefix = side === 'base' ? 'mg-base' : side === 'incoming' ? 'mg-inc' : 'mg-result';
    const el = $(`${prefix}-cursor`);
    if (!el) return;
    if (!point || !Number.isFinite(point.px)) {
      el.textContent = 'px —, —';
      return;
    }
    const inside = point.px >= 0 && point.py >= 0;
    el.textContent = `px ${Math.round(point.px)}, ${Math.round(point.py)}${inside ? '' : '（图外）'}`;
  }

  _updateZoomText(side, scale) {
    const prefix = side === 'base' ? 'mg-base' : side === 'incoming' ? 'mg-inc' : 'mg-result';
    const el = $(`${prefix}-zoom`);
    if (el) el.textContent = `${Math.round((scale || 0) * 100)}%`;
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

  setBaseImage({ image, width, height, calibration = null, label = '', origin = null } = {}) {
    this.baseView.setImage(image || null, width || 0, height || 0);
    this.baseCal = calibration || null;
    const meta = $('mg-base-meta');
    if (meta) meta.textContent = image ? `${width}×${height}px${label ? ` · ${label}` : ''}` : '未载入';
    if (origin) this._reflectOrigin('base', origin);
    this._updateCalText('base');
    this._updateZoomText('base', this.baseView.scale);
    this.setStatus(image ? '目标图已载入（滚轮缩放 / 拖动平移）' : '未载入目标图', image ? 'ok' : 'info');
  }

  setIncomingImage({ image, width, height, calibration = null, label = '', origin = null } = {}) {
    this.incomingView.setImage(image || null, width || 0, height || 0);
    this.incomingCal = calibration || null;
    const meta = $('mg-inc-meta');
    if (meta) meta.textContent = image ? `${width}×${height}px${label ? ` · ${label}` : ''}` : '未载入';
    if (origin) this._reflectOrigin('incoming', origin);
    this._updateCalText('incoming');
    this._updateZoomText('incoming', this.incomingView.scale);
    if (image) this.setStatus('新图已载入：可先用滚轮放大到能看到方块边界，再拾取 (0,0)', 'ok');
  }

  _reflectOrigin(side, { px, py }) {
    const prefix = side === 'base' ? 'mg-base' : 'mg-inc';
    const ox = $(`${prefix}-ox`);
    const oy = $(`${prefix}-oy`);
    if (ox) ox.value = String(Math.round(px));
    if (oy) oy.value = String(Math.round(py));
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
    const view = which === 'base' ? this.baseView : this.incomingView;
    view.setPick(point || null);
    if (point) this._reflectOrigin(which, point);
    this._updateCalText(which);
  }

  /** 把拾取点居中并放大到能看清像素的级别（供控制器在拾取后调用） */
  focusOrigin(which, scale = 6) {
    const view = which === 'base' ? this.baseView : this.incomingView;
    if (!view.pick) return;
    view.focusPixel(view.pick.px + 0.5, view.pick.py + 0.5, scale);
  }

  setAnalysis(analysis) {
    this.analysis = analysis || null;
    this.merged = null;
    this.baseView.setOverlay(
      analysis ? { map: analysis.map, cols: analysis.cols, rows: analysis.rows, tileSize: analysis.tileSize } : null,
    );
    const stats = $('mg-stats');
    if (stats) {
      const cells = stats.querySelectorAll('.mg-stat');
      const setCell = (i, value) => {
        const b = cells[i]?.querySelector('b');
        if (b) b.textContent = String(value);
      };
      if (cells.length >= 4) {
        setCell(0, analysis ? analysis.counts.onlyIncoming : '—');
        setCell(1, analysis ? analysis.counts.changed : '—');
        setCell(2, analysis ? analysis.counts.onlyBase : '—');
        const area = analysis ? Math.round(analysis.blocksArea.onlyIncoming + analysis.blocksArea.changed) : null;
        setCell(3, area == null ? '—' : area.toLocaleString('zh-CN'));
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
    this._syncButtons();
  }

  setMergedPreview(payload = {}) {
    const { data, width, height } = payload || {};
    if (!data) {
      this.merged = null;
      this.resultView.setImage(null, 0, 0);
      const hint = $('mg-result-hint');
      if (hint) hint.hidden = false;
      this._syncButtons();
      return;
    }
    this.merged = { width, height };
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    this.resultView.setImage(canvas, width, height);
    const hint = $('mg-result-hint');
    if (hint) hint.hidden = true;
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
    if ($('mg-apply')) $('mg-apply').disabled = this.busy || !hasAnalysis;
    if ($('mg-download')) $('mg-download').disabled = this.busy || !hasMerged;
    if ($('mg-save')) $('mg-save').disabled = this.busy || !hasMerged;
    if ($('mg-analyze')) $('mg-analyze').disabled = this.busy || !(this.baseView.image && this.incomingView.image);
  }

  cancelPick() {
    if (this.pickMode) this._setPickMode(null);
  }

  get pickModeName() {
    return this.pickMode;
  }

  redraw() {
    this.baseView.draw();
    this.incomingView.draw();
    this.resultView.draw();
  }

  destroy() {
    clearTimeout(this._toastTimer);
    this.baseView.destroy();
    this.incomingView.destroy();
    this.resultView.destroy();
  }
}

export default MergeUI;

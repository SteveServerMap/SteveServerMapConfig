/**
 * assets/js/canvas.js —— 编辑画布（EditorCanvas）
 * =============================================================================
 * 只操作 index.html 里已经存在的节点（全部用 container.querySelector 找，不创建同名节点）：
 *   #canvas-root     容器（tabindex=0，接收键盘焦点）
 *   #canvas-stage    被 transform 的图层（内含 img#canvas-image）
 *   #canvas-image    底图（必须严格按原始像素布局，否则标记与底图错位）
 *   #canvas-overlay  屏幕坐标覆盖层（不缩放；标记 / 网格 / 拾取点都画在这里）
 *   #canvas-empty / #mode-badge / #coord-readout / #zoom-level
 *   #zoom-in / #zoom-out / #btn-fit
 *
 * 变换语义（CONTRACT §3，本模块唯一真相）：
 *   图片像素 (px, py) → 容器 CSS 像素 (sx, sy) = (tx + px * scale, ty + py * scale)
 *   #canvas-stage 用 transform: translate3d(tx, ty, 0) scale(scale)，transform-origin: 0 0。
 *   CSS transform 自右向左作用：先 scale 再 translate，正好等价于上式。
 *
 * 分工边界：
 *   - 世界坐标 ↔ 图片像素的**唯一**实现来自站点的 /preview/assets/js/coords.js
 *     （createProjection），本文件绝不自己写一份投影数学。
 *   - 父模块（app.js）通过 setData / setProjection 把数据推进来；本模块只负责渲染与交互，
 *     所有用户动作用回调上报（onMarkerClick / onMarkerDrag* / onEmptyClick / onHover）。
 *   - 样式由 assets/css/tool.css 负责；本模块只在 JS 里写「语义必需」的兜底内联样式
 *     （transform-origin / position / width-height / touch-action / pointer-events），
 *     保证 CSS 还没就位时也不会错位。
 *
 * 安全：
 *   - 无图片、无投影、空 waypoints、脏数据（NaN / 缺字段）一律安全降级，最多 console.warn。
 *   - 外部回调统一 try/catch，app 报错不会把画布引擎带崩。
 *
 * 性能：
 *   - 每帧只写 transform / classList，不读布局、不重建 DOM；
 *   - 标记位移小于 0.25px 时不写 DOM；offscreen 类只在状态翻转时切换。
 */

import { createProjection } from '/preview/assets/js/coords.js';
import { TileLayer } from '/preview/assets/js/tiles.js';

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

const MIN_SCALE = 0.02;
const MAX_SCALE = 16;
const WHEEL_ZOOM_RATE = 0.0015;   // scale *= exp(-deltaY * rate)
const KEY_ZOOM_STEP = 1.25;       // 键盘 / 按钮单次缩放倍率
const DBLCLICK_ZOOM = 1.6;
const DRAG_THRESHOLD = 4;         // 平移判定阈值（px）：超过才算拖拽，避免把点击误判成拖拽
const MARKER_DRAG_THRESHOLD = 3;  // 标记拖拽阈值（px，契约要求 >3px 才算拖拽）
const ANIM_DURATION = 220;        // 视图动画时长（ms）
const FIT_PADDING = 24;           // 整图适配留白（px）
const POS_EPS = 0.25;             // 标记位置写 DOM 的最小变化量（px）
const DEFAULT_COLOR = '#5ad26f';
const LABEL_MODES = ['always', 'hover', 'never'];
const MODES = ['select', 'place'];
const OFFSCREEN = '-9999px';

/** 这些 UI 子元素上的滚轮 / 指针事件不参与地图拖拽与地图点击（标记由本文件单独处理） */
const IGNORE_SELECTOR = [
  '.zoom-panel',
  '.marker-popup',
  '.mode-badge',
  '.coord-readout',
  '.canvas-hint',
  '.canvas-empty',
  '.modal',
].join(', ');

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** 写进 transform 的数值：限制到 4 位小数，避免超长字符串与亚像素抖动 */
function n4(v) {
  return Math.round(v * 1e4) / 1e4;
}

/** 外部回调统一包一层 try/catch：app / 标记层的异常不应该把画布引擎带崩 */
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch (err) {
    console.error('[EditorCanvas] 回调执行失败：', err);
  }
}

/** 有限数字或 null（避免把 NaN 泄进 DOM / 表单） */
function numOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

/* -------------------------------------------------------------------------- */
/* EditorCanvas                                                                */
/* -------------------------------------------------------------------------- */

export class EditorCanvas {
  /**
   * @param {HTMLElement} container #canvas-root
   * @param {object} [callbacks]
   * @param {(state: object) => void} [callbacks.onViewChange]       每帧视图变化
   * @param {(id: string, info: {clientX:number, clientY:number}) => void} [callbacks.onMarkerClick] 点击标记（未拖动）
   * @param {(id: string, info: object) => void} [callbacks.onMarkerDragStart] 标记开始拖拽
   * @param {(id: string, info: object) => void} [callbacks.onMarkerDrag] 标记拖拽中
   * @param {(result: {id: string, world: {x:number,z:number}|null}) => void} [callbacks.onMarkerDragEnd] 松手
   * @param {(point: {px:number, py:number, world: object|null}) => void} [callbacks.onEmptyClick] 普通模式点击空白
   * @param {(world: {x:number,z:number}|null) => void} [callbacks.onHover] 悬停（移出传 null）
   */
  constructor(container, {
    onViewChange,
    onMarkerClick,
    onMarkerDragStart,
    onMarkerDrag,
    onMarkerDragEnd,
    onEmptyClick,
    onHover,
  } = {}) {
    if (!container || typeof container.querySelector !== 'function') {
      throw new Error('[EditorCanvas] 构造函数需要一个容器元素（#canvas-root）');
    }

    this.container = container;
    this.stage = container.querySelector('#canvas-stage') || container.querySelector('.canvas-stage');
    this.imageEl = container.querySelector('#canvas-image')
      || (this.stage ? this.stage.querySelector('img') : null);
    this.overlay = container.querySelector('#canvas-overlay') || container.querySelector('.canvas-overlay');
    this.emptyEl = container.querySelector('#canvas-empty');
    this.modeBadge = container.querySelector('#mode-badge');
    this.coordEl = container.querySelector('#coord-readout');
    this.zoomLevelEl = container.querySelector('#zoom-level');
    this.zoomInBtn = container.querySelector('#zoom-in');
    this.zoomOutBtn = container.querySelector('#zoom-out');
    this.fitBtn = container.querySelector('#btn-fit');

    this._callbacks = {
      onViewChange: typeof onViewChange === 'function' ? onViewChange : null,
      onMarkerClick: typeof onMarkerClick === 'function' ? onMarkerClick : null,
      onMarkerDragStart: typeof onMarkerDragStart === 'function' ? onMarkerDragStart : null,
      onMarkerDrag: typeof onMarkerDrag === 'function' ? onMarkerDrag : null,
      onMarkerDragEnd: typeof onMarkerDragEnd === 'function' ? onMarkerDragEnd : null,
      onEmptyClick: typeof onEmptyClick === 'function' ? onEmptyClick : null,
      onHover: typeof onHover === 'function' ? onHover : null,
    };

    // ---- 视图状态（本模块唯一真相） ----
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.minScale = MIN_SCALE;
    this.maxScale = MAX_SCALE;
    /** true 时最小缩放取「整图适配」（和站点一致，避免把地图缩成一个点） */
    this._minScaleFit = true;
    this._viewW = container.clientWidth || 0;
    this._viewH = container.clientHeight || 0;

    // ---- 底图 / 投影 ----
    this._imageSize = null;        // {width, height} 图片原始像素
    this._projection = null;       // coords.createProjection 的产物
    this._pendingProjection = null; // 图片尺寸未知时暂存，等 setImage 后补建
    this._loadToken = 0;

    // ---- 数据 ----
    this._waypoints = [];
    this._groups = [];
    this._byId = new Map();
    this._els = new Map();
    this._pos = new Map();
    this._groupVisible = new Map();
    this._filter = null;
    this._selection = null;
    this._hoverId = null;
    this._labelMode = 'hover';
    this._mode = 'select';
    this._gridVisible = false;

    // ---- 交互状态 ----
    this._pointers = new Map();    // pointerId -> {x, y}（client 坐标）
    this._pan = null;
    this._markerDrag = null;
    /** 是否允许「按住标记直接拖动」；默认关闭（避免误拖），由 app 的「拖动移动」开关或 Alt 键临时启用 */
    this._dragMoveEnabled = false;
    this._pinch = null;
    this._rect = null;             // 交互期间缓存的容器 clientRect
    this._anim = 0;
    this._destroyed = false;
    this._userMoved = false;
    this._lastClampWarn = 0;
    this._lastHoverKey = '';

    // ---- 子图层（本文件创建，destroy 时清掉） ----
    this._gridEl = null;

    // ---- 瓦片底图（可选；用 <canvas id="canvas-tiles"> 替代 <img> 作为底图） ----
    /** @type {HTMLCanvasElement|null} */
    this._tileCanvas = null;
    /** @type {TileLayer|null} */
    this._tileLayer = null;
    /** @type {object|null} 站点 tiles.js 的 Tileset 实例 */
    this._tileset = null;
    /** 设备像素比：>1 时瓦片层会选更细的层级 / 按设备像素判定插值 */
    this._dpr = Math.max(1, (typeof window !== 'undefined' && Number(window.devicePixelRatio)) || 1);
    this._tileRaf = 0;
    this._lastImageRendering = '';

    // ---- 初始化 ----
    this._ensureTileCanvas();
    this._applyBaseStyle();
    this._bind();
    this.setMode('select');
    this._applyTransform();
    this._layoutOverlay();

    // 首帧再发一次视图状态：此时调用方已经拿到画布实例，回调里可以安全地反向调用 getViewState()
    this._initialEmitRaf = requestAnimationFrame(() => {
      this._initialEmitRaf = 0;
      if (!this._destroyed) this._emit();
    });
  }

  /* ====================================================================== */
  /* 初始化 / 清理                                                          */
  /* ====================================================================== */

  /**
   * 创建 / 复用瓦片底图 canvas（子图层，和 _gridEl 同类，不算顶层 DOM）。
   * 初始隐藏：单图模式只显示 #canvas-image；切到瓦片模式时再显示。
   * @returns {HTMLCanvasElement|null}
   */
  _ensureTileCanvas() {
    if (this._tileCanvas) return this._tileCanvas;
    const stage = this.stage;
    if (!stage) return null;
    let canvas = stage.querySelector('#canvas-tiles');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'canvas-tiles';
      canvas.className = 'canvas-image canvas-tiles';
      canvas.setAttribute('aria-hidden', 'true');
      if (this.imageEl && this.imageEl.parentNode === stage) this.imageEl.after(canvas);
      else stage.appendChild(canvas);
    }
    canvas.hidden = true;
    canvas.style.display = 'none';
    this._tileCanvas = canvas;
    return canvas;
  }

  /**
   * 与「变换语义」强相关的兜底内联样式。
   * 只写语义必需项，其余交给 tool.css；容器定位只在 CSS 缺省时才补，避免和样式表打架。
   */
  _applyBaseStyle() {
    const c = this.container;
    try {
      const cs = getComputedStyle(c);
      if (cs.position === 'static') c.style.position = 'relative';
      if (cs.overflow === 'visible') c.style.overflow = 'hidden';
    } catch {
      c.style.position = c.style.position || 'relative';
      c.style.overflow = 'hidden';
    }
    // 触摸设备上必须禁用浏览器默认手势，否则捏合会变成页面缩放
    c.style.touchAction = 'none';
    c.style.webkitUserSelect = 'none';
    c.style.userSelect = 'none';
    c.style.cursor = this._baseCursor();

    if (this.stage) {
      const st = this.stage.style;
      st.transformOrigin = '0 0';
      st.position = 'absolute';
      st.left = '0px';
      st.top = '0px';
      st.willChange = 'transform';
      st.transform = 'translate3d(0px, 0px, 0) scale(1)';
      st.backfaceVisibility = 'hidden';
    }

    if (this.imageEl) {
      const it = this.imageEl.style;
      it.maxWidth = 'none';
      it.maxHeight = 'none';
      it.display = 'block';
      it.userSelect = 'none';
      it.webkitUserDrag = 'none';
      it.pointerEvents = 'none';       // 底图不吃事件，拖拽统一由容器处理
      this.imageEl.draggable = false;
      this.imageEl.alt = '';
    }

    if (this._tileCanvas) {
      const ct = this._tileCanvas.style;
      ct.maxWidth = 'none';
      ct.maxHeight = 'none';
      // display 交给 setTileset / _deactivateTiles 管（单图模式下必须保持 none，别在这里写 block）
      ct.userSelect = 'none';
      ct.pointerEvents = 'none';
      ct.touchAction = 'none';
    }

    if (this.overlay) {
      const ov = this.overlay.style;
      ov.position = 'absolute';
      ov.left = '0px';
      ov.top = '0px';
      ov.right = '0px';
      ov.bottom = '0px';
      ov.inset = '0';
      ov.overflow = 'hidden';
      ov.pointerEvents = 'none';       // 覆盖层透明；只有标记自己恢复 auto
    }

    // 纯展示型浮层一律不拦事件（CSS 没就位时也不影响拖拽）
    for (const el of [this.emptyEl, this.modeBadge, this.coordEl]) {
      if (el) el.style.pointerEvents = 'none';
    }
  }

  _bind() {
    const c = this.container;

    this._handlers = {
      wheel: this._onWheel.bind(this),
      pointerdown: this._onPointerDown.bind(this),
      pointermove: this._onPointerMove.bind(this),
      pointerup: this._onPointerUp.bind(this),
      pointercancel: this._onPointerCancel.bind(this),
      pointerover: this._onPointerOver.bind(this),
      pointerout: this._onPointerOut.bind(this),
      pointerleave: this._onPointerLeave.bind(this),
      dblclick: this._onDoubleClick.bind(this),
      keydown: this._onKeyDown.bind(this),
    };

    // passive:false —— Ctrl/⌘ + 滚轮要能被我们接管（否则浏览器会缩放整个页面）
    c.addEventListener('wheel', this._handlers.wheel, { passive: false });
    c.addEventListener('pointerdown', this._handlers.pointerdown);
    c.addEventListener('pointermove', this._handlers.pointermove);
    c.addEventListener('pointerup', this._handlers.pointerup);
    c.addEventListener('pointercancel', this._handlers.pointercancel);
    c.addEventListener('pointerover', this._handlers.pointerover);
    c.addEventListener('pointerout', this._handlers.pointerout);
    c.addEventListener('pointerleave', this._handlers.pointerleave);
    c.addEventListener('dblclick', this._handlers.dblclick);
    c.addEventListener('keydown', this._handlers.keydown);

    // 缩放按钮（#zoom-in / #zoom-out / #btn-fit）由 app.js 绑定，画布只提供 zoomIn/zoomOut/
    // fitToContent/zoomBy 方法 —— 两边都绑会导致一次点击缩放两次。

    // 容器尺寸变化（窗口缩放 / 面板收起 / 移动端旋转）
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(() => this._onResize());
      this._resizeObserver.observe(c);
    }
  }

  /** 销毁：解绑所有监听、取消动画与观察者，移除自己创建的图层。可重复调用。 */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._cancelAnim();
    if (this._initialEmitRaf) {
      cancelAnimationFrame(this._initialEmitRaf);
      this._initialEmitRaf = 0;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    const c = this.container;
    if (this._handlers) {
      c.removeEventListener('wheel', this._handlers.wheel);
      c.removeEventListener('pointerdown', this._handlers.pointerdown);
      c.removeEventListener('pointermove', this._handlers.pointermove);
      c.removeEventListener('pointerup', this._handlers.pointerup);
      c.removeEventListener('pointercancel', this._handlers.pointercancel);
      c.removeEventListener('pointerover', this._handlers.pointerover);
      c.removeEventListener('pointerout', this._handlers.pointerout);
      c.removeEventListener('pointerleave', this._handlers.pointerleave);
      c.removeEventListener('dblclick', this._handlers.dblclick);
      c.removeEventListener('keydown', this._handlers.keydown);
    }
    for (const el of this._els.values()) el.remove();
    this._els.clear();
    this._pos.clear();
    if (this._gridEl) {
      this._gridEl.remove();
      this._gridEl = null;
    }
    // 瓦片层：取消排队中的 rAF + 销毁 TileLayer（会清缓存/取消瓦片请求）+ 移除 canvas
    this._cancelTileDraw();
    if (this._tileLayer) {
      this._tileLayer.destroy();
      this._tileLayer = null;
    }
    if (this._tileCanvas) {
      this._tileCanvas.remove();
      this._tileCanvas = null;
    }
    this._tileset = null;

    this._waypoints = [];
    this._byId.clear();
    this._pointers.clear();
    this._pan = null;
    this._markerDrag = null;
    this._pinch = null;
    this._rect = null;
    this._filter = null;
  }

  /* ====================================================================== */
  /* 渲染：DOM 写入的出口                                                    */
  /* ====================================================================== */

  /** 把当前 {scale, tx, ty} 写到 #canvas-stage（唯一一处写 stage transform） */
  _applyTransform() {
    if (this.stage) {
      this.stage.style.transform =
        `translate3d(${n4(this.tx)}px, ${n4(this.ty)}px, 0) scale(${n4(this.scale)})`;
    }
    this._applyImageRendering();
    if (this.zoomLevelEl) {
      const pct = `${Math.round(this.scale * 100)}%`;
      if (this.zoomLevelEl.textContent !== pct) this.zoomLevelEl.textContent = pct;
    }
  }

  /**
   * 单图插值策略：放大（scale >= 1）时保持像素锐利，缩小时用浏览器平滑插值。
   * 只在档位变化时写样式，避免每帧写 style。
   */
  _applyImageRendering() {
    if (!this.imageEl) return;
    const next = this.scale >= 1 ? 'pixelated' : 'auto';
    if (next === this._lastImageRendering) return;
    this._lastImageRendering = next;
    this.imageEl.style.imageRendering = next;
  }

  /** 视图状态变化后的统一出口：写 stage → 重排覆盖层 → 通知外部 → 重绘瓦片 */
  _commit(state) {
    const nextScale = this._resolveScale(state && state.scale, this.scale);
    const tx = Number(state && state.tx);
    const ty = Number(state && state.ty);
    this.scale = nextScale;
    this.tx = Number.isFinite(tx) ? tx : this.tx;
    this.ty = Number.isFinite(ty) ? ty : this.ty;
    this._applyTransform();
    this._layoutOverlay();
    this._emit();
    // 瓦片层按最新视图补画（rAF 合并，一帧最多一次；回调里现场取 getViewState）
    this._scheduleTileDraw();
  }

  /** 同步通知外部（onViewChange 每帧一次） */
  _emit() {
    if (this._destroyed || !this._callbacks.onViewChange) return;
    safeCall(this._callbacks.onViewChange, this.getViewState());
  }

  /** 重排覆盖层：标记 + 网格（只写 transform / classList，不读布局、不重建 DOM） */
  _layoutOverlay() {
    if (this._destroyed) return;
    this._layoutMarkers();
    this._layoutGrid();
  }

  _layoutMarkers() {
    if (!this.overlay) return;
    const { width: vw, height: vh } = this._viewSize();
    for (const wp of this._waypoints) {
      const id = String(wp.id);
      const el = this._els.get(id);
      if (!el) continue;

      const drag = this._markerDrag;
      const screen = drag && drag.started && drag.id === id && drag.screen
        ? drag.screen
        : this._project(wp);

      if (!screen) {
        // 无法投影（无投影 / 脏坐标）：挪到视口外，保留 DOM 供选中与后续修复
        const prev = this._pos.get(id);
        if (!prev || prev.x !== -9999 || prev.y !== -9999) {
          el.style.transform = `translate3d(${OFFSCREEN}, ${OFFSCREEN}, 0)`;
          this._pos.set(id, { x: -9999, y: -9999 });
        }
        if (!el.classList.contains('is-offscreen')) el.classList.add('is-offscreen');
        continue;
      }

      const x = screen.x;
      const y = screen.y;
      const prev = this._pos.get(id);
      if (!prev || Math.abs(prev.x - x) > POS_EPS || Math.abs(prev.y - y) > POS_EPS) {
        el.style.transform = `translate3d(${n4(x)}px, ${n4(y)}px, 0)`;
        if (prev) {
          prev.x = x;
          prev.y = y;
        } else {
          this._pos.set(id, { x, y });
        }
      }
      const offscreen = x < 0 || y < 0 || x > vw || y > vh;
      if (el.classList.contains('is-offscreen') !== offscreen) {
        el.classList.toggle('is-offscreen', offscreen);
      }
    }
  }

  /* ====================================================================== */
  /* 视图状态 / 缩放 / 平移                                                  */
  /* ====================================================================== */

  _viewSize() {
    const w = this.container.clientWidth || this._viewW || 1;
    const h = this.container.clientHeight || this._viewH || 1;
    return { width: w, height: h };
  }

  /** @returns {{scale:number, tx:number, ty:number, viewWidth:number, viewHeight:number, imageWidth:number, imageHeight:number}} */
  getViewState() {
    const { width, height } = this._viewSize();
    return {
      scale: this.scale,
      tx: this.tx,
      ty: this.ty,
      viewWidth: width,
      viewHeight: height,
      imageWidth: this._imageSize ? this._imageSize.width : 0,
      imageHeight: this._imageSize ? this._imageSize.height : 0,
    };
  }

  /** 解析/钳制缩放值：非法值告警并保留 fallback，越界则钳制到 [minScale, maxScale] */
  _resolveScale(value, fallback) {
    if (value === undefined || value === null) return fallback;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) {
      console.warn(`[EditorCanvas] 非法缩放值已忽略：${String(value)}（保持当前比例）`);
      return fallback;
    }
    const minScale = this._effectiveMinScale();
    if (v < minScale) {
      this._warnClamp();
      return minScale;
    }
    if (v > this.maxScale) {
      this._warnClamp();
      return this.maxScale;
    }
    return v;
  }

  /** 越界钳制的告警：同一条消息 1.2 秒内只打一次，避免滚轮刷屏 */
  _warnClamp() {
    const t = nowMs();
    if (t - this._lastClampWarn < 1200) return;
    this._lastClampWarn = t;
    console.warn(`[EditorCanvas] 缩放比例超出范围，已钳制到 [${this._effectiveMinScale()}, ${this.maxScale}]。`);
  }

  /** 以 anchor（容器内 CSS 像素，缺省为视口中心）为不动点缩放 factor 倍 */
  _zoomTarget(factor, anchor) {
    const next = this._resolveScale(this.scale * factor, this.scale);
    const a = anchor && isNum(anchor.x) && isNum(anchor.y)
      ? anchor
      : (() => {
        const { width, height } = this._viewSize();
        return { x: width / 2, y: height / 2 };
      })();
    const imgX = (a.x - this.tx) / this.scale;
    const imgY = (a.y - this.ty) / this.scale;
    return { scale: next, tx: a.x - imgX * next, ty: a.y - imgY * next };
  }

  /** 以容器内坐标为锚点缩放（animate=true 时走 220ms 动画） */
  zoomBy(factor, anchor, { animate = false } = {}) {
    const f = Number(factor);
    if (!Number.isFinite(f) || f <= 0) {
      console.warn(`[EditorCanvas] 非法缩放倍率已忽略：${String(factor)}`);
      return;
    }
    this._userMoved = true;
    const target = this._zoomTarget(f, anchor);
    if (animate) this._animateTo(target);
    else {
      this._cancelAnim();
      this._commit(target);
    }
  }

  /** 放大一级（按钮 / 键盘） */
  zoomIn() {
    this.zoomBy(KEY_ZOOM_STEP, undefined, { animate: true });
  }

  /** 缩小一级（按钮 / 键盘） */
  zoomOut() {
    this.zoomBy(1 / KEY_ZOOM_STEP, undefined, { animate: true });
  }

  /** 不钳制的「整图适配」比例（内部用，避免与动态下限递归） */
  _rawFitScale(padding = FIT_PADDING) {
    if (!this._imageSize) return this.scale;
    const { width, height } = this._viewSize();
    const p = Math.max(0, Number(padding) || 0);
    const usableW = Math.max(1, width - p * 2);
    const usableH = Math.max(1, height - p * 2);
    return Math.min(usableW / this._imageSize.width, usableH / this._imageSize.height);
  }

  /**
   * 实际生效的最小缩放：开启 _minScaleFit 后不小于「整图适配」，
   * 这样怎么滚轮缩小，地图最多缩到刚好铺满画布（3584px 的图不会变成 72px）。
   */
  _effectiveMinScale() {
    if (!this._minScaleFit || !this._imageSize) return this.minScale;
    const fit = this._rawFitScale(FIT_PADDING);
    return Math.max(this.minScale, Math.min(this.maxScale, fit));
  }

  /** 整图适配比例 */
  _fitScale(padding) {
    return this._resolveScale(this._rawFitScale(padding), this.scale);
  }

  /** 整图适配：让整张底图完整落在容器内（留 padding） */
  fitToContent(options = {}) {
    const { padding = FIT_PADDING, animate = false } = options || {};
    if (!this._imageSize) {
      console.warn('[EditorCanvas] fitToContent：图片尚未载入');
      return;
    }
    const { width, height } = this._viewSize();
    const scale = this._fitScale(padding);
    const target = {
      scale,
      tx: (width - this._imageSize.width * scale) / 2,
      ty: (height - this._imageSize.height * scale) / 2,
    };
    if (animate) this._animateTo(target);
    else {
      this._cancelAnim();
      this._commit(target);
    }
  }

  /** 把某个路径点放到视口中心（找不到 / 无法投影时返回 false） */
  focusWaypoint(id) {
    const wp = this._byId.get(String(id));
    if (!wp) {
      console.warn(`[EditorCanvas] focusWaypoint：找不到路径点 ${String(id)}`);
      return false;
    }
    const imagePoint = this._worldToImagePoint(wp);
    if (!imagePoint) {
      console.warn(`[EditorCanvas] focusWaypoint：路径点 ${String(id)} 无法投影（缺少投影或坐标非法）`);
      return false;
    }
    const { width, height } = this._viewSize();
    const fitted = this._imageSize ? this._fitScale(FIT_PADDING) : this.scale;
    // 放大到「整图适配」的 2.2 倍；已经放得更大就保持，避免缩放来回跳
    const targetScale = this._resolveScale(Math.max(this.scale, fitted * 2.2), this.scale);
    this._animateTo({
      scale: targetScale,
      tx: width / 2 - imagePoint.px * targetScale,
      ty: height / 2 - imagePoint.py * targetScale,
    });
    return true;
  }

  /* ====================================================================== */
  /* 动画                                                                   */
  /* ====================================================================== */

  _cancelAnim() {
    if (this._anim) {
      cancelAnimationFrame(this._anim);
      this._anim = 0;
    }
  }

  /** ease-out 动画到目标视图（约 220ms）；prefers-reduced-motion 时直接跳过去 */
  _animateTo(target, duration = ANIM_DURATION) {
    this._cancelAnim();
    const from = { scale: this.scale, tx: this.tx, ty: this.ty };
    const to = {
      scale: this._resolveScale(target && target.scale, this.scale),
      tx: Number(target && target.tx),
      ty: Number(target && target.ty),
    };
    if (!Number.isFinite(to.tx)) to.tx = from.tx;
    if (!Number.isFinite(to.ty)) to.ty = from.ty;

    const reduceMotion = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduceMotion || !(duration > 0)) {
      this._commit(to);
      return;
    }

    const startAt = nowMs();
    const step = () => {
      if (this._destroyed) {
        this._anim = 0;
        return;
      }
      const raw = Math.min(1, (nowMs() - startAt) / duration);
      const k = easeOutCubic(raw);
      const state = raw >= 1
        ? to
        : {
          scale: from.scale + (to.scale - from.scale) * k,
          tx: from.tx + (to.tx - from.tx) * k,
          ty: from.ty + (to.ty - from.ty) * k,
        };
      this._commit(state);
      this._anim = raw < 1 ? requestAnimationFrame(step) : 0;
    };
    this._anim = requestAnimationFrame(step);
  }

  /* ====================================================================== */
  /* 底图 / 投影                                                             */
  /* ====================================================================== */

  /**
   * 载入底图。
   * @param {{src?:string, width?:number, height?:number}} image width/height = 图片原始像素
   * @returns {Promise<{width:number, height:number}|null>} 永不 reject（失败时 console.warn + resolve(null)）
   */
  setImage(image) {
    const { src, width, height } = image || {};
    this._loadToken += 1;
    const token = this._loadToken;
    // 切回单图模式：隐藏瓦片 canvas、停掉瓦片层，显示 #canvas-image
    this._deactivateTiles();
    if (this.imageEl) {
      this.imageEl.hidden = false;
      this.imageEl.style.display = 'block';
    }

    if (!src || typeof src !== 'string') {
      this._clearImage();
      return Promise.resolve(null);
    }

    const dw = Number(width);
    const dh = Number(height);
    const declared = isNum(dw) && dw > 0 && isNum(dh) && dh > 0;
    // 已知原始尺寸 → 立刻按它布局，图片还没下载完也能把标记放到正确位置
    if (declared) {
      this._setImageSize(dw, dh);
      this._showEmpty(false);
    }

    const img = this.imageEl;
    if (!img) {
      console.warn('[EditorCanvas] setImage：找不到 #canvas-image 元素');
      return Promise.resolve(declared ? { width: dw, height: dh } : null);
    }

    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      };
      const finish = (size) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(size);
      };
      const onLoad = () => {
        if (token !== this._loadToken || this._destroyed) {
          finish(declared ? { width: dw, height: dh } : null);
          return;
        }
        const naturalW = img.naturalWidth || 0;
        const naturalH = img.naturalHeight || 0;
        if (!(naturalW > 0) || !(naturalH > 0)) {
          console.warn(`[EditorCanvas] 图片尺寸无效：${src}`);
          finish(null);
          return;
        }
        this._showEmpty(false);
        this._setImageSize(naturalW, naturalH);
        // tool.css 里 .canvas-image 默认 opacity:0，加载完成后靠这个类淡入；
        // 少了这一行图片会永远不可见（DOM 有、尺寸对、但画不出来）。
        img.classList.add('is-loaded');
        img.style.opacity = '1';
        finish({ width: naturalW, height: naturalH });
      };
      const onError = () => {
        if (token !== this._loadToken || this._destroyed) {
          finish(null);
          return;
        }
        console.warn(`[EditorCanvas] 地图图片加载失败：${src}`);
        if (declared) {
          // 有声明尺寸时仍然可以继续标点（只是看不到底图）
          this._showEmpty(true, `地图图片加载失败：${src}`);
          finish({ width: dw, height: dh });
        } else {
          this._clearImage();
          finish(null);
        }
      };

      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      img.draggable = false;

      // 同一张图已在缓存里时浏览器不会再触发 load，这里手动收尾
      if (img.getAttribute('src') === src && img.complete && img.naturalWidth > 0) {
        onLoad();
        return;
      }
      img.src = src;
      // 极端情况：赋值后同步就 complete（data: URL / 已缓存）
      if (img.complete && img.naturalWidth > 0 && img.getAttribute('src') === src) onLoad();
    });
  }

  /** 写入图片原始尺寸：stage / img 必须按原始像素布局，否则标记与底图错位 */
  _setImageSize(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!isNum(w) || !isNum(h) || w <= 0 || h <= 0) {
      this._clearImage();
      return;
    }
    this._imageSize = { width: w, height: h };
    if (this.stage) {
      this.stage.style.width = `${w}px`;
      this.stage.style.height = `${h}px`;
    }
    if (this.imageEl) {
      this.imageEl.style.width = `${w}px`;
      this.imageEl.style.height = `${h}px`;
      this.imageEl.style.maxWidth = 'none';
      this.imageEl.style.maxHeight = 'none';
    }
    // 瓦片 canvas 与 <img> 共用同一套逻辑尺寸（同一个 stage transform），切模式时无需重排
    if (this._tileCanvas) {
      this._tileCanvas.style.width = `${w}px`;
      this._tileCanvas.style.height = `${h}px`;
    }
    // 之前因为不知道图片尺寸而没建成的投影，现在可以补建
    if (this._pendingProjection && !this._projection) {
      this._projection = this._coerceProjection(this._pendingProjection);
    }
    this.fitToContent();
  }

  /** 清空底图（保留容器与覆盖层，不销毁实例） */
  _clearImage() {
    this._imageSize = null;
    this._deactivateTiles();
    if (this.imageEl) {
      this.imageEl.removeAttribute('src');
      this.imageEl.style.width = '0px';
      this.imageEl.style.height = '0px';
    }
    if (this.stage) {
      this.stage.style.width = '0px';
      this.stage.style.height = '0px';
    }
    this._showEmpty(true, '还没有地图图片');
    this._commit({ scale: 1, tx: 0, ty: 0 });
  }

  /* ---------------------------- 瓦片底图（可选） ---------------------------- */

  /**
   * 切换到瓦片底图。app.js 解析完 manifest 后调用；传 null 表示停用瓦片层。
   * 不碰 _projection / _pendingProjection —— app 会在之后 setProjection。
   * @param {object|null} tileset 站点 tiles.js 的 Tileset 实例
   * @returns {boolean} 是否成功进入瓦片模式
   */
  setTileset(tileset) {
    const w = tileset && Number(tileset.imageWidth);
    const h = tileset && Number(tileset.imageHeight);
    if (!tileset || !isNum(w) || !isNum(h) || w <= 0 || h <= 0) {
      this._deactivateTiles();
      return false;
    }
    const canvas = this._ensureTileCanvas();
    if (!canvas) {
      console.warn('[EditorCanvas] setTileset：找不到 #canvas-stage，无法创建瓦片画布');
      return false;
    }

    this._tileset = tileset;
    if (!this._tileLayer) {
      this._tileLayer = new TileLayer(canvas, { tileset, dpr: this._dpr });
    } else {
      // 复用实例：换一份 tileset，避免把已解码瓦片缓存整批丢掉
      this._tileLayer.setTileset(tileset);
      this._tileLayer.setDpr(this._dpr);
    }
    this._tileLayer.setActive(true);

    canvas.hidden = false;
    canvas.style.display = 'block';
    // tool.css 的 .canvas-image 默认 opacity:0，靠 is-loaded 淡入（瓦片是异步贴的，先直接显示）
    canvas.classList.add('is-loaded');
    this._imageSize = { width: w, height: h };
    this._setImageSize(w, h);
    if (this.imageEl) {
      this.imageEl.hidden = true;
      this.imageEl.style.display = 'none';
    }
    this._layoutOverlay();
    this._scheduleTileDraw();
    return true;
  }

  /** 停用瓦片层并隐藏瓦片 canvas（切回单图 / 清空底图时调用） */
  _deactivateTiles() {
    this._cancelTileDraw();
    if (this._tileLayer) this._tileLayer.setActive(false);
    if (this._tileCanvas) {
      this._tileCanvas.hidden = true;
      this._tileCanvas.style.display = 'none';
      this._tileCanvas.classList.remove('is-loaded');
    }
    this._tileset = null;
  }

  /**
   * 设置设备像素比（默认读 window.devicePixelRatio）。
   * 瓦片层据此选更细的层级 / 按设备像素决定插值，高分屏不会发虚。
   * @param {number} [dpr]
   * @returns {number} 生效后的 dpr
   */
  setDpr(dpr) {
    const raw = Number(dpr);
    const fallback = typeof window !== 'undefined' && Number(window.devicePixelRatio);
    const next = Math.max(1, isNum(raw) && raw > 0 ? raw : isNum(fallback) && fallback > 0 ? fallback : 1);
    if (next === this._dpr) return this._dpr;
    this._dpr = next;
    if (this._tileLayer) this._tileLayer.setDpr(next);
    this._scheduleTileDraw();
    return this._dpr;
  }

  /** 瓦片渲染状态快照（单图模式返回 null），供调试 / e2e 断言 */
  getTileStats() {
    if (!this._tileLayer) return null;
    const stats = this._tileLayer.stats || {};
    const tileset = this._tileset;
    return {
      ...stats,
      dpr: this._dpr,
      hasTileset: Boolean(tileset),
      imageWidth: tileset ? tileset.imageWidth : 0,
      imageHeight: tileset ? tileset.imageHeight : 0,
      bounds: tileset ? { ...tileset.bounds } : null,
    };
  }

  /** 合并同一帧内的多次瓦片重绘请求（滚轮 / 拖拽一次手势只画一帧） */
  _scheduleTileDraw() {
    if (this._destroyed || !this._tileLayer || !this._tileset || this._tileRaf) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    this._tileRaf = raf(() => {
      this._tileRaf = 0;
      if (this._destroyed || !this._tileLayer || !this._tileset) return;
      // 现场取视图状态：rAF 期间视图可能又变了，不能沿用 _emit 时捕获的旧对象
      this._tileLayer.update(this.getViewState());
    });
  }

  _cancelTileDraw() {
    if (!this._tileRaf) return;
    const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    caf(this._tileRaf);
    this._tileRaf = 0;
  }

  /** 空状态提示：只控制显隐与 placeholder 文案，不覆盖 app 写好的自定义文案 */
  _showEmpty(visible, text) {
    if (!this.emptyEl) return;
    this.emptyEl.hidden = !visible;
    if (visible && text && (this.emptyEl.textContent || '').trim() === '') {
      this.emptyEl.textContent = text;
    }
  }

  /**
   * 保存投影（站点 coords.createProjection 的产物）。
   * 也接受裸 calibration `{xMin,xMax,zMin,zMax,flipZ}`：会用站点的 createProjection 补全，
   * 位图尺寸未知时先暂存，等 setImage 之后自动补建。
   */
  setProjection(projection) {
    this._pendingProjection = projection || null;
    this._projection = this._coerceProjection(projection);
    if (!this._projection && projection) {
      const looksLikeCalibration = isNum(projection.xMin) && isNum(projection.xMax)
        && isNum(projection.zMin) && isNum(projection.zMax);
      if (!looksLikeCalibration) {
        console.warn('[EditorCanvas] setProjection 收到无法识别的对象，已忽略', projection);
      }
    }
    this._layoutOverlay();
    this._emit();
  }

  _coerceProjection(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.worldToImage === 'function' && typeof raw.imageToWorld === 'function') return raw;

    // 裸 calibration → 用站点那份数学建投影器（绝不自己写一份）
    const { xMin, xMax, zMin, zMax, flipZ } = raw;
    const iw = this._imageSize ? this._imageSize.width : 0;
    const ih = this._imageSize ? this._imageSize.height : 0;
    if (isNum(xMin) && isNum(xMax) && isNum(zMin) && isNum(zMax)
      && xMax > xMin && zMax > zMin && iw > 0 && ih > 0) {
      try {
        return createProjection({
          xMin, xMax, zMin, zMax, flipZ: flipZ === true, imageWidth: iw, imageHeight: ih,
        });
      } catch (err) {
        console.warn('[EditorCanvas] createProjection 失败：', err);
        return null;
      }
    }
    return null;
  }

  /** @returns {{width:number, height:number}|null} */
  getImageSize() {
    return this._imageSize ? { ...this._imageSize } : null;
  }

  /** @returns {object|null} */
  getProjection() {
    return this._projection;
  }

  /* ====================================================================== */
  /* 数据 / 标记                                                             */
  /* ====================================================================== */

  /**
   * 载入当前维度的数据（waypoints / groups / projection）。
   * @param {{waypoints?: Array, groups?: Array, projection?: object}} data
   */
  setData(data = {}) {
    const { waypoints, groups, projection } = data || {};

    if (projection !== undefined) {
      this._pendingProjection = projection || null;
      this._projection = this._coerceProjection(projection);
    }

    this._waypoints = Array.isArray(waypoints)
      ? waypoints.filter((wp) => wp && typeof wp === 'object' && wp.id != null)
      : [];
    this._groups = Array.isArray(groups)
      ? groups.filter((g) => g && typeof g === 'object' && g.id != null)
      : [];
    this._byId = new Map(this._waypoints.map((wp) => [String(wp.id), wp]));
    this._groupVisible = new Map(this._groups.map((g) => [String(g.id), g.visible !== false]));

    // 选中项已不存在 → 清掉（避免旧 id 在新数据里“复活”）
    if (this._selection != null && !this._byId.has(String(this._selection))) this._selection = null;
    if (this._hoverId != null && !this._byId.has(String(this._hoverId))) this._hoverId = null;
    if (this._markerDrag) this._markerDrag = null;

    this._buildMarkers();
    this._applyVisibility();
    this._layoutOverlay();
    return this.visibleIds();
  }

  /** 新建 / 重建全部标记 DOM（只在 setData 时调用一次） */
  _buildMarkers() {
    for (const el of this._els.values()) el.remove();
    this._els.clear();
    this._pos.clear();
    if (!this.overlay) return;

    const fragment = document.createDocumentFragment();
    for (const wp of this._waypoints) {
      const id = String(wp.id);
      const el = this._createMarker(wp);
      this._els.set(id, el);
      fragment.appendChild(el);
    }
    this.overlay.appendChild(fragment);
  }

  _createMarker(waypoint) {
    const id = String(waypoint.id);
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'marker';
    marker.dataset.id = id;
    marker.dataset.group = String(waypoint.group || 'default');
    marker.style.setProperty('--marker-color', this._colorOf(waypoint));
    // 兜底：CSS 未就位时也要绝对定位（居中补偿由 CSS 的负 margin 负责，见交付说明）
    marker.style.position = 'absolute';
    marker.style.left = '0px';
    marker.style.top = '0px';
    marker.style.touchAction = 'none';
    marker.style.pointerEvents = 'auto';
    marker.style.transform = `translate3d(${OFFSCREEN}, ${OFFSCREEN}, 0)`;
    marker.setAttribute('aria-label', `${waypoint.name || id}（路径点）`);

    const pin = document.createElement('span');
    pin.className = 'marker-pin';

    const icon = document.createElement('span');
    icon.className = 'marker-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = this._iconOf(waypoint);
    pin.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'marker-label';
    label.textContent = waypoint.name != null ? String(waypoint.name) : id;

    marker.append(pin, label);
    this._applyLabelMode(marker, waypoint);
    if (this._selection != null && String(this._selection) === id) marker.classList.add('is-selected');
    if (this._hoverId != null && this._hoverId === id) marker.classList.add('is-hover');
    return marker;
  }

  /** 标签策略：单个路径点的 label 字段优先于全局 labelMode */
  _applyLabelMode(marker, waypoint) {
    const mode = LABEL_MODES.includes(waypoint && waypoint.label) ? waypoint.label : this._labelMode;
    if (marker.dataset.label !== mode) marker.dataset.label = mode;
  }

  /** 图标：站点图标表命中 → emoji；1~2 字符原样；其它 → 回落到名字首字 */
  _iconOf(waypoint) {
    const raw = waypoint && waypoint.icon;
    if (typeof raw === 'string' && raw.trim()) {
      const value = raw.trim();
      if (Array.from(value).length <= 2) return value;
      return value === 'pin' ? '🧷' : (ICON_FALLBACKS[value] || '🧷');
    }
    return '🧷';
  }

  _colorOf(waypoint) {
    if (waypoint && typeof waypoint.color === 'string' && waypoint.color) return waypoint.color;
    const groupId = String((waypoint && waypoint.group) || 'default');
    const group = this._groups.find((g) => String(g.id) === groupId);
    if (group && typeof group.color === 'string' && group.color) return group.color;
    return DEFAULT_COLOR;
  }

  /** 重新计算显示/隐藏（分组显隐 + 搜索过滤），只切 hidden / classList */
  _applyVisibility() {
    for (const wp of this._waypoints) {
      const id = String(wp.id);
      const el = this._els.get(id);
      if (!el) continue;
      const groupVisible = this._groupVisible.get(String(wp.group || 'default')) !== false;
      const passFilter = this._passFilter(wp);
      const shown = groupVisible && passFilter;
      if (el.hidden !== !shown) el.hidden = !shown;
      this._toggleClass(el, 'is-group-hidden', !groupVisible);
      this._toggleClass(el, 'is-filtered', !passFilter);
    }
  }

  _passFilter(waypoint) {
    if (typeof this._filter !== 'function') return true;
    try {
      return !!this._filter(waypoint);
    } catch (err) {
      console.warn('[EditorCanvas] filter 回调抛错，已按可见处理', err);
      return true;
    }
  }

  _toggleClass(el, name, on) {
    if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
  }

  /* ====================================================================== */
  /* 公开设置：选中 / 模式 / 网格 / 标签 / 显隐 / 过滤                        */
  /* ====================================================================== */

  /** 选中态（传 null 取消选中） */
  setSelection(waypointId) {
    this._selection = waypointId != null ? String(waypointId) : null;
    for (const [id, el] of this._els) {
      this._toggleClass(el, 'is-selected', this._selection !== null && id === this._selection);
    }
  }

  /** @returns {string|null} */
  getSelection() {
    return this._selection;
  }

  /**
   * 'select' | 'place'
   *   select：常规编辑（拖拽平移 / 拖拽标记 / 点击选中）
   *   place ：点击空白处放置新路径点（回调 onEmptyClick，光标十字）
   */
  /** 开启/关闭「拖动标记移动」；关闭时按住标记拖动不会改变坐标（Alt 键可临时启用） */
  setDragMoveEnabled(enabled) {
    this._dragMoveEnabled = enabled === true;
    return this._dragMoveEnabled;
  }

  getDragMoveEnabled() {
    return this._dragMoveEnabled === true;
  }

  setMode(mode) {
    const next = MODES.includes(mode) ? mode : 'select';
    this._mode = next;
    this.container.dataset.canvasMode = next;
    this.container.style.cursor = this._baseCursor();

    if (this.modeBadge) {
      // #mode-badge 的文案由 app.js 决定（它会写「在图上新建…」这类上下文）；
      // 这里只在它还没写文案时给一个兜底，避免两边互相覆盖。
      const text = next === 'place' ? '放置模式：点击地图放置路径点' : '';
      if (text) {
        if ((this.modeBadge.textContent || '').trim() === '') this.modeBadge.textContent = text;
        this.modeBadge.hidden = false;
      } else {
        this.modeBadge.hidden = true;
      }
    }
    return this._mode;
  }

  /** @returns {'select'|'place'} */
  getMode() {
    return this._mode;
  }

  _baseCursor() {
    return this._mode === 'place' ? 'crosshair' : 'grab';
  }

  /** 坐标网格（世界方块对齐）显隐 */
  setGrid(visible) {
    this._gridVisible = !!visible;
    const el = this._ensureGridLayer();
    if (!el) return;
    el.style.display = this._gridVisible ? 'block' : 'none';
    if (this._gridVisible) this._layoutGrid();
  }

  /** 标签策略：'always' | 'hover' | 'never'（单个路径点的 label 字段优先） */
  setLabelMode(mode) {
    this._labelMode = LABEL_MODES.includes(mode) ? mode : 'hover';
    for (const wp of this._waypoints) {
      const el = this._els.get(String(wp.id));
      if (el) this._applyLabelMode(el, wp);
    }
  }

  /** 分组显隐（与左侧树的眼睛图标联动） */
  setGroupVisible(groupId, visible) {
    if (groupId == null) return this.visibleIds();
    this._groupVisible.set(String(groupId), visible !== false);
    this._applyVisibility();
    this._layoutOverlay();
    return this.visibleIds();
  }

  /**
   * 一次性同步全部分组显隐（app.js 优先用这个，避免逐个分组触发 N 次重排）。
   * @param {Array<{id:string, visible?:boolean}>} groups
   */
  setGroupVisibilityAll(groups) {
    this._groupVisible = new Map(
      (Array.isArray(groups) ? groups : [])
        .filter((g) => g && g.id != null)
        .map((g) => [String(g.id), g.visible !== false]),
    );
    this._applyVisibility();
    this._layoutOverlay();
    return this.visibleIds();
  }

  /** 搜索过滤：predicate(waypoint) => boolean；传 null 清除 */
  setFilter(predicate) {
    this._filter = typeof predicate === 'function' ? predicate : null;
    this._applyVisibility();
    this._layoutOverlay();
    return this.visibleIds();
  }

  /** @returns {string[]} 当前可见的路径点 id */
  visibleIds() {
    const out = [];
    for (const wp of this._waypoints) {
      const el = this._els.get(String(wp.id));
      if (el && !el.hidden) out.push(String(wp.id));
    }
    return out;
  }

  /** 光标处坐标读数（#coord-readout）；传 null 隐藏 */
  setTooltipFor(point) {
    if (!this.coordEl) return;
    const ok = point && isNum(Number(point.x)) && isNum(Number(point.z));
    if (!ok) {
      if (!this.coordEl.hidden) this.coordEl.hidden = true;
      return;
    }
    const x = Math.round(Number(point.x));
    const z = Math.round(Number(point.z));
    const text = `X ${Object.is(x, -0) ? 0 : x} Z ${Object.is(z, -0) ? 0 : z}`;
    if (this.coordEl.textContent !== text) this.coordEl.textContent = text;
    if (this.coordEl.hidden) this.coordEl.hidden = false;
  }

  /* ====================================================================== */
  /* 坐标换算                                                               */
  /* ====================================================================== */

  /** 交互期间缓存 clientRect（避免 pointermove 里反复触发同步布局） */
  _localPoint(clientX, clientY) {
    if (!this._rect) this._rect = this.container.getBoundingClientRect();
    return { x: clientX - this._rect.left, y: clientY - this._rect.top };
  }

  /**
   * 页面 client 坐标 → 图片像素坐标（永远返回 {px, py}，不抛错）
   * @returns {{px:number, py:number}}
   */
  screenToImage(clientX, clientY) {
    const cx = Number(clientX);
    const cy = Number(clientY);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { px: NaN, py: NaN };
    let rect;
    try {
      rect = this.container.getBoundingClientRect();
    } catch {
      rect = { left: 0, top: 0 };
    }
    const scale = this.scale > 0 ? this.scale : 1;
    return {
      px: (cx - rect.left - this.tx) / scale,
      py: (cy - rect.top - this.ty) / scale,
    };
  }

  /**
   * 图片像素坐标 → 世界坐标（无投影 / 非法入参时返回 null，不抛错）
   * @returns {{x:number, z:number}|null}
   */
  imageToWorld(px, py) {
    const proj = this._projection;
    if (!proj || typeof proj.imageToWorld !== 'function') return null;
    const P = Number(px);
    const Q = Number(py);
    if (!Number.isFinite(P) || !Number.isFinite(Q)) return null;
    let out = null;
    try {
      out = proj.imageToWorld(P, Q);
    } catch (err) {
      console.warn('[EditorCanvas] projection.imageToWorld 抛错：', err);
      return null;
    }
    if (!out || !isNum(out.x) || !isNum(out.z)) return null;
    return { x: out.x, z: out.z };
  }

  /** 图片像素 → 容器 CSS 像素（纯变换，永远返回数值） */
  imageToScreen(px, py) {
    const X = Number(px);
    const Y = Number(py);
    return {
      x: this.tx + (Number.isFinite(X) ? X : 0) * this.scale,
      y: this.ty + (Number.isFinite(Y) ? Y : 0) * this.scale,
    };
  }

  /** 世界坐标 → 容器 CSS 像素（无投影返回 null） */
  worldToScreen(world) {
    const imagePoint = this._worldToImagePoint(world);
    if (!imagePoint) return null;
    return this.imageToScreen(imagePoint.px, imagePoint.py);
  }

  /** 世界坐标 → 图片像素（无投影 / 脏数据返回 null） */
  _worldToImagePoint(point) {
    const proj = this._projection;
    if (!proj || typeof proj.worldToImage !== 'function') return null;
    if (!point || !isNum(Number(point.x)) || !isNum(Number(point.z))) return null;
    let out = null;
    try {
      out = proj.worldToImage(Number(point.x), Number(point.z));
    } catch (err) {
      return null;
    }
    if (!out || !isNum(out.px) || !isNum(out.py)) return null;
    return { px: out.px, py: out.py };
  }

  /** 路径点 → 容器 CSS 像素（内部用；无投影 / 脏坐标返回 null） */
  _project(waypoint) {
    const imagePoint = this._worldToImagePoint(waypoint);
    if (!imagePoint) return null;
    return this.imageToScreen(imagePoint.px, imagePoint.py);
  }

  /* ====================================================================== */
  /* 网格图层                                                               */
  /* ====================================================================== */

  _ensureGridLayer() {
    if (this._gridEl) return this._gridEl;
    if (!this.overlay) return null;
    const el = document.createElement('div');
    el.className = 'canvas-grid';
    el.setAttribute('aria-hidden', 'true');
    const st = el.style;
    st.position = 'absolute';
    st.left = '0px';
    st.top = '0px';
    st.pointerEvents = 'none';
    st.display = 'none';
    st.zIndex = '0';
    st.backgroundImage = [
      'linear-gradient(to right, rgba(150, 190, 165, 0.16) 1px, transparent 1px)',
      'linear-gradient(to bottom, rgba(150, 190, 165, 0.16) 1px, transparent 1px)',
    ].join(', ');
    st.backgroundRepeat = 'repeat';
    // 网格画在标记之下
    this.overlay.insertBefore(el, this.overlay.firstChild);
    this._gridEl = el;
    return el;
  }

  _layoutGrid() {
    if (!this._gridVisible || !this._gridEl || !this._imageSize) return;
    const el = this._gridEl;
    const { width: iw, height: ih } = this._imageSize;
    const left = n4(this.tx);
    const top = n4(this.ty);
    const w = n4(iw * this.scale);
    const h = n4(ih * this.scale);
    if (el.dataset.left !== String(left)) {
      el.style.left = `${left}px`;
      el.dataset.left = String(left);
    }
    if (el.dataset.top !== String(top)) {
      el.style.top = `${top}px`;
      el.dataset.top = String(top);
    }
    if (el.dataset.w !== String(w)) {
      el.style.width = `${w}px`;
      el.dataset.w = String(w);
    }
    if (el.dataset.h !== String(h)) {
      el.style.height = `${h}px`;
      el.dataset.h = String(h);
    }
    const spacing = n4(this._gridSpacing());
    const key = String(spacing);
    if (el.dataset.spacing !== key) {
      el.style.backgroundSize = `${spacing}px ${spacing}px`;
      el.style.backgroundPosition = '0px 0px';
      el.dataset.spacing = key;
    }
  }

  /** 网格屏幕间距：优先按投影的「方块/像素」取整到整数方块，退化时用 128 图片像素并做 2 的幂调整 */
  _gridSpacing() {
    const proj = this._projection;
    let stepPx = 0; // 网格在图片像素上的步长
    if (proj && proj.isValid !== false
      && isNum(proj.xMin) && isNum(proj.xMax) && isNum(proj.imageWidth) && proj.imageWidth > 0
      && proj.xMax > proj.xMin) {
      const blocksPerPx = (proj.xMax - proj.xMin) / proj.imageWidth;
      if (blocksPerPx > 0) {
        // 先假设 64 方块一格，再按屏幕间距调整
        const candidates = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
        let best = 0;
        for (const blocks of candidates) {
          const px = blocks / blocksPerPx;
          const screen = px * this.scale;
          if (screen >= 48 && screen <= 192) {
            best = px;
            break;
          }
          if (screen < 48) best = px; // 记录「还太小」的最后一个，往大继续找
        }
        stepPx = best || (64 / blocksPerPx);
      }
    }
    if (!(stepPx > 0)) stepPx = 128;

    let spacing = stepPx * this.scale;
    let guard = 0;
    while (spacing > 0 && spacing < 48 && guard < 24) {
      stepPx *= 2;
      spacing *= 2;
      guard += 1;
    }
    guard = 0;
    while (spacing > 192 && guard < 24) {
      stepPx /= 2;
      spacing /= 2;
      guard += 1;
    }
    if (!(spacing > 0) || !Number.isFinite(spacing)) return 128;
    return spacing;
  }

  /* ====================================================================== */
  /* 事件：滚轮 / 指针 / 键盘                                                */
  /* ====================================================================== */

  /** 命中「不该由画布处理」的 UI 元素？ */
  _isIgnoredTarget(target) {
    if (!target || typeof target.closest !== 'function') return false;
    let hit = null;
    try {
      hit = target.closest(IGNORE_SELECTOR);
    } catch {
      return false;
    }
    return !!hit && hit !== this.container;
  }

  /** 命中标记按钮？ */
  _markerFromTarget(target) {
    if (!target || typeof target.closest !== 'function') return null;
    let el = null;
    try {
      el = target.closest('.marker');
    } catch {
      return null;
    }
    if (!el) return null;
    if (this.overlay && !this.overlay.contains(el)) return null;
    if (!this._els.has(String(el.dataset.id))) return null;
    return el;
  }

  _setCursor(cursor) {
    if (this.container.style.cursor !== cursor) this.container.style.cursor = cursor;
  }

  _onWheel(event) {
    if (this._destroyed) return;
    if (this._isIgnoredTarget(event.target)) return;

    // Ctrl/⌘ + 滚轮时浏览器会缩放整个页面，必须拦住
    event.preventDefault();
    this._cancelAnim();

    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;                                       // 行模式
    else if (event.deltaMode === 2) delta *= Math.max(1, this._viewSize().height); // 页模式
    if (!Number.isFinite(delta) || delta === 0) return;

    this._userMoved = true;
    this._rect = null;
    const factor = Math.exp(-delta * WHEEL_ZOOM_RATE);
    const anchor = this._localPoint(event.clientX, event.clientY);
    this._commit(this._zoomTarget(factor, anchor));
  }

  _onPointerDown(event) {
    if (this._destroyed) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (this._isIgnoredTarget(event.target)) return;

    this._cancelAnim();
    this._rect = this.container.getBoundingClientRect();
    this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      // 指针捕获：拖出容器（甚至拖出窗口）也能继续收到 move / up
      this.container.setPointerCapture(event.pointerId);
    } catch {
      /* 合成事件 / 旧环境不支持捕获，忽略 */
    }

    if (this._pointers.size >= 2) {
      // 双指：进入捏合，取消单指状态，避免松手时误触发点击
      this._pan = null;
      if (this._markerDrag) {
        this._markerDrag.el.classList.remove('is-dragging');
        this._markerDrag = null;
      }
      this._startPinch();
      this._setCursor('grabbing');
      return;
    }

    this._pinch = null;

    const markerEl = this._markerFromTarget(event.target);
    if (markerEl) {
      const id = String(markerEl.dataset.id);
      // 默认不允许直接拖动（避免不小心把点拖走）；「拖动移动」开关开启或按住 Alt 时才可拖
      const dragable = this._dragMoveEnabled === true || event.altKey === true;
      this._markerDrag = {
        pointerId: event.pointerId,
        id,
        el: markerEl,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
        dragable,
        world: null,
        screen: null,
        client: null,
        px: NaN,
        py: NaN,
      };
      this._setCursor(dragable ? 'grab' : 'pointer');
      return;
    }

    this._markerDrag = null;
    this._pan = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTx: this.tx,
      startTy: this.ty,
      moved: false,
    };
    this._setCursor('grabbing');
  }

  _onPointerMove(event) {
    if (this._destroyed) return;

    const tracked = this._pointers.get(event.pointerId);
    if (tracked) {
      tracked.x = event.clientX;
      tracked.y = event.clientY;
    }

    // ---- 双指捏合：缩放 + 双指中点跟随 ----
    if (this._pinch) {
      if (this._pointers.size >= 2) this._updatePinch();
      return;
    }

    // ---- 标记拖拽 ----
    const drag = this._markerDrag;
    if (drag && drag.pointerId === event.pointerId) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.dragable) return; // 拖动未启用：保持「点击选中」语义，不移动
      if (!drag.started && Math.hypot(dx, dy) > MARKER_DRAG_THRESHOLD) {
        drag.started = true;
        drag.el.classList.add('is-dragging');
        this._setCursor('grabbing');
        this._updateDragPosition(event);
        safeCall(this._callbacks.onMarkerDragStart, drag.id, this._markerDragInfo(drag));
        return;
      }
      if (drag.started) {
        this._updateDragPosition(event);
        safeCall(this._callbacks.onMarkerDrag, drag.id, this._markerDragInfo(drag));
      }
      return;
    }

    // ---- 平移 ----
    const pan = this._pan;
    if (pan && pan.pointerId === event.pointerId) {
      const dx = event.clientX - pan.startX;
      const dy = event.clientY - pan.startY;
      if (!pan.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        pan.moved = true;
        this._userMoved = true;
      }
      if (pan.moved) {
        this._commit({ scale: this.scale, tx: pan.startTx + dx, ty: pan.startTy + dy });
      }
      return;
    }

    // ---- 悬停读数 ----
    this._reportHover(event);
  }

  _onPointerUp(event) {
    if (this._destroyed) return;
    this._pointers.delete(event.pointerId);
    try {
      this.container.releasePointerCapture(event.pointerId);
    } catch {
      /* 忽略 */
    }

    // 捏合期间松手：不触发点击
    if (this._pinch) {
      if (this._pointers.size < 2) this._pinch = null;
      if (this._pointers.size === 0) this._finishGesture();
      return;
    }

    const drag = this._markerDrag;
    if (drag && drag.pointerId === event.pointerId) {
      this._markerDrag = null;
      drag.el.classList.remove('is-dragging');
      this._pos.delete(drag.id);
      // 先把标记摆回「数据里的位置」；app 若同步更新了数据，setData 会立刻覆盖成新位置
      this._layoutMarkers();
      if (drag.started) {
        safeCall(this._callbacks.onMarkerDragEnd, { id: drag.id, world: drag.world || null });
      } else {
        const wp = this._byId.get(drag.id);
        if (wp) this.setTooltipFor(wp);
        safeCall(this._callbacks.onMarkerClick, drag.id, {
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }
      if (this._pointers.size === 0) this._finishGesture();
      return;
    }

    const pan = this._pan;
    if (pan && pan.pointerId === event.pointerId) {
      this._pan = null;
      const clicked = !pan.moved;
      if (this._pointers.size === 0) this._finishGesture();
      if (clicked) this._handleMapClick(event);
      return;
    }

    if (this._pointers.size === 0) this._finishGesture();
  }

  _onPointerCancel(event) {
    if (this._destroyed) return;
    this._pointers.delete(event.pointerId);
    if (this._pinch && this._pointers.size < 2) this._pinch = null;

    const drag = this._markerDrag;
    if (drag && drag.pointerId === event.pointerId) {
      drag.el.classList.remove('is-dragging');
      this._markerDrag = null;
      this._pos.delete(drag.id);
      this._layoutMarkers();
    }
    if (this._pan && this._pan.pointerId === event.pointerId) this._pan = null;
    if (this._pointers.size === 0) this._finishGesture();
  }

  _onPointerLeave(event) {
    if (this._destroyed) return;
    if (this._pan || this._pinch || this._markerDrag) return; // 拖拽中离开不算移出
    if (event.pointerType === 'touch') return;                // 触摸抬起后没有悬停概念
    this.setTooltipFor(null);
    this._hoverId = null;
    this._lastHoverKey = '';
    for (const el of this._els.values()) this._toggleClass(el, 'is-hover', false);
    safeCall(this._callbacks.onHover, null);
  }

  _finishGesture() {
    this._rect = null;
    this._setCursor(this._baseCursor());
  }

  /**
   * 标记拖拽中：实时更新位置与世界坐标（只写 transform，不重建 DOM）。
   * 拖拽时标记锚点 = 指针位置（针尖贴光标），松手后由 setData 回到数据位置。
   */
  _updateDragPosition(event) {
    const drag = this._markerDrag;
    if (!drag) return;
    const local = this._localPoint(event.clientX, event.clientY);
    const scale = this.scale > 0 ? this.scale : 1;
    const px = (local.x - this.tx) / scale;
    const py = (local.y - this.ty) / scale;
    const world = this.imageToWorld(px, py);
    drag.screen = local;
    drag.client = { x: event.clientX, y: event.clientY };
    drag.px = px;
    drag.py = py;
    drag.world = world;
    drag.el.style.transform = `translate3d(${n4(local.x)}px, ${n4(local.y)}px, 0)`;
    this._pos.set(drag.id, { x: local.x, y: local.y });
    if (world) this.setTooltipFor(world);
  }

  _markerDragInfo(drag) {
    return {
      world: drag.world || null,
      px: numOrNull(drag.px),
      py: numOrNull(drag.py),
      clientX: drag.client ? drag.client.x : null,
      clientY: drag.client ? drag.client.y : null,
    };
  }

  /** 普通点击地图（未拖拽）：回调 onEmptyClick */
  _handleMapClick(event) {
    if (!this._imageSize) return; // 没有底图时不产生「地图点击」，避免 app 写进垃圾坐标
    const { px, py } = this.screenToImage(event.clientX, event.clientY);
    if (!isNum(px) || !isNum(py)) return;
    const world = this.imageToWorld(px, py);
    const info = { px, py, world };
    safeCall(this._callbacks.onEmptyClick, info);
  }

  /** 指针悬停：上报世界坐标 + 更新坐标读数（拖拽中不更新） */
  _reportHover(event) {
    if (this._pan || this._pinch || this._markerDrag) return;
    const local = this._localPoint(event.clientX, event.clientY);
    const scale = this.scale > 0 ? this.scale : 1;
    const px = (local.x - this.tx) / scale;
    const py = (local.y - this.ty) / scale;
    const world = this.imageToWorld(px, py);
    this.setTooltipFor(world);
    // 同一位置（取整后）不重复上报，避免 onHover 每像素刷屏
    const key = world
      ? `${Math.round(world.x * 4)}:${Math.round(world.z * 4)}`
      : 'none';
    if (key === this._lastHoverKey) return;
    this._lastHoverKey = key;
    safeCall(this._callbacks.onHover, world);
  }

  _onPointerOver(event) {
    if (this._destroyed) return;
    const el = this._markerFromTarget(event.target);
    if (!el) return;
    const related = event.relatedTarget;
    if (related instanceof Node && el.contains(related)) return;
    el.classList.add('is-hover');
    const id = String(el.dataset.id);
    if (this._hoverId === id) return;
    this._hoverId = id;
    const wp = this._byId.get(id);
    if (wp) this.setTooltipFor({ x: Number(wp.x), z: Number(wp.z) });
  }

  _onPointerOut(event) {
    if (this._destroyed) return;
    const el = this._markerFromTarget(event.target);
    if (!el) return;
    const related = event.relatedTarget;
    if (related instanceof Node && el.contains(related)) return;
    el.classList.remove('is-hover');
    if (this._hoverId === String(el.dataset.id)) this._hoverId = null;
  }

  _onDoubleClick(event) {
    if (this._destroyed) return;
    if (this._isIgnoredTarget(event.target)) return;
    event.preventDefault();
    this._cancelAnim();
    this._rect = this.container.getBoundingClientRect();
    this._userMoved = true;
    const anchor = this._localPoint(event.clientX, event.clientY);
    this._animateTo(this._zoomTarget(DBLCLICK_ZOOM, anchor));
  }

  _onKeyDown(event) {
    if (this._destroyed) return;
    if (event.defaultPrevented) return;
    // Ctrl/⌘/Alt 组合键留给浏览器（页面缩放、快捷键），不抢
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable) return;

    const { width, height } = this._viewSize();
    const step = Math.round(Math.max(40, Math.min(width, height) * 0.12));

    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault();
        this.zoomIn();
        break;
      case '-':
      case '_':
        event.preventDefault();
        this.zoomOut();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this._panBy(step, 0);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this._panBy(-step, 0);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this._panBy(0, step);
        break;
      case 'ArrowDown':
        event.preventDefault();
        this._panBy(0, -step);
        break;
      case '0':
        event.preventDefault();
        this.fitToContent({ animate: true });
        break;
      default:
        break;
    }
  }

  /** 方向键平移：地图内容按 (dx, dy) 移动，视觉上就是视野朝反方向走 */
  _panBy(dx, dy) {
    this._cancelAnim();
    this._userMoved = true;
    this._commit({ scale: this.scale, tx: this.tx + dx, ty: this.ty + dy });
  }

  /* ====================================================================== */
  /* 触摸捏合                                                               */
  /* ====================================================================== */

  _startPinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) {
      this._pinch = null;
      return;
    }
    const [a, b] = pts;
    const rect = this._rect || this.container.getBoundingClientRect();
    const midX = (a.x + b.x) / 2 - rect.left;
    const midY = (a.y + b.y) / 2 - rect.top;
    this._pinch = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startScale: this.scale,
      // 中点在缩放过程中始终压住这个图片像素
      imgMid: { x: (midX - this.tx) / this.scale, y: (midY - this.ty) / this.scale },
    };
  }

  _updatePinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2 || !this._pinch) return;
    const [a, b] = pts;
    const rect = this._rect || this.container.getBoundingClientRect();
    const midX = (a.x + b.x) / 2 - rect.left;
    const midY = (a.y + b.y) / 2 - rect.top;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const ratio = dist / this._pinch.startDist;
    const scale = this._resolveScale(this._pinch.startScale * ratio, this.scale);
    this._userMoved = true;
    this._commit({
      scale,
      tx: midX - this._pinch.imgMid.x * scale,
      ty: midY - this._pinch.imgMid.y * scale,
    });
  }

  /* ====================================================================== */
  /* 尺寸变化                                                               */
  /* ====================================================================== */

  /** 容器尺寸变化：保持「容器中心对应的图片点」不动，视觉上不跳 */
  _onResize() {
    if (this._destroyed) return;
    // 窗口可能被拖到不同 DPR 的显示器：重新读设备像素比（瓦片层级 / 插值跟着变）
    this.setDpr();
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!(w > 0) || !(h > 0)) return;

    const prevW = this._viewW;
    const prevH = this._viewH;
    this._viewW = w;
    this._viewH = h;
    this._rect = null;

    if (prevW > 0 && prevH > 0 && (prevW !== w || prevH !== h) && this.scale > 0) {
      const cx = (prevW / 2 - this.tx) / this.scale;
      const cy = (prevH / 2 - this.ty) / this.scale;
      this.tx = w / 2 - cx * this.scale;
      this.ty = h / 2 - cy * this.scale;
    }

    this._applyTransform();
    this._layoutOverlay();
    this._emit();
    this._scheduleTileDraw();
  }
}

/** 站点图标 key → emoji 的兜底（完整表在 model.js，这里只保证不渲染出英文 key） */
const ICON_FALLBACKS = Object.freeze({
  home: '🏠',
  village: '🏘️',
  farm: '🌾',
  mine: '⛏️',
  portal: '🌀',
  chest: '📦',
  diamond: '💎',
  skull: '☠️',
  tower: '🏰',
  ship: '⛵',
  mountain: '⛰️',
  redstone: '🔴',
  nether: '🐷',
  end: '🐉',
  shop: '🛒',
  spawn: '🌍',
  bed: '🛏️',
  pvp: '⚔️',
  event: '🎪',
  question: '❓',
  pin: '🧷',
});

export default EditorCanvas;


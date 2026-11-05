/**
 * assets/js/editor.js —— 编辑面板（editor-dev 拥有）
 *
 * 契约：docs/CONTRACT.md §4
 *   new EditorPanel(rootEl, { onAction, onChange, onSelect, onImportImage })
 *   setDraft(draft) / setSelection(sel) / setValidation({errors, warnings}) /
 *   setDirty(dirty) / setStatus(text, tone) / refresh()
 *
 * 边界（重要）：
 *   - 本文件**不发任何请求**、**不修改 draft**：所有编辑都通过 onChange(patch) 上抛，
 *     所有按钮都只通过 onAction(name) 上抛（名字严格取自契约 §4 的集合）；
 *   - 只 import model.js 的公开 API（ICONS / ICON_KEYS / resolveIcon / iconLabel /
 *     waypointMatchesQuery / dimensionById / waypointById 等）。model.js 暂时缺席时用等价的
 *     本地降级实现兜底，保证页面不会整块白屏；
 *   - index.html 由 Lead 拥有：本文件只在运行时填充 / 绑定节点，不改文件；
 *   - 树 / 工具栏里需要但 index.html 没有的按钮，由本文件动态创建（见文件末尾 DOM 清单）。
 *
 * 额外（契约之外、向后兼容的便利方法，见交付说明）：
 *   setImages(images) / setSiteInfo(info) / setHint(text) / setSavedAt(v) / setAutosave(v) /
 *   setHistoryState({undo,redo}) / setMode(mode) / setCanvasHint(text) / setCanvasEmpty(text) /
 *   showPreview(url) / hidePreview() / showToast(text, tone) / destroy()
 */

import * as Model from './model.js';

/* ============================== 常量 ============================== */

const DEFAULT_COLOR = '#5ad26f';
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LABEL_OPTIONS = [
  ['', '跟随全局'],
  ['always', '始终显示'],
  ['hover', '悬停显示'],
  ['never', '不显示'],
];
const MODE_TEXT = {
  select: '',
  place: '放置模式 · 点击画布放置路径点',
  pick: '拾取模式 · 依次点击两个已知地标',
};
/** 维度「画幅校准」区块的说明：瓦片模式下 calibration 只用于单图兜底（app.js 会按类型原地替换）。 */
const CAL_HINT_SINGLE = '世界坐标映射到图片像素的边界；改动画幅后请重新校准。';
const CAL_HINT_TILES = '瓦片底图的世界范围来自 manifest；下面的 calibration 只用于瓦片加载失败时的单图兜底。';
const TILES_MODE_OPTIONS = [
  ['image', '单图（PNG + 画幅校准）'],
  ['tiles', '瓦片（manifest 清单）'],
];
const TONE_SET = new Set(['info', 'ok', 'warn', 'error']);

/** xaero 子目录名 ↔ 站点维度：中英文叫法不同，先归一化再匹配。 */
const XAERO_ALIASES = new Map([
  ['overworld', ['overworld', 'world', '主世界', '地表', '地面']],
  ['nether', ['nether', 'thenether', '下界', '地狱']],
  ['theend', ['theend', 'end', '末地', '末路之地']],
].map(([canonical, aliases]) => [
  canonical,
  new Set(aliases.map((name) => normalizeXaeroName(name))),
]));

function normalizeXaeroName(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, '');
}

function canonicalXaeroName(value) {
  const key = normalizeXaeroName(value);
  if (!key) return '';
  for (const [canonical, aliases] of XAERO_ALIASES) {
    if (aliases.has(key)) return canonical;
  }
  return key;
}

/** model.js 缺席时的图标兜底表（与站点 markers.js 的 ICONS 一致）。 */
const FALLBACK_ICONS = Object.freeze({
  pin: '🧷', home: '🏠', village: '🏘️', farm: '🌾', mine: '⛏️', portal: '🌀', chest: '📦',
  diamond: '💎', skull: '☠️', tower: '🏰', ship: '⛵', mountain: '⛰️', redstone: '🔴',
  nether: '🐷', end: '🐉', shop: '🛒', spawn: '🌍', bed: '🛏️', pvp: '⚔️', event: '🎪',
  question: '❓',
});

const MODEL = Model && typeof Model === 'object' ? Model : {};
const ICONS = MODEL.ICONS && typeof MODEL.ICONS === 'object' ? MODEL.ICONS : FALLBACK_ICONS;
const ICON_KEYS = Array.isArray(MODEL.ICON_KEYS) && MODEL.ICON_KEYS.length
  ? MODEL.ICON_KEYS.slice()
  : Object.keys(ICONS);

/* ============================== model.js 轻量适配 ============================== */

function resolveIconOf(icon) {
  if (typeof MODEL.resolveIcon === 'function') {
    try { return MODEL.resolveIcon(icon); } catch { /* 降级 */ }
  }
  if (typeof icon !== 'string') return ICONS.pin || '📍';
  const value = icon.trim();
  if (!value) return ICONS.pin || '📍';
  if (Object.prototype.hasOwnProperty.call(ICONS, value)) return ICONS[value];
  if (Array.from(value).length <= 2) return value;
  return ICONS.pin || '📍';
}

function iconLabelOf(key) {
  if (typeof MODEL.iconLabel === 'function') {
    try {
      const text = MODEL.iconLabel(key);
      if (typeof text === 'string' && text) return text;
    } catch { /* 降级 */ }
  }
  return String(key);
}

function matchesQuery(waypoint, query) {
  if (typeof MODEL.waypointMatchesQuery === 'function') {
    try { return Boolean(MODEL.waypointMatchesQuery(waypoint, query)); } catch { /* 降级 */ }
  }
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  const wp = waypoint || {};
  const fields = [wp.name, wp.id, wp.description, wp.group, wp.icon, wp.x, wp.y, wp.z];
  return fields.some((value) => value != null && String(value).toLowerCase().includes(q));
}

function dimensionByIdOf(draft, id) {
  if (typeof MODEL.dimensionById === 'function') {
    try {
      const hit = MODEL.dimensionById(draft, id);
      if (hit) return hit;
    } catch { /* 降级 */ }
  }
  const dims = Array.isArray(draft && draft.dimensions) ? draft.dimensions : [];
  return dims.find((dim) => String(dim && dim.id) === String(id)) || null;
}

function waypointByIdOf(dimension, id) {
  if (typeof MODEL.waypointById === 'function') {
    try {
      const hit = MODEL.waypointById(dimension, id);
      if (hit) return hit;
    } catch { /* 降级 */ }
  }
  const list = Array.isArray(dimension && dimension.waypoints) ? dimension.waypoints : [];
  return list.find((wp) => String(wp && wp.id) === String(id)) || null;
}

/* ============================== 纯函数小工具 ============================== */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

/** 静态 SVG 精灵引用（只拼接本文件内的常量 id，没有用户输入）。 */
function svgUse(symbolId) {
  return `<svg class="icon" aria-hidden="true"><use href="#${symbolId}"></use></svg>`;
}

function str(value, fallback = '') {
  return value == null ? fallback : String(value);
}

function clampText(value, max) {
  const text = value == null ? '' : String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fmtBlock(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '—';
}

function waypointCoordText(waypoint) {
  const wp = waypoint || {};
  const head = `X ${fmtBlock(wp.x)}`;
  const tail = `Z ${fmtBlock(wp.z)}`;
  return Number.isFinite(wp.y) ? `${head} · Y ${fmtBlock(wp.y)} · ${tail}` : `${head} · ${tail}`;
}

function fmtClock(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && /^\d{1,2}:\d{2}/.test(value)) return value.slice(0, 5);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function validHex(value) {
  return typeof value === 'string' && HEX_RE.test(value.trim()) ? value.trim().toLowerCase() : '';
}

function normalizeSelection(sel) {
  const source = sel && typeof sel === 'object' ? sel : {};
  return {
    dimensionId: source.dimensionId == null || source.dimensionId === '' ? null : source.dimensionId,
    waypointId: source.waypointId == null || source.waypointId === '' ? null : source.waypointId,
    groupId: source.groupId == null || source.groupId === '' ? null : source.groupId,
  };
}

function selectionKey(sel) {
  const value = normalizeSelection(sel);
  return `${str(value.dimensionId)}|${str(value.waypointId)}|${str(value.groupId)}`;
}

function makeTone(tone) {
  return TONE_SET.has(tone) ? tone : 'info';
}

/* ============================== 表单控件工厂 ============================== */

function controlId(key) {
  return `f-${String(key || 'x').replace(/[^\w-]/g, '-')}`;
}

function makeInput(spec) {
  const {
    type = 'text', key, field, value, placeholder, step, readonly, mono,
    patchKind, commit, min, max, maxlength, inputmode,
  } = spec;
  const input = document.createElement('input');
  input.className = `form-input${mono ? ' mono' : ''}`;
  input.id = controlId(key);
  input.type = type;
  if (field) input.dataset.field = field;
  if (key) input.dataset.fieldKey = key;
  if (patchKind) input.dataset.patchKind = patchKind;
  if (commit) input.dataset.commit = commit;
  if (placeholder != null) input.placeholder = placeholder;
  if (step != null) input.step = step;
  if (min != null) input.min = String(min);
  if (max != null) input.max = String(max);
  if (maxlength != null) input.maxLength = maxlength;
  if (inputmode) input.inputMode = inputmode;
  if (readonly) input.readOnly = true;
  if (value !== null && value !== undefined && value !== '') input.value = String(value);
  return input;
}

function makeSelect(spec) {
  const { key, field, value, options, patchKind } = spec;
  const select = document.createElement('select');
  select.className = 'form-select';
  select.id = controlId(key);
  if (field) select.dataset.field = field;
  if (key) select.dataset.fieldKey = key;
  if (patchKind) select.dataset.patchKind = patchKind;
  const current = value == null ? '' : String(value);
  let matched = false;
  for (const [optionValue, optionLabel] of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = optionLabel;
    if (String(optionValue) === current) {
      option.selected = true;
      matched = true;
    }
    select.appendChild(option);
  }
  if (!matched && current) {
    const extra = document.createElement('option');
    extra.value = current;
    extra.textContent = `${current}（当前值）`;
    extra.selected = true;
    select.insertBefore(extra, select.firstChild);
  }
  return select;
}

function makeCheckbox(spec) {
  const { key, field, checked, label, patchKind } = spec;
  const wrap = document.createElement('label');
  wrap.className = 'form-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = controlId(key);
  input.checked = Boolean(checked);
  if (field) input.dataset.field = field;
  if (key) input.dataset.fieldKey = key;
  if (patchKind) input.dataset.patchKind = patchKind;
  const text = el('span', 'form-check-text', label);
  wrap.append(input, text);
  wrap.htmlFor = input.id;
  return wrap;
}

function makeTextarea(spec) {
  const { key, field, value, placeholder, rows = 3, patchKind } = spec;
  const area = document.createElement('textarea');
  area.className = 'form-textarea';
  area.id = controlId(key);
  area.rows = rows;
  if (field) area.dataset.field = field;
  if (key) area.dataset.fieldKey = key;
  if (patchKind) area.dataset.patchKind = patchKind;
  if (placeholder != null) area.placeholder = placeholder;
  if (value != null) area.value = String(value);
  return area;
}

/* ============================== EditorPanel ============================== */

export class EditorPanel {
  constructor(rootEl, handlers = {}) {
    const options = handlers && typeof handlers === 'object' ? handlers : {};
    this.root = rootEl && typeof rootEl.querySelector === 'function' ? rootEl : document;
    this._doc = this.root.nodeType === 9 ? this.root : (this.root.ownerDocument || document);

    this.onAction = typeof options.onAction === 'function' ? options.onAction : null;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this.onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
    this.onImportImage = typeof options.onImportImage === 'function' ? options.onImportImage : null;

    this.draft = null;
    this.selection = { dimensionId: null, waypointId: null, groupId: null };
    this.issues = { errors: [], warnings: [] };
    this._issueIndex = new Map();
    this._query = '';
    this._collapsed = new Set();
    this._images = [];
    this._xaeroSources = [];
    this._activeDimensionId = null;
    this._dirty = false;
    this._savedAt = null;
    this._autosaveAt = null;
    this._status = { text: '加载中…', tone: 'info' };
    this._history = { undo: true, redo: true };
    this._formStale = false;
    this._revealPending = false;
    this._treeRendered = false;
    this._toastTimer = 0;
    this._destroyed = false;
    this._listeners = [];

    this.el = this._collect();
    this._bind();
    this._buildTools();
    this._renderAll({ forceForm: true });
  }

  /* ------------------------------ 节点收集 ------------------------------ */

  _q(id) {
    const scoped = this.root.querySelector ? this.root.querySelector(`#${id}`) : null;
    if (scoped) return scoped;
    return this._doc.getElementById(id);
  }

  _collect() {
    const ids = [
      'dimension-tabs', 'search', 'tree', 'issues', 'issues-count', 'status', 'form',
      'form-title', 'form-subtitle', 'draft-meta', 'footer-site', 'footer-hint',
      'mode-badge', 'canvas-hint', 'canvas-empty', 'toolbar',
      'btn-undo', 'btn-redo', 'btn-save', 'btn-preview', 'btn-import-config',
      'btn-export-json', 'btn-fit', 'file-image', 'file-config', 'toast',
      'preview-dialog', 'preview-frame', 'btn-preview-close', 'btn-preview-reload',
    ];
    const nodes = {};
    for (const id of ids) nodes[id] = this._q(id);
    return nodes;
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  _on(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, options);
    this._listeners.push([target, type, handler, options]);
  }

  _emit(name, payload) {
    const fn = this[name];
    if (typeof fn !== 'function') return;
    try {
      fn(payload);
    } catch (error) {
      console.error(`[editor] ${name} 回调抛错：`, error);
    }
  }

  _emitAction(name, extra) {
    if (!name || typeof this.onAction !== 'function') return;
    try {
      this.onAction(name, extra);
    } catch (error) {
      console.error('[editor] onAction 回调抛错：', error);
    }
  }

  _emitSelect(sel) {
    const target = normalizeSelection(sel);
    this.setSelection(target);
    if (typeof this.onSelect === 'function') {
      try {
        this.onSelect({ ...target });
      } catch (error) {
        console.error('[editor] onSelect 回调抛错：', error);
      }
    }
  }

  _bind() {
    const doc = this._doc;

    /* 1) 全局委托：[data-action] → onAction(name)、维度标签、树操作 */
    this._on(doc, 'click', (event) => this._onDocumentClick(event));

    /* 2) 搜索框 */
    this._on(this.el.search, 'input', (event) => {
      this._query = event.target.value || '';
      this._renderTree();
    });

    /* 3) 表单输入 → onChange(patch) */
    this._on(this.el.form, 'input', (event) => this._onFormEvent(event));
    this._on(this.el.form, 'change', (event) => this._onFormEvent(event));
    this._on(this.el.form, 'click', (event) => this._onFormClick(event));
    this._on(this.el.form, 'focusout', (event) => this._onFormFocusOut(event));

    /* 4) 树键盘操作 */
    this._on(this.el.tree, 'keydown', (event) => this._onTreeKeydown(event));
    this._on(this.el.tree, 'dblclick', (event) => this._onTreeDoubleClick(event));

    /* 5) 工具栏按钮：只加 data-action，点击统一走全局委托 */
    const actionById = {
      'btn-undo': 'undo',
      'btn-redo': 'redo',
      'btn-save': 'save',
      'btn-preview': 'preview',
      'btn-import-config': 'import-config',
      'btn-export-json': 'export-json',
      'btn-fit': 'fit',
    };
    for (const [id, action] of Object.entries(actionById)) {
      const node = this.el[id];
      if (node) node.dataset.action = action;
    }

    /* 6) 本地图片选择：
     *    app.js 自己给 #file-image 绑了 change（内部调用 importImage），所以这里**不再重复绑定**，
     *    否则一次选择会导入两次。本面板只负责「导入本地图片」按钮去触发 #file-image.click()
     *    （走 document 委托里的 [data-import-image]）。
     *    如需由面板独占导入，可删掉 app.js 的对应绑定后再打开下面的注释。 */
    // this._on(this.el['file-image'], 'change', (event) => {
    //   const input = event.target;
    //   const file = input.files && input.files[0];
    //   input.value = '';
    //   if (!file || typeof this.onImportImage !== 'function') return;
    //   this.onImportImage(file);
    // });

    /* 7) 预览弹层：app.js 已经绑定了关闭 / 刷新 / 遮罩点击 / Esc，
     *    这里不重复绑定（避免一次点击触发两次请求或两次关闭）。
     *    showPreview(url) / hidePreview() 仍作为可选 API 保留。 */

    /* 8) 状态条 / 草稿信息初值 */
    this._renderStatus();
    this._renderMeta();
  }

  _onDocumentClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    const actionEl = target.closest('[data-action]');
    if (actionEl) {
      const name = actionEl.dataset.action;
      if (name) {
        event.preventDefault();
        this._emitAction(name, actionEl);
        return;
      }
    }

    if (target.closest('[data-import-image]')) {
      event.preventDefault();
      if (this.el['file-image']) this.el['file-image'].click();
      return;
    }

    const dimTab = target.closest('[data-dim-tab]');
    if (dimTab) {
      event.preventDefault();
      const id = dimTab.dataset.dimTab;
      if (id) this._emitSelect({ dimensionId: id });
      return;
    }

    const treeEl = this.el.tree;
    if (treeEl && treeEl.contains(target)) {
      const actEl = target.closest('[data-tree-act]');
      if (actEl) {
        event.preventDefault();
        this._onTreeAction(actEl.dataset.treeAct, actEl);
        return;
      }
      const item = target.closest('[data-waypoint-id]');
      if (item) {
        event.preventDefault();
        this._emitSelect({
          dimensionId: item.dataset.dimId,
          waypointId: item.dataset.waypointId,
        });
        return;
      }

      // 兜底：直接点分组容器（e2e 常按 #tree [data-group-id="…"] 点击）也选中分组
      const groupEl = target.closest('[data-group-id]');
      if (groupEl) {
        const groupId = groupEl.dataset.groupId;
        if (groupId) {
          event.preventDefault();
          const dimId = groupEl.dataset.dimensionId || groupEl.dataset.dimId || '';
          this._emitSelect({ dimensionId: dimId || undefined, groupId });
        }
      }
    }
  }

  /* ------------------------------ 树交互 ------------------------------ */

  _onTreeAction(action, node) {
    const dim = this._activeDimension();
    if (!dim) return;
    const groupKey = node.dataset.groupKey || '';
    const groupId = node.dataset.groupId || '';
    const rowNode = typeof node.closest === 'function' ? node.closest('[data-waypoint-id]') : null;
    const waypointId = node.dataset.waypointId || (rowNode ? rowNode.dataset.waypointId : '') || '';

    if (action === 'toggle-group') {
      if (this._collapsed.has(groupKey)) this._collapsed.delete(groupKey);
      else this._collapsed.add(groupKey);
      this._renderTree();
      return;
    }

    if (action === 'select-group') {
      if (!groupId) return;
      this._emitSelect({ dimensionId: dim.id, groupId });
      return;
    }

    if (action === 'toggle-visible') {
      if (!groupId) return;
      const group = (dim.groups || []).find((item) => String(item.id) === String(groupId));
      if (!group) return;
      this._emit('onChange', {
        kind: 'group',
        id: group.id,
        dimensionId: dim.id,
        field: 'visible',
        value: group.visible === false,
      });
      return;
    }

    if (action === 'copy' || action === 'delete') {
      if (!waypointId) return;
      const waypoint = waypointByIdOf(dim, waypointId);
      if (!waypoint) return;
      this._emitSelect({ dimensionId: dim.id, waypointId: waypoint.id });
      this._emitAction(action === 'copy' ? 'duplicate-waypoint' : 'delete-waypoint');
      return;
    }

    if (action === 'toggle-eye' && groupId) {
      this._onTreeAction('toggle-visible', node);
    }
  }

  _onTreeKeydown(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const isActivate = event.key === 'Enter' || event.key === ' ';
    const item = target.closest('[data-waypoint-id]');
    if (item && isActivate) {
      event.preventDefault();
      this._emitSelect({ dimensionId: item.dataset.dimId, waypointId: item.dataset.waypointId });
      return;
    }
    const head = target.closest('.tree-group-head');
    if (head) {
      if (isActivate) {
        event.preventDefault();
        this._emitSelect({ dimensionId: head.dataset.dimId, groupId: head.dataset.groupId });
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const key = head.dataset.groupKey || '';
        const collapsed = this._collapsed.has(key);
        const shouldCollapse = event.key === 'ArrowLeft';
        if (collapsed !== shouldCollapse) {
          if (shouldCollapse) this._collapsed.add(key);
          else this._collapsed.delete(key);
          this._renderTree();
        }
      }
    }
  }

  _onTreeDoubleClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const item = target.closest('[data-waypoint-id]');
    if (!item) return;
    event.preventDefault();
    // 契约动作集合里没有 focus-waypoint：重复派发选中，由 app 在选中时调画布 focus
    this._emitSelect({ dimensionId: item.dataset.dimId, waypointId: item.dataset.waypointId });
  }

  /* ------------------------------ 表单交互 ------------------------------ */

  _onFormEvent(event) {
    const form = this.el.form;
    const target = event.target;
    if (!form || !target || !form.contains(target)) return;
    const field = target.dataset.field;
    if (!field) return;

    const isToggle = target.tagName === 'SELECT' || target.type === 'checkbox';
    if (isToggle && event.type !== 'change') return;
    if (!isToggle && event.type !== 'input' && event.type !== 'change') return;
    if (target.dataset.commit === 'change' && event.type !== 'change') return;

    let value;
    if (target.type === 'checkbox') {
      value = target.checked;
    } else if (target.type === 'number') {
      // 与 app.js 的约定：数字输入框直接传字符串，由 app 做数值转换
      value = String(target.value == null ? '' : target.value);
    } else if (field === 'color' || field === 'url' || field === 'label') {
      const raw = String(target.value || '').trim();
      value = raw === '' ? null : raw;
    } else {
      value = target.value;
    }

    const kind = target.dataset.patchKind || form.dataset.kind;
    if (!kind) return;
    const patch = { kind, field, value };
    if (form.dataset.entityId != null && form.dataset.entityId !== '') patch.id = form.dataset.entityId;
    this._emit('onChange', patch);

    // 切换「底图类型」会改变表单结构（瓦片清单 / 瓦片摘要）。app 的 refresh() 在输入框仍有焦点时
    // 只把表单标记为 stale、不会重建 DOM（见 _isFormFocused），所以这里就地显示/隐藏瓦片相关行，
    // 保证下拉一改用户马上看到「瓦片清单」。焦点离开后由 _onFormFocusOut 走正常重建。
    if (field === 'tiles.mode' && target.tagName === 'SELECT' && form.contains(target)) {
      this._applyTilesModeView(str(target.value) === 'tiles');
    }
  }

  _onFormClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const form = this.el.form;
    if (!form || !form.contains(target)) return;
    const kind = form.dataset.kind;

    const iconOption = target.closest('[data-icon]');
    if (iconOption && form.contains(iconOption)) {
      event.preventDefault();
      const value = iconOption.dataset.icon;
      for (const node of form.querySelectorAll('.icon-option')) {
        node.classList.toggle('is-active', node === iconOption);
      }
      const current = form.querySelector('.icon-current');
      if (current) current.textContent = resolveIconOf(value);
      const custom = form.querySelector('[data-field="icon"][data-field-key="wp-icon-custom"]');
      if (custom) custom.value = '';
      const patch = { kind: kind || 'waypoint', field: 'icon', value };
      if (form.dataset.entityId) patch.id = form.dataset.entityId;
      this._emit('onChange', patch);
      return;
    }

    const clearColor = target.closest('[data-clear-color]');
    if (clearColor && form.contains(clearColor)) {
      event.preventDefault();
      const text = form.querySelector('[data-field="color"][data-field-key$="-color-text"]');
      if (text) text.value = '';
      const picker = form.querySelector('input[type="color"][data-field="color"]');
      if (picker) picker.value = DEFAULT_COLOR;
      const hint = form.querySelector('.form-color-hint');
      if (hint) hint.textContent = '跟随分组颜色';
      const patch = { kind: kind || 'waypoint', field: 'color', value: null };
      if (form.dataset.entityId) patch.id = form.dataset.entityId;
      this._emit('onChange', patch);
    }
  }

  _onFormFocusOut(event) {
    if (!this._formStale) return;
    const form = this.el.form;
    if (!form) return;
    const next = event.relatedTarget;
    if (next && form.contains(next)) return;
    setTimeout(() => {
      if (!this._formStale || this._destroyed) return;
      if (form.contains(document.activeElement)) return;
      this._formStale = false;
      this._renderForm();
    }, 0);
  }

  /* ============================== 公开 API（契约 §4） ============================== */

  setDraft(draft) {
    this.draft = draft && typeof draft === 'object' ? draft : null;
    this._syncImagesFromApp();
    this._renderAll();
  }

  setSelection(sel) {
    const previousKey = selectionKey(this.selection);
    const previousActiveId = this._activeDimensionId;
    const next = normalizeSelection(sel);
    this.selection = next;

    if (next.dimensionId != null) this._activeDimensionId = next.dimensionId;
    if (next.waypointId != null) {
      const dim = this._dimensionOfWaypoint(next.waypointId, next.dimensionId);
      if (dim) {
        this._activeDimensionId = dim.id;
        const wp = waypointByIdOf(dim, next.waypointId);
        if (wp) this._collapsed.delete(`${dim.id}::${str(wp.group)}`);
        this._revealPending = true;
      }
    }

    // 只更新高亮：维度没变时绝不重建整棵树（拖拽 / 点选会频繁调用）
    const active = this._activeDimension();
    const activeChanged = previousActiveId != null && String(previousActiveId) !== str(active && active.id);
    const tabsHost = this.el['dimension-tabs'];
    if (activeChanged || !tabsHost || !tabsHost.childElementCount) this._renderTabs();
    else this._applyTabSelection();
    if (activeChanged || !this._treeRendered) {
      this._renderTree();
    } else {
      this._applyTreeSelection();
    }

    // 表单：选中对象没变且用户正在输入时不要打断，等失焦后再同步
    const ctx = this._selectionContext();
    const identity = this._formIdentity(ctx);
    const current = this.el.form
      ? `${str(this.el.form.dataset.kind)}:${str(this.el.form.dataset.entityId)}`
      : '';
    const same = selectionKey(next) === previousKey;
    if (this._isFormFocused() && (identity === current || same)) {
      this._formStale = true;
      return;
    }
    this._formStale = false;
    this._renderForm();
  }

  setValidation(validation) {
    const source = validation && typeof validation === 'object' ? validation : {};
    this.issues = {
      errors: Array.isArray(source.errors) ? source.errors : [],
      warnings: Array.isArray(source.warnings) ? source.warnings : [],
    };
    this._indexIssues();
    this._renderIssues();
    this._renderTabs();
    this._renderTree();
  }

  setDirty(dirty) {
    this._dirty = Boolean(dirty);
    this._renderMeta();
  }

  setStatus(text, tone) {
    this._status = { text: text == null ? '' : String(text), tone: makeTone(tone) };
    this._renderStatus();
  }

  refresh() {
    if (this._destroyed) return;
    this._syncImagesFromApp();
    this._renderTabs();
    this._renderTree();
    this._renderIssues();
    this._renderMeta();
    this._renderStatus();
    if (this._isFormFocused()) {
      this._formStale = true;
      // app 在 manifest 加载完后会写 dim.tileMeta 再 refresh()；此时用户多半正停在表单里输入，
      // 整个表单不能重建（会吞掉焦点/光标），但「瓦片底图」摘要必须马上反映最新 tileMeta。
      this._refreshTilesSummaryInPlace();
      return;
    }
    this._formStale = false;
    this._renderForm();
  }

  /* ============================== 便利 API（契约之外） ============================== */

  /** app.js 在搜索框输入时会调用；外部设置过滤词。 */
  setSearch(text) {
    const value = text == null ? '' : String(text);
    if (value === this._query && this.el.search && this.el.search.value === value) return;
    this._query = value;
    if (this.el.search && this.el.search.value !== value) this.el.search.value = value;
    this._renderTree();
  }

  /**
   * 兜底：app.js 目前只在导入图片后调用 setImages，启动时不调用。
   * 若本面板还没有图片列表，就从 app 的调试接口 window.__tool.state() 里读一次，
   * 保证维度表单的「图片」下拉在首屏就是完整的（Lead 补上启动调用后这里自然失效）。
   */
  _syncImagesFromApp() {
    if (this._images.length) return;
    try {
      const app = typeof window !== 'undefined' ? window.__tool : null;
      const info = app && typeof app.state === 'function' ? app.state() : null;
      const list = info && Array.isArray(info.images) ? info.images : null;
      if (!list || !list.length) return;
      this._images = list
        .map((item) => (typeof item === 'string' ? { name: item } : item))
        .filter((item) => item && item.name);
    } catch {
      /* 读不到就算了，下拉退化成「当前图片」 */
    }
  }

  /** /api/state 返回的 images：[{name, width?, height?}] 或 ['a.png']。 */
  setImages(images) {
    const list = Array.isArray(images) ? images : [];
    this._images = list
      .map((item) => (typeof item === 'string' ? { name: item } : item))
      .filter((item) => item && item.name);
    const ctx = this._selectionContext();
    if (ctx.kind === 'dimension' || ctx.kind === 'empty' || ctx.kind === 'overview') {
      if (!this._isFormFocused()) this._renderForm();
    }
  }

  /** /api/state 的 xaero 列表：[{folder, kind, images, regions, bounds, bytes}]。 */
  setXaeroSources(sources) {
    const list = Array.isArray(sources) ? sources : [];
    this._xaeroSources = list
      .filter((item) => item && typeof item === 'object' && item.folder)
      .map((item) => ({ ...item }));
    const ctx = this._selectionContext();
    if (ctx.kind === 'dimension' && !this._isFormFocused()) this._renderForm();
  }

  /** { siteDir, siteExists } 或 'D:/…/SteveServerMap.github.io'。 */
  setSiteInfo(info) {
    const node = this.el['footer-site'];
    if (!node) return;
    if (info == null) {
      node.textContent = '站点目录：—';
      return;
    }
    if (typeof info === 'string') {
      node.textContent = `站点目录：${info}`;
      return;
    }
    const dir = info.siteDir || info.dir || '—';
    const text = `站点目录：${dir}`;
    node.textContent = info.siteExists === false ? `${text}（不存在）` : text;
  }

  setHint(text) {
    const node = this.el['footer-hint'];
    if (node) node.textContent = text == null ? '' : String(text);
  }

  setSavedAt(value) {
    this._savedAt = value;
    this._renderMeta();
  }

  setAutosave(value) {
    this._autosaveAt = value;
    this._renderMeta();
  }

  setHistoryState(state) {
    const source = state && typeof state === 'object' ? state : {};
    this._history = {
      undo: source.undo !== false,
      redo: source.redo !== false,
    };
    if (this.el['btn-undo']) this.el['btn-undo'].disabled = !this._history.undo;
    if (this.el['btn-redo']) this.el['btn-redo'].disabled = !this._history.redo;
  }

  setMode(mode) {
    const node = this.el['mode-badge'];
    if (!node) return;
    const text = MODE_TEXT[mode] || '';
    node.textContent = text;
    node.hidden = !text;
    node.dataset.mode = mode == null ? 'select' : String(mode);
  }

  setCanvasHint(text) {
    const node = this.el['canvas-hint'];
    if (!node) return;
    node.textContent = text == null ? '' : String(text);
    node.hidden = !text;
  }

  setCanvasEmpty(text) {
    const node = this.el['canvas-empty'];
    if (!node) return;
    node.textContent = text == null ? '' : String(text);
    node.hidden = !text;
  }

  showPreview(url) {
    const dialog = this.el['preview-dialog'];
    const frame = this.el['preview-frame'];
    if (!dialog || !frame) return;
    if (url) frame.src = String(url);
    dialog.hidden = false;
    dialog.classList.add('is-open');
    document.body.classList.add('preview-open');
    if (this.el['btn-preview-close']) this.el['btn-preview-close'].focus();
  }

  hidePreview() {
    const dialog = this.el['preview-dialog'];
    const frame = this.el['preview-frame'];
    if (dialog) {
      dialog.hidden = true;
      dialog.classList.remove('is-open');
    }
    document.body.classList.remove('preview-open');
    if (frame) frame.src = 'about:blank';
  }

  showToast(text, tone = 'info', duration = 2800) {
    const node = this.el.toast;
    if (!node) return;
    if (this._toastTimer) clearTimeout(this._toastTimer);
    node.textContent = text == null ? '' : String(text);
    node.dataset.tone = makeTone(tone);
    node.hidden = false;
    node.classList.add('is-show');
    this._toastTimer = setTimeout(() => {
      this._toastTimer = 0;
      node.classList.remove('is-show');
      node.hidden = true;
    }, Math.max(600, Number(duration) || 2800));
  }

  destroy() {
    this._destroyed = true;
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = 0;
    for (const [target, type, handler, options] of this._listeners) {
      try {
        target.removeEventListener(type, handler, options);
      } catch { /* 忽略 */ }
    }
    this._listeners = [];
  }

  /* ============================== 渲染入口 ============================== */

  _renderAll(options = {}) {
    this._renderTabs();
    this._renderTree();
    this._renderIssues();
    this._renderMeta();
    this._renderStatus();
    const forceForm = Boolean(options.forceForm) || !this._isFormFocused();
    if (forceForm) {
      this._formStale = false;
      this._renderForm();
    } else {
      this._formStale = true;
    }
  }

  _isFormFocused() {
    const form = this.el.form;
    if (!form) return false;
    const active = document.activeElement;
    return Boolean(active && form.contains(active));
  }

  /* ------------------------------ 维度标签页 ------------------------------ */

  _renderTabs() {
    const host = this.el['dimension-tabs'];
    if (!host) return;
    host.textContent = '';
    const active = this._activeDimension();

    if (!this._dimensions.length) {
      host.appendChild(el('span', 'dim-tab-empty', '无维度'));
    }

    for (const dim of this._dimensions) {
      const id = str(dim.id);
      const isActive = Boolean(active) && String(active.id) === id;
      const button = el('button', 'dim-tab');
      button.type = 'button';
      button.dataset.dimTab = id;
      button.dataset.dimensionId = id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      // 瓦片维度在标签 title 里标一下（不改 DOM 结构，避免影响样式与既有选择器）
      button.title = `${str(dim.name, id)} · ${(dim.waypoints || []).length} 个路径点${dim.tiles ? ' · 瓦片底图' : ''}`;
      if (isActive) button.classList.add('is-active');

      button.appendChild(el('span', 'dim-tab-name', str(dim.name, id)));
      button.appendChild(el('span', 'dim-tab-count', String((dim.waypoints || []).length)));

      this._decorateIssue(button, `dim:${id}`, 'dim-tab-dot');
      host.appendChild(button);
    }

    const add = el('button', 'dim-tab dim-tab-add', '+');
    add.type = 'button';
    add.dataset.action = 'new-dimension';
    add.title = '新建维度';
    add.setAttribute('aria-label', '新建维度');
    host.appendChild(add);
  }

  /** 只更新维度标签页的高亮（不重建 DOM）。 */
  _applyTabSelection() {
    const host = this.el['dimension-tabs'];
    if (!host) return;
    const active = this._activeDimension();
    const activeId = active ? str(active.id) : '';
    for (const tab of host.querySelectorAll('[data-dim-tab]')) {
      const on = tab.dataset.dimTab === activeId;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  /* ------------------------------ 树 ------------------------------ */

  _buildTools() {
    const tree = this.el.tree;
    if (!tree || !tree.parentNode) return;
    if (this._doc.getElementById('editor-tools')) return;

    const tools = el('div', 'editor-tools');
    tools.id = 'editor-tools';
    tools.setAttribute('role', 'toolbar');
    tools.setAttribute('aria-label', '新建与视图');

    const button = (label, action, extraClass = '') => {
      const node = el('button', `btn ghost small${extraClass ? ` ${extraClass}` : ''}`, label);
      node.type = 'button';
      node.dataset.action = action;
      return node;
    };

    // QA 的 e2e 依赖固定 id，这里给两个关键按钮补上 id
    const newWaypoint = button('+ 路径点', 'new-waypoint');
    newWaypoint.id = 'btn-new-waypoint';
    newWaypoint.setAttribute('aria-label', '新建路径点');
    newWaypoint.title = '在画布中心新建路径点，然后在画布上点一下定位';
    const newGroup = button('+ 分组', 'new-group');
    newGroup.setAttribute('aria-label', '新建分组');
    const calibrate = button('校准', 'goto-calibrate');
    calibrate.id = 'btn-calibrate';
    calibrate.setAttribute('aria-label', '打开画幅校准');
    calibrate.title = '打开画幅校准（两点拾取 / 手动输入）';

    tools.append(
      newWaypoint,
      newGroup,
      button('+ 维度', 'new-dimension'),
      calibrate,
    );

    const toggles = el('div', 'editor-toggles');
    toggles.setAttribute('role', 'group');
    toggles.setAttribute('aria-label', '视图');
    const gridBtn = button('网格', 'grid');
    gridBtn.setAttribute('aria-pressed', 'false');
    const labelsBtn = button('标签', 'toggle-labels');
    labelsBtn.setAttribute('aria-pressed', 'false');
    toggles.append(gridBtn, labelsBtn);

    tree.parentNode.insertBefore(tools, tree);
    tree.parentNode.insertBefore(toggles, tree);
  }

  _renderTree() {
    const tree = this.el.tree;
    if (!tree) return;
    const scrollTop = tree.scrollTop;
    tree.textContent = '';

    const dim = this._activeDimension();
    if (!dim) {
      delete tree.dataset.dimensionId;
      const empty = el('p', 'tree-empty', '还没有维度，点上方「+ 维度」新建一个');
      tree.appendChild(empty);
      this._treeRendered = true;
      return;
    }

    const query = this._query.trim();
    const lowered = query.toLowerCase();
    tree.dataset.dimensionId = str(dim.id);
    const groups = Array.isArray(dim.groups) ? dim.groups : [];
    const waypoints = Array.isArray(dim.waypoints) ? dim.waypoints : [];
    const groupIds = new Set(groups.map((group) => str(group.id)));

    let rendered = 0;
    for (const group of groups) {
      if (this._renderGroup(tree, dim, group, waypoints, query, lowered)) rendered += 1;
    }

    const orphans = waypoints.filter((wp) => !groupIds.has(str(wp.group)));
    const orphanMatches = orphans.filter((wp) => !query || matchesQuery(wp, query));
    if (orphans.length && (orphanMatches.length || !query)) {
      const pseudo = { id: '', name: '未分组', color: DEFAULT_COLOR, visible: true };
      this._renderGroup(tree, dim, pseudo, waypoints, query, lowered, true);
      rendered += 1;
    }

    if (!rendered) {
      tree.appendChild(el(
        'p',
        'tree-empty',
        query ? '没有匹配的路径点' : '该维度暂无路径点，点「+ 路径点」新建',
      ));
    }

    tree.scrollTop = scrollTop;
    this._treeRendered = true;

    if (this._revealPending) {
      this._revealPending = false;
      const selected = tree.querySelector('.tree-item.is-selected');
      if (selected && typeof selected.scrollIntoView === 'function') {
        selected.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  /** 仅更新选中高亮（不重建 DOM），供 setSelection 的快速路径使用。 */
  _applyTreeSelection() {
    const tree = this.el.tree;
    if (!tree) return;
    const ctx = this._selectionContext();
    const dimId = ctx.kind === 'waypoint' || ctx.kind === 'group' || ctx.kind === 'dimension'
      ? str(ctx.dim && ctx.dim.id)
      : '';
    const waypointId = ctx.kind === 'waypoint' ? str(ctx.waypoint.id) : '';
    const groupId = ctx.kind === 'group' ? str(ctx.group.id) : '';

    for (const row of tree.querySelectorAll('.tree-item')) {
      const on = waypointId !== ''
        && row.dataset.waypointId === waypointId
        && row.dataset.dimensionId === dimId;
      row.classList.toggle('is-selected', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const groupEl of tree.querySelectorAll('.tree-group')) {
      const on = groupId !== ''
        && (groupEl.dataset.groupId || '') === groupId
        && groupEl.dataset.dimensionId === dimId;
      groupEl.classList.toggle('is-selected', on);
    }

    if (this._revealPending) {
      this._revealPending = false;
      const selected = tree.querySelector('.tree-item.is-selected');
      if (selected && typeof selected.scrollIntoView === 'function') {
        selected.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  _renderGroup(host, dim, group, waypoints, query, lowered, pseudo = false) {
    const groupId = str(group.id);
    const groupKey = `${dim.id}::${groupId}`;
    const groupName = str(group.name, groupId || '未分组');
    const total = pseudo
      ? waypoints.filter((wp) => str(wp.group) === '').length
      : waypoints.filter((wp) => str(wp.group) === groupId).length;

    const nameMatch = Boolean(query) && groupName.toLowerCase().includes(lowered);
    const items = waypoints.filter((wp) => {
      const inGroup = pseudo ? !str(wp.group) : str(wp.group) === groupId;
      if (!inGroup) return false;
      if (!query || nameMatch) return true;
      return matchesQuery(wp, query);
    });

    if (query && !nameMatch && items.length === 0) return false;

    const collapsed = this._collapsed.has(groupKey) && !query;
    const visible = group.visible !== false;
    const selected = this._selectionContext();

    const groupEl = el('div', `tree-group${pseudo ? ' is-ungrouped' : ''}${collapsed ? ' is-collapsed' : ''}`);
    groupEl.dataset.groupKey = groupKey;
    if (!pseudo) groupEl.dataset.groupId = groupId;
    groupEl.dataset.dimId = str(dim.id);
    groupEl.dataset.dimensionId = str(dim.id);
    groupEl.style.setProperty('--group-color', validHex(group.color) || DEFAULT_COLOR);
    if (!visible) groupEl.classList.add('is-off');
    if (selected.kind === 'group' && !pseudo && str(selected.group.id) === groupId) {
      groupEl.classList.add('is-selected');
    }

    const head = el('div', 'tree-group-head');
    head.dataset.treeAct = 'select-group';
    head.dataset.groupKey = groupKey;
    head.dataset.groupId = groupId;
    head.dataset.dimId = str(dim.id);
    head.dataset.dimensionId = str(dim.id);
    head.setAttribute('role', 'treeitem');
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    head.tabIndex = 0;

    const caret = el('button', 'tree-caret');
    caret.type = 'button';
    caret.dataset.treeAct = 'toggle-group';
    caret.dataset.groupKey = groupKey;
    caret.setAttribute('aria-label', collapsed ? '展开分组' : '折叠分组');
    caret.innerHTML = svgUse('i-chevron');

    const dot = el('span', 'group-dot');
    dot.setAttribute('aria-hidden', 'true');

    const name = el('span', 'tree-group-name', groupName);
    name.title = groupName;

    const count = el('span', 'badge tree-group-count', query ? `${items.length}/${total}` : String(total));
    count.title = `共 ${total} 个路径点`;

    head.append(caret, dot, name, count);
    this._decorateIssue(head, pseudo ? '' : `grp:${str(dim.id)}:${groupId}`);

    if (!pseudo) {
      const eye = el('button', 'tree-eye');
      eye.type = 'button';
      eye.dataset.treeAct = 'toggle-visible';
      eye.dataset.groupId = groupId;
      eye.setAttribute('aria-pressed', visible ? 'true' : 'false');
      eye.setAttribute('aria-label', visible ? `隐藏分组「${groupName}」` : `显示分组「${groupName}」`);
      eye.title = visible ? '在画布上隐藏该分组' : '在画布上显示该分组';
      eye.classList.toggle('is-off', !visible);
      eye.innerHTML = svgUse('i-eye');
      head.appendChild(eye);
    }

    groupEl.appendChild(head);

    const itemsWrap = el('div', 'tree-items');
    itemsWrap.setAttribute('role', 'group');
    itemsWrap.setAttribute('aria-label', groupName);

    for (const wp of items) {
      itemsWrap.appendChild(this._renderWaypointRow(dim, wp, visible));
    }
    if (!items.length) {
      itemsWrap.appendChild(el('p', 'tree-group-empty', query ? '无匹配' : '暂无路径点'));
    }
    groupEl.appendChild(itemsWrap);
    host.appendChild(groupEl);
    return true;
  }

  _renderWaypointRow(dim, waypoint, groupVisible) {
    const id = str(waypoint.id);
    const selected = this._selectionContext();
    const isSelected = selected.kind === 'waypoint'
      && str(selected.waypoint.id) === id
      && str(selected.dim.id) === str(dim.id);

    const row = el('div', 'tree-item');
    row.dataset.waypointId = id;
    row.dataset.dimId = str(dim.id);
    row.dataset.dimensionId = str(dim.id);
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    row.tabIndex = 0;
    row.title = `${str(waypoint.name, id)} · ${waypointCoordText(waypoint)}`;
    if (isSelected) row.classList.add('is-selected');
    if (!groupVisible) row.classList.add('is-muted');
    row.style.setProperty('--wp-color', validHex(waypoint.color) || validHex(dimColorOf(dim, waypoint)) || DEFAULT_COLOR);

    row.appendChild(el('span', 'tree-icon', resolveIconOf(waypoint.icon)));

    const main = el('span', 'tree-item-main');
    main.appendChild(el('span', 'tree-item-name', str(waypoint.name, id)));
    main.appendChild(el('span', 'tree-item-coord', waypointCoordText(waypoint)));
    row.appendChild(main);

    this._decorateIssue(row, `wp:${str(dim.id)}:${id}`);

    const actions = el('span', 'tree-item-actions');
    const copy = el('button', 'icon-btn tiny tree-act');
    copy.type = 'button';
    copy.dataset.treeAct = 'copy';
    copy.title = '复制路径点';
    copy.setAttribute('aria-label', `复制路径点「${str(waypoint.name, id)}」`);
    copy.innerHTML = svgUse('i-copy');

    const remove = el('button', 'icon-btn tiny tree-act danger');
    remove.type = 'button';
    remove.dataset.treeAct = 'delete';
    remove.title = '删除路径点';
    remove.setAttribute('aria-label', `删除路径点「${str(waypoint.name, id)}」`);
    remove.innerHTML = svgUse('i-trash');

    actions.append(copy, remove);
    row.appendChild(actions);
    return row;
  }

  /* ------------------------------ 问题面板 ------------------------------ */

  _targetOfIssue(issue) {
    if (!issue || typeof issue.path !== 'string') return null;
    const match = /^dimensions\[(\d+)\]/.exec(issue.path);
    if (!match) return null;
    // 用 draft 原始数组下标解析 path，避免 _dimensions 过滤后错位
    const dims = this.draft && Array.isArray(this.draft.dimensions) ? this.draft.dimensions : [];
    const dim = dims[Number(match[1])];
    if (!dim || typeof dim !== 'object') return null;
    const rest = issue.path.slice(match[0].length);

    const wpMatch = /\.waypoints\[(\d+)\]/.exec(rest);
    if (wpMatch) {
      const wp = (dim.waypoints || [])[Number(wpMatch[1])];
      if (!wp) return null;
      return { dimensionId: dim.id, waypointId: wp.id };
    }

    const groupMatch = /\.groups\[(\d+)\]/.exec(rest);
    if (groupMatch) {
      const group = (dim.groups || [])[Number(groupMatch[1])];
      if (!group) return null;
      return { dimensionId: dim.id, groupId: group.id };
    }

    return { dimensionId: dim.id };
  }

  _keysOfTarget(target) {
    if (!target) return [];
    const dimId = str(target.dimensionId);
    const keys = [`dim:${dimId}`];
    if (target.groupId != null && target.groupId !== '') keys.push(`grp:${dimId}:${str(target.groupId)}`);
    if (target.waypointId != null && target.waypointId !== '') keys.push(`wp:${dimId}:${str(target.waypointId)}`);
    return keys;
  }

  _indexIssues() {
    this._issueIndex = new Map();
    for (const [level, list] of [['error', this.issues.errors], ['warning', this.issues.warnings]]) {
      for (const issue of list) {
        const target = this._targetOfIssue(issue);
        if (!target) continue;
        for (const key of this._keysOfTarget(target)) {
          let entry = this._issueIndex.get(key);
          if (!entry) {
            entry = { error: [], warning: [] };
            this._issueIndex.set(key, entry);
          }
          entry[level].push(String(issue.message || ''));
        }
      }
    }
  }

  _issueStateOf(key) {
    if (!key) return null;
    const entry = this._issueIndex.get(key);
    if (!entry) return null;
    if (entry.error.length) return 'error';
    if (entry.warning.length) return 'warning';
    return null;
  }

  _issueTitleOf(key) {
    const entry = key ? this._issueIndex.get(key) : null;
    if (!entry) return '';
    return [...entry.error, ...entry.warning].filter(Boolean).slice(0, 3).join('\n');
  }

  _decorateIssue(host, key, extraClass) {
    const state = this._issueStateOf(key);
    if (!state) return;
    host.classList.add(state === 'error' ? 'has-error' : 'has-warning');
    const dot = el('span', `issue-dot ${state === 'error' ? 'is-error' : 'is-warning'}${extraClass ? ` ${extraClass}` : ''}`);
    dot.title = this._issueTitleOf(key) || (state === 'error' ? '存在错误' : '存在警告');
    dot.setAttribute('aria-label', dot.title);
    host.appendChild(dot);
  }

  _renderIssues() {
    const host = this.el.issues;
    const counter = this.el['issues-count'];
    const total = this.issues.errors.length + this.issues.warnings.length;
    if (counter) {
      counter.textContent = String(total);
      counter.hidden = total === 0;
      counter.dataset.tone = this.issues.errors.length ? 'error' : 'warn';
      counter.title = total
        ? `${this.issues.errors.length} 个错误 · ${this.issues.warnings.length} 个警告`
        : '配置检查通过';
    }
    if (!host) return;
    host.textContent = '';

    if (!total) {
      const ok = el('div', 'issues-ok');
      ok.appendChild(el('span', 'issue-ok-icon', '✓'));
      ok.appendChild(el('span', 'issues-ok-text', '配置检查通过'));
      host.appendChild(ok);
      return;
    }

    const groups = [
      ['error', '错误', this.issues.errors],
      ['warning', '警告', this.issues.warnings],
    ];
    for (const [level, title, list] of groups) {
      if (!list.length) continue;
      const section = el('section', 'issue-group');
      const head = el('div', 'issue-group-head');
      head.appendChild(el('span', 'issue-group-title', title));
      head.appendChild(el('span', `badge issue-badge ${level === 'error' ? 'is-error' : 'is-warning'}`, String(list.length)));
      section.appendChild(head);

      for (const issue of list) {
        const node = el('button', `issue ${level === 'error' ? 'is-error' : 'is-warning'}`);
        node.type = 'button';
        node.dataset.level = level;
        node.appendChild(el('span', 'issue-msg', str(issue.message, '未知问题')));
        if (issue.path) node.appendChild(el('code', 'issue-path', str(issue.path)));
        const target = this._targetOfIssue(issue);
        if (target) {
          node.title = `定位到 ${issue.path || ''}`.trim();
          node.addEventListener('click', () => this._emitSelect(target));
        } else {
          node.disabled = true;
          node.title = '无法定位（全局问题）';
        }
        section.appendChild(node);
      }
      host.appendChild(section);
    }
  }

  /* ------------------------------ 状态 / 草稿信息 ------------------------------ */

  _renderStatus() {
    const node = this.el.status;
    if (!node) return;
    node.textContent = this._status.text;
    node.dataset.tone = makeTone(this._status.tone);
  }

  _renderMeta() {
    const node = this.el['draft-meta'];
    if (!node) return;
    const dims = this._dimensions;
    const waypointCount = dims.reduce((sum, dim) => sum + (Array.isArray(dim.waypoints) ? dim.waypoints.length : 0), 0);
    const stats = this.draft ? `${dims.length} 个维度 · ${waypointCount} 个路径点` : '';
    node.classList.toggle('is-dirty', this._dirty && Boolean(this.draft));

    let text;
    if (!this.draft) {
      text = '正在加载…';
    } else if (this._dirty) {
      text = `未保存修改 · ${stats}`;
    } else if (this._autosaveAt) {
      const clock = fmtClock(this._autosaveAt);
      text = `草稿已自动保存${clock ? ` · ${clock}` : ''} · ${stats}`;
    } else if (this._savedAt) {
      const clock = fmtClock(this._savedAt);
      text = `已保存至站点${clock ? ` · ${clock}` : ''} · ${stats}`;
    } else {
      text = `与站点一致 · ${stats}`;
    }
    if (!this._dirty && this._autosaveAt && this._savedAt) {
      const clock = fmtClock(this._savedAt);
      text = `已保存至站点${clock ? ` · ${clock}` : ''} · ${stats}`;
    }
    node.textContent = text;
  }

  /* ============================== 选择上下文 ============================== */

  get _dimensions() {
    const dims = this.draft && Array.isArray(this.draft.dimensions) ? this.draft.dimensions : [];
    return dims.filter((dim) => dim && typeof dim === 'object');
  }

  _activeDimension() {
    const dims = this._dimensions;
    if (!dims.length) return null;
    const wanted = this.selection && this.selection.dimensionId;
    let dim = wanted != null ? dimensionByIdOf(this.draft, wanted) : null;
    if (!dim && this._activeDimensionId != null) dim = dimensionByIdOf(this.draft, this._activeDimensionId);
    if (!dim && this.draft && this.draft.defaultDimension != null) {
      dim = dimensionByIdOf(this.draft, this.draft.defaultDimension);
    }
    if (!dim) dim = dims[0];
    this._activeDimensionId = dim.id;
    return dim;
  }

  _dimensionOfWaypoint(waypointId, preferDimensionId) {
    if (preferDimensionId != null) {
      const preferred = dimensionByIdOf(this.draft, preferDimensionId);
      if (preferred && waypointByIdOf(preferred, waypointId)) return preferred;
    }
    for (const dim of this._dimensions) {
      if (waypointByIdOf(dim, waypointId)) return dim;
    }
    return null;
  }

  _dimensionOfGroup(groupId, preferDimensionId) {
    if (preferDimensionId != null) {
      const preferred = dimensionByIdOf(this.draft, preferDimensionId);
      if (preferred && (preferred.groups || []).some((group) => str(group.id) === str(groupId))) {
        return preferred;
      }
    }
    for (const dim of this._dimensions) {
      if ((dim.groups || []).some((group) => str(group.id) === str(groupId))) return dim;
    }
    return null;
  }

  _selectionContext() {
    const dims = this._dimensions;
    if (!dims.length) return { kind: 'empty' };
    const sel = normalizeSelection(this.selection);

    if (sel.waypointId != null) {
      const dim = this._dimensionOfWaypoint(sel.waypointId, sel.dimensionId);
      if (dim) {
        const waypoint = waypointByIdOf(dim, sel.waypointId);
        if (waypoint) return { kind: 'waypoint', dim, waypoint };
      }
    }

    if (sel.groupId != null) {
      const dim = this._dimensionOfGroup(sel.groupId, sel.dimensionId);
      if (dim) {
        const group = (dim.groups || []).find((item) => str(item.id) === str(sel.groupId));
        if (group) return { kind: 'group', dim, group };
      }
    }

    if (sel.dimensionId != null) {
      const dim = dimensionByIdOf(this.draft, sel.dimensionId);
      if (dim) return { kind: 'dimension', dim };
    }

    return { kind: 'overview' };
  }

  /** 表单身份指纹：用于判断「是否需要重建表单 DOM」。 */
  _formIdentity(ctx) {
    if (!ctx || !ctx.kind) return '';
    if (ctx.kind === 'waypoint') return `waypoint:${str(ctx.waypoint.id)}`;
    if (ctx.kind === 'group') return `group:${str(ctx.group.id)}`;
    if (ctx.kind === 'dimension') return `dimension:${str(ctx.dim.id)}`;
    return `${ctx.kind}:`;
  }

  /* ============================== 表单渲染 ============================== */

  _renderForm() {
    const form = this.el.form;
    if (!form) return;
    this._syncImagesFromApp();
    const ctx = this._selectionContext();
    form.textContent = '';
    form.dataset.kind = ctx.kind;
    delete form.dataset.entityId;
    delete form.dataset.dimensionId;
    this._renderFormHead(ctx);

    if (ctx.kind === 'empty') {
      form.appendChild(el(
        'p',
        'form-empty',
        this.draft ? '还没有维度，点上方「+ 维度」新建一个' : '正在加载草稿…',
      ));
      return;
    }
    if (ctx.kind === 'overview') {
      this._renderOverviewForm(form);
      return;
    }
    if (ctx.kind === 'waypoint') {
      this._renderWaypointForm(form, ctx);
      return;
    }
    if (ctx.kind === 'group') {
      this._renderGroupForm(form, ctx);
      return;
    }
    this._renderDimensionForm(form, ctx);
  }

  _renderFormHead(ctx) {
    const title = this.el['form-title'];
    const subtitle = this.el['form-subtitle'];
    let titleText = '属性';
    let subtitleText = '';

    if (ctx.kind === 'waypoint') {
      titleText = '路径点属性';
      subtitleText = `${str(ctx.dim.name, ctx.dim.id)} · ${str(ctx.waypoint.name, ctx.waypoint.id)}`;
    } else if (ctx.kind === 'group') {
      titleText = '分组属性';
      const count = (ctx.dim.waypoints || []).filter((wp) => str(wp.group) === str(ctx.group.id)).length;
      subtitleText = `${str(ctx.dim.name, ctx.dim.id)} · ${count} 个路径点`;
    } else if (ctx.kind === 'dimension') {
      titleText = '维度属性';
      subtitleText = `${(ctx.dim.waypoints || []).length} 个路径点 · ${(ctx.dim.groups || []).length} 个分组`;
    } else if (ctx.kind === 'overview') {
      titleText = '站点与显示';
      subtitleText = '未选中对象';
    } else {
      titleText = '属性';
      subtitleText = '正在加载…';
    }

    if (title) title.textContent = titleText;
    if (subtitle) subtitle.textContent = subtitleText;
  }

  _row(labelText, control, hint) {
    const row = el('div', 'form-row');
    const label = el('label', 'form-label', labelText);
    if (control && control.id) label.htmlFor = control.id;
    row.appendChild(label);
    if (control) row.appendChild(control);
    if (hint) row.appendChild(el('p', 'form-hint', hint));
    return row;
  }

  _section(title, hint) {
    const section = el('section', 'form-section');
    if (title) section.appendChild(el('h3', 'form-section-title', title));
    if (hint) section.appendChild(el('p', 'form-hint', hint));
    return section;
  }

  _actionButton(label, action, extraClass = '') {
    const node = el('button', `btn ghost small${extraClass ? ` ${extraClass}` : ''}`, label);
    node.type = 'button';
    node.dataset.action = action;
    return node;
  }

  _idRow(kind, id) {
    return this._row('ID', makeInput({ key: `${kind}-id`, value: str(id), readonly: true, mono: true }), '只读；改名会影响引用，请谨慎。');
  }

  _colorRow(keyPrefix, value, fallbackColor, hint) {
    const field = 'color';
    const wrap = el('div', 'form-color');
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'form-color-input';
    picker.id = controlId(`${keyPrefix}-color-picker`);
    picker.dataset.field = field;
    picker.dataset.fieldKey = `${keyPrefix}-color-pick`;
    picker.dataset.commit = 'change';
    picker.value = validHex(value) || validHex(fallbackColor) || DEFAULT_COLOR;
    picker.title = '选择颜色';

    const text = makeInput({
      key: `${keyPrefix}-color-text`,
      field,
      value: value == null ? '' : String(value),
      placeholder: '跟随分组',
      mono: true,
      maxlength: 7,
    });

    const clear = el('button', 'btn ghost small form-color-clear', '跟随分组');
    clear.type = 'button';
    clear.dataset.clearColor = '1';
    clear.title = '清除自定义颜色，跟随分组颜色';

    wrap.append(picker, text, clear);
    const row = this._row('颜色', wrap, hint);
    row.appendChild(el('p', 'form-hint form-color-hint', value ? '' : '跟随分组颜色'));
    return row;
  }

  _iconRow(value) {
    const wrap = el('div', 'form-icon');
    const preview = el('div', 'icon-current', resolveIconOf(value));
    preview.title = '当前图标';

    const picker = el('div', 'icon-picker');
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', '图标选择');
    for (const iconKey of ICON_KEYS) {
      const button = el('button', 'icon-option');
      button.type = 'button';
      button.dataset.icon = iconKey;
      button.title = `${iconLabelOf(iconKey)}（${iconKey}）`;
      button.setAttribute('aria-label', `图标 ${iconLabelOf(iconKey)}`);
      button.textContent = ICONS[iconKey] || '📍';
      if (String(value) === String(iconKey)) button.classList.add('is-active');
      picker.appendChild(button);
    }

    const custom = makeInput({
      key: 'wp-icon-custom',
      field: 'icon',
      value: Object.prototype.hasOwnProperty.call(ICONS, String(value)) ? '' : str(value),
      placeholder: '自定义 emoji（直接输入）',
      maxlength: 8,
    });

    wrap.append(preview, picker, custom);
    const row = this._row('图标', wrap, '点选网格图标，或在下方输入任意 emoji。');
    return row;
  }

  _waypointGroupRow(dim, waypoint) {
    const groups = Array.isArray(dim.groups) ? dim.groups : [];
    const options = groups.map((group) => [
      str(group.id),
      `${str(group.name, group.id)}（${(dim.waypoints || []).filter((wp) => str(wp.group) === str(group.id)).length}）`,
    ]);
    const current = str(waypoint.group);
    if (!current) options.unshift(['', '（未分组 · 默认）']);
    if (current && !options.some(([id]) => id === current)) {
      options.unshift([current, `${current}（未知分组）`]);
    }
    if (!options.length) options.push(['default', 'default']);
    return this._row(
      '分组',
      makeSelect({ key: 'wp-group', field: 'group', value: current, options }),
      '分组决定颜色与显隐；未指定时使用默认分组。',
    );
  }

  _renderWaypointForm(form, ctx) {
    form.dataset.kind = 'waypoint';
    form.dataset.entityId = str(ctx.waypoint.id);
    form.dataset.dimensionId = str(ctx.dim.id);

    const wp = ctx.waypoint;
    const group = (ctx.dim.groups || []).find((item) => str(item.id) === str(wp.group)) || null;

    form.appendChild(this._row(
      '名称',
      makeInput({ key: 'wp-name', field: 'name', value: str(wp.name), placeholder: '例如：出生点' }),
      '显示在画布标记与左侧列表上的名称。',
    ));

    const grid = el('div', 'form-grid');
    const cells = [
      ['X', 'wp-x', 'x', wp.x],
      ['Y', 'wp-y', 'y', wp.y],
      ['Z', 'wp-z', 'z', wp.z],
    ];
    for (const [label, key, field, value] of cells) {
      const cell = el('div', 'form-cell');
      const lab = el('label', 'form-cell-label', label);
      lab.htmlFor = controlId(key);
      const input = makeInput({
        type: 'number',
        key,
        field,
        value: Number.isFinite(value) ? value : null,
        step: 'any',
        inputmode: 'decimal',
        placeholder: field === 'y' ? '可留空' : '0',
      });
      cell.append(lab, input);
      grid.appendChild(cell);
    }
    const coordRow = this._row('坐标', grid, '世界坐标（方块）。Y 留空表示不显示高度；拖拽画布标记也会实时更新。');
    form.appendChild(coordRow);

    form.appendChild(this._waypointGroupRow(ctx.dim, wp));
    form.appendChild(this._iconRow(wp.icon));
    form.appendChild(this._colorRow('wp', wp.color, group && group.color, '不选则跟随分组颜色。'));

    const labelSelect = makeSelect({
      key: 'wp-label',
      field: 'label',
      value: wp.label == null ? '' : String(wp.label),
      options: LABEL_OPTIONS,
    });
    form.appendChild(this._row('标签策略', labelSelect, '「跟随全局」使用维度页里的默认标签策略。'));

    form.appendChild(this._row(
      '描述',
      makeTextarea({ key: 'wp-description', field: 'description', value: str(wp.description), placeholder: '可选：补充说明', rows: 3 }),
      null,
    ));

    form.appendChild(this._row(
      '外链',
      makeInput({ type: 'url', key: 'wp-url', field: 'url', value: str(wp.url), placeholder: 'https://…（可选）', mono: true }),
      null,
    ));

    form.appendChild(this._section('标识'));
    form.appendChild(this._idRow('waypoint', wp.id));

    const actions = el('div', 'form-actions');
    actions.append(
      this._actionButton('复制路径点', 'duplicate-waypoint'),
      this._actionButton('删除路径点', 'delete-waypoint', 'danger'),
    );
    form.appendChild(actions);

    if (!group) {
      form.appendChild(el('p', 'form-hint form-warn', `当前分组「${str(wp.group, '未设置')}」不存在，保存时会被回落到默认分组。`));
    }
  }

  _renderGroupForm(form, ctx) {
    form.dataset.kind = 'group';
    form.dataset.entityId = str(ctx.group.id);
    form.dataset.dimensionId = str(ctx.dim.id);

    const group = ctx.group;
    const count = (ctx.dim.waypoints || []).filter((wp) => str(wp.group) === str(group.id)).length;

    form.appendChild(this._row(
      '名称',
      makeInput({ key: 'group-name', field: 'name', value: str(group.name), placeholder: '例如：据点' }),
      null,
    ));
    form.appendChild(this._colorRow('group', group.color, DEFAULT_COLOR, '画布标记与分组色块使用该颜色。'));
    form.appendChild(this._row(
      '可见',
      makeCheckbox({ key: 'group-visible', field: 'visible', checked: group.visible !== false, label: '在画布上显示该分组' }),
      '隐藏只影响画布显示，不会删除路径点。',
    ));

    form.appendChild(this._section('标识'));
    form.appendChild(this._idRow('group', group.id));
    form.appendChild(el('p', 'form-hint', `该分组包含 ${count} 个路径点。`));

    const actions = el('div', 'form-actions');
    actions.append(
      this._actionButton('+ 新建路径点', 'new-waypoint'),
      this._actionButton('删除分组', 'delete-group', 'danger'),
    );
    form.appendChild(actions);
  }

  _imageOptions(dim) {
    const names = this._images.map((item) => str(item.name));
    const current = str(dim.image);
    const options = [['', '（未设置）']];
    for (const name of names) options.push([name, name]);
    if (current && !names.includes(current)) options.push([current, `${current}（站点目录未找到）`]);
    return options;
  }

  /* ------------------------------ 底图类型（单图 / 瓦片） ------------------------------ */

  /** 维度是否处于瓦片模式。app.js 的约定：`dim.tiles` 为真即瓦片（下拉 value = dim.tiles ? 'tiles' : 'image'）。 */
  _isTilesDimension(dim) {
    return Boolean(dim && dim.tiles);
  }

  /** dim.tiles 由 model.js 规范化成 `{ manifest }`；这里同时兼容手写字符串。 */
  _tilesManifestOf(dim) {
    const tiles = dim && dim.tiles;
    if (!tiles) return '';
    if (typeof tiles === 'string') return tiles.trim();
    if (typeof tiles === 'object') return str(tiles.manifest).trim();
    return '';
  }

  /** 找当前维度对应的 xaero 子目录（按 id / 名称 / 中英文别名匹配）。 */
  _xaeroSourceFor(dim) {
    if (!dim) return null;
    const wanted = new Set(
      [dim.id, dim.name].map((value) => canonicalXaeroName(value)).filter(Boolean),
    );
    if (!wanted.size) return null;
    for (const source of this._xaeroSources) {
      if (wanted.has(canonicalXaeroName(source.folder))) return source;
    }
    return null;
  }

  /** 「XAERO 瓦片源」区块：显示 xaero/<维度>/ 的扫描结果 + 生成按钮。 */
  _xaeroSection(dim) {
    const section = this._section(
      'XAERO 瓦片源',
      '工具会扫描 xaero/ 下的一级子目录；每个子目录对应一个维度（支持 x<X>_z<Z>.png 导出图或区域 zip）。',
    );
    section.dataset.xaeroSummary = '1';
    const source = this._xaeroSourceFor(dim);
    const refresh = this._actionButton('重新扫描 xaero', 'refresh-xaero');

    if (!source) {
      const available = this._xaeroSources
        .filter((item) => item && item.folder && item.kind !== 'empty')
        .map((item) => item.folder);
      section.appendChild(el(
        'p',
        'form-hint',
        available.length
          ? `没有匹配到「${str(dim.name) || str(dim.id)}」的源文件夹。现有可用：xaero/${available.join('、')}`
          : `没有可用的源文件夹：把 Xaero 导出 PNG 放进 xaero/${str(dim.name) || '主世界'}/ 后点「重新扫描 xaero」。`,
      ));
      section.appendChild(refresh);
      return section;
    }

    const kindText = source.kind === 'png'
      ? `${source.images} 张导出 PNG`
      : source.kind === 'region'
        ? `${source.regions} 个区域 zip`
        : '空文件夹';
    const bounds = source.bounds && typeof source.bounds === 'object' ? source.bounds : null;
    section.appendChild(el(
      'p',
      'form-hint',
      `源：xaero/${source.folder} · ${kindText}${bounds
        ? ` · X[${fmtBlock(bounds.xMin)}, ${fmtBlock(bounds.xMax)}] Z[${fmtBlock(bounds.zMin)}, ${fmtBlock(bounds.zMax)}]`
        : ''}`,
    ));

    if (source.kind === 'empty') {
      section.appendChild(el(
        'p',
        'form-hint form-warn',
        `xaero/${source.folder} 还是空的：先放导出图（文件名要带 x<X>_z<Z>）或区域 zip，再点「重新扫描 xaero」。`,
      ));
      section.appendChild(refresh);
      return section;
    }

    section.appendChild(el(
      'p',
      'form-hint',
      `输出：tiles/${str(dim.id)}/manifest.json（生成会覆盖这个目录里已有的瓦片）。`,
    ));
    const generate = this._actionButton(`从 xaero/${source.folder} 生成瓦片`, 'generate-xaero-tiles');
    generate.dataset.xaeroFolder = source.folder;
    generate.title = '读取该目录的导出图并切成站点瓦片，然后把当前维度切换到瓦片底图';
    section.append(generate, refresh);
    return section;
  }

  /**
   * 「瓦片底图」摘要：dim.tileMeta 是 **工具专用** 数据（app.js 在 manifest 加载后写入，
   * 不导出、不进草稿文件）。这里只读不写。
   */
  _tilesSection(dim) {
    const manifest = this._tilesManifestOf(dim);
    const meta = dim && dim.tileMeta && typeof dim.tileMeta === 'object' ? dim.tileMeta : null;
    const section = this._section('瓦片底图', '信息来自 manifest（工具专用，不会写入 config.json）。');
    section.dataset.tilesOnly = '1';
    section.dataset.tilesSummary = '1';

    if (!manifest) {
      section.appendChild(el('p', 'form-hint', '还没有填写瓦片清单：填好上面的路径后 app 会自动读取并解析 manifest。'));
      return section;
    }
    if (!meta) {
      section.appendChild(el('p', 'form-hint', `正在读取 ${manifest} …（若一直停在这里，检查路径是否指向站点目录里的 manifest.json）`));
      return section;
    }
    if (meta.error) {
      section.appendChild(el('p', 'form-hint form-warn', `manifest 解析失败：${str(meta.error)}`));
      return section;
    }

    const bounds = meta.bounds && typeof meta.bounds === 'object' ? meta.bounds : null;
    if (bounds) {
      section.appendChild(el(
        'p',
        'form-hint',
        `世界范围 X[${fmtBlock(bounds.xMin)}, ${fmtBlock(bounds.xMax)}] · Z[${fmtBlock(bounds.zMin)}, ${fmtBlock(bounds.zMax)}]`,
      ));
    }
    if (Number.isFinite(Number(meta.imageWidth)) && Number.isFinite(Number(meta.imageHeight))) {
      section.appendChild(el(
        'p',
        'form-hint',
        `底图 ${fmtBlock(Number(meta.imageWidth))} × ${fmtBlock(Number(meta.imageHeight))} px（1 像素 = 1 方块）`,
      ));
    }

    const levels = Array.isArray(meta.levels) ? meta.levels : [];
    if (levels.length) {
      const detail = levels.map((entry) => {
        const levelName = entry && entry.level != null ? `L${str(entry.level)}` : 'L?';
        const bpp = entry && Number.isFinite(Number(entry.blocksPerPixel)) ? Number(entry.blocksPerPixel) : null;
        return bpp == null ? levelName : `${levelName} ${bpp} 方块/像素`;
      }).join(' · ');
      section.appendChild(el('p', 'form-hint', `层级数 ${levels.length}（${detail}）`));
    }

    const shownManifest = str(meta.manifest) || manifest;
    section.appendChild(el('p', 'form-hint', `manifest：${shownManifest}`));
    if (str(meta.source)) section.appendChild(el('p', 'form-hint', `来源：${str(meta.source)}`));
    return section;
  }

  /** 就地切换「瓦片相关行」的可见性 + 画幅校准说明（不重建表单、不动数据）。 */
  _applyTilesModeView(isTiles) {
    const form = this.el.form;
    if (!form) return;
    const on = Boolean(isTiles);
    for (const node of form.querySelectorAll('[data-tiles-only]')) {
      node.hidden = !on;
      // CSS 可能给 .form-row/.form-section 设了 display，hidden 属性会被覆盖，这里再兜一层。
      if (on) node.style.removeProperty('display');
      else node.style.display = 'none';
    }
    const calHint = form.querySelector('[data-tiles-cal]');
    if (calHint) {
      const next = on ? calHint.dataset.hintTiles : calHint.dataset.hintSingle;
      if (next && calHint.textContent !== next) calHint.textContent = next;
    }
  }

  /** 表单有焦点时的增量刷新：只替换「瓦片底图」摘要 + 同步可见性，不打断输入。 */
  _refreshTilesSummaryInPlace() {
    const form = this.el.form;
    if (!form || form.dataset.kind !== 'dimension') return;
    const ctx = this._selectionContext();
    if (ctx.kind !== 'dimension') return;
    const dim = ctx.dim;
    const active = document.activeElement;
    // 用户正在瓦片区块里输入（比如把 manifest 清空又重打）时不要把他脚下的行藏掉，
    // 等焦点离开、表单重建时再按草稿切换类型。
    const inTilesBlock = Boolean(active && typeof active.closest === 'function' && active.closest('[data-tiles-only]'));
    if (!inTilesBlock) {
      const isTiles = this._isTilesDimension(dim);
      this._applyTilesModeView(isTiles);
      // 下拉没被聚焦时与草稿对齐（app 切类型时会自动补默认 manifest / 清空 tiles）
      const modeSelect = form.querySelector('[data-field="tiles.mode"]');
      if (modeSelect && active !== modeSelect) {
        const wanted = isTiles ? 'tiles' : 'image';
        if (modeSelect.value !== wanted) modeSelect.value = wanted;
      }
      // manifest 输入框没被聚焦时也补上 app 写的值（例：切到瓦片模式时自动填了默认路径）
      const input = form.querySelector('[data-field="tiles.manifest"]');
      if (input && active !== input) {
        const wanted = this._tilesManifestOf(dim);
        if (input.value !== wanted) input.value = wanted;
      }
    }
    const current = form.querySelector('[data-tiles-summary]');
    if (!current) return;
    const next = this._tilesSection(dim);
    // 只在内容真的变了才换节点：用户每敲一个字 app 都会 refresh，这里避免无谓的 DOM 抖动。
    if (current.textContent !== next.textContent) current.replaceWith(next);
  }

  _renderDimensionForm(form, ctx) {
    form.dataset.kind = 'dimension';
    form.dataset.entityId = str(ctx.dim.id);
    form.dataset.dimensionId = str(ctx.dim.id);

    const dim = ctx.dim;
    const calibration = dim.calibration && typeof dim.calibration === 'object' ? dim.calibration : {};
    const isTiles = this._isTilesDimension(dim);

    form.appendChild(this._row(
      '名称',
      makeInput({ key: 'dim-name', field: 'name', value: str(dim.name), placeholder: '例如：主世界' }),
      '显示在维度标签与页脚上的名字。',
    ));

    const imageWrap = el('div', 'form-image');
    const imageSelect = makeSelect({
      key: 'dim-image',
      field: 'image',
      value: str(dim.image),
      options: this._imageOptions(dim),
    });
    const importBtn = el('button', 'btn ghost small form-image-import', '导入本地图片');
    importBtn.type = 'button';
    importBtn.dataset.importImage = '1';
    importBtn.title = '选择本地图片并写入站点目录';
    imageWrap.append(imageSelect, importBtn);
    form.appendChild(this._row(
      '图片',
      imageWrap,
      isTiles
        ? '瓦片模式下「图片」只作为 manifest 加载失败时的兜底底图；单图模式直接显示该 PNG。'
        : '站点目录里的地图文件；不在列表中的名字保存后站点会显示「地图还没上传」。',
    ));

    // 底图类型：单图（PNG + 画幅校准）/ 瓦片（manifest）——app.js 按 `tiles.mode` 处理
    form.appendChild(this._row(
      '底图类型',
      makeSelect({
        key: 'dim-tiles-mode',
        field: 'tiles.mode',
        value: isTiles ? 'tiles' : 'image',
        options: TILES_MODE_OPTIONS,
      }),
      '瓦片模式按 manifest 的 worldBlockRange 定位，不再需要手动画幅校准。',
    ));

    // 瓦片清单：只读 manifest 路径，app.js 会通过 /preview/ 拉取并解析。
    // 单图模式下隐藏但保留在 DOM 里，切换类型时可就地显示（见 _applyTilesModeView）。
    const manifestRow = this._row(
      '瓦片清单',
      makeInput({
        key: 'dim-tiles-manifest',
        field: 'tiles.manifest',
        value: this._tilesManifestOf(dim),
        placeholder: 'tiles/manifest.json',
        mono: true,
      }),
      '相对站点根目录的 manifest 路径（例如 tiles/manifest.json）；工具通过 /preview/ 读取。',
    );
    manifestRow.dataset.tilesOnly = '1';
    form.appendChild(manifestRow);

    // 瓦片摘要：dim.tileMeta 由 app.js 加载 manifest 后写入（工具专用，不导出）
    const tilesSection = this._tilesSection(dim);
    form.appendChild(tilesSection);

    // XAERO 源：扫描 xaero/<维度>/，可直接生成该维度的站点瓦片
    form.appendChild(this._xaeroSection(dim));

    // 单图模式下先隐藏瓦片相关行（切换类型时由 _applyTilesModeView 就地显示）
    if (!isTiles) {
      for (const node of [manifestRow, tilesSection]) {
        node.hidden = true;
        node.style.display = 'none';
      }
    }

    const meta = dim.imageMeta && typeof dim.imageMeta === 'object' ? dim.imageMeta : null;
    if (meta && Number.isFinite(meta.width) && Number.isFinite(meta.height)) {
      form.appendChild(el('p', 'form-hint', `图片尺寸：${meta.width} × ${meta.height}${meta.missing ? ' · 文件缺失' : ''}`));
    }

    // 瓦片模式：画幅来自 manifest，calibration 只是单图兜底（字段仍可编辑）
    const calSection = this._section('画幅校准', isTiles ? CAL_HINT_TILES : CAL_HINT_SINGLE);
    const calHint = calSection.querySelector('.form-hint');
    if (calHint) {
      calHint.dataset.tilesCal = '1';
      calHint.dataset.hintSingle = CAL_HINT_SINGLE;
      calHint.dataset.hintTiles = CAL_HINT_TILES;
    }
    form.appendChild(calSection);
    const grid = el('div', 'form-grid form-grid-2');
    const calFields = [
      ['左边界 X', 'dim-xmin', 'calibration.xMin', calibration.xMin],
      ['右边界 X', 'dim-xmax', 'calibration.xMax', calibration.xMax],
      ['上边界 Z', 'dim-zmin', 'calibration.zMin', calibration.zMin],
      ['下边界 Z', 'dim-zmax', 'calibration.zMax', calibration.zMax],
    ];
    for (const [label, key, field, value] of calFields) {
      const cell = el('div', 'form-cell');
      const lab = el('label', 'form-cell-label', label);
      lab.htmlFor = controlId(key);
      cell.append(lab, makeInput({
        type: 'number',
        key,
        field,
        value: Number.isFinite(value) ? value : null,
        step: 'any',
        inputmode: 'decimal',
      }));
      grid.appendChild(cell);
    }
    form.appendChild(this._row('边界', grid, '需满足 xMax > xMin、zMax > zMin。'));

    form.appendChild(this._row(
      '南北翻转',
      makeCheckbox({ key: 'dim-flipz', field: 'calibration.flipZ', checked: calibration.flipZ === true, label: '图片上方是 +Z（南北翻转）' }),
      null,
    ));

    form.appendChild(this._row(
      '校准备注',
      makeInput({ key: 'dim-note', field: 'calibration.note', value: str(calibration.note), placeholder: '可选：记录校准依据' }),
      null,
    ));

    const calState = el('div', 'form-cal-state');
    calState.classList.add(calibration.calibrated === true ? 'is-ok' : 'is-warn');
    calState.appendChild(el('span', 'form-cal-icon', calibration.calibrated === true ? '✓' : '!'));
    calState.appendChild(el(
      'span',
      'form-cal-text',
      calibration.calibrated === true ? '该维度已校准' : '该维度尚未校准，画布上的路径点位置可能不准',
    ));
    form.appendChild(calState);

    form.appendChild(this._section('标识'));
    form.appendChild(this._row(
      'ID',
      makeInput({ key: 'dim-id', field: 'id', value: str(dim.id), mono: true }),
      '维度 id 同时用于链接参数与默认维度；修改会影响外部链接。',
    ));

    if (str(dim.id) === str(this.draft && this.draft.defaultDimension)) {
      form.appendChild(el('p', 'form-hint', '这是默认维度。'));
    }

    const actions = el('div', 'form-actions');
    actions.append(
      this._actionButton('去校准', 'goto-calibrate'),
      this._actionButton('+ 新建分组', 'new-group'),
      this._actionButton('删除维度', 'delete-dimension', 'danger'),
    );
    form.appendChild(actions);
  }

  _renderOverviewForm(form) {
    form.dataset.kind = 'overview';
    const draft = this.draft;
    if (!draft) {
      form.appendChild(el('p', 'form-empty', '正在加载草稿…'));
      return;
    }
    const site = draft.site && typeof draft.site === 'object' ? draft.site : {};
    const ui = draft.ui && typeof draft.ui === 'object' ? draft.ui : {};

    form.appendChild(el('p', 'form-hint', '从左侧选择维度、分组或路径点开始编辑；下面的字段属于站点级配置。'));

    form.appendChild(this._section('站点信息'));
    form.appendChild(this._row(
      '标题',
      makeInput({ key: 'site-title', field: 'title', value: str(site.title), placeholder: '网站的标题', patchKind: 'site' }),
      null,
    ));
    form.appendChild(this._row(
      '副标题',
      makeInput({ key: 'site-subtitle', field: 'subtitle', value: str(site.subtitle), placeholder: '一句话说明', patchKind: 'site' }),
      null,
    ));
    form.appendChild(this._row(
      '页脚',
      makeInput({ key: 'site-footer', field: 'footer', value: str(site.footer), placeholder: '版权 / 说明', patchKind: 'site' }),
      null,
    ));

    const dimOptions = this._dimensions.map((dim) => [str(dim.id), str(dim.name, dim.id)]);
    form.appendChild(this._row(
      '默认维度',
      makeSelect({
        key: 'site-default-dim',
        field: 'defaultDimension',
        value: str(draft.defaultDimension),
        // app.js 把 defaultDimension 归到 kind:'dimension' 分支处理，这里必须对齐
        options: dimOptions,
        patchKind: 'dimension',
      }),
      '打开站点时默认显示的维度。',
    ));

    form.appendChild(this._section('显示选项'));
    form.appendChild(this._row(
      '标签策略',
      makeSelect({
        key: 'ui-label',
        field: 'labelMode',
        value: str(ui.labelMode, 'hover'),
        options: [['always', '始终显示'], ['hover', '悬停显示'], ['never', '不显示']],
        patchKind: 'ui',
      }),
      '路径点未单独设置标签策略时使用此默认值。',
    ));
    form.appendChild(this._row(
      '网格',
      makeCheckbox({ key: 'ui-grid', field: 'grid', checked: ui.grid === true, label: '显示坐标网格', patchKind: 'ui' }),
      null,
    ));
    form.appendChild(this._row(
      '折叠分组',
      makeCheckbox({ key: 'ui-collapsed', field: 'startCollapsed', checked: ui.startCollapsed === true, label: '站点启动时折叠所有分组', patchKind: 'ui' }),
      null,
    ));
    form.appendChild(this._row(
      '坐标显示',
      makeCheckbox({ key: 'ui-coords', field: 'showCoords', checked: ui.showCoords !== false, label: '显示路径点坐标', patchKind: 'ui' }),
      null,
    ));
  }
}

/** 取分组颜色（用于路径点行色块兜底）。 */
function dimColorOf(dim, waypoint) {
  const groups = Array.isArray(dim && dim.groups) ? dim.groups : [];
  const group = groups.find((item) => String(item.id) === String(waypoint && waypoint.group));
  return group && typeof group.color === 'string' ? group.color : '';
}

export default EditorPanel;

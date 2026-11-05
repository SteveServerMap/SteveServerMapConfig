/**
 * assets/js/model.js —— 草稿数据模型（model-dev 拥有）
 * ============================================================================
 * 本文件是整个配置工具的「唯一数据真源」，按 docs/CONTRACT.md §2 实现：
 *
 *   草稿 = 站点 config.json 的超集
 *     · 站点字段全部保留（version / site / defaultDimension / ui / dimensions）
 *     · 维度字段 `tiles`（瓦片底图清单）也是站点字段，草稿里统一规范化成
 *       `{ manifest: string } | null`；导出时原样写回（没有则整个字段省略）
 *     · 每个维度多一个工具专用字段 imageMeta（图片原始像素尺寸 / 是否缺图）
 *     · 导出时由 toConfigJson() 剥掉 imageMeta，并去掉空值字段
 *
 * 设计边界（切记）：
 *   1. 纯函数 / 零 DOM / 零依赖：浏览器里 `import`、Node 里也能直接 `import`
 *      （tests/model.test.mjs 就是这么测的）。
 *   2. 永不抛异常：坏数据一律「降级 + warning」，由 app.js / editor.js 决定怎么提示。
 *   3. 只处理「结构与类型」，不做像素数学 —— 世界坐标 ↔ 图片像素是站点
 *      assets/js/coords.js（createProjection）的事，工具端直接复用同一份代码。
 *   4. 输出字段顺序固定，方便 git diff；toConfigJson() 的产物必须能通过站点
 *      config.schema.json 校验（tests/model.test.mjs 会用真实 schema 跑一遍）。
 *
 * 草稿结构（JSON 形态）：
 *   {
 *     version: 1,
 *     site: { title, subtitle, footer },
 *     defaultDimension: 'overworld',
 *     ui: { labelMode, grid, startCollapsed, showCoords },
 *     dimensions: [{
 *       id, name, image,
 *       tiles: { manifest: 'tiles/manifest.json' } | null,   // 瓦片底图（站点 schema：object 或 string）
 *       calibration: { calibrated, xMin, xMax, zMin, zMax, flipZ, note },
 *       groups: [{ id, name, color, visible }],
 *       waypoints: [{ id, name, x, y, z, group, icon, color, label, description, url }],
 *       imageMeta: { width, height, missing }   // 仅工具用，导出时剥掉
 *     }]
 *   }
 */

/* ========================================================================== */
/* 常量                                                                        */
/* ========================================================================== */

/** 配置格式版本；与站点 config.schema.json 的 `version.const` 保持一致。 */
export const CONFIG_VERSION = 1;

/** 站点文案默认值；与站点 assets/js/config.js 的 DEFAULT_SITE 保持一致。 */
const DEFAULT_SITE = Object.freeze({
  title: 'Steve Server 地图',
  subtitle: '离线地图 · 路径点可配置',
  footer: '路径点由 config.json 驱动',
});

/** 界面默认值；与站点 assets/js/config.js 的 DEFAULT_UI 保持一致。 */
const DEFAULT_UI = Object.freeze({
  labelMode: 'hover',
  grid: false,
  startCollapsed: false,
  showCoords: true,
});

/** 内置兜底分组；语义与站点 config.js 的 DEFAULT_GROUP 一致。 */
const DEFAULT_GROUP = Object.freeze({
  id: 'default',
  name: '未分组',
  color: '#8fa3a0',
  visible: true,
});

/** 新建分组时轮换使用的调色板（取自站点现有配置的配色）。 */
const GROUP_COLORS = Object.freeze([
  '#5ad26f', '#59a6ff', '#ffbc4b', '#ff7ab6', '#b485ff',
  '#4dd0e1', '#ff8a65', '#9ccc65', '#f06292', '#7986cb',
]);

const LABEL_MODES = Object.freeze(['always', 'hover', 'never']);
const SITE_KEYS = Object.freeze(['title', 'subtitle', 'footer']);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * 图标表：key → emoji。
 * 必须与站点 assets/js/markers.js 的 `export const ICONS` 逐项一致
 * （tests/model.test.mjs 会直接 import 站点文件做深比较，改这里必须同步改站点）。
 */
export const ICONS = Object.freeze({
  pin: '🧷',
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
});

/** 图标 key 的有序列表（编辑器图标选择器直接按这个顺序渲染）。 */
export const ICON_KEYS = Object.freeze(Object.keys(ICONS));

/** 图标 key → 中文名（iconLabel 用来生成选择器里的可读文案，仅本文件内部使用）。 */
const ICON_LABELS = Object.freeze({
  pin: '图钉',
  home: '家',
  village: '村庄',
  farm: '农场',
  mine: '矿洞',
  portal: '传送门',
  chest: '箱子',
  diamond: '钻石',
  skull: '骷髅',
  tower: '城堡',
  ship: '船',
  mountain: '山',
  redstone: '红石',
  nether: '下界',
  end: '末地',
  shop: '商店',
  spawn: '出生点',
  bed: '床',
  pvp: '竞技',
  event: '活动',
  question: '未知',
});

/* ========================================================================== */
/* 内部小工具：全部对坏数据安全（不抛异常）                                     */
/* ========================================================================== */

/** 严格「普通对象」判定（数组 / null 都不算）。 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 宽松字符串化：非字符串一律当空串；字符串会 trim。 */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 宽松数值化：接受 number 或「看起来像数字的字符串」（手写 JSON 常带引号）。
 * 非数字返回 null，绝不返回 NaN —— 避免 NaN 泄到表单 / JSON 里变成 null 之外的脏值。
 */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 宽松布尔化：兼容 JSON 里写 "true" / 1 的情况（与站点 coords.js 的 toBool 一致）。 */
function toBool(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

/**
 * 从维度的 `tiles` 值里取出 manifest 路径（站点 schema 允许 `"tiles/manifest.json"`
 * 简写，也允许 `{ manifest: "tiles/manifest.json" }`）。
 *
 * @param {any} tiles
 * @returns {string|null} trim 后的 manifest；拿不到（空 / 非法 / 缺 manifest）返回 null
 */
function tilesManifestOf(tiles) {
  if (typeof tiles === 'string') return str(tiles) || null;
  if (isObject(tiles)) return str(tiles.manifest) || null;
  return null;
}

/**
 * 规范化维度的瓦片配置。站点 schema 允许 `"tiles": { "manifest": "…" }`，
 * 也允许直接写字符串；草稿统一存成 `{ manifest }` 或 null（单图模式）。
 *
 * @param {any} rawTiles
 * @param {string[]} warnings
 * @param {string} dimensionName
 * @returns {{manifest: string}|null}
 */
function normalizeTiles(rawTiles, warnings, dimensionName) {
  if (rawTiles === undefined || rawTiles === null) return null;
  if (typeof rawTiles !== 'string' && !isObject(rawTiles)) {
    warnings.push(`维度「${dimensionName}」的 tiles 不是对象或字符串，已忽略`);
    return null;
  }
  const manifest = tilesManifestOf(rawTiles);
  if (!manifest) {
    warnings.push(`维度「${dimensionName}」的 tiles 缺少 manifest，已按单图模式处理`);
    return null;
  }
  return { manifest };
}

/**
 * 把名字变成 id 片段：小写、保留中文与字母数字，其它字符变 `-`。
 * 与站点 config.js 的 slugify 保持一致（中文 id 在站点里是合法的）。
 */
function slugify(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 复制一份默认分组（防止共享同一个对象被就地修改）。 */
function makeDefaultGroup() {
  return { ...DEFAULT_GROUP };
}

/** 一个「尚未校准」的空校准对象。 */
function emptyCalibration() {
  return {
    calibrated: false,
    xMin: null,
    xMax: null,
    zMin: null,
    zMax: null,
    flipZ: false,
    note: '',
  };
}

/** 在「已占用 id 集合」里为 base 找一个不冲突的 `base-2`、`base-3`… */
function uniqueIdIn(seen, base) {
  let n = 2;
  let candidate = `${base}-${n}`;
  while (seen.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/** 取草稿的第一个维度（没有则为 null）。 */
function firstDimension(draft) {
  if (!isObject(draft) || !Array.isArray(draft.dimensions)) return null;
  const found = draft.dimensions.find((dimension) => isObject(dimension));
  return found || null;
}

/**
 * 选一个合法的图标值：
 *   - ICONS 里的 key 原样保留；
 *   - 1~2 个字符的自定义 emoji / 符号原样保留（与站点 resolveIcon 规则一致）；
 *   - 其余（空 / 未知长 key）→ 'pin'。
 */
function pickIcon(icon) {
  const value = str(icon);
  if (!value) return 'pin';
  if (Object.prototype.hasOwnProperty.call(ICONS, value)) return value;
  if (Array.from(value).length <= 2) return value;
  return 'pin';
}

/* ========================================================================== */
/* 1. 空草稿                                                                   */
/* ========================================================================== */

/**
 * 创建一份全新的空草稿：一个「主世界」维度 + 一个默认分组，没有任何路径点。
 * 每次调用都返回全新的对象（可以直接改，不会污染上一次的返回值）。
 *
 * @returns {object} 符合契约 §2 的草稿对象
 */
export function createEmptyDraft() {
  return {
    version: CONFIG_VERSION,
    site: { ...DEFAULT_SITE },
    defaultDimension: 'overworld',
    ui: { ...DEFAULT_UI },
    dimensions: [
      {
        id: 'overworld',
        name: '主世界',
        image: '',
        // 瓦片底图：null = 未配置（单张 image + calibration 模式）
        tiles: null,
        calibration: emptyCalibration(),
        groups: [makeDefaultGroup()],
        waypoints: [],
        // 工具专用：图片原始像素尺寸；null 表示还不知道，missing=true 表示文件不存在
        imageMeta: { width: null, height: null, missing: true },
      },
    ],
  };
}

/* ========================================================================== */
/* 2. 规范化（永不抛异常）                                                     */
/* ========================================================================== */

/**
 * 规范化任意来源的配置 / 草稿（站点 config.json、浏览器里的旧草稿、用户导入的文件）。
 *
 * 容错策略（坏数据一律降级，绝不抛异常）：
 *   - 根节点不是对象 → 空草稿 + warning；
 *   - 字符串数字（"65"）→ number；非法数字 → null；
 *   - 缺失 dimensions / 维度全坏 → 自动补一个「主世界」维度；
 *   - 路径点没写分组 / 分组不存在 → 自动补 `default`（未分组）分组并归入；
 *   - 维度 / 分组 / 路径点 id 重复 → 自动改名（`-2`、`-3`…）并给 warning；
 *   - 未知字段一律忽略（导入时不会把奇怪字段带进草稿）；
 *   - 路径点缺 x/z 时**保留该路径点**（x/z 置 null）而不是静默丢弃，避免编辑器丢数据。
 *
 * 注意：这里**不会**纠正画幅倒置之类的「数值不合法」——那是 validateDraft 的职责，
 * 编辑器要能把原值显示出来让用户修。
 *
 * @param {any} raw 任意 JSON 值
 * @returns {{ draft: object, warnings: string[] }} 规范化后的草稿与人类可读的提示
 */
export function normalizeDraft(raw) {
  const warnings = [];

  if (!isObject(raw)) {
    warnings.push(
      raw === undefined || raw === null
        ? '没有可用的配置数据，已新建空白草稿'
        : '配置根节点不是对象（应为 { ... }），已新建空白草稿',
    );
    return { draft: createEmptyDraft(), warnings };
  }

  try {
    if (raw.version !== undefined && raw.version !== null && Number(raw.version) !== CONFIG_VERSION) {
      warnings.push(`配置 version 为 ${JSON.stringify(raw.version)}，已按 ${CONFIG_VERSION} 处理`);
    }

    /* ---- site ---- */
    const site = { ...DEFAULT_SITE };
    if (isObject(raw.site)) {
      for (const key of SITE_KEYS) {
        if (typeof raw.site[key] === 'string') site[key] = raw.site[key];
      }
    } else if (raw.site !== undefined && raw.site !== null) {
      warnings.push('site 不是对象，已使用默认站点文案');
    }

    /* ---- ui ---- */
    const ui = normalizeUi(raw.ui, warnings);

    /* ---- dimensions ---- */
    const rawDimensions = Array.isArray(raw.dimensions) ? raw.dimensions : [];
    if (!Array.isArray(raw.dimensions) && raw.dimensions !== undefined && raw.dimensions !== null) {
      warnings.push('dimensions 不是数组，已忽略');
    }
    const dimensions = [];
    rawDimensions.forEach((rawDimension, index) => {
      const dimension = normalizeDimension(rawDimension, index, warnings);
      if (dimension) dimensions.push(dimension);
    });
    if (dimensions.length === 0) {
      const fallback = createEmptyDraft();
      dimensions.push(fallback.dimensions[0]);
      warnings.push(
        rawDimensions.length === 0
          ? 'config.json 里没有可用维度（至少需要一个），已新建「主世界」维度'
          : 'config.json 里的维度都不可用，已新建「主世界」维度',
      );
    }

    /* ---- 维度 id 去重（跨维度） ---- */
    const dimensionIds = new Set();
    dimensions.forEach((dimension) => {
      if (!dimensionIds.has(dimension.id)) {
        dimensionIds.add(dimension.id);
        return;
      }
      const next = uniqueIdIn(dimensionIds, dimension.id);
      warnings.push(`维度 id 重复：${dimension.id}，已自动改名为 ${next}`);
      dimension.id = next;
      dimensionIds.add(next);
    });

    /* ---- defaultDimension ---- */
    let defaultDimension = typeof raw.defaultDimension === 'string' ? raw.defaultDimension.trim() : '';
    if (!defaultDimension) {
      defaultDimension = dimensions[0].id;
    } else if (!dimensionIds.has(defaultDimension)) {
      warnings.push(`defaultDimension「${defaultDimension}」不存在，已改用「${dimensions[0].id}」`);
      defaultDimension = dimensions[0].id;
    }

    return {
      draft: { version: CONFIG_VERSION, site, defaultDimension, ui, dimensions },
      warnings,
    };
  } catch (error) {
    warnings.push(
      `配置规范化失败（${error && error.message ? error.message : String(error)}），已回退为空白草稿`,
    );
    return { draft: createEmptyDraft(), warnings };
  }
}

/**
 * 规范化 ui 字段：非法 labelMode 给 warning；布尔字段不是布尔就保持默认。
 * @param {any} rawUi
 * @param {string[]} warnings
 * @returns {{labelMode: string, grid: boolean, startCollapsed: boolean, showCoords: boolean}}
 */
function normalizeUi(rawUi, warnings) {
  const ui = { ...DEFAULT_UI };
  if (rawUi === undefined || rawUi === null) return ui;
  if (!isObject(rawUi)) {
    warnings.push('ui 不是对象，已使用默认界面设置');
    return ui;
  }
  if (typeof rawUi.labelMode === 'string') {
    if (LABEL_MODES.includes(rawUi.labelMode)) ui.labelMode = rawUi.labelMode;
    else warnings.push(`ui.labelMode 取值非法：${rawUi.labelMode}（应为 always / hover / never）`);
  }
  for (const key of ['grid', 'startCollapsed', 'showCoords']) {
    if (typeof rawUi[key] === 'boolean') ui[key] = rawUi[key];
  }
  return ui;
}

/**
 * 规范化单个维度。不可用的维度返回 null（由调用方跳过）。
 * @param {any} rawDimension
 * @param {number} index
 * @param {string[]} warnings
 * @returns {object|null}
 */
function normalizeDimension(rawDimension, index, warnings) {
  if (!isObject(rawDimension)) {
    warnings.push(`dimensions[${index}] 不是对象，已跳过`);
    return null;
  }

  const name = str(rawDimension.name) || `维度 ${index + 1}`;
  const id = str(rawDimension.id) || slugify(name) || `dim-${index + 1}`;
  const image = str(rawDimension.image);
  // 瓦片底图：{ manifest } 或直接字符串都接受；拿不到有效 manifest 时为 null（= 单图模式）
  const tiles = normalizeTiles(rawDimension.tiles, warnings, name);
  if (!image) {
    warnings.push(`维度「${name}」缺少 image（基底图文件名），站点会显示「地图还没上传」`);
  }

  const calibration = normalizeCalibration(rawDimension.calibration, warnings, name, Boolean(tiles));
  const groups = normalizeGroups(rawDimension.groups, warnings, name);
  const groupIds = new Set(groups.map((group) => group.id));
  const waypoints = normalizeWaypoints(rawDimension.waypoints, groups, groupIds, warnings, name);

  // 完全没有分组的维度补一个默认分组，保证编辑器有地方放新路径点
  if (groups.length === 0) {
    groups.push(makeDefaultGroup());
    groupIds.add(DEFAULT_GROUP.id);
  }

  // 字段顺序固定（便于 diff / 快照比较）：tiles 为 null 时也保留该键
  return {
    id,
    name,
    image,
    tiles,
    calibration,
    groups,
    waypoints,
    imageMeta: normalizeImageMeta(rawDimension.imageMeta),
  };
}

/**
 * 规范化校准对象。优先「四边画幅」写法，其次兼容站点支持的
 * `pixelsPerBlock + originX/originZ` 写法（原样保留，导出时也原样带回）。
 * 四边界保持原值（哪怕倒置），只在 warning 里提示，交给 validateDraft 报错。
 *
 * @param {any} raw
 * @param {string[]} warnings
 * @param {string} dimensionName
 * @param {boolean} [hasTiles] 配置了瓦片底图时，画幅由 manifest 决定，缺 calibration 不再告警
 * @returns {object}
 */
function normalizeCalibration(raw, warnings, dimensionName, hasTiles = false) {
  const calibration = emptyCalibration();
  if (!isObject(raw)) {
    if (!hasTiles) {
      warnings.push(`维度「${dimensionName}」没有 calibration，路径点将无法定位（请在工具里校准画幅）`);
    }
    return calibration;
  }

  calibration.calibrated = toBool(raw.calibrated);
  calibration.flipZ = toBool(raw.flipZ);
  calibration.note = typeof raw.note === 'string' ? raw.note : '';

  const bounds = [num(raw.xMin), num(raw.xMax), num(raw.zMin), num(raw.zMax)];
  const hasAllBounds = bounds.every((value) => value !== null);
  const hasSomeBounds = bounds.some((value) => value !== null);
  if (hasAllBounds) {
    calibration.xMin = bounds[0];
    calibration.xMax = bounds[1];
    calibration.zMin = bounds[2];
    calibration.zMax = bounds[3];
    if (!(bounds[1] > bounds[0]) || !(bounds[3] > bounds[2])) {
      warnings.push(`维度「${dimensionName}」画幅不合法（xMax 应大于 xMin、zMax 应大于 zMin），请在工具里重新校准`);
    }
    return calibration;
  }
  if (hasSomeBounds) {
    warnings.push(`维度「${dimensionName}」画幅四边界不完整（缺的已置空），请在工具里重新校准`);
  }

  // 兼容站点支持的替代写法：pixelsPerBlock + 左上角世界坐标
  const pixelsPerBlock = num(raw.pixelsPerBlock);
  const originX = num(raw.originX);
  const originZ = num(raw.originZ);
  if (pixelsPerBlock !== null && pixelsPerBlock > 0 && originX !== null && originZ !== null) {
    calibration.pixelsPerBlock = pixelsPerBlock;
    calibration.originX = originX;
    calibration.originZ = originZ;
    return calibration;
  }
  if (raw.pixelsPerBlock !== undefined || raw.originX !== undefined || raw.originZ !== undefined) {
    warnings.push(`维度「${dimensionName}」calibration 的 pixelsPerBlock / origin 写法不完整，请在工具里重新校准`);
  }
  return calibration;
}

/**
 * 规范化分组列表：补 id / name / color / visible，id 重复自动改名。
 * @param {any} rawGroups
 * @param {string[]} warnings
 * @param {string} dimensionName
 * @returns {Array<{id: string, name: string, color: string, visible: boolean}>}
 */
function normalizeGroups(rawGroups, warnings, dimensionName) {
  const groups = [];
  if (rawGroups === undefined || rawGroups === null) return groups;
  if (!Array.isArray(rawGroups)) {
    warnings.push(`维度「${dimensionName}」的 groups 不是数组，已忽略`);
    return groups;
  }

  const seen = new Set();
  rawGroups.forEach((rawGroup, index) => {
    if (!isObject(rawGroup)) {
      warnings.push(`维度「${dimensionName}」groups[${index}] 不是对象，已跳过`);
      return;
    }
    let id = str(rawGroup.id) || slugify(str(rawGroup.name)) || `group-${index + 1}`;
    if (seen.has(id)) {
      const next = uniqueIdIn(seen, id);
      warnings.push(`维度「${dimensionName}」分组 id 重复：${id}，已自动改名为 ${next}`);
      id = next;
    }
    seen.add(id);
    groups.push({
      id,
      name: str(rawGroup.name) || `分组 ${index + 1}`,
      color: str(rawGroup.color) || DEFAULT_GROUP.color,
      visible: rawGroup.visible !== false,
    });
  });
  return groups;
}

/**
 * 规范化路径点列表：字符串数字转 number、补默认分组 / 图标、id 重复自动改名。
 * 缺 x/z 的路径点**保留**（x/z 为 null）并给 warning，方便在表单里补坐标。
 *
 * @param {any} rawWaypoints
 * @param {Array<object>} groups 会被就地追加默认分组
 * @param {Set<string>} groupIds
 * @param {string[]} warnings
 * @param {string} dimensionName
 * @returns {Array<object>}
 */
function normalizeWaypoints(rawWaypoints, groups, groupIds, warnings, dimensionName) {
  const waypoints = [];
  if (rawWaypoints === undefined || rawWaypoints === null) return waypoints;
  if (!Array.isArray(rawWaypoints)) {
    warnings.push(`维度「${dimensionName}」的 waypoints 不是数组，已忽略`);
    return waypoints;
  }

  const seen = new Set();
  rawWaypoints.forEach((rawWaypoint, index) => {
    if (!isObject(rawWaypoint)) {
      warnings.push(`维度「${dimensionName}」waypoints[${index}] 不是对象，已跳过`);
      return;
    }

    const name = str(rawWaypoint.name) || `路径点 ${index + 1}`;
    const x = num(rawWaypoint.x);
    const y = num(rawWaypoint.y);
    const z = num(rawWaypoint.z);
    if (x === null || z === null) {
      warnings.push(
        `维度「${dimensionName}」的路径点「${name}」缺少有效的 x / z 世界坐标，已保留为空值，请在表单里补上`,
      );
    }

    let id = str(rawWaypoint.id) || slugify(name) || `wp-${index + 1}`;
    if (seen.has(id)) {
      const next = uniqueIdIn(seen, id);
      warnings.push(`维度「${dimensionName}」路径点 id 重复：${id}，已自动改名为 ${next}`);
      id = next;
    }
    seen.add(id);

    let group = str(rawWaypoint.group);
    if (!group || !groupIds.has(group)) {
      if (group) {
        warnings.push(`路径点「${name}」引用了不存在的分组「${group}」，已归入「未分组」`);
      }
      group = DEFAULT_GROUP.id;
      if (!groupIds.has(group)) {
        groups.push(makeDefaultGroup());
        groupIds.add(group);
      }
    }

    let label = null;
    if (rawWaypoint.label !== undefined && rawWaypoint.label !== null && rawWaypoint.label !== '') {
      if (LABEL_MODES.includes(rawWaypoint.label)) {
        label = rawWaypoint.label;
      } else {
        warnings.push(
          `路径点「${name}」的 label 取值非法：${String(rawWaypoint.label)}（应为 always / hover / never），已清除`,
        );
      }
    }

    waypoints.push({
      id,
      name,
      x,
      y,
      z,
      group,
      icon: str(rawWaypoint.icon) || 'pin',
      color: str(rawWaypoint.color) || null,
      label,
      description: str(rawWaypoint.description),
      url: str(rawWaypoint.url) || null,
    });
  });
  return waypoints;
}

/**
 * 规范化工具专用的 imageMeta：宽高必须是有限的非负数，否则 null。
 * @param {any} raw
 * @returns {{width: number|null, height: number|null, missing: boolean}}
 */
function normalizeImageMeta(raw) {
  const meta = { width: null, height: null, missing: false };
  if (!isObject(raw)) return meta;
  const width = num(raw.width);
  const height = num(raw.height);
  meta.width = width !== null && width >= 0 ? width : null;
  meta.height = height !== null && height >= 0 ? height : null;
  meta.missing = raw.missing === true;
  return meta;
}

/* ========================================================================== */
/* 3. 导出为站点 config.json                                                   */
/* ========================================================================== */

/**
 * 把草稿转成可以直接写入站点 `config.json` 的普通对象。
 *
 * 规则（契约 §2）：
 *   - 剥掉工具专用字段 `imageMeta` 以及所有未知字段；
 *   - 字段顺序固定，便于 git diff：
 *     根：version, site, defaultDimension, ui, dimensions[]
 *     维度：id, name, image, [tiles], calibration, groups, waypoints
 *   - `tiles` 只在配置了 manifest 时输出（`{ manifest }`），否则整个字段省略；
 *   - 空值不输出：`y: null`、`color`、`url`、`description`、`label` 为空时省略；
 *   - `group` 引用了不存在的分组时回落到 `default`（站点也会这么做）；
 *   - 不在本函数里做缩进 —— 调用方用 `JSON.stringify(cfg, null, 2) + '\n'`。
 *
 * @param {object} draft 草稿（通常是 normalizeDraft 的产物）
 * @returns {object} 站点配置对象（可直接 JSON.stringify 写盘）
 */
export function toConfigJson(draft) {
  const source = isObject(draft) ? draft : {};
  const rawDimensions = Array.isArray(source.dimensions) ? source.dimensions : [];

  const dimensions = [];
  const dimensionIds = [];
  for (const rawDimension of rawDimensions) {
    if (!isObject(rawDimension)) continue;
    const id = str(rawDimension.id);
    dimensionIds.push(id);

    const groups = Array.isArray(rawDimension.groups)
      ? rawDimension.groups.filter(isObject).map(toConfigGroup)
      : [];
    const groupIds = new Set(groups.map((group) => group.id));

    const waypoints = Array.isArray(rawDimension.waypoints)
      ? rawDimension.waypoints.filter(isObject).map((waypoint) => toConfigWaypoint(waypoint, groupIds))
      : [];

    const tilesManifest = tilesManifestOf(rawDimension.tiles);
    const outputDimension = {
      id,
      name: str(rawDimension.name),
      image: str(rawDimension.image),
    };
    // 维度字段顺序：id, name, image, [tiles], calibration, groups, waypoints
    if (tilesManifest) outputDimension.tiles = { manifest: tilesManifest };
    outputDimension.calibration = toConfigCalibration(rawDimension.calibration);
    outputDimension.groups = groups;
    outputDimension.waypoints = waypoints;
    dimensions.push(outputDimension);
  }

  const site = isObject(source.site) ? source.site : {};
  const ui = isObject(source.ui) ? source.ui : {};
  const defaultDimension = str(source.defaultDimension);

  return {
    version: CONFIG_VERSION,
    site: {
      title: typeof site.title === 'string' ? site.title : DEFAULT_SITE.title,
      subtitle: typeof site.subtitle === 'string' ? site.subtitle : DEFAULT_SITE.subtitle,
      footer: typeof site.footer === 'string' ? site.footer : DEFAULT_SITE.footer,
    },
    defaultDimension: defaultDimension || dimensionIds[0] || '',
    ui: {
      labelMode: LABEL_MODES.includes(ui.labelMode) ? ui.labelMode : DEFAULT_UI.labelMode,
      grid: typeof ui.grid === 'boolean' ? ui.grid : DEFAULT_UI.grid,
      startCollapsed: typeof ui.startCollapsed === 'boolean' ? ui.startCollapsed : DEFAULT_UI.startCollapsed,
      showCoords: typeof ui.showCoords === 'boolean' ? ui.showCoords : DEFAULT_UI.showCoords,
    },
    dimensions,
  };
}

/**
 * 单个分组 → 站点配置里的分组对象（字段顺序：id, name, color, visible）。
 * @param {object} group
 * @returns {{id: string, name: string, color: string, visible: boolean}}
 */
function toConfigGroup(group) {
  return {
    id: str(group.id),
    name: str(group.name),
    color: str(group.color) || DEFAULT_GROUP.color,
    visible: group.visible !== false,
  };
}

/**
 * 单个路径点 → 站点配置里的路径点对象。
 * 字段顺序：id, name, x, [y], z, group, icon, [color], [label], [description], [url]。
 * @param {object} waypoint
 * @param {Set<string>} groupIds 当前维度已输出的分组 id
 * @returns {object}
 */
function toConfigWaypoint(waypoint, groupIds) {
  const x = num(waypoint.x);
  const y = num(waypoint.y);
  const z = num(waypoint.z);
  const group = str(waypoint.group);

  const output = {
    id: str(waypoint.id),
    name: str(waypoint.name),
    x,
  };
  if (y !== null) output.y = y;
  output.z = z;
  output.group = group && groupIds.has(group) ? group : DEFAULT_GROUP.id;
  output.icon = str(waypoint.icon) || 'pin';

  const color = str(waypoint.color);
  if (color) output.color = color;
  if (LABEL_MODES.includes(waypoint.label)) output.label = waypoint.label;
  const description = typeof waypoint.description === 'string' ? waypoint.description : '';
  if (description.trim()) output.description = description;
  const url = str(waypoint.url);
  if (url) output.url = url;

  return output;
}

/**
 * 单个校准对象 → 站点配置里的校准对象。
 * 四边界完整才输出画幅；否则退化为省略（站点视为未校准），
 * 这样即使草稿还没校准，导出的 JSON 也依然是 schema 合法的。
 *
 * @param {any} calibration
 * @returns {object}
 */
function toConfigCalibration(calibration) {
  const cal = isObject(calibration) ? calibration : {};
  const output = { calibrated: toBool(cal.calibrated) };

  const bounds = [num(cal.xMin), num(cal.xMax), num(cal.zMin), num(cal.zMax)];
  if (bounds.every((value) => value !== null)) {
    output.xMin = bounds[0];
    output.xMax = bounds[1];
    output.zMin = bounds[2];
    output.zMax = bounds[3];
  } else {
    const pixelsPerBlock = num(cal.pixelsPerBlock);
    const originX = num(cal.originX);
    const originZ = num(cal.originZ);
    if (pixelsPerBlock !== null && pixelsPerBlock > 0 && originX !== null && originZ !== null) {
      output.pixelsPerBlock = pixelsPerBlock;
      output.originX = originX;
      output.originZ = originZ;
    }
  }

  output.flipZ = toBool(cal.flipZ);
  const note = typeof cal.note === 'string' ? cal.note : '';
  if (note) output.note = note;
  return output;
}

/* ========================================================================== */
/* 4. 校验（给问题面板 / 保存拦截用）                                          */
/* ========================================================================== */

/**
 * 校验草稿，产出问题列表。`Issue.path` 形如 `dimensions[0].waypoints[2].x`，
 * editor.js 靠它把问题定位到具体的树节点 / 表单字段。
 *
 * 规则与严重度（docs/CONTRACT.md §2）：
 *   - 没有任何维度、维度 id/name/image 为空、维度 id 重复 → error
 *   - 画幅四边界不完整 / 倒置 / 不是数字 → error；`calibrated !== true` → warning
 *   - 路径点 id 为空或维度内重复、name 为空、x/z 不是数字 → error
 *   - 路径点引用了不存在的分组 → warning（toConfigJson 会回落到 default）
 *   - 分组 id 为空或重复、color 不是 #rrggbb → error；空分组 / 无名称 → warning
 *   - image 不在 ctx.imageNames 里 → warning（站点会显示「地图还没上传」）
 *   - defaultDimension 不存在 → warning
 *
 * 附加检查：当 ctx.imageSizeOf(dim) 给出图片像素尺寸时，若画幅的
 * 「方块/像素」在 X / Z 两个方向相差超过 3%，给一条 warning（路径点会变形）。
 *
 * @param {object} draft
 * @param {{ imageNames?: string[], imageSizeOf?: (dimension: object) => ({width: number, height: number}|null) }} [ctx]
 * @returns {{ errors: Array<{path: string, message: string, level: 'error'|'warning'}>, warnings: Array<{path: string, message: string, level: 'error'|'warning'}> }}
 */
export function validateDraft(draft, ctx) {
  const errors = [];
  const warnings = [];
  const error = (path, message) => errors.push({ path, message, level: 'error' });
  const warn = (path, message) => warnings.push({ path, message, level: 'warning' });

  try {
    const context = isObject(ctx) ? ctx : {};
    const imageNames = Array.isArray(context.imageNames)
      ? context.imageNames.map((name) => String(name))
      : null;
    const imageSizeOf = typeof context.imageSizeOf === 'function' ? context.imageSizeOf : null;

    const source = isObject(draft) ? draft : {};
    const dimensions = Array.isArray(source.dimensions) ? source.dimensions : [];
    if (dimensions.length === 0) {
      error('dimensions', '至少需要一个维度（dimensions 不能为空）');
    }

    const dimensionIds = new Set();

    dimensions.forEach((dimension, dimensionIndex) => {
      const base = `dimensions[${dimensionIndex}]`;
      if (!isObject(dimension)) {
        error(base, '维度必须是对象');
        return;
      }

      /* ---- id / name / image ---- */
      const dimensionId = str(dimension.id);
      if (!dimensionId) {
        error(`${base}.id`, '维度 id 不能为空');
      } else if (dimensionIds.has(dimensionId)) {
        error(`${base}.id`, `维度 id 重复：「${dimensionId}」`);
      } else {
        dimensionIds.add(dimensionId);
      }
      if (!str(dimension.name)) error(`${base}.name`, '维度名称不能为空');

      const image = str(dimension.image);
      if (!image) {
        error(`${base}.image`, '维度基底图不能为空（请先导入或选择一张图片）');
      } else if (imageNames && !imageNames.includes(image)) {
        warn(`${base}.image`, `站点目录里没有「${image}」，站点会显示「地图还没上传」`);
      }

      /* ---- tiles（瓦片底图，可选） ---- */
      const tilesManifest = tilesManifestOf(dimension.tiles);
      const hasTiles = Boolean(tilesManifest);
      if (dimension.tiles !== undefined && dimension.tiles !== null && !hasTiles) {
        error(`${base}.tiles.manifest`, '瓦片清单路径不能为空（要用单图请把「底图类型」切回单图）');
      }
      if (hasTiles && !/\.json$/i.test(tilesManifest)) {
        warn(`${base}.tiles.manifest`, `瓦片清单通常应以 .json 结尾：${tilesManifest}`);
      }

      /* ---- calibration ---- */
      validateCalibration(
        dimension.calibration,
        `${base}.calibration`,
        dimension,
        imageSizeOf,
        error,
        warn,
        hasTiles,
      );

      /* ---- groups ---- */
      const groups = Array.isArray(dimension.groups) ? dimension.groups : [];
      const groupIds = new Set();
      const usedGroupIds = new Set();
      if (Array.isArray(dimension.waypoints)) {
        for (const waypoint of dimension.waypoints) {
          if (isObject(waypoint) && str(waypoint.group)) usedGroupIds.add(str(waypoint.group));
        }
      }
      groups.forEach((group, groupIndex) => {
        const groupPath = `${base}.groups[${groupIndex}]`;
        if (!isObject(group)) {
          error(groupPath, '分组必须是对象');
          return;
        }
        const groupId = str(group.id);
        if (!groupId) {
          error(`${groupPath}.id`, '分组 id 不能为空');
        } else if (groupIds.has(groupId)) {
          error(`${groupPath}.id`, `分组 id 重复：「${groupId}」`);
        } else {
          groupIds.add(groupId);
        }
        if (!str(group.name)) warn(`${groupPath}.name`, '分组名称建议填写（站点侧会显示为空）');
        const color = str(group.color);
        if (!color) {
          warn(`${groupPath}.color`, '分组没有颜色，站点会使用默认灰色');
        } else if (!COLOR_RE.test(color)) {
          error(`${groupPath}.color`, `颜色「${color}」格式不合法，应为 #rrggbb`);
        }
        if (groupId && !usedGroupIds.has(groupId)) {
          warn(groupPath, `分组「${str(group.name) || groupId}」下还没有路径点`);
        }
      });

      /* ---- waypoints ---- */
      const waypoints = Array.isArray(dimension.waypoints) ? dimension.waypoints : [];
      const waypointIds = new Set();
      waypoints.forEach((waypoint, waypointIndex) => {
        const waypointPath = `${base}.waypoints[${waypointIndex}]`;
        if (!isObject(waypoint)) {
          error(waypointPath, '路径点必须是对象');
          return;
        }
        const waypointId = str(waypoint.id);
        if (!waypointId) {
          error(`${waypointPath}.id`, '路径点 id 不能为空');
        } else if (waypointIds.has(waypointId)) {
          error(`${waypointPath}.id`, `路径点 id 重复：「${waypointId}」`);
        } else {
          waypointIds.add(waypointId);
        }
        if (!str(waypoint.name)) error(`${waypointPath}.name`, '路径点名称不能为空');
        if (num(waypoint.x) === null) error(`${waypointPath}.x`, 'X 坐标必须是数字');
        if (num(waypoint.z) === null) error(`${waypointPath}.z`, 'Z 坐标必须是数字');
        if (
          waypoint.y !== undefined &&
          waypoint.y !== null &&
          waypoint.y !== '' &&
          num(waypoint.y) === null
        ) {
          warn(`${waypointPath}.y`, 'Y 坐标不是数字，站点会忽略它');
        }
        const group = str(waypoint.group);
        if (!group) {
          if (!groupIds.has(DEFAULT_GROUP.id)) {
            warn(`${waypointPath}.group`, '未指定分组，站点会自动归入「未分组」');
          }
        } else if (!groupIds.has(group)) {
          warn(`${waypointPath}.group`, `分组「${group}」不存在，将回落到「未分组」`);
        }
      });
    });

    /* ---- defaultDimension / version ---- */
    const defaultDimension = str(source.defaultDimension);
    if (defaultDimension && !dimensionIds.has(defaultDimension)) {
      warn('defaultDimension', `默认维度「${defaultDimension}」不存在，站点会改用第一个维度`);
    }
    if (
      source.version !== undefined &&
      source.version !== null &&
      Number(source.version) !== CONFIG_VERSION
    ) {
      warn('version', `配置版本不是 ${CONFIG_VERSION}，保存时会写成 ${CONFIG_VERSION}`);
    }
  } catch (errorCaught) {
    errors.push({
      path: '',
      message: `校验器内部错误：${errorCaught && errorCaught.message ? errorCaught.message : String(errorCaught)}`,
      level: 'error',
    });
  }

  return { errors, warnings };
}

/**
 * 校验单个维度的画幅校准。
 * @param {any} calibration
 * @param {string} path 形如 `dimensions[0].calibration`
 * @param {object} dimension 所属维度（传给 ctx.imageSizeOf）
 * @param {Function|null} imageSizeOf
 * @param {(path: string, message: string) => void} error
 * @param {(path: string, message: string) => void} warn
 * @param {boolean} [hasTiles] 维度配了瓦片底图：世界范围来自 manifest，画幅只作单图兜底，问题降级为 warning
 */
function validateCalibration(calibration, path, dimension, imageSizeOf, error, warn, hasTiles = false) {
  const report = hasTiles ? warn : error;
  if (!isObject(calibration)) {
    report(path, '缺少画幅校准（calibration），路径点无法定位');
    return;
  }

  const bounds = [num(calibration.xMin), num(calibration.xMax), num(calibration.zMin), num(calibration.zMax)];
  const [xMin, xMax, zMin, zMax] = bounds;
  const hasAllBounds = bounds.every((value) => value !== null);
  const hasSomeBounds = bounds.some((value) => value !== null);

  if (hasAllBounds) {
    if (!(xMax > xMin)) report(`${path}.xMax`, `画幅倒置：xMax（${xMax}）必须大于 xMin（${xMin}）`);
    if (!(zMax > zMin)) report(`${path}.zMax`, `画幅倒置：zMax（${zMax}）必须大于 zMin（${zMin}）`);

    // 附加检查：X / Z 两个方向的「方块/像素」应基本一致，否则路径点会被拉伸
    if (imageSizeOf) {
      let size = null;
      try {
        size = imageSizeOf(dimension);
      } catch {
        size = null;
      }
      if (size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0) {
        const blocksPerPixelX = (xMax - xMin) / size.width;
        const blocksPerPixelZ = (zMax - zMin) / size.height;
        if (
          Number.isFinite(blocksPerPixelX) &&
          Number.isFinite(blocksPerPixelZ) &&
          blocksPerPixelX > 0 &&
          blocksPerPixelZ > 0
        ) {
          const ratio =
            blocksPerPixelX > blocksPerPixelZ
              ? blocksPerPixelX / blocksPerPixelZ
              : blocksPerPixelZ / blocksPerPixelX;
          if (ratio > 1.03) {
            warn(
              path,
              `画幅比例与图片像素比例不一致（X ${formatRatio(blocksPerPixelX)} 方块/像素，Z ${formatRatio(blocksPerPixelZ)} 方块/像素），路径点可能被拉伸；若不是有意为之请重新校准`,
            );
          }
        }
      }
    }
  } else if (hasSomeBounds) {
    report(path, '画幅四边界不完整（xMin / xMax / zMin / zMax 都要是数字）');
  } else {
    const pixelsPerBlock = num(calibration.pixelsPerBlock);
    const originX = num(calibration.originX);
    const originZ = num(calibration.originZ);
    const hasScale =
      pixelsPerBlock !== null && pixelsPerBlock > 0 && originX !== null && originZ !== null;
    if (hasScale) {
      warn(path, '使用了 pixelsPerBlock + originX/originZ 的替代写法（站点支持），推荐改成四边界写法');
    } else {
      report(path, '还没有校准画幅（需要 xMin / xMax / zMin / zMax）');
    }
  }

  // 瓦片底图的世界范围来自 manifest，画幅只当单图兜底，不再要求「已校准」标记
  if (calibration.calibrated !== true && !hasTiles) {
    warn(`${path}.calibrated`, '画幅还没有标记为「已校准」，确认无误后请完成一次校准');
  }
}

/** 比例的小数格式化（最多 4 位，避免 warning 里出现长浮点数）。 */
function formatRatio(value) {
  return String(Math.round(value * 10000) / 10000);
}

/* ========================================================================== */
/* 5. 新建 / 复制                                                              */
/* ========================================================================== */

/**
 * 为一个集合生成不冲突的下一个 id：`base`、`base-2`、`base-3`…
 *
 * @param {Array<string|{id: any}>|Set<string>|Map<string, any>} collection 已有 id 的集合
 * @param {string} base 期望的 id 前缀
 * @returns {string} 未被占用的 id
 */
export function nextId(collection, base) {
  const used = new Set();
  let items = [];
  if (Array.isArray(collection)) items = collection;
  else if (collection instanceof Set || collection instanceof Map) items = [...collection.keys()];

  for (const item of items) {
    if (typeof item === 'string') used.add(item);
    else if (isObject(item) && item.id !== undefined && item.id !== null) used.add(String(item.id));
  }

  const root = slugify(String(base === null || base === undefined ? '' : base)) || 'item';
  if (!used.has(root)) return root;
  let n = 2;
  while (used.has(`${root}-${n}`)) n += 1;
  return `${root}-${n}`;
}

/**
 * 生成维度内唯一的路径点 id（等价于对当前维度的路径点列表调用 nextId）。
 *
 * @param {object} draft
 * @param {string} dimensionId
 * @param {string} [base='wp'] 期望的 id 前缀
 * @returns {string}
 */
export function uniqueWaypointId(draft, dimensionId, base = 'wp') {
  const dimension = dimensionById(draft, dimensionId) || firstDimension(draft);
  const waypoints = dimension && Array.isArray(dimension.waypoints) ? dimension.waypoints : [];
  return nextId(waypoints, base || 'wp');
}

/**
 * 在指定维度里新建一个路径点并追加到末尾。
 * 自动生成唯一 id、补默认分组（必要时补「未分组」分组）与图标。
 *
 * @param {object} draft
 * @param {string} dimensionId
 * @param {object} [partial] 允许预填 name / x / y / z / group / icon / color / label / description / url / id
 * @returns {object|null} 新建的路径点；草稿里没有任何维度时返回 null
 */
export function createWaypoint(draft, dimensionId, partial = {}) {
  const dimension = dimensionById(draft, dimensionId) || firstDimension(draft);
  if (!dimension) return null;

  if (!Array.isArray(dimension.groups)) dimension.groups = [];
  if (!Array.isArray(dimension.waypoints)) dimension.waypoints = [];
  const groups = dimension.groups;
  const prefs = isObject(partial) ? partial : {};

  let group = str(prefs.group);
  if (!group || !groups.some((item) => isObject(item) && String(item.id) === group)) {
    group = DEFAULT_GROUP.id;
    if (!groups.some((item) => isObject(item) && item.id === DEFAULT_GROUP.id)) {
      groups.push(makeDefaultGroup());
    }
  }

  const waypoint = {
    id: uniqueWaypointId(draft, dimension.id, str(prefs.id) || 'wp'),
    name: str(prefs.name) || '新路径点',
    x: num(prefs.x) === null ? 0 : num(prefs.x),
    y: num(prefs.y),
    z: num(prefs.z) === null ? 0 : num(prefs.z),
    group,
    icon: pickIcon(prefs.icon),
    color: str(prefs.color) || null,
    label: LABEL_MODES.includes(prefs.label) ? prefs.label : null,
    description: str(prefs.description),
    url: str(prefs.url) || null,
  };
  dimension.waypoints.push(waypoint);
  return waypoint;
}

/**
 * 在指定维度里新建一个分组并追加到末尾。
 * 自动生成唯一 id；没给颜色时从调色板里轮换取色。
 *
 * @param {object} draft
 * @param {string} dimensionId
 * @param {object} [partial] 允许预填 id / name / color / visible
 * @returns {object|null} 新建的分组；草稿里没有任何维度时返回 null
 */
export function createGroup(draft, dimensionId, partial = {}) {
  const dimension = dimensionById(draft, dimensionId) || firstDimension(draft);
  if (!dimension) return null;

  if (!Array.isArray(dimension.groups)) dimension.groups = [];
  const groups = dimension.groups;
  const prefs = isObject(partial) ? partial : {};
  const name = str(prefs.name) || `新分组 ${groups.length + 1}`;
  const color = COLOR_RE.test(str(prefs.color))
    ? str(prefs.color)
    : GROUP_COLORS[groups.length % GROUP_COLORS.length];

  const group = {
    id: nextId(groups, str(prefs.id) || 'group'),
    name,
    color,
    visible: prefs.visible !== false,
  };
  groups.push(group);
  return group;
}

/**
 * 新建一个维度并追加到草稿末尾。
 * 新维度带默认分组 / 空路径点 / 未校准画幅；image 为空，需要用户再选图。
 *
 * @param {object} draft
 * @param {object} [partial] 允许预填 id / name / image / calibration
 * @returns {object|null} 新建的维度；草稿不是对象时返回 null
 */
export function createDimension(draft, partial = {}) {
  if (!isObject(draft)) return null;
  if (!Array.isArray(draft.dimensions)) draft.dimensions = [];

  const prefs = isObject(partial) ? partial : {};
  const name = str(prefs.name) || `新维度 ${draft.dimensions.length + 1}`;
  const dimension = {
    id: nextId(draft.dimensions, str(prefs.id) || 'dimension'),
    name,
    image: str(prefs.image),
    tiles: normalizeTiles(prefs.tiles, [], name),
    calibration: emptyCalibration(),
    groups: [makeDefaultGroup()],
    waypoints: [],
    imageMeta: { width: null, height: null, missing: true },
  };

  if (isObject(prefs.calibration)) {
    const provided = prefs.calibration;
    dimension.calibration.calibrated = toBool(provided.calibrated);
    dimension.calibration.flipZ = toBool(provided.flipZ);
    dimension.calibration.note = typeof provided.note === 'string' ? provided.note : '';
    for (const key of ['xMin', 'xMax', 'zMin', 'zMax']) {
      const value = num(provided[key]);
      if (value !== null) dimension.calibration[key] = value;
    }
  }

  draft.dimensions.push(dimension);
  return dimension;
}

/**
 * 复制一个路径点（插在原路径点后面）。
 * 新 id 唯一，名称追加「（副本）」，其余字段原样复制。
 *
 * @param {object} draft
 * @param {string} dimensionId
 * @param {string} waypointId
 * @returns {object|null} 复制出来的新路径点；找不到时返回 null
 */
export function duplicateWaypoint(draft, dimensionId, waypointId) {
  const dimension = dimensionById(draft, dimensionId);
  if (!dimension || !Array.isArray(dimension.waypoints)) return null;

  const index = dimension.waypoints.findIndex(
    (waypoint) => isObject(waypoint) && String(waypoint.id) === String(waypointId),
  );
  if (index < 0) return null;

  const source = dimension.waypoints[index];
  const sourceName = str(source.name) || '路径点';
  const copy = {
    id: uniqueWaypointId(draft, dimension.id, `${str(source.id) || 'wp'}-copy`),
    name: `${sourceName}（副本）`,
    x: num(source.x),
    y: num(source.y),
    z: num(source.z),
    group: str(source.group) || DEFAULT_GROUP.id,
    icon: pickIcon(source.icon),
    color: str(source.color) || null,
    label: LABEL_MODES.includes(source.label) ? source.label : null,
    description: str(source.description),
    url: str(source.url) || null,
  };

  dimension.waypoints.splice(index + 1, 0, copy);
  return copy;
}

/* ========================================================================== */
/* 6. 查询 / 图标 / 搜索                                                       */
/* ========================================================================== */

/**
 * 按 id 找维度。
 * @param {object} draft
 * @param {string} id
 * @returns {object|null}
 */
export function dimensionById(draft, id) {
  if (id === undefined || id === null) return null;
  if (!isObject(draft) || !Array.isArray(draft.dimensions)) return null;
  const found = draft.dimensions.find(
    (dimension) => isObject(dimension) && String(dimension.id) === String(id),
  );
  return found || null;
}

/**
 * 在维度里按 id 找路径点。
 * @param {object} dimension
 * @param {string} id
 * @returns {object|null}
 */
export function waypointById(dimension, id) {
  if (id === undefined || id === null) return null;
  if (!isObject(dimension) || !Array.isArray(dimension.waypoints)) return null;
  const found = dimension.waypoints.find(
    (waypoint) => isObject(waypoint) && String(waypoint.id) === String(id),
  );
  return found || null;
}

/**
 * 解析图标值：ICONS 命中 → emoji；1~2 个字符（自定义 emoji / 短符号）→ 原样；
 * 其它（空 / 未知长 key）→ pin 的 emoji。
 *
 * @param {string} icon
 * @returns {string}
 */
export function resolveIcon(icon) {
  if (typeof icon !== 'string') return ICONS.pin;
  const value = icon.trim();
  if (!value) return ICONS.pin;
  if (Object.prototype.hasOwnProperty.call(ICONS, value)) return ICONS[value];
  if (Array.from(value).length <= 2) return value;
  return ICONS.pin;
}

/**
 * 图标选择器里显示的可读文案，如 `iconLabel('farm')` → `'🌾 农场'`。
 * 未知 key 回落到「❓ 未知」；自定义 1~2 字符串显示「自定义」。
 *
 * @param {string} key 图标 key（或自定义 emoji）
 * @returns {string}
 */
export function iconLabel(key) {
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value) return `${ICONS.pin} ${ICON_LABELS.pin}`;
  if (ICON_LABELS[value]) return `${ICONS[value]} ${ICON_LABELS[value]}`;
  if (Array.from(value).length <= 2) return `${resolveIcon(value)} 自定义`;
  return `${ICONS.pin} ${ICON_LABELS.pin}`;
}

/**
 * 路径点搜索匹配。与站点 assets/js/sidebar.js 的 `_matchesQuery` / app.js 的
 * `matchQuery` 保持**同一套规则**，保证「侧栏列表可见项」=「地图上可见标记」：
 *
 *   1. 名称（name，缺省用 id）包含查询串（忽略大小写）；
 *   2. 描述包含查询串；
 *   3. `"x z"` 坐标文本（四舍五入后的整数）包含查询串；
 *   4. 查询串里能抽出两个以上数字时，按「两数字前缀匹配」：
 *      `-512 640` 会命中 x=-512、z=640，也会命中 x=-5120、z=6400。
 *
 * 空查询一律返回 true（不过滤）。
 *
 * @param {object} waypoint
 * @param {string} query
 * @returns {boolean}
 */
export function waypointMatchesQuery(waypoint, query) {
  const search = String(query === null || query === undefined ? '' : query)
    .trim()
    .toLowerCase();
  if (!search) return true;
  if (!isObject(waypoint)) return false;

  const name = String(
    waypoint.name !== undefined && waypoint.name !== null ? waypoint.name : waypoint.id ?? '',
  ).toLowerCase();
  if (name.includes(search)) return true;

  if (waypoint.description) {
    if (String(waypoint.description).toLowerCase().includes(search)) return true;
  }

  const coordText = `${roundBlock(waypoint.x)} ${roundBlock(waypoint.z)}`;
  if (coordText.includes(search)) return true;

  const numbers = search.match(/-?\d+(?:\.\d+)?/g);
  if (numbers && numbers.length >= 2) {
    const [rawX, rawZ] = numbers;
    const nx = String(Math.trunc(Number(rawX)));
    const nz = String(Math.trunc(Number(rawZ)));
    const wx = num(waypoint.x);
    const wz = num(waypoint.z);
    if (wx === null || wz === null) return false;
    return String(Math.round(wx)).startsWith(nx) && String(Math.round(wz)).startsWith(nz);
  }
  return false;
}

/**
 * 坐标取整成搜索用的显示文本；非数字返回破折号（与站点侧 roundBlock 一致）。
 * @param {any} value
 * @returns {string}
 */
function roundBlock(value) {
  const numeric = num(value);
  return numeric === null ? '—' : String(Math.round(numeric));
}

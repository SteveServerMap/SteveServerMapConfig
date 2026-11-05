/**
 * tests/model.test.mjs —— assets/js/model.js 的单元测试（node:test + node:assert/strict）
 *
 * 运行：node --test tests/model.test.mjs
 *
 * 覆盖（docs/CONTRACT.md §2）：
 *   1. createEmptyDraft 结构合法（1 个维度 + 默认分组）
 *   2. normalizeDraft(站点真实 config.json) 往返语义等价、且导出物不含 imageMeta
 *   3. toConfigJson 的产物用站点 config.schema.json 做真实校验（自带迷你 schema 校验器）
 *   4. validateDraft 的 error / warning 与 Issue.path
 *   5. nextId / uniqueWaypointId 递增不冲突；duplicateWaypoint 复制后 id 唯一、名称带「副本」
 *   6. resolveIcon 规则；ICONS 与站点 assets/js/markers.js 逐项相等
 *   7. waypointMatchesQuery 与站点侧搜索规则一致
 *
 * 站点仓库是只读基准（默认 ../SteveServerMap.github.io），
 * 不存在时相关用例会 skip，不会失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CONFIG_VERSION,
  createEmptyDraft,
  normalizeDraft,
  toConfigJson,
  validateDraft,
  createWaypoint,
  createGroup,
  createDimension,
  nextId,
  uniqueWaypointId,
  ICONS,
  ICON_KEYS,
  resolveIcon,
  iconLabel,
  waypointMatchesQuery,
  duplicateWaypoint,
  dimensionById,
  waypointById,
} from '../assets/js/model.js';

/* ========================================================================== */
/* 站点仓库路径（只读；不存在则跳过相关用例）                                   */
/* ========================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = path.resolve(HERE, '..');
const SITE_DIR = path.resolve(TOOL_DIR, '..', 'SteveServerMap.github.io');
const SITE_CONFIG = path.join(SITE_DIR, 'config.json');
const SITE_SCHEMA = path.join(SITE_DIR, 'config.schema.json');
const SITE_MARKERS = path.join(SITE_DIR, 'assets', 'js', 'markers.js');
test('defaultSpanBlocks 在草稿与配置间往返保留且不接受越界值', () => {
  for (const span of [64, 1200, 16384]) {
    const raw = createEmptyDraft();
    raw.ui.defaultSpanBlocks = span;
    const { draft } = normalizeDraft(raw);
    assert.equal(draft.ui.defaultSpanBlocks, span);
    assert.equal(toConfigJson(draft).ui.defaultSpanBlocks, span);
  }
  for (const span of [null, '', '1024', 0, 63, 100.5, 16385, Infinity]) {
    const raw = createEmptyDraft();
    raw.ui.defaultSpanBlocks = span;
    assert.equal(toConfigJson(normalizeDraft(raw).draft).ui.defaultSpanBlocks, undefined);
  }
});

const siteConfigAvailable = fs.existsSync(SITE_CONFIG);
const siteSchemaAvailable = fs.existsSync(SITE_SCHEMA);

/** 读取站点真实 config.json（测试内部用，不写回）。 */
function readSiteConfig() {
  return JSON.parse(fs.readFileSync(SITE_CONFIG, 'utf8'));
}

/** 站点真实图片尺寸（与 config.json 的 calibration 对得上，用于 validateDraft 的附加检查）。 */
const SITE_IMAGE_SIZES = {
  '主世界.png': { width: 3584, height: 5120 },
  '下界.png': { width: 2048, height: 2048 },
  '末地.png': { width: 2048, height: 2048 },
};

/** 一份「完全合法」的草稿，供 validateDraft / 序列化用例做基准。 */
function makeValidDraft() {
  return {
    version: CONFIG_VERSION,
    site: { title: '测试站点', subtitle: '副标题', footer: '页脚' },
    defaultDimension: 'overworld',
    ui: { labelMode: 'hover', grid: false, startCollapsed: false, showCoords: true },
    dimensions: [
      {
        id: 'overworld',
        name: '主世界',
        image: '主世界.png',
        calibration: {
          calibrated: true,
          xMin: -100,
          xMax: 100,
          zMin: -100,
          zMax: 100,
          flipZ: false,
          note: '测试画幅',
        },
        groups: [{ id: 'base', name: '据点', color: '#5ad26f', visible: true }],
        waypoints: [
          {
            id: 'spawn',
            name: '出生点',
            x: 0,
            y: 65,
            z: 0,
            group: 'base',
            icon: 'spawn',
            color: null,
            label: 'always',
            description: '',
            url: null,
          },
        ],
        imageMeta: { width: 200, height: 200, missing: false },
      },
    ],
  };
}

/** validateDraft 用的 ctx。 */
function makeCtx() {
  return {
    imageNames: ['主世界.png'],
    imageSizeOf: () => ({ width: 200, height: 200 }),
  };
}

/** 精确 path + 消息片段查询。 */
function hasIssue(issues, expectedPath, messagePart) {
  return issues.some(
    (issue) => issue.path === expectedPath && (!messagePart || issue.message.includes(messagePart)),
  );
}

/* ========================================================================== */
/* 迷你 JSON-Schema 子集校验器（零依赖，故意手写，支持站点 schema 用到的关键字） */
/* ========================================================================== */

/**
 * 校验 data 是否符合 schema 的指定子集。
 * 支持：type（含 type 数组）/ required / properties / items / enum / const /
 * additionalProperties（true | false）。未知关键字（如 description/$schema）忽略。
 *
 * @param {any} data
 * @param {object} schema
 * @param {string} [at]
 * @returns {string[]} 错误列表（空数组 = 通过）
 */
function validateSchema(data, schema, at = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  const typeOf = (value) => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return typeof value;
  };

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(data);
    const ok = expected.some((type) => {
      if (type === 'number') return actual === 'number' || actual === 'integer';
      return type === actual;
    });
    if (!ok) errors.push(`${at}: 类型应为 ${expected.join(' | ')}，实际是 ${actual}`);
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && data !== schema.const) {
    errors.push(`${at}: 应为常量 ${JSON.stringify(schema.const)}，实际是 ${JSON.stringify(data)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === data)) {
    errors.push(`${at}: 不在枚举 ${JSON.stringify(schema.enum)} 中，实际是 ${JSON.stringify(data)}`);
  }

  if (Array.isArray(data) && schema.items) {
    data.forEach((item, index) => {
      errors.push(...validateSchema(item, schema.items, `${at}[${index}]`));
    });
  }

  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) errors.push(`${at}: 缺少必需字段 ${key}`);
    }
    const properties = schema.properties || {};
    for (const [key, subSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        errors.push(...validateSchema(data[key], subSchema, `${at}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`${at}: 不允许的字段 ${key}`);
        }
      }
    }
  }

  return errors;
}

/* ========================================================================== */
/* 1. createEmptyDraft                                                        */
/* ========================================================================== */

test('createEmptyDraft：包含 1 个主世界维度 + 默认分组，字段齐全', () => {
  const draft = createEmptyDraft();

  assert.equal(draft.version, CONFIG_VERSION);
  assert.deepEqual(draft.site, {
    title: 'Steve Server 地图',
    subtitle: '离线地图 · 路径点可配置',
    footer: '路径点由 config.json 驱动',
  });
  assert.equal(draft.defaultDimension, 'overworld');
  assert.deepEqual(draft.ui, { labelMode: 'hover', grid: false, startCollapsed: false, showCoords: true });

  assert.ok(Array.isArray(draft.dimensions));
  assert.equal(draft.dimensions.length, 1);
  const dimension = draft.dimensions[0];
  assert.equal(dimension.id, 'overworld');
  assert.equal(dimension.name, '主世界');
  assert.equal(dimension.image, '');
  assert.ok(Array.isArray(dimension.groups));
  assert.equal(dimension.groups.length, 1);
  assert.deepEqual(dimension.groups[0], { id: 'default', name: '未分组', color: '#8fa3a0', visible: true });
  assert.ok(Array.isArray(dimension.waypoints));
  assert.equal(dimension.waypoints.length, 0);
  assert.deepEqual(dimension.imageMeta, { width: null, height: null, missing: true });
  assert.deepEqual(Object.keys(dimension.calibration), [
    'calibrated', 'xMin', 'xMax', 'zMin', 'zMax', 'flipZ', 'note',
  ]);
  assert.equal(dimension.calibration.calibrated, false);
  assert.equal(dimension.calibration.xMin, null);
});

test('createEmptyDraft：每次返回独立对象，改动互不影响', () => {
  const a = createEmptyDraft();
  const b = createEmptyDraft();
  a.dimensions[0].name = '改过了';
  a.dimensions[0].groups[0].name = '也改过了';
  a.site.title = '改过了';

  assert.equal(b.dimensions[0].name, '主世界');
  assert.equal(b.dimensions[0].groups[0].name, '未分组');
  assert.equal(b.site.title, 'Steve Server 地图');
  assert.notEqual(a.dimensions[0], b.dimensions[0]);
});

/* ========================================================================== */
/* 2. normalizeDraft 往返（站点真实 config.json）                              */
/* ========================================================================== */

test('normalizeDraft：站点真实 config.json 往返语义等价，且导出物不含 imageMeta', (t) => {
  if (!siteConfigAvailable) {
    t.skip('站点仓库 ../SteveServerMap.github.io/config.json 不存在');
    return;
  }
  const raw = readSiteConfig();
  const { draft, warnings } = normalizeDraft(raw);

  // 站点真实配置是完全合法的，规范化不应产生任何提示
  assert.deepEqual(warnings, []);

  // 草稿是超集：每个维度都有工具专用 imageMeta
  for (const dimension of draft.dimensions) {
    assert.ok(dimension.imageMeta && typeof dimension.imageMeta === 'object');
    assert.equal(typeof dimension.imageMeta.missing, 'boolean');
  }

  const config = toConfigJson(draft);
  assert.equal(config.version, 1);
  assert.deepEqual(config.site, raw.site);
  assert.equal(config.defaultDimension, raw.defaultDimension);
  assert.deepEqual(config.ui, raw.ui);
  assert.equal(config.dimensions.length, raw.dimensions.length);

  raw.dimensions.forEach((rawDimension, index) => {
    const dimension = config.dimensions[index];
    assert.equal(dimension.id, rawDimension.id);
    assert.equal(dimension.name, rawDimension.name);
    assert.equal(dimension.image, rawDimension.image);
    assert.deepEqual(dimension.calibration, rawDimension.calibration);
    assert.deepEqual(dimension.groups, rawDimension.groups);
    assert.equal(dimension.waypoints.length, rawDimension.waypoints.length);
    rawDimension.waypoints.forEach((rawWaypoint, waypointIndex) => {
      assert.deepEqual(
        dimension.waypoints[waypointIndex],
        rawWaypoint,
        `路径点不一致：${rawDimension.id}.waypoints[${waypointIndex}]`,
      );
    });
  });

  // 工具字段必须剥掉
  assert.equal(JSON.stringify(config).includes('imageMeta'), false);
  // 路径点数量必须与站点原文件一致（不要写死具体数字：站点配置会随使用变化）
  assert.deepEqual(
    config.dimensions.map((dimension) => dimension.waypoints.length),
    raw.dimensions.map((dimension) => (Array.isArray(dimension.waypoints) ? dimension.waypoints.length : 0)),
  );
});

test('normalizeDraft：导出 → 再规范化 → 再导出，结果完全稳定（幂等）', (t) => {
  if (!siteConfigAvailable) {
    t.skip('站点仓库不可用');
    return;
  }
  const raw = readSiteConfig();
  const first = toConfigJson(normalizeDraft(raw).draft);
  const second = toConfigJson(normalizeDraft(first).draft);
  assert.deepEqual(second, first);
});

/* ========================================================================== */
/* 3. toConfigJson + 站点 config.schema.json 真实校验                          */
/* ========================================================================== */

test('toConfigJson：字段顺序固定，空值字段（y/color/label/description/url）不输出', () => {
  const draft = createEmptyDraft();
  const dimension = draft.dimensions[0];
  dimension.image = '主世界.png';
  dimension.calibration = {
    calibrated: true, xMin: 0, xMax: 100, zMin: 0, zMax: 100, flipZ: false, note: '',
  };
  dimension.waypoints = [
    {
      id: 'w1',
      name: '路径点',
      x: 1,
      y: null,
      z: 2,
      group: 'default',
      icon: 'pin',
      color: null,
      label: null,
      description: '',
      url: null,
    },
    {
      id: 'w2',
      name: '带 Y',
      x: 3,
      y: 70,
      z: 4,
      group: 'default',
      icon: 'farm',
      color: '#ff0000',
      label: 'never',
      description: '说明',
      url: 'https://example.com/',
    },
  ];

  const config = toConfigJson(draft);
  assert.deepEqual(Object.keys(config), ['version', 'site', 'defaultDimension', 'ui', 'dimensions']);
  assert.deepEqual(Object.keys(config.dimensions[0]), [
    'id', 'name', 'image', 'calibration', 'groups', 'waypoints',
  ]);

  const [plain, full] = config.dimensions[0].waypoints;
  assert.deepEqual(Object.keys(plain), ['id', 'name', 'x', 'z', 'group', 'icon']);
  assert.deepEqual(Object.keys(full), [
    'id', 'name', 'x', 'y', 'z', 'group', 'icon', 'color', 'label', 'description', 'url',
  ]);

  // 空校准说明不输出；imageMeta 被剥掉
  assert.deepEqual(Object.keys(config.dimensions[0].calibration), [
    'calibrated', 'xMin', 'xMax', 'zMin', 'zMax', 'flipZ',
  ]);
  assert.equal(JSON.stringify(config).includes('imageMeta'), false);
});

test('toConfigJson：引用了不存在分组的路径点回落到 default', () => {
  const draft = createEmptyDraft();
  const dimension = draft.dimensions[0];
  dimension.groups = [{ id: 'base', name: '据点', color: '#5ad26f', visible: true }];
  dimension.waypoints = [
    { id: 'w', name: 'W', x: 0, z: 0, group: 'missing-group', icon: 'pin' },
  ];
  const config = toConfigJson(draft);
  assert.equal(config.dimensions[0].waypoints[0].group, 'default');
});

test('toConfigJson(createEmptyDraft()) 能通过站点 config.schema.json', (t) => {
  if (!siteSchemaAvailable) {
    t.skip('站点 config.schema.json 不存在');
    return;
  }
  const schema = JSON.parse(fs.readFileSync(SITE_SCHEMA, 'utf8'));
  const errors = validateSchema(toConfigJson(createEmptyDraft()), schema);
  assert.deepEqual(errors, []);
});

test('toConfigJson(normalizeDraft(站点 config.json)) 能通过站点 config.schema.json', (t) => {
  if (!siteConfigAvailable || !siteSchemaAvailable) {
    t.skip('站点仓库不可用');
    return;
  }
  const schema = JSON.parse(fs.readFileSync(SITE_SCHEMA, 'utf8'));
  const config = toConfigJson(normalizeDraft(readSiteConfig()).draft);
  const errors = validateSchema(config, schema);
  assert.deepEqual(errors, []);
});

test('迷你 schema 校验器自身有效：能发现类型 / 必需字段 / 枚举错误', (t) => {
  if (!siteSchemaAvailable) {
    t.skip('站点 config.schema.json 不存在');
    return;
  }
  const schema = JSON.parse(fs.readFileSync(SITE_SCHEMA, 'utf8'));
  assert.ok(validateSchema({}, schema).length > 0, '缺少 dimensions 应报错');
  assert.ok(validateSchema({ dimensions: [] }, schema).length === 0, 'dimensions 为空数组在 schema 层面合法');
  assert.ok(
    validateSchema({ dimensions: [{ id: 1, name: 'x', image: 'a.png' }] }, schema).length > 0,
    '维度 id 不是字符串应报错',
  );
  assert.ok(
    validateSchema(
      {
        version: 2,
        dimensions: [{ id: 'a', name: 'x', image: 'a.png' }],
      },
      schema,
    ).length > 0,
    'version 不是 1 应报错',
  );
  assert.ok(
    validateSchema(
      {
        dimensions: [
          {
            id: 'a',
            name: 'x',
            image: 'a.png',
            calibration: { flipZ: 'no' },
          },
        ],
      },
      schema,
    ).length > 0,
    'flipZ 不是布尔应报错',
  );
});

/* ========================================================================== */
/* 4. normalizeDraft 容错                                                      */
/* ========================================================================== */

test('normalizeDraft：字符串数字 / 缺分组 / 重复 id / 未知字段都能降级处理', () => {
  const raw = {
    version: 1,
    site: { title: 'T' },
    defaultDimension: 'missing-dim',
    ui: { labelMode: 'weird', grid: 'yes' },
    dimensions: [
      {
        id: 'dup',
        name: '维度 A',
        image: 'a.png',
        foo: 'bar',
        calibration: {
          calibrated: 'true',
          xMin: '-10',
          xMax: '10',
          zMin: '-20',
          zMax: '20',
          flipZ: 'true',
          note: 'n',
          extra: 1,
        },
        groups: [
          { id: 'g', name: 'G', color: '#123456' },
          { id: 'g', name: 'G2' },
        ],
        waypoints: [
          { id: 'p', name: 'P1', x: '12.5', y: '64', z: '-3', group: 'nope', foo: 1 },
          { id: 'p', name: 'P2', x: 1, z: 2 },
          { name: 'P3' },
        ],
      },
      { id: 'dup', name: '维度 B', image: 'b.png', groups: [], waypoints: [] },
    ],
  };

  const { draft, warnings } = normalizeDraft(raw);

  // 维度 id 去重、defaultDimension 回落到第一个维度
  assert.equal(draft.dimensions[0].id, 'dup');
  assert.equal(draft.dimensions[1].id, 'dup-2');
  assert.equal(draft.defaultDimension, 'dup');

  // ui 非法值回落默认
  assert.equal(draft.ui.labelMode, 'hover');
  assert.equal(draft.ui.grid, false);

  // 字符串数字 / 字符串布尔
  const calibration = draft.dimensions[0].calibration;
  assert.equal(calibration.xMin, -10);
  assert.equal(calibration.xMax, 10);
  assert.equal(calibration.flipZ, true);
  assert.equal(calibration.calibrated, true);
  assert.equal(calibration.note, 'n');

  // 分组 id 重复改名；缺失分组自动补 default 并归入
  assert.deepEqual(draft.dimensions[0].groups.map((group) => group.id), ['g', 'g-2', 'default']);
  assert.ok(draft.dimensions[0].groups.some((group) => group.id === 'default'));

  // 路径点
  const waypoints = draft.dimensions[0].waypoints;
  assert.equal(waypoints[0].x, 12.5);
  assert.equal(waypoints[0].y, 64);
  assert.equal(waypoints[0].z, -3);
  assert.equal(waypoints[0].group, 'default');
  assert.equal(waypoints[1].id, 'p-2');
  assert.equal(waypoints[2].x, null, '缺 x/z 的路径点应保留为空值而不是丢弃');
  assert.equal(waypoints[2].z, null);

  // 未知字段被忽略
  assert.equal('foo' in draft.dimensions[0], false);
  assert.equal('foo' in waypoints[0], false);
  assert.equal('extra' in calibration, false);

  // 关键 warning 文案
  assert.ok(warnings.some((warning) => warning.includes('维度 id 重复')));
  assert.ok(warnings.some((warning) => warning.includes('分组 id 重复')));
  assert.ok(warnings.some((warning) => warning.includes('路径点 id 重复')));
  assert.ok(warnings.some((warning) => warning.includes('不存在的分组')));
  assert.ok(warnings.some((warning) => warning.includes('defaultDimension')));
  assert.ok(warnings.some((warning) => warning.includes('labelMode')));
});

test('normalizeDraft：垃圾输入不抛异常，总能得到可用的草稿', () => {
  const inputs = [
    null,
    undefined,
    42,
    'not json',
    [],
    { dimensions: 'nope' },
    { dimensions: [null, 5, {}] },
    { site: 1, ui: [], dimensions: [{}] },
  ];
  for (const input of inputs) {
    let result;
    assert.doesNotThrow(() => {
      result = normalizeDraft(input);
    }, `normalizeDraft(${JSON.stringify(input)}) 不应抛异常`);
    assert.ok(result && result.draft, '应返回 draft');
    assert.ok(Array.isArray(result.warnings), '应返回 warnings 数组');
    assert.ok(Array.isArray(result.draft.dimensions));
    assert.ok(result.draft.dimensions.length >= 1);
    assert.equal(typeof result.draft.dimensions[0].id, 'string');
    assert.ok(Array.isArray(result.draft.dimensions[0].groups));
    assert.ok(Array.isArray(result.draft.dimensions[0].waypoints));
  }
});

test('normalizeDraft：路径点字符串坐标能转成数字，分组缺失自动补 default', () => {
  const raw = {
    dimensions: [
      {
        id: 'd',
        name: 'D',
        image: 'd.png',
        calibration: { xMin: 0, xMax: 1, zMin: 0, zMax: 1 },
        waypoints: [
          { id: 'w1', name: 'W1', x: '64', z: '-32' },
          { id: 'w2', name: 'W2', x: '1.5', z: '2.5', group: 'default' },
        ],
      },
    ],
  };
  const { draft } = normalizeDraft(raw);
  assert.equal(draft.dimensions[0].waypoints[0].x, 64);
  assert.equal(draft.dimensions[0].waypoints[0].z, -32);
  assert.equal(draft.dimensions[0].waypoints[0].group, 'default');
  assert.equal(draft.dimensions[0].waypoints[1].x, 1.5);
  assert.ok(draft.dimensions[0].groups.some((group) => group.id === 'default'));
});

/* ========================================================================== */
/* 5. validateDraft                                                           */
/* ========================================================================== */

test('validateDraft：合法草稿没有任何 error / warning', () => {
  const result = validateDraft(makeValidDraft(), makeCtx());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.errors.every((issue) => issue.level === 'error'), true);
});

test('validateDraft：缺 id / 重复 id / 非数字坐标 / 分组不存在 → error 或 warning，path 正确', () => {
  const draft = makeValidDraft();
  const dimension = draft.dimensions[0];
  dimension.waypoints = [
    { ...dimension.waypoints[0] },
    { ...dimension.waypoints[0], id: 'second' },
    { ...dimension.waypoints[0], id: 'third' },
  ];

  // 缺 id
  delete dimension.waypoints[0].id;
  // 重复 id
  dimension.waypoints[1].id = 'third';
  // x 非数字、z 缺失
  dimension.waypoints[1].x = 'abc';
  dimension.waypoints[1].z = null;
  // 分组不存在
  dimension.waypoints[2].group = 'missing-group';

  const result = validateDraft(draft, makeCtx());
  const { errors, warnings } = result;

  assert.ok(hasIssue(errors, 'dimensions[0].waypoints[0].id', 'id 不能为空'));
  assert.ok(hasIssue(errors, 'dimensions[0].waypoints[2].id', 'id 重复'));
  assert.ok(hasIssue(errors, 'dimensions[0].waypoints[1].x', 'X 坐标'));
  assert.ok(hasIssue(errors, 'dimensions[0].waypoints[1].z', 'Z 坐标'));
  assert.ok(hasIssue(warnings, 'dimensions[0].waypoints[2].group', '不存在'));
  assert.equal(errors.every((issue) => issue.level === 'error'), true);
  assert.equal(warnings.every((issue) => issue.level === 'warning'), true);
});

test('validateDraft：画幅倒置 / 四边界缺失 → error，path 指向 calibration', () => {
  const inverted = makeValidDraft();
  inverted.dimensions[0].calibration.xMax = -200; // < xMin
  inverted.dimensions[0].calibration.zMax = -200;
  const result = validateDraft(inverted, makeCtx());
  assert.ok(hasIssue(result.errors, 'dimensions[0].calibration.xMax', '倒置'));
  assert.ok(hasIssue(result.errors, 'dimensions[0].calibration.zMax', '倒置'));

  const incomplete = makeValidDraft();
  incomplete.dimensions[0].calibration.xMin = null;
  const incompleteResult = validateDraft(incomplete, makeCtx());
  assert.ok(hasIssue(incompleteResult.errors, 'dimensions[0].calibration'));

  const missing = makeValidDraft();
  missing.dimensions[0].calibration = null;
  const missingResult = validateDraft(missing, makeCtx());
  assert.ok(hasIssue(missingResult.errors, 'dimensions[0].calibration'));
});

test('validateDraft：calibrated=false / 缺图 / 空分组 / 坏颜色 / defaultDimension 的提示', () => {
  const draft = makeValidDraft();
  const dimension = draft.dimensions[0];
  dimension.calibration.calibrated = false;
  dimension.groups.push({ id: 'empty-group', name: '空分组', color: '#123456', visible: true });
  dimension.groups[0].color = 'green';
  draft.defaultDimension = 'not-there';

  const result = validateDraft(draft, { imageNames: ['other.png'], imageSizeOf: () => null });
  const { errors, warnings } = result;

  assert.ok(hasIssue(warnings, 'dimensions[0].calibration.calibrated', '已校准'));
  assert.ok(hasIssue(warnings, 'dimensions[0].image', '地图还没上传'));
  assert.ok(
    warnings.some((issue) => issue.path === 'dimensions[0].groups[1]' && issue.message.includes('还没有路径点')),
  );
  assert.ok(hasIssue(errors, 'dimensions[0].groups[0].color', '#rrggbb'));
  assert.ok(hasIssue(warnings, 'defaultDimension', '默认维度'));
});

test('validateDraft：维度为空 / 维度 id 重复 / image 为空 / name 为空 → error', () => {
  const empty = validateDraft({ ...makeValidDraft(), dimensions: [] }, makeCtx());
  assert.ok(hasIssue(empty.errors, 'dimensions'));

  const draft = makeValidDraft();
  draft.dimensions.push({ ...makeValidDraft().dimensions[0] });
  draft.dimensions[0].image = '';
  draft.dimensions[0].name = '';
  const result = validateDraft(draft, makeCtx());
  assert.ok(hasIssue(result.errors, 'dimensions[1].id', '重复'));
  assert.ok(hasIssue(result.errors, 'dimensions[0].image'));
  assert.ok(hasIssue(result.errors, 'dimensions[0].name'));
});

test('validateDraft：画幅比例与图片像素比例差太多时给 warning', () => {
  const draft = makeValidDraft();
  // 图片 200×200，但 X 跨度 200、Z 跨度 100 → X/Z 每像素差 2 倍
  draft.dimensions[0].calibration.zMax = 0;
  const result = validateDraft(draft, makeCtx());
  assert.ok(
    result.warnings.some(
      (issue) => issue.path === 'dimensions[0].calibration' && issue.message.includes('比例'),
    ),
  );
});

test('validateDraft：对坏数据不抛异常', () => {
  const inputs = [null, undefined, {}, { dimensions: 'x' }, { dimensions: [null] }];
  for (const input of inputs) {
    assert.doesNotThrow(() => validateDraft(input, makeCtx()), `validateDraft(${JSON.stringify(input)})`);
    const result = validateDraft(input, makeCtx());
    assert.ok(Array.isArray(result.errors));
    assert.ok(Array.isArray(result.warnings));
  }
});

/* ========================================================================== */
/* 6. nextId / createXxx / duplicateWaypoint                                  */
/* ========================================================================== */

test('nextId：base、base-2、base-3… 递增且避开已占用 id', () => {
  assert.equal(nextId([], 'wp'), 'wp');
  assert.equal(nextId(['wp'], 'wp'), 'wp-2');
  assert.equal(nextId(['wp'], 'wp'), 'wp-2');
  assert.equal(nextId([{ id: 'wp' }, { id: 'wp-2' }], 'wp'), 'wp-3');
  assert.equal(nextId(['wp', 'wp-2', 'wp-3'], 'wp'), 'wp-4');
  assert.equal(nextId(new Set(['a']), 'a'), 'a-2');
  assert.equal(nextId(new Map([['b', 1]]), 'b'), 'b-2');
  assert.equal(nextId([], ''), 'item');
  assert.equal(nextId([], null), 'item');
  assert.equal(nextId('not-a-collection', 'x'), 'x');
});

test('uniqueWaypointId：维度内递增不冲突', () => {
  const draft = createEmptyDraft();
  const dimensionId = draft.dimensions[0].id;
  assert.equal(uniqueWaypointId(draft, dimensionId, 'wp'), 'wp');

  const first = createWaypoint(draft, dimensionId, { name: 'A' });
  const second = createWaypoint(draft, dimensionId, { name: 'B' });
  assert.equal(first.id, 'wp');
  assert.equal(second.id, 'wp-2');
  assert.equal(uniqueWaypointId(draft, dimensionId, 'wp'), 'wp-3');

  const ids = draft.dimensions[0].waypoints.map((waypoint) => waypoint.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('createWaypoint：补默认分组 / 图标，字符串坐标转数字，可预填字段', () => {
  const draft = createEmptyDraft();
  const dimensionId = draft.dimensions[0].id;
  const waypoint = createWaypoint(draft, dimensionId, {
    name: '测试点',
    x: '12.5',
    y: '64',
    z: '-3',
    icon: 'farm',
  });
  assert.equal(waypoint.name, '测试点');
  assert.equal(waypoint.x, 12.5);
  assert.equal(waypoint.y, 64);
  assert.equal(waypoint.z, -3);
  assert.equal(waypoint.group, 'default');
  assert.equal(waypoint.icon, 'farm');
  assert.equal(draft.dimensions[0].waypoints.length, 1);
  assert.equal(draft.dimensions[0].waypoints[0], waypoint);
});

test('createGroup / createDimension：自动 id、默认值与追加', () => {
  const draft = createEmptyDraft();
  const dimensionId = draft.dimensions[0].id;

  const group = createGroup(draft, dimensionId, { name: '新据点' });
  assert.equal(group.id, 'group');
  assert.equal(group.name, '新据点');
  assert.match(group.color, /^#[0-9a-f]{6}$/i);
  assert.equal(group.visible, true);
  assert.equal(createGroup(draft, dimensionId, {}).id, 'group-2');

  const dimension = createDimension(draft, { name: '下界' });
  assert.equal(dimension.id, 'dimension');
  assert.equal(dimension.name, '下界');
  assert.equal(dimension.image, '');
  assert.equal(dimension.groups.length, 1);
  assert.equal(dimension.groups[0].id, 'default');
  assert.deepEqual(dimension.waypoints, []);
  assert.deepEqual(dimension.imageMeta, { width: null, height: null, missing: true });
  assert.equal(draft.dimensions.length, 2);
  assert.equal(createDimension(draft, {}).id, 'dimension-2');

  // id 已存在时给显式 id 也保证唯一
  const explicit = createGroup(draft, dimensionId, { id: 'default', name: '重复默认' });
  assert.equal(explicit.id, 'default-2');
});

test('duplicateWaypoint：复制后 id 唯一、名称带「副本」、插在原路径点后面', () => {
  const draft = createEmptyDraft();
  const dimensionId = draft.dimensions[0].id;
  const source = createWaypoint(draft, dimensionId, { name: '出生点', x: 10, y: 65, z: 20, icon: 'spawn' });
  createWaypoint(draft, dimensionId, { name: '其他点', x: 0, z: 0 });

  const copy = duplicateWaypoint(draft, dimensionId, source.id);
  assert.ok(copy);
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.id, 'wp-copy');
  assert.ok(copy.name.includes('副本'));
  assert.equal(copy.x, source.x);
  assert.equal(copy.y, source.y);
  assert.equal(copy.z, source.z);
  assert.equal(copy.group, source.group);
  assert.equal(copy.icon, source.icon);

  const ids = draft.dimensions[0].waypoints.map((waypoint) => waypoint.id);
  assert.equal(ids.indexOf(copy.id), ids.indexOf(source.id) + 1);
  assert.equal(new Set(ids).size, ids.length);

  // 再复制一次也不会撞 id
  const copy2 = duplicateWaypoint(draft, dimensionId, source.id);
  assert.equal(copy2.id, 'wp-copy-2');
  assert.equal(duplicateWaypoint(draft, dimensionId, 'nope'), null);
});

/* ========================================================================== */
/* 7. 图标                                                                     */
/* ========================================================================== */

test('resolveIcon：已知 key → emoji；1~2 字符原样；未知 → pin', () => {
  assert.equal(resolveIcon('pin'), ICONS.pin);
  assert.equal(resolveIcon('end'), ICONS.end);
  assert.equal(resolveIcon('farm'), ICONS.farm);
  assert.equal(resolveIcon('🌋'), '🌋');
  assert.equal(resolveIcon('AB'), 'AB');
  assert.equal(resolveIcon('nope'), ICONS.pin);
  assert.equal(resolveIcon('a-very-long-key'), ICONS.pin);
  assert.equal(resolveIcon(''), ICONS.pin);
  assert.equal(resolveIcon('   '), ICONS.pin);
  assert.equal(resolveIcon(null), ICONS.pin);
  assert.equal(resolveIcon(undefined), ICONS.pin);
  assert.equal(resolveIcon(42), ICONS.pin);
});

test('ICONS：与站点 assets/js/markers.js 的图标表逐项相等', async (t) => {
  if (!fs.existsSync(SITE_MARKERS)) {
    t.skip('站点 markers.js 不存在');
    return;
  }

  let siteIcons = null;
  try {
    // 站点 markers.js 是 ESM，无 DOM 顶层副作用，可以在 Node 下直接 import
    const module = await import(pathToFileURL(SITE_MARKERS).href);
    if (module && module.ICONS) siteIcons = module.ICONS;
  } catch {
    siteIcons = null;
  }
  if (!siteIcons) {
    // 兜底：用 fs + 正则解析 export const ICONS = Object.freeze({...})
    const source = fs.readFileSync(SITE_MARKERS, 'utf8');
    const block = /export const ICONS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(source);
    if (!block) {
      t.skip('无法解析站点 markers.js 的 ICONS');
      return;
    }
    siteIcons = {};
    for (const match of block[1].matchAll(/([A-Za-z0-9_-]+)\s*:\s*'([^']*)'/g)) {
      siteIcons[match[1]] = match[2];
    }
  }

  assert.deepEqual(ICONS, siteIcons);
  assert.deepEqual(Object.keys(ICONS), Object.keys(siteIcons));
  assert.deepEqual(ICON_KEYS, Object.keys(siteIcons));
  for (const key of ICON_KEYS) {
    assert.equal(resolveIcon(key), siteIcons[key], `图标 ${key} 的 emoji 不一致`);
  }
});

test('iconLabel：已知 key 给出 emoji + 中文文案', () => {
  assert.ok(iconLabel('farm').includes(ICONS.farm));
  assert.ok(iconLabel('farm').includes('农场'));
  assert.ok(iconLabel('pin').includes('图钉'));
  assert.ok(iconLabel('').length > 0);
  assert.ok(iconLabel('🌋').length > 0);
  assert.ok(iconLabel('unknown-key').length > 0);
});

/* ========================================================================== */
/* 8. 搜索匹配                                                                 */
/* ========================================================================== */

test('waypointMatchesQuery：名称 / 描述 / 坐标文本 / 两数字前缀 / 无匹配', () => {
  const diamondMine = {
    id: 'diamond-mine',
    name: '钻石矿洞',
    description: 'Y = -54 主矿区的入口。',
    x: -512,
    y: -54,
    z: 640,
  };

  // 名称命中（忽略大小写）
  assert.equal(waypointMatchesQuery(diamondMine, '钻石'), true);
  assert.equal(waypointMatchesQuery({ name: 'Spawn Point', x: 0, z: 0 }, 'spawn'), true);
  // 描述命中
  assert.equal(waypointMatchesQuery(diamondMine, '矿区'), true);
  // "x z" 坐标文本命中
  assert.equal(waypointMatchesQuery(diamondMine, '-512 640'), true);
  assert.equal(waypointMatchesQuery(diamondMine, '-512'), true);
  // 两数字前缀匹配
  assert.equal(waypointMatchesQuery({ name: '城堡', x: 420, z: 180 }, '42 18'), true);
  assert.equal(waypointMatchesQuery({ name: '城堡', x: 420, z: 180 }, '420 180'), true);
  assert.equal(waypointMatchesQuery({ name: '城堡', x: 420, z: 180 }, '42 19'), false);
  assert.equal(waypointMatchesQuery(diamondMine, '-5120 6400'), false);
  // 空查询不过滤
  assert.equal(waypointMatchesQuery(diamondMine, ''), true);
  assert.equal(waypointMatchesQuery(diamondMine, '   '), true);
  // 无匹配
  assert.equal(waypointMatchesQuery(diamondMine, '不存在的地方'), false);
  // 坏数据安全
  assert.equal(waypointMatchesQuery(null, 'x'), false);
  assert.equal(waypointMatchesQuery({ id: 'no-coords' }, '1 2'), false);
});

/* ========================================================================== */
/* 9. 查询工具                                                                 */
/* ========================================================================== */

test('dimensionById / waypointById：命中与未命中', () => {
  const draft = createEmptyDraft();
  const dimension = draft.dimensions[0];
  const waypoint = createWaypoint(draft, dimension.id, { name: 'A' });

  assert.equal(dimensionById(draft, 'overworld'), dimension);
  assert.equal(dimensionById(draft, 'nope'), null);
  assert.equal(dimensionById(null, 'overworld'), null);
  assert.equal(waypointById(dimension, waypoint.id), waypoint);
  assert.equal(waypointById(dimension, 'nope'), null);
  assert.equal(waypointById(null, 'x'), null);
});

/* ========================================================================== */
/* 10. 瓦片底图字段 tiles（站点 schema：object 或 string）                      */
/* ========================================================================== */

test('normalizeDraft：保留站点 config.json 的 tiles（对象写法）', { skip: !siteConfigAvailable }, () => {
  const source = readSiteConfig();
  const original = source.dimensions.find((dim) => dim.id === 'overworld');
  const { draft, warnings } = normalizeDraft(source);
  const overworld = dimensionById(draft, 'overworld');
  assert.ok(overworld, '应能规范化出 overworld 维度');
  assert.deepEqual(overworld.tiles, original.tiles);
  assert.equal(overworld.image, original.image);
  assert.equal(warnings.length, 0, `真实站点配置不应产生 warning：${JSON.stringify(warnings)}`);

  const exported = toConfigJson(draft);
  assert.deepEqual(dimensionById(exported, 'overworld').tiles, original.tiles);
  const roundTrip = normalizeDraft(exported).draft;
  assert.deepEqual(dimensionById(roundTrip, 'overworld').tiles, original.tiles);
});

test('normalizeDraft：tiles 支持字符串简写，非法值降级为 null 并给 warning', () => {
  const base = createEmptyDraft();
  const raw = {
    ...base,
    dimensions: [
      { ...base.dimensions[0], tiles: ' tiles/manifest.json ' },
      { ...base.dimensions[0], id: 'dim-b', tiles: { manifest: '   ' } },
      { ...base.dimensions[0], id: 'dim-c', tiles: 42 },
    ],
  };
  const { draft, warnings } = normalizeDraft(raw);
  assert.deepEqual(draft.dimensions[0].tiles, { manifest: 'tiles/manifest.json' });
  assert.equal(draft.dimensions[1].tiles, null);
  assert.equal(draft.dimensions[2].tiles, null);
  assert.ok(warnings.some((w) => w.includes('tiles')), '非法 tiles 应给出提示');
});

test('toConfigJson：tiles 在 image 之后、只在配置时输出', () => {
  const draft = createEmptyDraft();
  const dim = draft.dimensions[0];
  dim.image = '主世界.png';
  dim.tiles = { manifest: 'tiles/manifest.json' };
  dim.calibration = { calibrated: true, xMin: -10, xMax: 10, zMin: -10, zMax: 10, flipZ: false, note: '' };

  const withTiles = toConfigJson(draft);
  assert.deepEqual(Object.keys(withTiles.dimensions[0]), [
    'id', 'name', 'image', 'tiles', 'calibration', 'groups', 'waypoints',
  ]);
  assert.deepEqual(withTiles.dimensions[0].tiles, { manifest: 'tiles/manifest.json' });

  const single = toConfigJson({ ...draft, dimensions: [{ ...dim, tiles: null }] });
  assert.equal('tiles' in single.dimensions[0], false, '单图维度不应输出 tiles 字段');
});

test('validateDraft：tiles.manifest 为空 → error；瓦片维度不再要求「已校准」', () => {
  const draft = createEmptyDraft();
  const dim = draft.dimensions[0];
  dim.image = '主世界.png';
  dim.tiles = { manifest: '' };
  dim.calibration = { calibrated: false, xMin: -10, xMax: 10, zMin: -10, zMax: 10, flipZ: false, note: '' };

  const bad = validateDraft(draft);
  assert.ok(bad.errors.some((e) => e.path === 'dimensions[0].tiles.manifest' && e.level === 'error'));

  dim.tiles = { manifest: 'tiles/manifest.json' };
  const ok = validateDraft(draft);
  assert.equal(ok.errors.filter((e) => e.path.startsWith('dimensions[0].tiles')).length, 0);
  assert.equal(
    ok.warnings.filter((w) => w.path === 'dimensions[0].calibration.calibrated').length,
    0,
    '瓦片维度不应再提示画幅未校准',
  );
});


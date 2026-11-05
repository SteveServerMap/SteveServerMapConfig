/**
 * merge-core 单元测试
 * 运行：node --test tests/merge-core.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TILE,
  calibrationFromOrigin,
  calibrationFromBounds,
  worldToPixel,
  pixelToWorld,
  resampleToBase,
  analyzeDiff,
  composeMerged,
  renderOverlay,
} from '../assets/js/merge-core.js';

/* ------------------------------------------------------------------ */
/* 工具：造图                                                          */
/* ------------------------------------------------------------------ */

/** 生成一张 RGBA 图：默认全黑不透明 */
function makeImage(width, height, cal, fill = [0, 0, 0, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  }
  return { data, width, height, cal };
}

/** 在图上按像素矩形填色 */
function paint(image, x0, y0, x1, y1, color) {
  const { data, width } = image;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = color[3] ?? 255;
    }
  }
  return image;
}

/** 取某世界坐标处（四舍五入到像素）的 RGBA */
function sampleAtWorld(image, cal, x, z) {
  const { px, py } = worldToPixel(cal, x, z);
  const ix = Math.min(image.width - 1, Math.max(0, Math.round(px)));
  const iy = Math.min(image.height - 1, Math.max(0, Math.round(py)));
  const i = (iy * image.width + ix) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

/* ------------------------------------------------------------------ */
/* 1. 校准                                                             */
/* ------------------------------------------------------------------ */

test('calibrationFromOrigin：原点在左上、1 像素 1 方块时四边界正确', () => {
  const cal = calibrationFromOrigin({ originPx: 0, originPy: 0, pxPerBlock: 1, imageWidth: 100, imageHeight: 50 });
  assert.equal(cal.xMin, 0);
  assert.equal(cal.xMax, 100);
  assert.equal(cal.zMin, 0);
  assert.equal(cal.zMax, 50);
  assert.equal(cal.pxPerBlock, 1);
  assert.equal(cal.blocksPerPixel, 1);
});

test('calibrationFromOrigin：原点落在图中间 + 每方块 2 像素', () => {
  const cal = calibrationFromOrigin({ originPx: 100, originPy: 80, pxPerBlock: 2, imageWidth: 200, imageHeight: 160 });
  // 每像素 0.5 方块 → 半宽 50 方块、半高 40 方块
  assert.equal(cal.xMin, -50);
  assert.equal(cal.xMax, 50);
  assert.equal(cal.zMin, -40);
  assert.equal(cal.zMax, 40);
});

test('calibrationFromOrigin：flipZ 时原点以 +Z 在上为基准', () => {
  const cal = calibrationFromOrigin({ originPx: 0, originPy: 60, pxPerBlock: 1, imageWidth: 100, imageHeight: 120, flipZ: true });
  assert.equal(cal.flipZ, true);
  assert.equal(cal.zMax, 60); // 图片顶部 = +60
  assert.equal(cal.zMin, -60);
  // z=0 应该落在 py=60 处
  assert.equal(Math.round(worldToPixel(cal, 0, 0).py), 60);
});

test('calibrationFromOrigin：非法参数返回 null 且不抛错', () => {
  assert.equal(calibrationFromOrigin({ originPx: 0, originPy: 0, pxPerBlock: 0, imageWidth: 10, imageHeight: 10 }), null);
  assert.equal(calibrationFromOrigin({}), null);
  assert.equal(calibrationFromOrigin(), null);
});

test('calibrationFromBounds：与 origin 正反算一致（含 flipZ）', () => {
  for (const flipZ of [false, true]) {
    const origin = calibrationFromOrigin({ originPx: 123, originPy: 456, pxPerBlock: 1.5, imageWidth: 800, imageHeight: 600, flipZ });
    const bounds = calibrationFromBounds({ ...origin, imageWidth: 800, imageHeight: 600 });
    assert.ok(Math.abs(bounds.xMin - origin.xMin) < 1e-6, 'xMin');
    assert.ok(Math.abs(bounds.xMax - origin.xMax) < 1e-6, 'xMax');
    assert.ok(Math.abs(bounds.zMin - origin.zMin) < 1e-6, 'zMin');
    assert.ok(Math.abs(bounds.zMax - origin.zMax) < 1e-6, 'zMax');
    assert.equal(bounds.flipZ, flipZ);
    // 世界 (0,0) 反解回像素应等于原始 origin
    const p = worldToPixel(bounds, 0, 0);
    assert.ok(Math.abs(p.px - 123) < 1e-6);
    assert.ok(Math.abs(p.py - 456) < 1e-6);
  }
});

test('pixelToWorld / worldToPixel：往返一致', () => {
  const cal = calibrationFromOrigin({ originPx: 50, originPy: 70, pxPerBlock: 2, imageWidth: 400, imageHeight: 300 });
  for (const [px, py] of [[0, 0], [399, 299], [200, 150], [13.5, 7.25]]) {
    const world = pixelToWorld(cal, px, py);
    const back = worldToPixel(cal, world.x, world.z);
    assert.ok(Math.abs(back.px - px) < 1e-6, `px ${px}`);
    assert.ok(Math.abs(back.py - py) < 1e-6, `py ${py}`);
  }
});

test('calibrationFromBounds：非法参数返回 null', () => {
  assert.equal(calibrationFromBounds({ xMin: 0, xMax: 0, zMin: 0, zMax: 10, imageWidth: 10, imageHeight: 10 }), null);
  assert.equal(calibrationFromBounds({}), null);
});

/* ------------------------------------------------------------------ */
/* 2. 重采样                                                           */
/* ------------------------------------------------------------------ */

test('resampleToBase：完全重叠 + 同校准时像素一一对应', () => {
  const cal = calibrationFromOrigin({ originPx: 0, originPy: 0, pxPerBlock: 1, imageWidth: 32, imageHeight: 32 });
  const base = makeImage(32, 32, cal);
  const incoming = makeImage(32, 32, cal);
  paint(incoming, 4, 4, 8, 8, [255, 0, 0, 255]);
  const out = resampleToBase({ base, incoming });
  assert.equal(out.width, 32);
  assert.equal(out.height, 32);
  assert.deepEqual(sampleAtWorld(out, cal, 5, 5), [255, 0, 0, 255]);
  assert.deepEqual(sampleAtWorld(out, cal, 20, 20), [0, 0, 0, 255]);
  assert.ok(out.coverage, '应报告覆盖范围');
});

test('resampleToBase：新图分辨率是目标的 2 倍且原点偏移，仍能对齐', () => {
  // base：1 像素 1 方块，世界 -16..16
  const baseCal = calibrationFromOrigin({ originPx: 16, originPy: 16, pxPerBlock: 1, imageWidth: 32, imageHeight: 32 });
  const base = makeImage(32, 32, baseCal);
  // incoming：2 倍分辨率（64px，每方块 2 像素），原点在像素 32 → 世界 -16..16，与 base 完全同范围
  const incCal = calibrationFromOrigin({ originPx: 32, originPy: 32, pxPerBlock: 2, imageWidth: 64, imageHeight: 64 });
  assert.equal(incCal.xMin, -16);
  assert.equal(incCal.xMax, 16);
  const incoming = makeImage(64, 64, incCal);
  // 在 incoming 里把世界 [-8,-4) 涂红：像素 = (x+16)/0.5 → 16..24
  paint(incoming, 16, 16, 24, 24, [255, 0, 0, 255]);

  const out = resampleToBase({ base, incoming });
  // base 世界 (-6,-6) 落在红块内
  assert.deepEqual(sampleAtWorld(out, baseCal, -6, -6), [255, 0, 0, 255]);
  // base 世界 (12,12) 在红块外 → 黑
  assert.deepEqual(sampleAtWorld(out, baseCal, 12, 12), [0, 0, 0, 255]);
});

test('resampleToBase：完全不重叠时输出全透明且 coverage=null', () => {
  const baseCal = calibrationFromOrigin({ originPx: 0, originPy: 0, pxPerBlock: 1, imageWidth: 16, imageHeight: 16 });
  const incCal = calibrationFromOrigin({ originPx: 0, originPy: 0, pxPerBlock: 1, imageWidth: 16, imageHeight: 16 });
  const base = makeImage(16, 16, baseCal);
  const incoming = makeImage(16, 16, incCal);
  // 把 incoming 的世界范围挪到很远
  incoming.cal = { ...incCal, xMin: 1000, xMax: 1016, zMin: 1000, zMax: 1016 };
  const out = resampleToBase({ base, incoming });
  assert.equal(out.coverage, null);
  for (let i = 3; i < out.data.length; i += 4) assert.equal(out.data[i], 0, '应全透明');
});

test('resampleToBase：非法输入返回空图不抛错', () => {
  const out = resampleToBase({ base: null, incoming: null });
  assert.equal(out.data.length, 0);
  assert.equal(out.coverage, null);
});

/* ------------------------------------------------------------------ */
/* 3. 差异分析                                                         */
/* ------------------------------------------------------------------ */

function buildClassCase() {
  // 64×64，tile 16 → 4×4 个 tile；世界 -32..32
  const cal = calibrationFromOrigin({ originPx: 32, originPy: 32, pxPerBlock: 1, imageWidth: 64, imageHeight: 64 });
  const base = makeImage(64, 64, cal);
  const incoming = makeImage(64, 64, cal);
  paint(base, 0, 0, 16, 16, [255, 0, 0, 255]); // 左上 tile：onlyBase（incoming 那里是黑）
  paint(base, 16, 0, 32, 16, [0, 0, 255, 255]); // 上方第二格：两边同色 → same
  paint(incoming, 16, 0, 32, 16, [0, 0, 255, 255]);
  paint(incoming, 32, 0, 48, 16, [0, 255, 0, 255]); // 右上：onlyIncoming（base 黑）
  paint(base, 48, 32, 64, 48, [10, 10, 10, 255]); // 右下：两边都有但色差大 → changed
  paint(incoming, 48, 32, 64, 48, [200, 200, 200, 255]);
  return { cal, base, incoming };
}

test('analyzeDiff：四类分类正确（onlyBase / onlyIncoming / changed / same + void）', () => {
  const { base, incoming } = buildClassCase();
  const a = analyzeDiff({ base, incoming, tileSize: 16 });
  assert.equal(a.cols, 4);
  assert.equal(a.rows, 4);
  assert.equal(a.map[0], TILE.ONLY_BASE, '左上应 onlyBase');
  assert.equal(a.map[1], TILE.SAME, '上方第二格应 same');
  assert.equal(a.map[2], TILE.ONLY_INCOMING, '右上应 onlyIncoming');
  assert.equal(a.map[3], TILE.VOID, '右上第三格应 void');
  assert.equal(a.map[11], TILE.CHANGED, '右下应 changed');
  assert.equal(a.counts.onlyBase, 1);
  assert.equal(a.counts.onlyIncoming, 1);
  assert.equal(a.counts.changed, 1);
  assert.equal(a.counts.same, 1);
  assert.equal(a.counts.void, 16 - 4);
});

test('analyzeDiff：阈值边界（色差刚好等于阈值 → same）', () => {
  const cal = calibrationFromOrigin({ originPx: 0, originPy: 0, pxPerBlock: 1, imageWidth: 16, imageHeight: 16 });
  const base = makeImage(16, 16, cal, [100, 100, 100, 255]);
  const incoming = makeImage(16, 16, cal, [124, 100, 100, 255]); // 色差正好 24
  const equal = analyzeDiff({ base, incoming, tileSize: 16, diffThreshold: 24 });
  assert.equal(equal.map[0], TILE.SAME, '等于阈值不判 changed');
  const below = analyzeDiff({ base, incoming, tileSize: 16, diffThreshold: 23 });
  assert.equal(below.map[0], TILE.CHANGED, '阈值调低后应判 changed');
});

test('analyzeDiff：空白亮度阈值生效', () => {
  const cal = calibrationFromOrigin({ originPx: 0, originPy: 0, pxPerBlock: 1, imageWidth: 16, imageHeight: 16 });
  const base = makeImage(16, 16, cal, [0, 0, 0, 255]);
  const incoming = makeImage(16, 16, cal, [10, 10, 10, 255]); // 亮度 10
  // 阈值 8 → incoming 有内容（lit>8）
  const a1 = analyzeDiff({ base, incoming, tileSize: 16, voidLuminance: 8 });
  assert.equal(a1.map[0], TILE.ONLY_INCOMING);
  // 阈值 20 → incoming 也算空白
  const a2 = analyzeDiff({ base, incoming, tileSize: 16, voidLuminance: 20 });
  assert.equal(a2.map[0], TILE.VOID);
});

test('analyzeDiff：面积按方块换算', () => {
  const { base, incoming } = buildClassCase();
  const a = analyzeDiff({ base, incoming, tileSize: 16 });
  // 每像素 1 方块、tile 16 → 每格 256 方块²
  assert.equal(a.blocksArea.onlyIncoming, 256);
  assert.equal(a.blocksArea.changed, 256);
});

test('analyzeDiff：尺寸不一致/缺数据时不抛错并返回空 map', () => {
  const cal = calibrationFromOrigin({ originPx: 0, originPy: 0, pxPerBlock: 1, imageWidth: 8, imageHeight: 8 });
  const a = analyzeDiff({ base: makeImage(8, 8, cal), incoming: makeImage(4, 4, cal) });
  assert.equal(a.map.length, a.cols * a.rows);
  assert.equal(a.counts.onlyIncoming, 0);
  assert.doesNotThrow(() => analyzeDiff({}));
});

/* ------------------------------------------------------------------ */
/* 4. 合成                                                             */
/* ------------------------------------------------------------------ */

test('composeMerged：fillNew 生效、updateChanged 关闭时保留目标图像素', () => {
  const { base, incoming } = buildClassCase();
  const analysis = analyzeDiff({ base, incoming, tileSize: 16 });

  const merged = composeMerged({ base, incoming, analysis, options: { fillNew: true, updateChanged: false } });
  assert.equal(merged.applied.filledTiles, 1);
  assert.equal(merged.applied.updatedTiles, 0);
  // 新增区域（tile 2,0：像素 x 32..48 / y 0..16 → 世界 x 0..16 / z -32..-16）应变成绿色
  assert.deepEqual(sampleAtWorld(merged, base.cal, 8, -24), [0, 255, 0, 255]);
  // changed 区域（tile 3,2：世界 x 16..32 / z 0..16）应保留 base 的深灰
  assert.deepEqual(sampleAtWorld(merged, base.cal, 24, 8), [10, 10, 10, 255]);
});

test('composeMerged：fillNew 关闭时与目标图完全一致', () => {
  const { base, incoming } = buildClassCase();
  const analysis = analyzeDiff({ base, incoming, tileSize: 16 });
  const merged = composeMerged({ base, incoming, analysis, options: { fillNew: false, updateChanged: false } });
  assert.equal(merged.applied.filledTiles, 0);
  assert.deepEqual(Array.from(merged.data), Array.from(base.data));
});

test('composeMerged：updateChanged 开启时覆盖变更区域', () => {
  const { base, incoming } = buildClassCase();
  const analysis = analyzeDiff({ base, incoming, tileSize: 16 });
  const merged = composeMerged({ base, incoming, analysis, options: { fillNew: true, updateChanged: true } });
  assert.equal(merged.applied.updatedTiles, 1);
  assert.deepEqual(sampleAtWorld(merged, base.cal, 24, 8), [200, 200, 200, 255]);
});

test('composeMerged：incoming 透明处不挖空目标图', () => {
  const cal = calibrationFromOrigin({ originPx: 0, originPy: 0, pxPerBlock: 1, imageWidth: 16, imageHeight: 16 });
  const base = makeImage(16, 16, cal, [30, 30, 30, 255]);
  const incoming = makeImage(16, 16, cal, [0, 0, 0, 0]); // 全透明
  // 手工让这个 tile 判成 onlyIncoming
  const analysis = { width: 16, height: 16, tileSize: 16, cols: 1, rows: 1, map: Uint8Array.from([TILE.ONLY_INCOMING]) };
  const merged = composeMerged({ base, incoming, analysis, options: { fillNew: true, updateChanged: true } });
  assert.deepEqual(Array.from(merged.data.slice(0, 4)), [30, 30, 30, 255]);
});

test('composeMerged：坏参数不抛错', () => {
  assert.doesNotThrow(() => composeMerged({}));
  const out = composeMerged({ base: null, incoming: null, analysis: null });
  assert.equal(out.width, 0);
});

/* ------------------------------------------------------------------ */
/* 5. 叠加层                                                           */
/* ------------------------------------------------------------------ */

test('renderOverlay：尺寸与色块正确，未分类 tile 透明', () => {
  const { base, incoming } = buildClassCase();
  const analysis = analyzeDiff({ base, incoming, tileSize: 16 });
  const overlay = renderOverlay({ analysis });
  assert.equal(overlay.width, 64);
  assert.equal(overlay.height, 64);
  // 左上（onlyBase）应有半透明灰
  assert.ok(overlay.data[3] > 0, 'onlyBase 应着色');
  // 右上（onlyIncoming）绿
  const idxNew = (0 * 64 + 40) * 4;
  assert.deepEqual(Array.from(overlay.data.slice(idxNew, idxNew + 4)), [90, 210, 111, 150]);
  // void 区域透明
  const idxVoid = (0 * 64 + 60) * 4;
  assert.equal(overlay.data[idxVoid + 3], 0);
});

test('renderOverlay：空 analysis 不抛错', () => {
  const o = renderOverlay({});
  assert.equal(o.width, 0);
});

/* ------------------------------------------------------------------ */
/* 6. 端到端小场景（重采样 + 分析 + 合成串联）                          */
/* ------------------------------------------------------------------ */

test('串联：base 只有红块，incoming 有红块 + 远处绿块 → 合并不动红块、补上绿块', () => {
  const baseCal = calibrationFromOrigin({ originPx: 16, originPy: 16, pxPerBlock: 1, imageWidth: 32, imageHeight: 32 });
  const incCal = calibrationFromOrigin({ originPx: 16, originPy: 16, pxPerBlock: 1, imageWidth: 64, imageHeight: 64 }); // 世界 -16..48，比 base 更大

  const base = makeImage(32, 32, baseCal);
  paint(base, 16, 16, 20, 20, [255, 0, 0, 255]); // 世界 0..4

  const incoming = makeImage(64, 64, incCal);
  // incoming 像素 = 世界 + 32（因为 originPx=16 且 64px → 世界 -16..48）→ 世界 0 对应像素 32
  paint(incoming, 32, 32, 36, 36, [255, 0, 0, 255]); // 同样的红块（世界 0..4）
  // incoming 像素 = 世界 + 16 → 世界 8..12 = 像素 24..28（base 覆盖范围内，且 base 那里是空白 → 新增）
  paint(incoming, 24, 24, 28, 28, [0, 255, 0, 255]);

  const resampled = resampleToBase({ base, incoming });
  const analysis = analyzeDiff({ base, incoming: resampled, tileSize: 8 });
  assert.ok(analysis.counts.onlyIncoming >= 1, '应检测到新增');
  const merged = composeMerged({ base, incoming: resampled, analysis });
  // 红块仍是红
  assert.deepEqual(sampleAtWorld(merged, baseCal, 2, 2), [255, 0, 0, 255]);
  // 绿块被补到 base 网格上对应位置
  assert.deepEqual(sampleAtWorld(merged, baseCal, 10, 10), [0, 255, 0, 255]);
});

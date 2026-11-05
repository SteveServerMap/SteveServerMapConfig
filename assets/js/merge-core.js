/**
 * merge-core.js —— 地图合并的纯算法层
 *
 * 设计要点：
 *   1. 两张地图各自有一份「画幅校准」（cal）：图片四边对应的世界坐标 + 每方块像素数；
 *   2. 先把 incoming（别人给的新图）**重采样到 base（站点当前地图）的像素网格**上，
 *      之后所有比较和合成都在同一个网格里做，逻辑最简单也最快；
 *   3. 差异按 tile（默认 16×16 像素）统计：未探索(void) / 仅目标图(onlyBase) /
 *      仅新图(onlyIncoming，即「新增」) / 两边都有但颜色差很多(changed，即「变更」) / 相同(same)；
 *   4. 「有没有内容」「颜色差多少」都是**启发式**：换过渲染器/光照的两张图会大面积判成 changed，
 *      所以 UI 必须先给人看差异叠加层，再决定合并。
 *
 * 全部函数纯计算，不碰 DOM，可在 Node 下单测。
 */

/** tile 分类 */
export const TILE = Object.freeze({
  VOID: 0,
  ONLY_BASE: 1,
  ONLY_INCOMING: 2,
  CHANGED: 3,
  SAME: 4,
});

const DEFAULT_VOID_LUMINANCE = 8;
const DEFAULT_DIFF_THRESHOLD = 24;
const DEFAULT_TILE_SIZE = 16;

const num = (v, fallback = NaN) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/* ============================== 校准 ============================== */

/**
 * 由「世界原点 (0,0) 落在图片的第几个像素 + 每方块像素数」构造校准。
 * @param {{originPx:number, originPy:number, pxPerBlock:number, imageWidth:number, imageHeight:number, flipZ?:boolean}} input
 */
export function calibrationFromOrigin({ originPx, originPy, pxPerBlock, imageWidth, imageHeight, flipZ = false } = {}) {
  const w = num(imageWidth);
  const h = num(imageHeight);
  const ox = num(originPx);
  const oy = num(originPy);
  const ppb = num(pxPerBlock);
  if (!(w > 0) || !(h > 0) || !(ppb > 0) || !Number.isFinite(ox) || !Number.isFinite(oy)) {
    console.warn('[merge-core] calibrationFromOrigin 参数非法', { originPx, originPy, pxPerBlock, imageWidth, imageHeight });
    return null;
  }
  const bpp = 1 / ppb; // 每像素多少方块
  const xMin = 0 - ox * bpp; // 用 0 - x 避免出现 -0
  const xMax = xMin + w * bpp;
  let zMin;
  let zMax;
  if (flipZ) {
    zMax = oy * bpp;
    zMin = zMax - h * bpp;
  } else {
    zMin = 0 - oy * bpp;
    zMax = zMin + h * bpp;
  }
  return {
    xMin,
    xMax,
    zMin,
    zMax,
    flipZ: flipZ === true,
    pxPerBlock: ppb,
    blocksPerPixel: bpp,
    imageWidth: w,
    imageHeight: h,
  };
}

/**
 * 由站点 config.json 里的四边界反解出「原点像素 + 每方块像素数」，供目标图预填。
 */
export function calibrationFromBounds({ xMin, xMax, zMin, zMax, imageWidth, imageHeight, flipZ = false } = {}) {
  const x0 = num(xMin);
  const x1 = num(xMax);
  const z0 = num(zMin);
  const z1 = num(zMax);
  const w = num(imageWidth);
  const h = num(imageHeight);
  if (!(w > 0) || !(h > 0) || !(x1 > x0) || !(z1 > z0)) {
    console.warn('[merge-core] calibrationFromBounds 参数非法', { xMin, xMax, zMin, zMax, imageWidth, imageHeight });
    return null;
  }
  const pxPerBlock = w / (x1 - x0);
  // 世界 (0,0) 的像素位置
  const originPx = ((0 - x0) / (x1 - x0)) * w;
  const originPy = flipZ ? ((z1 - 0) / (z1 - z0)) * h : ((0 - z0) / (z1 - z0)) * h;
  return {
    ...calibrationFromOrigin({ originPx, originPy, pxPerBlock, imageWidth: w, imageHeight: h, flipZ }),
    // 保留原始边界（浮点误差比反解小）
    xMin: x0,
    xMax: x1,
    zMin: z0,
    zMax: z1,
  };
}

/** 世界坐标 → 图片像素（返回浮点；配合最近邻取整使用） */
export function worldToPixel(cal, x, z) {
  if (!cal) return { px: NaN, py: NaN };
  const w = cal.imageWidth;
  const h = cal.imageHeight;
  const px = ((num(x) - cal.xMin) / (cal.xMax - cal.xMin)) * w;
  const t = (num(z) - cal.zMin) / (cal.zMax - cal.zMin);
  const py = (cal.flipZ ? 1 - t : t) * h;
  return { px, py };
}

/** 图片像素 → 世界坐标 */
export function pixelToWorld(cal, px, py) {
  if (!cal) return { x: NaN, z: NaN };
  const w = cal.imageWidth;
  const h = cal.imageHeight;
  if (!(w > 0) || !(h > 0)) return { x: NaN, z: NaN };
  const x = cal.xMin + (num(px) / w) * (cal.xMax - cal.xMin);
  let t = num(py) / h;
  if (cal.flipZ) t = 1 - t;
  const z = cal.zMin + t * (cal.zMax - cal.zMin);
  return { x, z };
}

/* ============================== 重采样 ============================== */

/**
 * 把 incoming 重采样到 base 的像素网格（最近邻）。
 * 不重叠 / 越界处填 alpha=0。
 * @returns {{data:Uint8ClampedArray,width:number,height:number,cal:object,coverage:{x0:number,y0:number,x1:number,y1:number}|null}}
 */
export function resampleToBase({ base, incoming } = {}) {
  const bw = base?.width | 0;
  const bh = base?.height | 0;
  const iw = incoming?.width | 0;
  const ih = incoming?.height | 0;
  const out = new Uint8ClampedArray(Math.max(0, bw * bh * 4));
  const empty = { data: out, width: bw, height: bh, cal: base?.cal || null, coverage: null };
  if (!(bw > 0) || !(bh > 0) || !(iw > 0) || !(ih > 0) || !base?.data || !incoming?.data) {
    console.warn('[merge-core] resampleToBase 参数非法');
    return empty;
  }

  const baseCal = base.cal;
  const incCal = incoming.cal;
  if (!baseCal || !incCal) {
    console.warn('[merge-core] resampleToBase 缺少 calibration');
    return empty;
  }

  // 两个画面都是线性的：先算好「base 每一列/每一行 → incoming 像素坐标」，逐行复用
  const colX = new Int32Array(bw);
  let minCol = bw;
  let maxCol = -1;
  for (let bx = 0; bx < bw; bx += 1) {
    const worldX = baseCal.xMin + ((bx + 0.5) / bw) * (baseCal.xMax - baseCal.xMin);
    const ix = Math.round(((worldX - incCal.xMin) / (incCal.xMax - incCal.xMin)) * iw - 0.5);
    if (ix >= 0 && ix < iw) {
      colX[bx] = ix;
      if (ix < minCol) minCol = ix;
      if (ix > maxCol) maxCol = ix;
    } else {
      colX[bx] = -1;
    }
  }

  const src = incoming.data;
  let y0 = bh;
  let y1 = -1;
  let x0 = bw;
  let x1 = -1;

  for (let by = 0; by < bh; by += 1) {
    const worldZ = baseCal.flipZ
      ? baseCal.zMax - ((by + 0.5) / bh) * (baseCal.zMax - baseCal.zMin)
      : baseCal.zMin + ((by + 0.5) / bh) * (baseCal.zMax - baseCal.zMin);
    const t = (worldZ - incCal.zMin) / (incCal.zMax - incCal.zMin);
    const iy = Math.round((incCal.flipZ ? 1 - t : t) * ih - 0.5);
    const rowOut = by * bw * 4;
    if (iy < 0 || iy >= ih) continue;
    const rowSrc = iy * iw * 4;
    let rowMin = -1;
    let rowMax = -1;
    for (let bx = 0; bx < bw; bx += 1) {
      const ix = colX[bx];
      if (ix < 0) continue;
      const s = rowSrc + ix * 4;
      const d = rowOut + bx * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
      if (rowMin < 0) rowMin = bx;
      rowMax = bx;
    }
    if (rowMin >= 0) {
      if (by < y0) y0 = by;
      if (by > y1) y1 = by;
      if (rowMin < x0) x0 = rowMin;
      if (rowMax > x1) x1 = rowMax;
    }
  }

  const has = y1 >= 0 && x1 >= 0;
  return {
    data: out,
    width: bw,
    height: bh,
    cal: baseCal,
    coverage: has ? { x0, y0, x1, y1, minCol, maxCol } : null,
  };
}

/* ============================== 差异分析 ============================== */

/**
 * 按 tile 分类。incoming 必须是**已重采样到 base 网格**的图（resampleToBase 的输出）。
 * @returns {{tileSize:number,cols:number,rows:number,map:Uint8Array,counts:object,blocksArea:object,
 *            width:number,height:number,baseMean:number,incomingMean:number}}
 */
export function analyzeDiff({
  base,
  incoming,
  tileSize = DEFAULT_TILE_SIZE,
  voidLuminance = DEFAULT_VOID_LUMINANCE,
  diffThreshold = DEFAULT_DIFF_THRESHOLD,
} = {}) {
  const size = clamp(Math.round(num(tileSize, DEFAULT_TILE_SIZE)), 2, 512);
  const voidLum = clamp(num(voidLuminance, DEFAULT_VOID_LUMINANCE), 0, 255);
  const diffThr = clamp(num(diffThreshold, DEFAULT_DIFF_THRESHOLD), 0, 255);

  const w = base?.width | 0;
  const h = base?.height | 0;
  const result = {
    tileSize: size,
    cols: Math.max(1, Math.ceil(w / size)),
    rows: Math.max(1, Math.ceil(h / size)),
    map: new Uint8Array(0),
    counts: { void: 0, onlyBase: 0, onlyIncoming: 0, changed: 0, same: 0 },
    blocksArea: { onlyIncoming: 0, changed: 0 },
    width: w,
    height: h,
    baseMean: 0,
    incomingMean: 0,
  };
  if (!(w > 0) || !(h > 0) || !base?.data || !incoming?.data || incoming.width !== w || incoming.height !== h) {
    console.warn('[merge-core] analyzeDiff 参数非法或尺寸不一致', { w, h, iw: incoming?.width, ih: incoming?.height });
    result.map = new Uint8Array(result.cols * result.rows);
    return result;
  }

  const bData = base.data;
  const iData = incoming.data;
  const cols = result.cols;
  const rows = result.rows;
  const map = new Uint8Array(cols * rows);
  const counts = result.counts;
  const pixelArea = { onlyIncoming: 0, changed: 0 };
  let baseLumSum = 0;
  let incLumSum = 0;
  let pixelCount = 0;

  for (let ty = 0; ty < rows; ty += 1) {
    const yStart = ty * size;
    const yEnd = Math.min(h, yStart + size);
    for (let tx = 0; tx < cols; tx += 1) {
      const xStart = tx * size;
      const xEnd = Math.min(w, xStart + size);

      let bR = 0, bG = 0, bB = 0, bLit = 0, bAlpha = 0, bN = 0;
      let iR = 0, iG = 0, iB = 0, iLit = 0, iAlpha = 0, iN = 0;

      for (let y = yStart; y < yEnd; y += 1) {
        let idx = (y * w + xStart) * 4;
        const len = (xEnd - xStart) * 4;
        for (let k = 0; k < len; k += 4) {
          const r = bData[idx];
          const g = bData[idx + 1];
          const bl = bData[idx + 2];
          const a = bData[idx + 3];
          bR += r; bG += g; bB += bl; bAlpha += a;
          if (a > 0 && 0.2126 * r + 0.7152 * g + 0.0722 * bl > voidLum) bLit += 1;
          bN += 1;

          const ir = iData[idx];
          const ig = iData[idx + 1];
          const ib = iData[idx + 2];
          const ia = iData[idx + 3];
          iR += ir; iG += ig; iB += ib; iAlpha += ia;
          if (ia > 0 && 0.2126 * ir + 0.7152 * ig + 0.0722 * ib > voidLum) iLit += 1;
          iN += 1;
          idx += 4;
        }
      }
      if (!bN) continue;

      const bAvg = { r: bR / bN, g: bG / bN, b: bB / bN, a: bAlpha / bN, lit: bLit / bN };
      // 只用「有像素」的部分算 incoming 均值
      const iAvg = iN ? { r: iR / iN, g: iG / iN, b: iB / iN, a: iAlpha / iN, lit: iLit / iN } : { r: 0, g: 0, b: 0, a: 0, lit: 0 };

      baseLumSum += 0.2126 * bAvg.r + 0.7152 * bAvg.g + 0.0722 * bAvg.b;
      incLumSum += 0.2126 * iAvg.r + 0.7152 * iAvg.g + 0.0722 * iAvg.b;
      pixelCount += 1;

      const baseVoid = bAvg.lit < 0.03 || bAvg.a < 8;
      const incVoid = iAvg.lit < 0.03 || iAvg.a < 8;

      let cls;
      if (baseVoid && incVoid) cls = TILE.VOID;
      else if (baseVoid && !incVoid) cls = TILE.ONLY_INCOMING;
      else if (!baseVoid && incVoid) cls = TILE.ONLY_BASE;
      else {
        const dist = Math.sqrt(
          (bAvg.r - iAvg.r) ** 2 + (bAvg.g - iAvg.g) ** 2 + (bAvg.b - iAvg.b) ** 2,
        );
        cls = dist > diffThr ? TILE.CHANGED : TILE.SAME;
      }
      map[ty * cols + tx] = cls;
      if (cls === TILE.VOID) counts.void += 1;
      else if (cls === TILE.ONLY_BASE) counts.onlyBase += 1;
      else if (cls === TILE.ONLY_INCOMING) {
        counts.onlyIncoming += 1;
        pixelArea.onlyIncoming += (xEnd - xStart) * (yEnd - yStart);
      } else if (cls === TILE.CHANGED) {
        counts.changed += 1;
        pixelArea.changed += (xEnd - xStart) * (yEnd - yStart);
      } else counts.same += 1;
    }
  }

  // 实际像素面积 → 方块面积（边缘 tile 必须裁到图片边界）
  const cal = base.cal;
  const bppX = cal ? (cal.xMax - cal.xMin) / w : 1;
  const bppZ = cal ? (cal.zMax - cal.zMin) / h : 1;
  const areaPerPixel = bppX * bppZ;
  result.blocksArea.onlyIncoming = pixelArea.onlyIncoming * areaPerPixel;
  result.blocksArea.changed = pixelArea.changed * areaPerPixel;
  result.map = map;
  result.baseMean = pixelCount ? baseLumSum / pixelCount : 0;
  result.incomingMean = pixelCount ? incLumSum / pixelCount : 0;
  return result;
}

/* ============================== 合成 ============================== */

/**
 * 按策略合成：onlyIncoming（+ changed，若 updateChanged）用 incoming 的像素覆盖 base。
 * @returns {{data:Uint8ClampedArray,width:number,height:number,applied:{filledTiles:number,updatedTiles:number}}}
 */
export function composeMerged({ base, incoming, analysis, options = {} } = {}) {
  const { fillNew = true, updateChanged = true } = options;
  const w = base?.width | 0;
  const h = base?.height | 0;
  const out = new Uint8ClampedArray(Math.max(0, w * h * 4));
  const applied = { filledTiles: 0, updatedTiles: 0 };
  if (!(w > 0) || !(h > 0) || !base?.data) {
    console.warn('[merge-core] composeMerged 参数非法');
    return { data: out, width: w, height: h, applied };
  }

  // 默认：原样复制目标图
  out.set(base.data);
  if (!analysis?.map || !incoming?.data || incoming.width !== w || incoming.height !== h) {
    return { data: out, width: w, height: h, applied };
  }

  const { map, cols, rows, tileSize: size } = analysis;
  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      const cls = map[ty * cols + tx];
      const isNew = cls === TILE.ONLY_INCOMING && fillNew;
      const isChanged = cls === TILE.CHANGED && updateChanged;
      if (!isNew && !isChanged) continue;
      if (isNew) applied.filledTiles += 1;
      if (isChanged) applied.updatedTiles += 1;

      const yStart = ty * size;
      const yEnd = Math.min(h, yStart + size);
      const xStart = tx * size;
      const xEnd = Math.min(w, xStart + size);
      for (let y = yStart; y < yEnd; y += 1) {
        let idx = (y * w + xStart) * 4;
        const len = (xEnd - xStart) * 4;
        for (let k = 0; k < len; k += 4) {
          // incoming 那里是透明的就保留 base（避免把目标图抠出洞）
          if (incoming.data[idx + 3] > 0) {
            out[idx] = incoming.data[idx];
            out[idx + 1] = incoming.data[idx + 1];
            out[idx + 2] = incoming.data[idx + 2];
            out[idx + 3] = 255;
          }
          idx += 4;
        }
      }
    }
  }
  return { data: out, width: w, height: h, applied };
}

/* ============================== 叠加层 ============================== */

/**
 * 生成差异叠加层（与 base 同尺寸的 RGBA，透明底 + 半透明色块），供 canvas putImageData。
 */
export function renderOverlay({
  analysis,
  colors = {
    [TILE.ONLY_INCOMING]: [90, 210, 111, 150],
    [TILE.CHANGED]: [255, 188, 75, 150],
    [TILE.ONLY_BASE]: [140, 160, 150, 110],
  },
} = {}) {
  const w = analysis?.width | 0;
  const h = analysis?.height | 0;
  const out = new Uint8ClampedArray(Math.max(0, w * h * 4));
  if (!(w > 0) || !(h > 0) || !analysis?.map) return { data: out, width: w, height: h };

  const { map, cols, rows, tileSize: size } = analysis;
  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < cols; tx += 1) {
      const color = colors[map[ty * cols + tx]];
      if (!color) continue;
      const yStart = ty * size;
      const yEnd = Math.min(h, yStart + size);
      const xStart = tx * size;
      const xEnd = Math.min(w, xStart + size);
      for (let y = yStart; y < yEnd; y += 1) {
        let idx = (y * w + xStart) * 4;
        for (let x = xStart; x < xEnd; x += 1) {
          out[idx] = color[0];
          out[idx + 1] = color[1];
          out[idx + 2] = color[2];
          out[idx + 3] = color[3];
          idx += 4;
        }
      }
    }
  }
  return { data: out, width: w, height: h };
}

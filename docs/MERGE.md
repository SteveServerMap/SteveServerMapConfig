# 地图合并工具（merge.html）—— 接口契约

给 `SteveServerMapConfig` 增加一个**独立页面** `/merge.html`：把「别人提供的另一张地图 PNG」与「当前站点地图」对齐后，
自动算出差异（哪里缺、哪里有变化）并按策略合并，最后导出或写回站点。

```
merge.html                    页面骨架（Lead 拥有）
assets/js/merge.js            控制器：文件载入 / 解码 / 编排 / 保存（Lead 拥有）
assets/js/merge-core.js       纯函数：投影、重采样、差异分析、合成（merge-core-dev 拥有）
assets/js/merge-ui.js         交互与渲染：两张图的选择/拾取/预览画布/图例（merge-ui-dev 拥有）
assets/css/merge.css          本页样式（merge-ui-dev 拥有）
tests/merge-core.test.mjs     merge-core 单元测试（merge-core-dev 拥有）
tests/merge-e2e.mjs           端到端验收（merge-qa 拥有）
docs/MERGE.md                 本文件
```

**只改自己拥有的文件。** 页面 DOM 由 Lead 在 `merge.html` 里定好 id，JS 只填充/绑定。

---

## 1. 输入与对齐（核心概念）

两张图各自需要一份「画幅校准」，与站点 `config.json` 的 calibration 同一套含义：

```jsonc
// 每张图：图片左上角像素 (0,0) 对应的世界坐标 + 每方块像素数
{ "originX": -1792, "originZ": -2560, "pxPerBlock": 1, "flipZ": false }
```

- 「目标图（base）」= 当前站点正在用的地图，默认从站点 `config.json` 的 calibration 反解出来：
  `pxPerBlock = 图宽 / (xMax - xMin)`、`originX = xMin`、`originZ = zMin`。
- 「新图（incoming）」= 你从别人那里下载的 PNG，**手动设置原点**：
  在图上点一下世界 (0,0) → 填「每方块像素数」→ 工具反解出它的 originX/originZ。

两图用各自的校准映射到同一个世界坐标系后，才能逐像素比较。

`merge-core.js` 必须导出（纯函数、零 DOM，可在 Node 下测试）：

```js
/** 由「世界原点在图片里的像素位置 + 每方块像素数」构造校准 */
export function calibrationFromOrigin({ originPx, originPy, pxPerBlock, imageWidth, imageHeight, flipZ = false })
  // -> { xMin, xMax, zMin, zMax, flipZ, pxPerBlock }

/** 由站点 calibration 反解出 originPx/originPy/pxPerBlock（目标图默认值用） */
export function calibrationFromBounds({ xMin, xMax, zMin, zMax, imageWidth, imageHeight, flipZ = false })

/** 世界坐标 ↔ 图片像素（单张图） */
export function worldToPixel(cal, x, z)   // -> {px, py}
export function pixelToWorld(cal, px, py) // -> {x, z}

/**
 * 把 incoming 重采样到 base 的像素网格上（最近邻，保持像素风锐利）。
 * 不重叠/越界处填 alpha=0。
 * 输入/输出统一为 { data: Uint8ClampedArray(RGBA), width, height, cal }
 */
export function resampleToBase({ base, incoming })
  // -> { data, width, height, cal, coverage: {x0,y0,x1,y1} | null }

/**
 * 差异分析（按 tile 分类，默认 16×16 像素）
 * 返回的 map 是 Uint8Array，每个 tile 一个值：
 *   0=both void(两边都没内容) 1=onlyBase 2=onlyIncoming(新增) 3=changed(变更) 4=same
 */
export function analyzeDiff({ base, incoming, tileSize = 16, voidLuminance = 8, diffThreshold = 24 })
  // -> { tileSize, cols, rows, map: Uint8Array, counts: {void, onlyBase, onlyIncoming, changed, same},
  //      blocksArea: { onlyIncoming, changed }, baseMean, incomingMean }

/**
 * 合成：onlyIncoming 用新图补；changed 且 options.updateChanged 时用新图覆盖；
 * 其余保留目标图原像素。
 */
export function composeMerged({ base, incoming, analysis, options = { fillNew: true, updateChanged: true } })
  // -> { data, width, height, applied: { filledTiles, updatedTiles } }

/** 给画布用的差异叠加层（透明底 + 半透明色块） */
export function renderOverlay({ analysis, colors = { 2: 'rgba(90,210,111,.55)', 3: 'rgba(255,188,75,.55)', 1: 'rgba(140,160,150,.35)' } })
  // -> { data, width, height }（尺寸 = base 像素尺寸）
```

**判定细节（必须写进注释，便于以后调）**
- 「空白/未探索」：tile 内亮度 > `voidLuminance` 的像素占比 < 3% 或平均 alpha < 8 → 视为 void。
- 「变更」：两边都有内容，且 tile 平均 RGB 的欧氏距离 > `diffThreshold`。
- 全部阈值可由 UI 暴露（默认如上）。

---

## 2. 页面结构与 DOM（`merge.html`，Lead 定）

```
#merge-app
 ├ header.mg-topbar
 │   ├ #mg-title / #mg-subtitle
 │   ├ #mg-status（状态文案，data-tone=info|ok|warn|error）
 │   └ 操作按钮：#mg-analyze（分析差异）、#mg-apply（按策略合并）、#mg-download（下载 PNG）、
 │                #mg-save（保存到站点）、#mg-back（返回配置工具 → /）
 ├ main.mg-body
 │   ├ section.mg-panel.mg-left（目标图）
 │   │   ├ #mg-base-drop（拖放区 / 点击选文件）+ #mg-base-file（input[type=file]）
 │   │   ├ #mg-base-canvas（<canvas>，显示目标图 + 拾取十字/叠加层）
 │   │   ├ #mg-base-meta（尺寸 / 校准文案）
 │   │   └ #mg-base-pick（按钮：拾取 (0,0)）+ #mg-base-ppb（每方块像素数输入）
 │   ├ section.mg-center（合并结果预览）
 │   │   ├ #mg-result-canvas
 │   │   ├ #mg-legend（图例：绿=新增 / 黄=变更 / 灰=仅目标图）
 │   │   └ #mg-stats（统计：新增 X 格 / 变更 Y 格 / 仅目标 Z 格 / 面积）
 │   └ section.mg-panel.mg-right（新图）
 │       ├ #mg-inc-drop / #mg-inc-file
 │       ├ #mg-inc-canvas
 │       ├ #mg-inc-meta
 │       └ #mg-inc-pick / #mg-inc-ppb
 └ footer.mg-footer
     ├ 阈值：#mg-tile-size / #mg-void-lum / #mg-diff-thr
     ├ 策略：#mg-opt-fill（补空白，默认勾选）/ #mg-opt-update（覆盖变更，默认勾选）
     └ #mg-save-name（保存文件名，默认 = 目标图文件名）
```

**对齐用的交互（v2，2026-11）**

- 两个 canvas 都是可缩放/平移的视图器：滚轮以光标为锚点缩放、拖拽平移、双击放大、右上角 `+/−/适应` 按钮、键盘 `+/-` 与方向键平移；右下角实时显示**图片像素**坐标（`px 1792, 2563`）。
- 拾取 (0,0) 之后会自动把该点居中放大到 600%，方便继续微调。
- 原点除了点画布，还可以**直接输入像素数字**（`#mg-base-ox/oy`、`#mg-inc-ox/oy`），或用 **← ↑ ↓ →** 按钮（`[data-nudge]`）挪 1 像素 —— 避免「凭感觉点」。
- 改「每方块像素数」会**立即按当前原点重算**画幅。

`merge-ui.js` 导出：

```js
export class MergeUI {
  constructor(rootEl, {
    onPickBase(), onPickIncoming(),          // 用户点了「拾取 (0,0)」
    onBaseImage(file), onIncomingImage(file),// 拖放/选择文件
    onParamsChange({ tileSize, voidLuminance, diffThreshold }),
    onOptionChange({ fillNew, updateChanged }),
    onAction(name),                          // analyze / apply / download / save / back
    onOriginChange(which, {px,py}),          // 原点像素被改动（输入框 / 微调按钮）
    onPpbChange(which, pxPerBlock),          // 每方块像素数被改动
  })
  setStatus(text, tone)
  setBaseImage({ imageBitmapOrImage, width, height, calibration })  // 画到左画布
  setIncomingImage({ ... })
  setPickMarker(which /* 'base'|'incoming' */, { px, py } | null)
  setAnalysis(analysis)      // 更新统计 + 中间画布叠加 + 图例
  setMergedPreview({ data, width, height }) // 合成结果预览
  setBusy(bool) / getParams() / getOptions() / getSaveName()
}
```

## 3. 控制器流程（`merge.js`，Lead）

1. 初始：`GET /api/state` → 取站点图片列表；默认把 `config.json` 里**第一个维度**的图作为「目标图」
   （`/preview/<图片名>` 解码），并用它的 calibration 预填目标图参数。
2. 「新图」由用户从本地选择（`File` → `createImageBitmap` / `Image`）。
3. 拾取 (0,0)：点画布 → 记录像素位置 → 由 `pxPerBlock` 反解校准 → 若新图尚未有校准，默认沿用目标图的 `pxPerBlock`。
4. 分析：`resampleToBase` → `analyzeDiff` → `MergeUI.setAnalysis`（统计 + 叠加层）。
5. 合并：`composeMerged` → `MergeUI.setMergedPreview`。
6. 下载：canvas → `toBlob('image/png')` → `<a download>`。
7. 保存到站点：`POST /api/import-image`（`fileName` + `dataUrl`）—— 已有接口，会写前备份到站点 `.backups/` 并记审计日志。

**安全**：保存默认写回「目标图文件名」，覆盖前自动备份；若目标图来自站点配置，保存后需自行在配置工具里刷新预览。

## 4. 验收（`tests/merge-e2e.mjs`，merge-qa）

用**生成的合成图**做确定性验证（Pillow 生成，放在 `tests/fixtures/`）：
1. `base.png`(256×256)：纯黑 + 一块红方块（世界坐标已知）。
2. `incoming.png`(384×384)：同一红方块（位置偏移以便验证对齐）+ 新增一块绿方块。
3. 页面打开无 console error；两图载入后尺寸/校准文案正确。
4. 按契约设置两图原点与 `pxPerBlock` → 「分析差异」→ 统计里 **新增 ≥1 格、变更 = 0、仅目标 ≥1 格**。
5. 勾选「补空白」→「按策略合并」→ 中间画布出现绿方块区域的像素；取消「补空白」→ 结果与目标图一致。
6. 「保存到站点」：站点副本目录里出现备份 + 目标 PNG 字节变化；JSON 无关文件不受影响。
7. `merge-core.js` 单测覆盖：校准正反算、越界重采样、void/新增/变更/相同 四类分类、阈值边界、合成统计。

## 5. 已知限制（必须写进页面提示）

- 只能处理**轴对齐、无旋转**的地图；两张图必须使用相同朝向（`flipZ` 一致）。
- 「变更」是像素启发式：渲染调色板/光照不同会导致大面积误判，所以必须先看差异叠加层再合并。
- 大图受浏览器 canvas 限制（单边 >16384 或面积 >2.68 亿像素会失败），超出时给出提示。
- 只合并 RGB，不处理透明度语义（透明像素视为空白）。

---

## 6. 瓦片差分模式（2026-11-06，Lead）

与单图合并并列的第二种模式：**站点瓦片集 vs 另一套 Xaero 导出**，逐瓦片差分由服务端完成（`tools/tile-merge.mjs`），
浏览器只负责上传、展示、对比与发布。

### 6.1 服务端

- `POST /api/merge-tiles/analyze`（multipart）：校验文件名（`x<X>_z<Z>.png` / `<rx>_<rz>.zip`）→
  合成到 `.data/merge-staging/<dim>/`（临时目录 + 原子替换，同维度后分析覆盖前一次）。
  响应含 `counts` / `blocksArea` / `grid`（level-0 分类色块）/ `stagingManifestUrl` / `stagedGeneratedAt`。
- `POST /api/merge-tiles/apply`：读暂存 manifest 校验结构 → 站点 `tiles/<dim>/` 备份（`backupTreeInto`）
  → 原子替换 → 清理上传目录 → 记 `save.log`。
- `GET /api/merge-staging/<dim>/<file>`：**只读**暂存结果，`manifest.json` 或 `tiles/<level>/<x>_<y>.png`；
  维度名校验 + 文件名白名单正则 + `path.resolve` 包含防护，其余一律 404。
- 暂存 manifest 与站点 manifest 的 `worldBlockRange` **恒等**（合并沿用基底范围），这是对比图逐像素对齐的前提。

### 6.2 前端

- 模式切换：`#mg-tiles-*` 面板三栏（左=站点维度 / 中=差异预览 / 右=文件拖放），`MergeUI.setTileDims/setTileBaseInfo/setTileAnalysis`。
- **对比滑块**（`#mg-compare`，分析成功后显示）：
  - 动态 `import('/preview/assets/js/tiles.js')`，复用站点的 `parseManifest` + `TileLayer`；
  - 基底 manifest 走 `/preview/tiles/<dim>/manifest.json`，合并结果走 `stagingManifestUrl`；
  - 双 canvas 同视图状态（contain 适配、`dpr` 感知层级选择），合并结果 canvas 用 `clip-path: inset(0 0 0 v%)`
    裁掉左侧，分割线跟随滑块；窗口 resize 重排，发布/失效（`invalidateTiles`）后销毁并隐藏。
- **更新徽标**：左面板「瓦片更新于 …（今天/昨天/N 天前）」、中面板「合并结果生成于 …」，
  `formatTileAge` 与站点 `formatGeneratedAt` 同口径（本地午夜 + Math.round 吸收夏令时）。
- 分析后改参数/文件 → `stale` 标记，保存前必须重新分析。

### 6.3 验收

- `tests/merge-tiles-server.test.mjs`：analyze → apply 全流程（暂存/发布/备份/审计/上传清理）、
  负向用例（400/404/422/500/409）、暂存只读端点正负用例（含路径穿越）。
- `tests/merge-tiles-e2e.mjs`：真实页面走查（切模式 → 选维度 → 传文件 → 分析 → 对比滑块 → stale →
  重分析 → 发布），断言统计、色块画布、双画布渲染、分割线跟随、徽标显隐、发布后资源释放。

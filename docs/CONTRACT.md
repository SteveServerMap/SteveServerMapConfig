# SteveServerMapConfig —— 内部接口契约

本仓库是 **SteveServerMap.github.io 的本地配置与预览工具**：在浏览器里编辑维度/路径点/分组，
实时用**真实站点**预览效果，最后把 `config.json` 写回站点仓库。

- **零依赖、零构建**：只用 Node 内置模块（`node:http`/`node:fs`）+ 原生 ES Module，不 `npm install`。
- 站点代码复用方式：服务端把站点仓库挂到 `/preview/`（只读），前端直接 `import` 站点的
  `assets/js/coords.js` 做坐标换算 —— **全世界只有一份投影数学**，不会和线上漂移。

```
server.mjs                 零依赖本地服务器（Lead）：静态托管 + 编辑 API + /preview 站点挂载
index.html                 工具页面骨架（Lead，其他人不要改）
assets/css/tool.css        style-dev
assets/js/app.js           装配层：状态/撤销/保存/预览刷新（Lead）
assets/js/canvas.js        编辑画布：平移缩放 + 标记拖拽 + 拾取 + 瓦片底图/DPR（canvas-dev）
assets/js/editor.js        左侧树 + 属性表单 + 工具栏（editor-dev）
assets/js/model.js         草稿模型 / 规范化 / 校验 / 导出（model-dev）
tests/model.test.mjs       model 单元测试（model-dev）
tests/e2e.mjs              端到端验收（qa-dev）
```

**只改自己拥有的文件。** 需要别人配合 → 发消息给 Lead。

---

## 1. 两个目录

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| 工具目录 | 本仓库根目录 | 存放草稿 `.data/draft.json` |
| 站点目录 | `../SteveServerMap.github.io` | 读写 `config.json`、`*.png`；可用 `--site=<path>` 或环境变量 `SSM_SITE` 覆盖 |

启动：

```bash
node server.mjs                 # → http://127.0.0.1:5273/
node server.mjs --port=5300 --site="D:/Project/Github/SteveServerMap.github.io"
```

---

## 2. 草稿数据模型（`model.js`）

草稿 = 站点 `config.json` 的超集（多一个**工具专用**字段 `imageMeta`，导出时必须剥掉）。

```jsonc
{
  "version": 1,
  "site": { "title": "…", "subtitle": "…", "footer": "…" },
  "defaultDimension": "overworld",
  "ui": { "labelMode": "hover", "grid": false, "startCollapsed": false, "showCoords": true },
  "dimensions": [
    {
      "id": "overworld",
      "name": "主世界",
      "image": "主世界.png",
      "tiles": { "manifest": "tiles/manifest.json" },   // 可选：瓦片底图（也接受字符串写法）
      "calibration": {
        "calibrated": true,
        "xMin": -1792, "xMax": 1792, "zMin": -2560, "zMax": 2560,
        "flipZ": false,
        "note": "画幅 · …"
      },
      "groups": [{ "id": "base", "name": "据点", "color": "#5ad26f", "visible": true }],
      "waypoints": [
        { "id": "spawn", "name": "出生点", "x": 0, "y": 65, "z": 0,
          "group": "base", "icon": "spawn", "color": null, "label": "always",
          "description": "…", "url": null }
      ],
      "imageMeta": { "width": 3584, "height": 5120, "missing": false },  // 仅工具用，导出时剥掉
      "tileMeta": {                                                     // 仅工具用，导出时剥掉
        "manifest": "tiles/manifest.json",
        "imageWidth": 4096, "imageHeight": 5120,
        "bounds": { "xMin": -2048, "xMax": 2048, "zMin": -3584, "zMax": 1536 },
        "levels": [{ "level": 0, "blocksPerPixel": 1 }],
        "error": null
      }
    }
  ]
}
```

`model.js` 必须导出：

```js
export const CONFIG_VERSION = 1;

export function createEmptyDraft()                     // 含一个主世界维度 + 默认分组
export function normalizeDraft(raw)                    // -> { draft, warnings: string[] }（坏字段降级，不抛错）
export function toConfigJson(draft)                    // -> 可直接写入 config.json 的对象（剥掉 imageMeta、空值字段）
export function validateDraft(draft, ctx)              // -> { errors: Issue[], warnings: Issue[] }
   // ctx = { imageNames: string[], imageSizeOf(dim) -> {width,height}|null }
   // Issue = { path: 'dimensions[0].waypoints[2].x', message: string, level: 'error'|'warning' }

export function createWaypoint(draft, dimensionId, partial)   // 生成唯一 id + 默认分组/图标
export function createGroup(draft, dimensionId, partial)
export function createDimension(draft, partial)
export function nextId(collection, base)                       // base、base-2、base-3…
export function uniqueWaypointId(draft, dimensionId, base)

export const ICONS                                  // 与站点 markers.js 完全一致的 key → emoji
export const ICON_KEYS                              // 有序 key 列表（图标选择器用）
export function resolveIcon(icon)                   // key → emoji；1~2 字符原样；未知 → pin
export function iconLabel(key)                      // 供选择器显示
export function waypointMatchesQuery(wp, query)     // 与站点侧搜索规则一致
export function duplicateWaypoint(draft, dimensionId, waypointId)
export function dimensionById(draft, id)
export function waypointById(dimension, id)
```

校验规则（严重度）：
- `dimensions` 至少 1 个、`id/name/image` 非空、维度 `id` 唯一 → error
- `tiles`（可选）：`manifest` 非空字符串 → 否则 error；不以 `.json` 结尾 → warning
- `calibration` 四边界有限且 `xMax>xMin`、`zMax>zMin`；`calibrated !== true` → warning（提示补画幅）
  - **瓦片维度例外**：世界范围来自 manifest，`calibration` 只作单图兜底，因此「缺画幅 / 画幅不合法 /
    未标记已确认」全部降级为 warning（瓦片维度无需画幅即可保存）
- 路径点：`id` 在维度内唯一、`name` 非空、`x`/`z` 有限 → error；`group` 不存在 → warning 并回落到 `default` 分组
- 分组：`id` 唯一、`color` 形如 `#rrggbb` → error；空分组 → warning
- `image` 不在 `ctx.imageNames` → warning（缺图，站点会显示「地图还没上传」）

序列化要求（`toConfigJson`）：
- 字段顺序固定（便于 diff）：`version, site, defaultDimension, ui, dimensions[]`；
  维度内 `id, name, image, [tiles], calibration, groups, waypoints`（`tiles` 只在配置了 manifest 时输出 `{ manifest }`）
- `y` 为 `null` 时**不输出**该字段；`color/url/description/label` 为空/null 时不输出
- 输出 JSON 用 2 空格缩进 + 结尾换行（`JSON.stringify(cfg, null, 2) + '\n'`）
- 必须能通过站点 `config.schema.json` 校验

---

## 3. 画布（`canvas.js`，canvas-dev）

```js
export class EditorCanvas {
  constructor(container, {
    onViewChange(viewState),        // { scale, tx, ty, viewWidth, viewHeight, imageWidth, imageHeight }
    onMarkerClick(waypointId, { clientX, clientY }),
    onMarkerDragStart(id), onMarkerDrag(id), onMarkerDragEnd({ id, world }), // 拖拽改坐标
    onEmptyClick({ px, py, world }),// 普通模式下点击空白（用于取消选中）
    onHover(world | null),
  })

  setImage({ src, width, height })       // width/height = 图片原始像素；顺带停用瓦片层
  setTileset(tileset | null)             // 瓦片底图：站点 tiles.js 的 Tileset；null = 停用（切回单图）
  setDpr(dpr?)                           // 设备像素比（默认读 devicePixelRatio）；影响瓦片层级选择与插值判定
  getTileStats()                         // TileLayer.stats + dpr/tileset 尺寸；单图模式返回 null
  setProjection(projection)              // 站点 coords.js createProjection 的返回对象
  setData({ waypoints, groups, projection })
  setSelection(waypointId | null)
  setMode('select' | 'place')            // place = 放置模式（光标变化、点击落位）
  setGrid(visible)
  setLabelMode('always' | 'hover' | 'never')
  setGroupVisible(groupId, visible)
  setFilter(predicate | null)
  setTooltipFor(point)                   // 可选：光标处坐标读数由 app 处理
  fitToContent()
  focusWaypoint(id)
  getViewState() / screenToImage(clientX, clientY) / imageToWorld(px, py)
  destroy()
}
```

交互要求：滚轮以光标为锚点缩放、拖拽平移、双击放大、`+`/`-`/方向键、触摸捏合；
标记拖拽（无 lib，Pointer Events，移动超过 3px 才算拖拽，松手回调世界坐标）；
空数据/无图片时安全不抛错。

**底图二选一（2026-11-06 新增瓦片）**
- 单图：`<img id="canvas-image">`（`.canvas-image` 靠 `is-loaded` 淡入）；
- 瓦片：`<canvas id="canvas-tiles" class="canvas-image canvas-tiles">`（由 canvas.js 创建的子图层，
  与 `#canvas-image` 共用 stage 的 transform 与逻辑尺寸；同一时刻只显示一个，另一个 `display:none`）；
- 瓦片层的层级选择 / 视口裁剪 / LRU 缓存全部复用站点 `assets/js/tiles.js`（`/preview/` 静态导入）：
  1 瓦片像素 ≈ 1 **设备**像素（`levelForScale(scale, dpr)`），放大时关插值、缩小时平滑；
- 单图缩放插值：`scale >= 1` → `image-rendering: pixelated`（锐利），`< 1` → `auto`（平滑）；
- 视图变化统一走 `_commit()`，瓦片重绘用 rAF 合并（回调里现场 `getViewState()`，不复用旧状态）。

---

## 4. 编辑面板（`editor.js`，editor-dev）

```js
export class EditorPanel {
  constructor(rootEl, {
    onAction(name),                 // 见下
    onChange(patch),                // 就地修改：{ kind:'waypoint'|'group'|'dimension'|'site'|'ui', id?, field, value }
    onSelect({ dimensionId, waypointId, groupId }),
    onImportImage(file)             // 用户选了本地图片文件
  })
  setDraft(draft)
  setSelection(sel)
  setValidation({ errors, warnings })   // Issue[]，用于列表上的红点与底部问题面板
  setDirty(dirty) / setStatus(text, tone)  // tone: 'info'|'ok'|'warn'|'error'
  refresh()                        // 重新渲染（尽量保持滚动位置与输入焦点）
}
```

`onAction` 取值：`save` `reload-site` `import-config` `export-json` `preview` `undo` `redo`
`new-dimension` `delete-dimension` `new-group` `delete-group` `new-waypoint` `delete-waypoint`
`duplicate-waypoint` `import-image` `fit` `grid` `toggle-labels` `copy-command`
`open-site-folder`。

`index.html` 中已存在的节点（编辑器填充这些）：
`#tree`（维度/分组/路径点树）、`#form`（选中项属性表单）、`#toolbar`、`#status`、`#issues`、
`#btn-*` 系列按钮、`#draft-meta`、`#search`、`#dimension-tabs`。

**维度表单的「底图类型」**（2026-11-06 新增，e2e 稳定选择器）：
- `#form [data-field="tiles.mode"]`：`<select>`，值 `image` | `tiles`（`dim.tiles` 为真即 `tiles`）；
- `#form [data-field="tiles.manifest"]`：瓦片清单路径输入框（单图模式下隐藏）；
- `#form [data-tiles-summary]`：瓦片摘要（世界范围 / 底图尺寸 / 层级数 / manifest / 错误）；
- patch 约定：`{ kind:'dimension', id, field:'tiles.mode'|'tiles.manifest', value }`，
  app 收到后改 `dim.tiles` 并重新 `activateDimension()`（异步加载 manifest，失败回退单图）；
- 编辑器**只读** `dim.tileMeta`（app 注入），不得写回草稿，也不得导出到 config.json。

---

## 5. 本地服务器 API（`server.mjs`，Lead）

所有接口只监听 `127.0.0.1`，JSON 进出；错误统一 `{ ok:false, error:string }` + 4xx/5xx。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 工具页面 |
| GET | `/assets/*` | 工具静态资源 |
| GET | `/api/state` | `{ ok, siteDir, toolDir, siteExists, configExists, images:[{name,size}], draft, lastSaved, sitePackage:boolean }` |
| PUT | `/api/draft` | 保存草稿到 `.data/draft.json`（自动保存用），返回 `{ ok, savedAt }` |
| GET | `/api/site-config` | 读站点 `config.json`（存在则规范化后返回 `{ ok, config }`，不存在 `{ ok:false }`） |
| POST | `/api/import-image` | `{ fileName, dataUrl }` → 写入站点目录（覆盖前备份 `.bak-<时间戳>`），返回 `{ ok, name, bytes, width, height }` |
| POST | `/api/save` | `{ config }` → 校验 JSON 可序列化 + 写前备份 `config.json.bak-<时间戳>` → 写入站点目录，返回 `{ ok, path, backup, bytes }` |
| POST | `/api/preview-token` | `{ config }` → `{ ok, token }`（内存保存 10 分钟，供 `/preview/config.json?token=` 使用） |
| GET | `/preview/*` | 站点仓库只读静态；`/preview/config.json` 若带 `token` 则返回该草稿导出的配置 |
| GET | `/api/health` | `{ ok, version, uptime }` |
| POST | `/api/merge-tiles/analyze` | multipart：`dim` + `files[]`（Xaero 命名 PNG/区域 zip）+ `fillNew`/`updateChanged`/`voidLuminance`/`diffThreshold` → 逐瓦片差分并把合并结果暂存 `.data/merge-staging/<dim>/`，返回 `{ ok, dim, staged, stagingManifestUrl, stagedGeneratedAt, counts, blocksArea, grid, incoming, base, durationMs }` |
| POST | `/api/merge-tiles/apply` | `{ dim }` → 校验暂存 manifest → 站点 `tiles/<dim>/` 备份到 `.backups/` 后原子替换 → `{ ok, dim, tiles, backup, tileSize, levels, tilesWritten, appliedAt }` |
| GET | `/api/merge-staging/<dim>/<file>` | 只读暴露暂存结果（`manifest.json` 或 `tiles/<level>/<x>_<y>.png`），供对比滑块加载；维度名校验 + 文件名白名单 + 路径包含防护，`cache: no-store` |

安全：`/api/save` 与 `/api/import-image` 只允许写到 `siteDir`（`path.resolve` 后必须以 `siteDir` 前缀开头，
且文件名不得含 `..` 或路径分隔符）。

---

## 6. 校验与保存流程（app.js，Lead）

1. 启动 → `GET /api/state` → 有站点 `config.json` 就 `normalizeDraft` 载入，否则 `createEmptyDraft`；
   浏览器 `.data` 里有未保存草稿时提示「恢复上次编辑」。
2. 任何编辑 → 更新内存 draft → `validateDraft` 实时刷新问题面板 → 800ms 防抖 `PUT /api/draft`。
3. 「预览」→ `POST /api/preview-token` → iframe `src=/preview/index.html?token=…`（真实站点渲染同一份配置）。
4. 「保存」→ 有 error 时阻止（列出前 3 条）→ `POST /api/save` → 提示备份路径 + 可复制的 git 提交命令。
5. 撤销/重做：内存快照栈（最多 50 步），`Ctrl+Z` / `Ctrl+Shift+Z`。

---

## 7. 验收标准（qa-dev）

1. `node server.mjs --port=<空闲端口>` 能启动，`GET /api/health` 200。
2. 打开页面 3 秒内渲染出维度/分组/路径点树，无 console error。
3. 载入站点现有 `config.json` 后，树里的路径点数量与站点一致（主世界 10 个）。
4. 新增路径点 → 画布点一下 → 坐标出现在表单里 → 保存 → 读回站点 `config.json` 校验：新点存在、字段合法、`JSON.parse` 通过、`config.schema.json` 校验通过。
5. 保存前存在 error（例如删掉维度 id）时保存被阻止并提示。
6. 预览 iframe 能加载真实站点并渲染出当前草稿的路径点数量。
7. 服务器对越界路径写入返回 4xx（例如 `fileName: "../evil.png"`）。

---

### 8.7 拖动移动开关（v2，2026-11-05）

- `EditorCanvas` 新增 `setDragMoveEnabled(bool)` / `getDragMoveEnabled()`；**默认 false**。
- 关闭时：pointerdown 落在标记上只记录「待点击」（`_markerDrag.dragable = false`），pointermove 不产生位移，pointerup 走 `onMarkerClick` → 只选中；
- 开启时（或 pointerdown 事件带 **Alt**）：`dragable = true`，超过 `MARKER_DRAG_THRESHOLD = 3px` 才开始拖，走原有 `onMarkerDragStart/onMarkerDrag/onMarkerDragEnd` 回调。
- app 侧：顶栏 `#btn-drag-move`（`aria-pressed` 同步）、状态存 `localStorage['ssm.dragMove.v1']`、启动时 `setDragMove(readDragMovePref(), { silent: true })` 静默恢复；
  `handleAction('drag-move')` 与按钮都走 `toggleDragMove()`。
- 回归：e2e `c5d-drag` 验证「默认拖不动 → 开启可拖 → Alt 临时可拖」。

## 8. 实现定稿补充（v1，Lead 记录）

以下是实现过程中与上文契约对齐/细化的部分，作为最终行为说明。

### 8.1 目录与参数
- 站点目录：`--site=` > `SSM_SITE` > `../SteveServerMap.github.io`
- 草稿目录：`--data=` > `SSM_DATA` > `<工具目录>/.data`（`/api/state` 会返回 `dataDir`）
- 端口：`--port=` > `SSM_PORT` > `5273`；只监听 `127.0.0.1`

### 8.2 预览配置的三层兜底（很重要）
站点页面里是 `fetch('config.json')`，**不会带上 iframe URL 的查询参数**，所以 `/preview/config.json` 按以下顺序取：
1. 查询参数 `?token=`；
2. `Referer` 里的 `token=`（同源请求会带上完整 URL）；
3. **最近一次** `POST /api/preview-token` 的配置（内存，10 分钟）；
4. 都没有 → 站点仓库里真实的 `config.json`。

### 8.3 画布补充
- `place` 模式：`onEmptyClick({px,py,world})` 负责落点，canvas 不建点；
- 追加公开方法：`getMode()` `getProjection()` `getImageSize()` `visibleIds()` `setGroupVisibilityAll(groups)` `imageToScreen(px,py)` `worldToScreen({x,z})`；
- 标记居中补偿 100% 由 CSS 负 margin 完成（JS 只写 `translate3d`），`pointer-events` 由 JS 内联控制；
- 无投影时 `imageToWorld()`/`worldToScreen()` 返回 `null`。

### 8.4 编辑行为补充
- **放置模式**：点「+ 路径点」→ 立即创建（落在图片中心）并进入 `place` 模式（`#mode-badge` 提示），在地图上点一下即把坐标改为点击处，`Esc` 取消；
- **撤销合并**：同一字段 700ms 内的连续输入合并为一次撤销步骤（打字不必逐字撤销）；
- **`$schema` 保留**：载入站点配置时记住首行 `$schema`，保存时原样写回；
- **维度 id 失效兜底**：`currentDimension()` 在 id 被改名/清空时按索引回落，避免「改 id 后编辑器失灵」；
- 「读取站点配置」按钮 = `onAction('import-config')` → 从站点重读；本地 JSON 导入走 `import-local-json` / 拖拽文件。

### 8.5 调试接口 `window.__tool`（自动化测试用）
```js
window.__tool = {
  draft(), state(), canvas,            // 读状态
  save(), preview(),                    // 与 UI 同一代码路径；save 失败不抛异常，返回 {ok:false,error}
  action(name),                         // 复用 onAction
  json(), validate(), select(), patch(),
  activateDimension(), undo(), redo(), toast(),
  tiles(), tileMeta(),                  // 瓦片渲染状态 / 当前维度 manifest 元信息（单图模式为 null）
}
```

### 8.6 已修复的实现缺陷（回归用例见 docs/QA.md）
1. 撤销按字符记录（已合并）；
2. 维度 id 清空/改名后编辑器找不到当前维度（已按索引兜底）。

### 8.7 瓦片底图（2026-11-06）
站点侧已有瓦片渲染（站点 `assets/js/tiles.js` + `tiles/manifest.json`），工具复用同一套模块，
**不复制任何瓦片数学**：
- manifest 路径：站点相对路径（如 `tiles/manifest.json`），工具通过 `/preview/<path>` 读取；
  也接受已带 `/preview/` 或 `http(s)://` 的绝对地址；
- 加载流程：`app.js` 动态 `import('/preview/assets/js/tiles.js')` → `loadTileset(url)` →
  写 `dim.tileMeta` / `dim.imageMeta` → `canvas.setTileset(tileset)` → `syncAppProjection()`；
- 投影：瓦片维度用 manifest 的 `worldBlockRange`（1 像素 = 1 方块），`calibration` 只作单图兜底；
  瓦片维度没有有效 calibration 时，`ensureCalibrationFromTiles()` 会按 manifest 自动补一份；
- 失败回退：manifest 404 / 结构非法 / 老站点没有 tiles.js → 记 `dim.tileMeta.error`，显示单图并 toast；
- DPR：`levelForScale(scale, dpr)` 让 1 瓦片像素 ≈ 1 设备像素（高分屏选更细的层级），
  插值判定也按设备像素（`screenDevicePxPerCanvasPx`）；DPR **不参与** canvas 位图尺寸，
  `MAX_CANVAS_PIXELS` 上限不变；
- 平滑：单图 `scale>=1` → `pixelated`；瓦片放大 → 关 `imageSmoothingEnabled`，缩小 → 平滑；
- e2e：`prepareSiteCopy()` 会复制站点 `tiles/` 目录；缺失瓦片的 404 在 `createDiagnostics` 里放行
  （`/preview/tiles/tiles/**/*.png`），manifest 的 404 仍然算错误。

## 10. 交互体检修正（2026-11-05）

按"反人类交互"体检结果修的几处（用户确认后实施）：

1. **键盘不再劫持输入框**（`bindKeyboard`）：`isTypingTarget(target)` 为真时，`Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y` 交还浏览器
   （否则文本撤销失效、且输入框显示与草稿会不同步）；`Ctrl+S` 仍接管（= 保存到站点）。
   → e2e `x1-undo-redo` 在按 Ctrl+Z 前先把焦点移出输入框。
2. **最小缩放 = 整图适配**（`EditorCanvas._minScaleFit`，默认 true）：`_effectiveMinScale()` = max(minScale, 整图适配)。
   3584px 的图不再能缩到 72px。`_fitScale` 拆成 `_rawFitScale`（不钳制）+ `_fitScale`（钳制），避免递归。
3. **切维度整图适配**（`activateDimension` 末尾 `canvas.fitToContent()`）：不同维度图幅不同，沿用旧缩放会只看到一角。
4. **Esc 取消选中**：无拾取 / 放置 / 待建 / 弹窗时，Esc 清空选中。
5. **应用内确认弹窗**（`showConfirm`）：删除路径点 / 分组 / 维度、"大量删点"防呆、覆盖草稿，全部改用 `#confirm-dialog`
   （不再用 `window.confirm`）；`Esc` 或点遮罩 = 取消。
   `#confirm-dialog` 结构在 `index.html`，样式在 `tool.css`（`.modal-panel.narrow / .confirm-message / .btn.danger`）。
6. **合并页保存后清空分析**：底图已更新，旧的差异叠加层会误导 → `invalidateAll()` + 提示重新分析。


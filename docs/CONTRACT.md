# SteveServerMapConfig —— 内部接口契约

本仓库是 **SteveServerMap.github.io 的本地配置与预览工具**：在浏览器里编辑维度/路径点/分组/画幅校准，
实时用**真实站点**预览效果，最后把 `config.json` 写回站点仓库。

- **零依赖、零构建**：只用 Node 内置模块（`node:http`/`node:fs`）+ 原生 ES Module，不 `npm install`。
- 站点代码复用方式：服务端把站点仓库挂到 `/preview/`（只读），前端直接 `import` 站点的
  `assets/js/coords.js` 做坐标换算 —— **全世界只有一份投影数学**，不会和线上漂移。

```
server.mjs                 零依赖本地服务器（Lead）：静态托管 + 编辑 API + /preview 站点挂载
index.html                 工具页面骨架（Lead，其他人不要改）
assets/css/tool.css        style-dev
assets/js/app.js           装配层：状态/撤销/保存/预览刷新（Lead）
assets/js/canvas.js        编辑画布：平移缩放 + 标记拖拽 + 拾取（canvas-dev）
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
      "calibration": {
        "calibrated": true,
        "xMin": -1792, "xMax": 1792, "zMin": -2560, "zMax": 2560,
        "flipZ": false,
        "note": "两点校准 · …"
      },
      "groups": [{ "id": "base", "name": "据点", "color": "#5ad26f", "visible": true }],
      "waypoints": [
        { "id": "spawn", "name": "出生点", "x": 0, "y": 65, "z": 0,
          "group": "base", "icon": "spawn", "color": null, "label": "always",
          "description": "…", "url": null }
      ],
      "imageMeta": { "width": 3584, "height": 5120, "missing": false }   // 仅工具用
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
- `calibration` 四边界有限且 `xMax>xMin`、`zMax>zMin`；`calibrated !== true` → warning（提示去校准）
- 路径点：`id` 在维度内唯一、`name` 非空、`x`/`z` 有限 → error；`group` 不存在 → warning 并回落到 `default` 分组
- 分组：`id` 唯一、`color` 形如 `#rrggbb` → error；空分组 → warning
- `image` 不在 `ctx.imageNames` → warning（缺图，站点会显示「地图还没上传」）

序列化要求（`toConfigJson`）：
- 字段顺序固定（便于 diff）：`version, site, defaultDimension, ui, dimensions[]`；维度内 `id, name, image, calibration, groups, waypoints`
- `y` 为 `null` 时**不输出**该字段；`color/url/description/label` 为空/null 时不输出
- 输出 JSON 用 2 空格缩进 + 结尾换行（`JSON.stringify(cfg, null, 2) + '\n'`）
- 必须能通过站点 `config.schema.json` 校验

---

## 3. 画布（`canvas.js`，canvas-dev）

```js
export class EditorCanvas {
  constructor(container, {
    onViewChange(viewState),        // { scale, tx, ty, viewWidth, viewHeight, imageWidth, imageHeight }
    onPickPoint({ px, py, world }), // 「拾取」模式下在地图点击
    onMarkerClick(waypointId, { clientX, clientY }),
    onMarkerDragStart(id), onMarkerDrag(id), onMarkerDragEnd({ id, world }), // 拖拽改坐标
    onEmptyClick({ px, py, world }),// 普通模式下点击空白（用于取消选中）
    onHover(world | null),
  })

  setImage({ src, width, height })       // width/height = 图片原始像素
  setProjection(projection)              // 站点 coords.js createProjection 的返回对象
  setData({ waypoints, groups, projection })
  setSelection(waypointId | null)
  setMode('select' | 'place' | 'pick')   // pick = 校准拾取（光标十字、点击不拖拽）
  setPickPoints([{ px, py }] )           // 校准拾取到的点位（画十字/连线）
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
`pick` 模式下点击不触发拖拽、不选中标记；空数据/无图片时安全不抛错。

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
`duplicate-waypoint` `import-image` `fit` `grid` `toggle-labels` `goto-calibrate` `copy-command`
`open-site-folder`。

`index.html` 中已存在的节点（编辑器填充这些）：
`#tree`（维度/分组/路径点树）、`#form`（选中项属性表单）、`#toolbar`、`#status`、`#issues`、
`#btn-*` 系列按钮、`#draft-meta`、`#search`、`#dimension-tabs`。

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
4. 「拾取」两点后画幅解算正确（对站点现有画幅误差 < 2 方块）。
5. 新增路径点 → 画布点一下 → 坐标出现在表单里 → 保存 → 读回站点 `config.json` 校验：新点存在、字段合法、`JSON.parse` 通过、`config.schema.json` 校验通过。
6. 保存前存在 error（例如删掉维度 id）时保存被阻止并提示。
7. 预览 iframe 能加载真实站点并渲染出当前草稿的路径点数量。
8. 服务器对越界路径写入返回 4xx（例如 `fileName: "../evil.png"`）。

---

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
  calibrate(a, b),                      // {px,py,x,z} 两点反解并应用
  json(), validate(), select(), patch(),
  activateDimension(), undo(), redo(), setCalibration(), toast(),
}
```

### 8.6 已修复的实现缺陷（回归用例见 docs/QA.md）
1. 校准对话框忘了把面板 append 到遮罩上（对话框是空的）；
2. 校准对话框全屏遮罩挡住画布，导致两点拾取无法点图（拾取时遮罩 `pointer-events:none` + 提示条）；
3. 手填 X/Z 没有 `input` 监听，解算不触发、「应用」永远禁用；
4. 撤销按字符记录（已合并）；
5. 维度 id 清空/改名后编辑器找不到当前维度（已按索引兜底）。

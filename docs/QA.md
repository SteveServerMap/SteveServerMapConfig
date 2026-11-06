# 验收测试说明（`tests/e2e.mjs`）

本文件说明 **SteveServerMapConfig 的端到端验收测试**：它验什么、怎么跑、怎么读结果、有哪些已知限制。
被测对象是 `docs/CONTRACT.md` §5（服务器 API）与 §7（验收标准），以及契约里写明的页面骨架
（`index.html` 的 `#tree` / `#form` / `#btn-*` / `#preview-frame` 等）。

- 测试文件：`tests/e2e.mjs`（零依赖，只 import Node 内置模块 + 站点仓库现成的 CDP 库）
- CDP 库：复用 `D:\Project\Github\SteveServerMap.github.io\tests\headless.mjs`（用 `file://` 绝对路径 import，不复制粘贴）
- 运行产物：`tests/artifacts/`（`.gitignore` 掉除 `.gitignore` 以外的一切）

当前状态：**站点侧全绿（单测 71/71、static-checks 30/30、smoke 39/39，2026-11-07 恒外扩窗口 + 平移冻结落地后，位图恒 = 1.5×视口×dpr）**；本仓库 e2e
`node tests/e2e.mjs` → **17 通过 / 0 失败 / 0 跳过**（2026-11-07 修复两处测试 bug 后首次全绿，见下）。

## 2026-11-07 e2e 全绿：两处测试 bug 修复

之前「4 通过 / 1 失败 / 12 跳过」（c2-page 因瓦片 404 失败，拖挂后面全部检查）追查后是两处**测试自身**的 bug，工具行为是对的：

1. **瓦片 404 放行正则漏了维度段**：`createDiagnostics` 的 ignore 正则是
   `/preview/tiles/tiles/<level>/<x>_<y>.png`，而真实 URL 布局是
   `/preview/tiles/<维度>/tiles/<level>/<x>_<y>.png`（如 `overworld`），从来没兜住过。
   未导出瓦片的 404 是设计内正常情况（未探索区域不导出），已改为与站点 smoke 一致的模式
   （兼容带/不带维度段，且要求 404 状态码）。`tiles/overworld/tiles/6/1_0.png` 磁盘缺失
   无需重新生成——它就该被放行。
2. **点击期望坐标误用旧 calibration**：c5a/c5c 用 `dim.calibration`（站点 config.json 里
   单图时代的旧画幅，世界原点在图片中心）反推点击处世界坐标；瓦片维度的世界范围来自
   manifest 的 `worldBlockRange`（主世界 origin = (-39424, -6656)），整体偏移 16000 方块。
   工具落点用的是 manifest 投影（实测 X=-15906 与点击处完全一致），是期望算错了。
   现改为瓦片模式取 `tool.tileMeta().bounds`、单图模式才用 `dim.calibration`。

修复后 `17 通过 / 0 失败 / 0 跳过`（≈22.2 s），`c0c-tiles` 首次在瓦片模式下真正跑通：
level 6→3（放大 8×）、canvas 位图恒 1167×1167、单图互切 / 导出 tiles 全部正确。

## 瓦片底图 + DPR + 缩放插值（2026-11-06）

站点主世界已改用瓦片底图，工具这边补齐了「看得见 + 摆得动 + 保存不丢」：

- **模型**：`model.js` 规范化 / 导出 / 校验维度字段 `tiles`（`{manifest}` 或字符串）；
  瓦片维度不再要求「已校准」（世界范围来自 manifest，calibration 只作单图兜底）。
  单测 `node --test tests/model.test.mjs` → **33 通过 / 0 失败**（新增 4 条 tiles 用例）。
- **画布**：`canvas.js` 新增 `<canvas id="canvas-tiles">` 子图层 + `setTileset()/setDpr()/getTileStats()`；
  层级选择 / 视口裁剪 / LRU 缓存直接复用站点 `assets/js/tiles.js`（经 `/preview/` 静态导入），
  不复制瓦片数学。瓦片重绘用 rAF 合并，切单图/切瓦片时同步 `display` 与 `is-loaded`。
- **DPR / 平滑**：站点 `Tileset.levelForScale(scale, dpr)` 与 `TileLayer({ dpr })` 为向后兼容扩展
  （默认 dpr=1，站点行为不变）；工具传 `devicePixelRatio`，让 1 瓦片像素 ≈ 1 设备像素；
  单图 `scale>=1` 用 `image-rendering: pixelated`，缩小时平滑。
- **接线**：`app.js` 动态加载 `/preview/assets/js/tiles.js` → `loadTileset()` → 写 `dim.tileMeta` →
  `canvas.setTileset()`；投影走 manifest 的 `worldBlockRange`；manifest 失败自动回退单图并 toast。
  维度表单新增「底图类型 = 单图/瓦片」「瓦片清单」与瓦片摘要（世界范围 / 尺寸 / 层级）。
- **e2e 基建**：临时站点副本改为连 `tiles/` 目录一起复制；`createDiagnostics` 放行
  `/preview/tiles/<维度>/tiles/<level>/<x>_<y>.png` 的 404（未导出瓦片属正常，兼容无维度段布局），
  manifest 的 404 仍算错误；
  「基底图可见性」检查支持两种底图（canvas 位图 / img）。
- **新增检查 `c0c-tiles`**：表单值 `tiles` + manifest、摘要含世界范围、`#canvas-tiles` 可见且
  `#canvas-image` 隐藏、瓦片真的贴出、放大 8× 后层级由 3 → 0（视口渲染下位图恒为视口 × dpr，
  不再随层级放大）、切到单图维度再切回瓦片维度正确互切、导出 JSON 仍保留 `tiles`。
- **结果**：`node tests/e2e.mjs` → **18 通过 / 0 失败 / 0 跳过**（≈26 s，实测 25.8 s）。
  实测 `c0-visible`：瓦片 level=3、canvas 512×640、dpr=1（无头）、已贴 6/6 张、像素 mean=21.8 / litRatio=0.185。
- 更新（2026-11-06 晚，视口渲染）：站点 `tiles.js` 改视口渲染后（backing = 视口 × dpr），本仓库 `canvas.js`
  与 `e2e.mjs` 相应适配——`canvasPointAt` / `checkCanvasVisible` 的截图与坐标换算改读 `#canvas-stage`
  的「整幅地图盒」（瓦片模式下 `<canvas>` 盒子 = 视口，不再是地图盒）；`c0c-tiles` 断言改为
  「位图恒为视口 × dpr，不再随层级放大」。
- 更新（2026-11-07，恒外扩窗口）：站点 `tiles.js` 改为「外扩窗口渲染 + 平移冻结」——静止与拖拽同一条
  路径，位图 = 1.5×视口×dpr（不再有进出交互的窗口切换），进出交互零重画零变化；本仓库 `e2e.mjs`
  相应断言「位图恒为 1.5×视口×dpr」。

---

## 1. 一条命令跑完

```powershell
cd D:\Project\Github\SteveServerMapConfig
node tests/e2e.mjs
```

- **退出码 0** = 全部检查通过；**退出码 1** = 有失败项或基础设施起不来。
- 全过程约 **19 秒**（本次实测 18.8 s）。
- 结束时保证：工具服务器已 `taskkill /T /F`、浏览器进程已退出、`%TEMP%` 下的站点副本与草稿目录已删除
  （用 `--keep` 时才保留并打印路径）。

### 前置条件

| 条件 | 说明 |
| --- | --- |
| Node 24 | 用到全局 `fetch` / `WebSocket`（实测 v24.18.0） |
| 无头浏览器 | 默认自动找 Edge / Chrome，可用 `--browser=` 指定（实测 Edge 155） |
| 站点仓库 | 默认 `D:\Project\Github\SteveServerMap.github.io`，可用 `--site-repo=` 覆盖 |
| 工具源码 | `server.mjs` 必须存在；`assets/js/*.js`、`assets/css/tool.css` 缺失会表现为 §7.2 失败 |

### 可选参数

| 参数 | 作用 |
| --- | --- |
| `--keep` | 保留临时站点副本与临时草稿目录，并打印它们的绝对路径（排查失败用） |
| `--url=http://127.0.0.1:<port>` | 指向**已经启动**的服务，跳过「复制站点 / 启动服务器 / 清理服务器」 |
| `--browser=<路径>` | 指定 msedge.exe / chrome.exe |
| `--headed` | 打开可见窗口（配合 `--verbose` 观察真实交互） |
| `--verbose` | 把服务端与浏览器输出打到当前终端 |
| `--site-repo=<路径>` | 换一个站点仓库 |
| `--headless=<路径>` | 换一个 `headless.mjs`（默认取 `<site-repo>\tests\headless.mjs`） |
| `--data=<路径>` | 指定草稿目录（默认自动建 `%TEMP%\ssm-cfg-e2e-data-<随机>`） |
| `--port=<端口>` | 固定工具服务器端口（默认自动挑空闲端口） |

`--url` 模式的额外约束：脚本会先读 `/api/state` 拿 `siteDir`，**如果 `siteDir` 解析到真实站点仓库就直接中止**——
因为 §7.4（新增路径点 + 保存）会真的写 `config.json`，必须指向临时副本。

---

## 2. 安全边界：为什么不会碰到真实站点

1. **站点副本**：先把站点仓库复制成 `%TEMP%\ssm-cfg-e2e-<随机>`，只复制
   `index.html`、`config.json`、`config.schema.json`、`assets/`、根目录的 `*.png`；
   跳过 `.git`、`.github`、`tests/`、`docs/`。服务器用 `--site=<副本>` 启动。
2. **草稿隔离**：草稿目录用 `--data=%TEMP%\ssm-cfg-e2e-data-<随机>`，不碰工具仓库里的 `.data/`。
   §7.1 断言 `/api/state` 返回的 `dataDir` 就等于这里传进去的临时目录（本轮实测一致）。
3. **目标校验**：§7.1 断言 `/api/health` 的 `siteDir` 等于副本路径；一旦发现指向真实仓库立即中止。
4. **写前闸门**：所有会写 `config.json` 的检查（§7.4b/§7.5）在写入前再校验一次「siteDir 不是真实仓库」。
5. **事后观察**：最后一项检查给真实站点仓库拍快照（`config.json` 的 sha256 + 顶层条目的体积/mtime），跑完比对。
   因为**用户可能同时在用另一个工具实例（默认端口 5273）往真实站点保存**，这一项对「外部改动」只记
   warning（列出前后 sha256/mtime），不判失败；快照会忽略 `.backups/` 与根目录 `config.json.bak-*` 这类保存副产物。
   「e2e 自己没写到真实站点」由第 1~4 条硬保证，不依赖这一项。
6. **清理**：退出前 `taskkill /T /F` 服务器、`launchBrowser().close()` 收浏览器、删除两个临时目录。

§7.7 另外检查「越界写入被拒绝后，站点副本之外没有留下 `evil.png`」。

---

## 3. 检查项清单（共 17 项）

| id | 对应条款 | 断言什么 |
| --- | --- | --- |
| `x3-schema-selftest` | 扩展 | 自制 JSON Schema 校验器**确实能拒绝坏配置**（否则 §7.4 的 schema 断言是假阳性） |
| `c1-health` | §7.1 | `GET /api/health` → 200 且 `ok:true`、`version`/`uptime` 合法；`siteDir`/`dataDir` 指向临时目录 |
| `c2-page` | §7.2 | **重新导航**后 3 秒内渲染出配置树；console error / 未捕获异常 / HTTP≥400 共 0 条；基底图载入成功 |
| `c0-visible` | 扩展（可见性回归） | 基底图**真的被画出来**（单图看 `#canvas-image`，瓦片看 `#canvas-tiles`）：computed `opacity===1`、class 含 `is-loaded`、尺寸 >50×50、截图亮度 `mean>8` 且 `litRatio>0.05`、`#canvas-info` 含 `W×H`；瓦片还断言层级/位图尺寸/dpr/已贴张数，且 `#canvas-image` 已隐藏 |
| `c0c-tiles` | 扩展（瓦片底图） | 维度表单「底图类型 = 瓦片」+ manifest、摘要含世界范围；`#canvas-tiles` 可见、瓦片真的贴出；放大 8× 层级由粗变细（3→0，视口渲染下位图恒为视口尺寸）；切单图维度再切回瓦片维度正确互切；导出 JSON 仍保留 `tiles` |
| `c0b-enhance` | 扩展 | 点一次 `#btn-enhance` 只翻转一次（`body[data-enhance]` / `aria-pressed` / `#canvas-image` filter / `localStorage['ssm.enhance.v1']` 同步、再点回原状、不重复绑定） |
| `c3-tree-count` | §7.3 | `#tree` 里 `[data-waypoint-id]` 数量 = 站点 `config.json` 主世界路径点数（**从副本动态读取**，站点配置由用户随时改） |
| `x1-undo-redo` | 扩展 | 改路径点名称 → `Ctrl+Z` 复原 → `Ctrl+Shift+Z` 再改回（每步读草稿实测） |
| `c5a-new-waypoint` | §7.4a | 点「新增路径点」→ 点「在图上取点」→ place → 画布点一下 → 新点坐标 = 点击处世界坐标 → 表单里能看到这两个坐标 |
| `c5b-save-verify` | §7.4b | 保存 → 站点 `config.json`：`JSON.parse` 通过、`config.schema.json` 通过、新点在、字段合法、其它维度点数**按站点原配置动态比较** |
| `x2-backup` | 扩展 | 写前备份落在站点 `.backups/`：`config.json.bak-<时间戳>` 可解析、内容是保存前的点数；站点根目录不再散落 bak |
| `c5c-place` | §7.4c（交互语义） | 新建后 `mode==='select'`、`placeFor===null`、`#btn-pick-position` 可用；点它 → `place` + badge → 点地图落位（误差 ≤1.5 方块）→ 回 `select`；**点画布空白只取消选中、不移动已选点**；切换选中会自动取消放置 |
| `c6-save-blocked` | §7.5 | 制造 error（清空维度 id）→ 点保存 → `config.json` 字节不变 + 界面出现错误提示 |
| `c7-preview` | §7.6 | 加一个**未保存**的点 → 点「真实站点预览」→ `#preview-frame.contentDocument` 里 `#overlay .marker` 数量 = 草稿点数（且多于站点已保存数） |
| `c8-path-traversal` | §7.7 | `POST /api/import-image` 用 `../evil.png`、`..\evil.png`、`sub/evil.png`、`C:\Windows\Temp\evil.png` 四种写法 → 全部 4xx 且 `ok:false`，目录外无残留 |
| `x4-real-site-untouched` | 扩展 | 观察真实站点有没有被**本次 e2e** 写入：快照忽略 `.backups/` 与 `config.json.bak-*`；若是外部进程（用户自己的工具实例）改的，**降级为 warning** 并列出前后 sha256/mtime；「e2e 没写到真实站点」由临时副本 + `--data` + 三重 `siteDir` 断言 + 写前闸门保证 |

---

## 4. §7 七条验收标准：逐条「怎么测的」

### §7.1 `node server.mjs --port=<空闲端口>` 能启动，`GET /api/health` 200

- 脚本用 `spawn(process.execPath, ['server.mjs', '--port=…', '--site=<副本>', '--data=<临时目录>'])` 启动，
  `stdio:'ignore'`，轮询 `/api/health`（**20 秒超时**，实测 ~170 ms 就绪）。
- 进程若提前退出会直接报 `server 进程提前退出（code=…）`，提示端口占用或 `--site` 无效。
- 通过后再校验 `siteDir` / `dataDir` 确实指向临时目录（安全边界，见上一节）。

### §7.2 打开页面 3 秒内渲染出维度/分组/路径点树，无 console error

- 浏览器打开后先等 `window.__tool` 就绪，然后在检查项里**重新 `Page.navigate` 一次**，
  从导航开始计时，用 `page.waitFor` 轮询「`#tree` 里有 `[data-waypoint-id]` 或树文本里出现 ≥2 个站点路径点名」，
  超时 3000 ms。
- `createDiagnostics(page)` 全程收集 `console.error`、`Runtime.exceptionThrown`、
  `Log.entryAdded(error)`、`Network.responseReceived(status≥400)`，要求 0 条。
- 顺带断言 `#canvas-image` 的 `naturalWidth > 0`（图片来自 `/preview/<编码后的文件名>`）。

### §7.3 载入站点 `config.json` 后，树里的路径点数量与站点一致

- 期望值从**站点仓库的 `config.json`** 里读（**绝不写死**——站点配置由用户随时改：现在主世界 5 个点、
  下界/末地各 0 个，脚本都会自动跟着变），断言两件事：
  - 数量相等；
  - 路径点名字都出现在 `#tree` 文本里（`[data-waypoint-id]` 数量优先，缺失时退化为文本匹配）。
- 附带记录维度标签出现数与分组名出现数作为诊断信息（不作为失败条件）。

### §7.4 新增路径点 → 画布点一下 → 坐标出现在表单里 → 保存 → 读回站点 `config.json` 校验

拆成 3 项，失败时能立刻定位是「交互 / 放置模式 / 保存序列化」哪一环：

- `c5a`：
  1. 先把画布放大到 `scale ≥ 1.8`（1 屏幕像素 ≈ 0.55 图片像素；否则 1 px 误差就是 4~5 个方块）；
  2. 点 `#btn-new-waypoint`，等草稿里多出一个 id；断言**没有**自动进入 place（新语义）；
  3. 点顶栏「在图上取点」`#btn-pick-position` → 断言进入 `place` → 在画布相对位置 (0.42, 0.38) **点一下**，
     等草稿里新点坐标 = 该处世界坐标（±2.5 方块）；落位后断言模式回到 `select`；
     若这条链路走不通，退化为「把标记拖过去」（真实 pointer 拖拽），最后才用 `__tool.patch`；
  4. 选中该点，断言 `#form` 里同时出现 X、Z 两个数值。
- `c5b`：点 `#btn-save`（真实按钮），轮询站点副本的 `config.json` 直到主世界点数 +1，然后断言：
  - `JSON.parse` 通过（解析失败会直接抛错）；
  - `config.schema.json` 校验通过（脚本内 draft-07 子集校验器，支持 `type/const/enum/required/properties/items/additionalProperties`）；
  - 新路径点存在、`name` 非空、`x/z` 有限、`group` 在分组表里、坐标与草稿一致；
  - `version`/`site.title` 不变；**其它维度的点数按站点原配置动态比较**（不再写死下界/末地各 2 个）。
- `c5c`（交互语义回归，用户反馈后重写）：
  1. 点 `#btn-new-waypoint` → 断言 `canvas.getMode()==='select'`、`state.placeFor===null`、`#mode-badge` 隐藏、
     `#btn-pick-position` 可用（新点自动选中）；
  2. 点 `#btn-pick-position` → 断言 `mode==='place'`、`placeFor === 新点 id`、badge 可见；
  3. 点地图 → 断言落点误差 **≤1.5 方块**、`mode` 回 `select`、`placeFor` 清空、badge 隐藏；
  4. **核心回归**：点画布空白处 → 断言已选中的点坐标**一点都没变**、选中被清空、`#btn-pick-position` 变
     `disabled`（这几种都是预期行为）；
  5. 切换选中会自动 `disarmPlacement()`：为 A 点进入 place 后选中 B 点 → 断言 `mode==='select'`、`placeFor===null`；
  6. 用 `Ctrl+Z` 撤销回原状（不影响后续用例）。

### §7.5 保存前存在 error（例如删掉维度 id）时保存被阻止并提示

- 记录 `config.json` 当前字节内容 → 选中主世界维度 → 把维度 `id` 输入框清空（`#form` 里值为 `overworld` 的字段；
  拿不到就走 `__tool.patch`），确认校验器报 ≥1 个 error；
- 点 `#btn-save`，等 1.2 s，断言两件事：
  1. `config.json` **字节内容完全没变**（保存真的被阻止）；
  2. 界面出现错误提示（`#status` / `#issues` / `#toast` 里含「错误 / 未保存 / 不能为空…」）。
- 检查结束后复原现场（维度 id 改回 + 必要时「读取站点配置」重载，`window.confirm` 由 CDP 自动接受）。

### §7.6 预览 iframe 能加载真实站点并渲染出当前草稿的路径点数量

- **故意先加一个不保存的点**，让「草稿」与「站点已保存」数量不同（否则断言没有区分力）。
- 点 `#btn-preview` → 等弹层打开且 iframe `src` 匹配 `/preview/index.html` →
  在主页面里读 `document.getElementById('preview-frame').contentDocument`（同源，可直接访问），
  轮询 `#overlay .marker` 数量（≤20 s，等站点自己拉配置 + 渲染标记）。
- 断言 `marker 数量 === 草稿路径点数`；若等于「站点已保存数」，错误信息会直接写
  「预览没有用草稿配置，token 未生效」。
- 结束后关预览、`Ctrl+Z` 撤销临时点并等草稿点数复原。

### §7.7 服务器对越界路径写入返回 4xx

- 对 `/api/import-image` 依次发 4 种越界 `fileName`：`../evil.png`、`..\evil.png`、`sub/evil.png`、`C:\Windows\Temp\evil.png`
  （`dataUrl` 是一个 1×1 的合法 PNG data URI）。
- 每个都断言 `4xx` 且 body 是 `{ ok:false, … }`；随后检查副本的上级目录、`sub/`、`%TEMP%` 根目录都没有 `evil.png`。

### 附：可见性回归（`c0-visible` / `c0b-enhance`，「DOM 正确 ≠ 用户看得见」）

§7 的 8 条全都是「数值/结构」断言，**没有一条能保证画面真的画出来了**。事故教训：
`tool.css` 里 `.canvas-image { opacity: 0 }` + `.canvas-image.is-loaded { opacity: 1 }`，
而 `canvas.js` 有一段时间没加 `is-loaded` 类 → 基底图 `opacity` 恒为 0，
用户看到的是「没有地图」，但 `naturalWidth`、`getBoundingClientRect`、标记 transform 全部正常，
14 项断言全绿。所以补了两条：

- `c0-visible`（放在 §7.2 之后，`requires: ['page']`）：
  1. **DOM 硬性门槛**：`getComputedStyle(img).opacity === 1`、`class` 含 `\bis-loaded\b`、
     `visibility === 'visible'` 且 `display !== 'none'`、渲染尺寸 > 50×50、`complete && naturalWidth > 0`；
  2. **像素级**：`Page.captureScreenshot({ clip: 图片可见区域 })` 截图 → 用 `node:zlib.inflateSync`
     + 手写反滤波解 PNG（约 70 行，零依赖），统计 `mean` 与 `litRatio`（亮度 >30 的像素占比）。
     阈值 `mean > 8 && litRatio > 0.05`。实测对照（正常态会随视口/图片内容小幅浮动）：
     - 正常显示：`mean = 44.0 ~ 47.3 / litRatio = 0.214 ~ 0.233`
     - 模拟事故（去掉 `is-loaded` → `opacity:0`）：`mean = 16.5 / litRatio = 0.021` → **会被判失败**
     （`litRatio` 是本图的判别式；`mean` 只兜「整块全黑」，因为关掉提亮后暗图本身 mean 也不高）；
  3. **信息条**：`#canvas-info` 不能隐藏，文本必须含 `3584×5120`（即图片天然尺寸）与图片名 `主世界.png`。
- `c0b-enhance`：点一次 `#btn-enhance` → `body[data-enhance]` 必须**只翻转一次**（若一次点击绑了两次监听，
  会翻转两次又变回来），同时 `aria-pressed`、`#canvas-image` 的 computed `filter`、
  `localStorage['ssm.enhance.v1']` 同步变化；再点一次回到原状。
  实测：`data-enhance 1 → 0 → 1`、`aria-pressed true→false`、filter 变化 ✓、`localStorage=0`。

> 注意：`#canvas-image` 在 `tool.css` 里是 `pointer-events: none`（画布拖拽由父层接收），
> 所以 **不能**用 `document.elementFromPoint/elementsFromPoint` 判断图片有没有被遮挡 —— 那会稳定假失败。
> 遮挡类问题由「截图亮度」兜。

---

## 5. 最近结果

| 时间（本地） | 环境 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 2026-11-06 05:23 | Node v24.22.1 · Edge 155.0.4283.62 (headless) · Windows | **17 通过 / 0 失败 / 0 跳过 / 0 警告**（退出码 0）；单测 108 + 11 全过；merge-e2e 10/10、merge-tiles-e2e 17/17 | 21.5 s |
| 2026-11-05 04:32 | Node v24.18.0 · Edge 155 (headless) · Windows | **16 通过 / 0 失败 / 0 跳过 / 0 警告**（退出码 0） | 18.8 s |

> 本轮是「移除校准 UI + 修复两个 merge e2e」提交（`54e0fcd` / `4499257`）后的第一轮：§7 重新编号为 7 条，
> 检查项 17 项（新增 `c5d-drag` 拖动移动开关，`c4-calibration` 已随校准功能移除）；
> 站点主世界已是瓦片底图（15 个路径点 / 4 个分组），`c0-visible` 走瓦片分支。
> 配套：`npm test` 108/108、`node --test tests/png-to-tiles.test.mjs tests/tile-merge.test.mjs tests/merge-tiles-server.test.mjs` 11/11、
> `node tests/merge-e2e.mjs` 10/10、`node tests/merge-tiles-e2e.mjs` 17/17。

逐项（与运行时输出一致）：

```
✓ x3-schema-selftest      站点配置 0 错误；坏配置被拒 3 条（如 $.dimensions[0]: 缺少必填字段 "name"）
✓ c1-health               200 · version=1.0.0 · siteDir=临时副本 · dataDir=--data 指定的临时目录
✓ c2-page                 重新导航后 411 ms 内完成首屏；树渲染 104 ms；[data-waypoint-id] 15 个；
                          瓦片底图 4096×5120（manifest）；console error / 异常 / HTTP≥400：0 条
✓ c0-visible              瓦片底图：opacity=1、is-loaded ✓、592×740px；level=3、canvas 512×640、dpr=1、已贴 6/6；
                          mean=21.9 / litRatio=0.186（阈值 8 / 0.05）；#canvas-info="主世界 · 瓦片 tile…"
✓ c0b-enhance             data-enhance 0 → 1 → 0；aria-pressed false→true；filter 变化 ✓；localStorage=1
✓ c3-tree-count           [data-waypoint-id] 15 个 = 站点 config.json 主世界 15 个；维度 3/3、分组 4/4
✓ c0c-tiles               放大 8× 层级 3→0、canvasW 512→4096；表单/摘要/单图互切/导出 tiles 全部正确
✓ x1-undo-redo            改名 → Ctrl+Z 复原 → Ctrl+Shift+Z 再改回（每步由草稿实测）
✓ c5a-new-waypoint        「在图上取点」→ place → 画布点击；新点 wp-16 X=-29 Z=-1068（点击处 -28.977 / -1068.026）
✓ c5b-save-verify         主世界 15 → 16 个点；JSON.parse ✓；schema ✓；其它维度（nether/the_end）点数未变
✓ x2-backup               .backups/config.json.bak-20261106-052320…（5544 字节）：JSON.parse ✓、保存前 15 个点
✓ c5c-place               新建后 select/placeFor=null → place → 落位误差 0.726 方块 ≤1.5 → 回 select；
                          点空白不移动已选点 ✓、切换选中自动取消放置 ✓（撤销 2 次复原）
✓ c5d-drag                默认不可拖（坐标未变）· 开启后可拖 {6,-11}→{218,70} · Alt 临时可拖
✓ c6-save-blocked         维度 id 清空 → 校验器报 1 个错误 → 保存被阻止（5723 字节未变）→ 界面提示「有 1 个错误，未保存」
✓ c7-preview              iframe 标记 17 个 = 草稿 17 个（站点已保存 16 个）
✓ c8-path-traversal       4 种越界写法全部 4xx；站点目录外没有 evil.png
✓ x4-real-site-untouched  真实站点 config.json sha256 872307ead905… 不变、15 个顶层条目体积/mtime 全部一致
```

`tests/artifacts/` 里当前只保留 `last-run.json`（本轮全部通过，因此没有失败截图）。

### 上一轮（2026-11-05 04:32）

> 站点 `config.json` 已被用户改成 **主世界 5 点 / 下界 0 / 末地 0**、画幅也重新校准过；
> 本轮的期望值全部从站点副本动态读取，所以数字与上一轮不同属于正常。

逐项（与运行时输出一致）：

```
✓ x3-schema-selftest      站点配置 0 错误；坏配置被拒 3 条
✓ c1-health               200 · version=1.0.0 · siteDir=临时副本 · dataDir=--data 指定的临时目录
✓ c2-page                 重新导航后 464 ms 内完成首屏；树渲染 116 ms；console error / 异常 / HTTP≥400：0
✓ c0-visible              opacity=1、is-loaded ✓、518×740px 显示中；mean=44.0 / litRatio=0.214（阈值 8 / 0.05）
                          #canvas-info="主世界 · 主世界.png · 3584×5120px"；enhance=1、画布标记 5 个
✓ c0b-enhance             data-enhance 1 → 0 → 1；aria-pressed true→false；filter 变化 ✓；localStorage=0
✓ c3-tree-count           [data-waypoint-id] 5 个 = 站点 config.json 5 个；维度 3/3、分组 2/2
✓ x1-undo-redo            改名 → Ctrl+Z 复原 → Ctrl+Shift+Z 再改回（各 1 次）
✓ c4-calibration          真实校准对话框：拾取 A/B（命中 #canvas-stage）→ 填 X/Z → 应用 → 保存
                          落盘 xMin=-2047.749 xMax=1534.692 zMin=-3584.616 zMax=1536.134，最大误差 0.808 方块
✓ c5a-new-waypoint        点「在图上取点」→ place → 画布点击；新点 wp-6 X=-286 Z=-1068（点击处 -285.966 / -1068.033）
✓ c5b-save-verify         主世界 5 → 6 个点；JSON.parse ✓；schema ✓；其它维度（nether/the_end）点数未变
✓ x2-backup               .backups/config.json.bak-20261105-043157（2981 字节）：JSON.parse ✓、保存前 5 个点；
                          共 2 份备份；站点根目录无散落 bak
✓ c5c-place               新建后 mode='select'/placeFor=null →「在图上取点」→ mode='place' → 落位误差 0.738 方块 ≤1.5
                          → 回 'select'；点空白不移动已选点 ✓、取消选中 + 取点按钮 disabled ✓；切换选中自动取消放置 ✓
✓ c6-save-blocked         注入「维度 id 为空」→ 保存被阻止（3159 字节未变）→ 提示「有 1 个错误，未保存」
✓ c7-preview              iframe 标记 7 个 = 草稿 7 个（站点已保存 6 个）
✓ c8-path-traversal       4 种越界写法全部 400；站点目录外没有 evil.png
✓ x4-real-site-untouched  真实站点 config.json sha256 34b99e3430ff… 不变、14 个顶层条目体积/mtime 全部一致
```

历史（供对照）：

- 早期 `assets/js/model.js`、`editor.js` 还没落地时：3 通过 / 1 失败 / 8 跳过，
  失败原因是 `/assets/js/model.js` 等 404 导致白屏——脚本给出的就是这条具体信息。
- 校准对话框修好之前：13 通过 / 0 失败 / 1 警告（§7.4 靠 `__tool.calibrate` 兜底）。
- 可见性回归补上之前：14 通过 / 0 失败 / 0 警告 —— **全绿但地图根本没显示**，这就是 `c0-visible` 的存在理由。
  补测时用「运行时去掉 `is-loaded` 类」复现：`mean` 47.3 → 16.5、`litRatio` 0.233 → 0.021，确认新断言会失败。

---

## 6. 已知限制

### 6.1 只覆盖 Chromium 内核

脚本用 Edge/Chrome 的 DevTools Protocol（`headless.mjs` 已把 CDP 封装好），没有跑 Firefox/WebKit，
也没有做真机触摸手势测试。拖拽是用**鼠标事件**触发（Chrome 会合成 pointer 事件），
未覆盖真实触屏的 pinch/两指平移。

### 6.2 部分断言依赖 `window.__tool` 调试接口（用途已尽量收窄）

| 用途 | 是否必需 |
| --- | --- |
| 读取「当前草稿」（判断撤销/改名/新点坐标是否真的生效） | 是；缺失时退化为 `GET /api/state` 的自动保存草稿（有 800 ms 防抖延迟） |
| 放大画布（§7.4a/§7.4c 的点击精度）、`canvas.getMode()`（§7.4c 模式断言） | 是；`getMode` 缺失时退化到 `body[data-mode]` / `#mode-badge` |
| `patch()/select()` | 仅用于「恢复被 §7.5 弄坏的现场」或点不到树节点时兜底选中 |

真实交互（按钮点击、画布点击/拖拽、键盘 Ctrl+Z）**全部走 CDP 输入事件**；
没有用 `__tool` 直接改数据来通过任何一条断言。`x4-real-site-untouched`、`c8-path-traversal`、`c1-health`
完全走 HTTP，不依赖浏览器。

### 6.3 临时站点副本 ≠ 真实站点

副本只含 `index.html`、`config.json`、`config.schema.json`、`assets/`、三张 `*.png`。
因此以下内容**没有被验证**：`.git` 状态与提交、GitHub Pages 部署、`tests/` 下的站点自身测试、
站点 `docs/` 文档、缓存/CDN 行为、跨域场景（工具与站点同源）。

### 6.4 坐标精度与视口相关

- §7.4a / §7.4c 会先把画布放大到 `scale ≥ 1.8` 再点，否则 1 屏幕像素 ≈ 4~5 个方块，±1.5 方块的阈值不可能达到。
- 视口固定 1440×900；`--headed` 时窗口尺寸可能不同，脚本用「图片可见区域」的比例取点，正常情况下自适应。

### 6.5 schema 校验是「够用」而非「完整」

脚本内置的是 JSON Schema draft-07 的**子集**实现（`type/const/enum/required/properties/items/additionalProperties`），
足以覆盖站点 `config.schema.json` 当前用到的关键字；如果将来 schema 里加了 `$ref/oneOf/pattern/minimum` 等，
需要同步扩展 `validateSchema()`。校验器本身有自检项（`x3-schema-selftest`）：
必须能拒绝「维度缺 image」和「缺少 dimensions」的坏配置，避免出现「永远通过」的假阳性。

### 6.6 像素可见性断言的阈值与「当前这张图」绑定

`c0-visible` 的截图亮度阈值是在**当前站点基图（主世界.png）**上实测校准的：正常 `mean 47.3 / litRatio 0.233`，
`opacity:0` 时 `mean 16.5 / litRatio 0.021`，所以取 `mean > 8 && litRatio > 0.05`。
如果以后换成「大部分是白色/浅色」的基图，`litRatio` 会天然接近 1（判别力下降），
届时需要重新测一组「正常 vs 故意 opacity:0」的数值再调阈值；`mean > 8` 只用于兜「整块全黑」，不参与判别。
另外截图裁的是「图片与视口/画布的交集」，所以换了视口尺寸（`--headed`）时统计比例可能略有变化，
但 `litRatio` 的判别式仍然成立。

### 6.7 其它

- **站点 `config.json` 会被用户随时修改**（本轮就变成了主世界 5 点 / 下界 0 / 末地 0），
  所以所有期望值都必须**从本次复制出来的副本动态读取**：`ctx.siteCount`、`ctx.dimensionCounts`、
  `#canvas-info` 里的尺寸等。新增断言时不要写死「10 个点」「下界 2 个」这类常量。
- 断言里保留了「按中文文案找按钮」的兜底（如「保存到站点」「真实预览」）；改文案时可能影响兜底路径，
  但 id/data-* 选择器优先级更高（`#btn-*`、`[data-action]`、`[data-field]`、`[data-waypoint-id]`）。
- 表单类断言只操作 `#form` 内的字段（会校验 `closest('#form')`），不会误写到 `#search` 之类的旁路输入框。
- 自动保存是 800 ms 防抖，脚本读取「草稿」时以 `window.__tool.draft()` 为准，
  退化到 `/api/state` 时轮询等待最长 4~6 s。
- 预览 iframe 加载站点可能需要几秒（3.7 MB 的主世界图），脚本最多等 20 s。
- 无头模式下 `window.confirm` 会自动被接受（通过 `Page.javascriptDialogOpening`），
  因此「读取站点配置」「删除路径点」这类确认框不会卡住用例；但也意味着**没有覆盖「用户点取消」的分支**。
- **真实站点可能被外部进程写入**：用户可能同时开着默认端口（5273）的工具实例并在保存。
  `x4-real-site-untouched` 因此只做「观察」：快照忽略 `.backups/` 与 `config.json.bak-*`，
  `config.json` 变了就记 warning（附前后 sha256/mtime），不判失败。
  真正防「e2e 写真实站点」的是：临时副本 + `--data` 隔离 + `/api/health.siteDir`、`/api/state.dataDir`
  三重断言（checkHealth / `--url` 模式都会在写前再校验一次 siteDir）。因此**不要**把这项的 warning 当成可以无视的噪音。
- 备份位置由站点根目录改为 **`.backups/`** 子目录（服务端只留最近 10 份，`config.json.bak-<时间戳>`），
  站点仓库 `.gitignore` 已忽略 `.backups/`、`config.json.bak-*`、`*.bak-*`；`x2-backup` 会检查
  「`.backups/` 里有备份」且「站点根目录没有散落 bak」两条。
- 已知产品缺陷（**不阻塞验收，但建议修**）：把维度 `id` 改成空串后，`app.js` 的 `handlePatch()` 依赖
  `currentDimension()`（靠 `selection.dimensionId` 定位），此时找不到维度就直接 `return`，
  导致用户**无法再把 id 改回来**，只能点「读取站点配置」重载。e2e 在 §7.5 之后用
  「直接修 `draft.dimensions[0].id` + 必要时重载」把现场恢复，并在报告里留痕。
  建议：`handlePatch` 允许用表单的 `data-entity-id` / `data-dimension-id` 定位维度。

---

## 7. 失败怎么排查

1. 看控制台输出的 `✗` 行：每条都带「实际 … vs 期望 …」。
2. 打开 `tests/artifacts/last-run.json`：`results[]` 里有 `id / label / status / ms / detail / error`。
3. 失败项会自动存 `tests/artifacts/fail-<id>-<时间戳>.png`（页面截图）与 `.txt`
   （错误 + 完整堆栈 + DOM 摘要 + `#form` 输入框快照 + 当轮 console error/HTTP 错误）。
4. 想对着现场调试：

   ```powershell
   node tests/e2e.mjs --keep --headed --verbose
   ```

   `--keep` 会打印临时站点副本路径（里面有 `config.json`、`config.json.bak-*`）和草稿目录，跑完不会删；
   确认无误后手工删掉 `%TEMP%\ssm-cfg-e2e-*` 即可。

---

## 8. 给后续维护者

- 新增检查项：在 `tests/e2e.mjs` 的 `CHECKS` 数组里加一条
  `{ id, label, requires: ['page'], run: async (ctx) => '细节字符串' }`，
  `run` 里抛错即判失败（错误信息请写「实际 vs 期望」），返回字符串会显示在 `✓` 行。
- 选择器优先级（从稳到脆）：`id` → `data-*` → 文本正则 → `window.__tool`。
  新增断言尽量用前三种，别写死中文。
- 需要新的前置条件时：在 `run` 里设置 `ctx.flags.xxx = true`，别的检查用 `requires: ['xxx']` 依赖它。
- **新增任何「应该显示在屏幕上」的 UI 元素 / 图片 / 画布内容，必须补一条可见性断言**，不能只断言
  「元素存在 + 尺寸正确」。至少覆盖：computed `opacity`/`visibility`/`display`、必要的 class/data 属性；
  对图片、canvas、关键区块再补**像素级**检查（`Page.captureScreenshot({ clip })` + `pngBrightness()`）。
  理由：`opacity:0`、`filter: brightness(0)`、被浮层盖住、父容器 `display:none` 这几种情况下，
  `naturalWidth` / `getBoundingClientRect` / 标记 `transform` 全部正常，纯结构断言会全绿（见 §9 第 8 条）。
- 像素断言的阈值要「先用正常/故障两态各测一次再定」，并写进 `docs/QA.md`；别凭感觉取数。
- **不要**把 `--site` 指向真实仓库，也不要在 `tests/` 里直接读写真实站点——所有写入都必须落在临时副本。

---

## 9. 本轮验收暴露并已修复的问题（留档）

这些问题是写 `tests/e2e.mjs` 的过程中由测试实际跑出来的，修完之后对应检查从「失败/警告/跳过」变成「通过」，
可以作为以后回归的参考：

| # | 现象（测试怎么发现的） | 修复 |
| --- | --- | --- |
| 1 | §7.6 只要草稿比站点多一个点就必然失败：`/preview/config.json` 无 token 时回落到**已保存**配置（站点侧 `fetch('config.json')` 不带 query）。旁证：`server.mjs` 里 `currentPreview` 声明了却从未赋值 | `server.mjs` 改为「token → Referer 里的 token → 最近一次预览 → 回落站点文件」三层兜底，`/api/preview-token` 同时写 `currentPreview` |
| 2 | 草稿目录固定在 `<工具目录>/.data`，`--site` 换了也不隔离，上一轮跑的草稿会污染下一轮 | 新增 `--data=<dir>`（优先级 `--data` > `SSM_DATA` > 默认），`/api/state` 返回 `dataDir`；e2e 每次给一个临时目录，§7.1 断言它生效 |
| 3 | 「新增路径点」后点画布不会落位（`onEmptyClick` 里没有放置逻辑），§7.4「画布点一下」只能退化到拖拽 | 新增 `place` 模式：`armPlacement()` 设 `canvas.setMode('place')` + `#mode-badge` 提示，点地图调用 `placeAt()`，落位后自动回 `select`（对应 `c5c-place`） |
| 4 | 把维度 `id` 改空后 UI 再也改不回来（`handlePatch` 用 `currentDimension()` 定位维度，找不到就 `return`） | **尚未修复**，e2e 在 §7.5 之后自行修复现场并打警告/留痕；建议改用表单的 `data-entity-id` / `data-dimension-id` 定位（见 6.7） |
| 5 | **地图图片在 DOM 里、尺寸/坐标全对，但屏幕上永远不显示**：`tool.css` 写的是 `.canvas-image{opacity:0}` + `.canvas-image.is-loaded{opacity:1}`，而 `canvas.js` 的 `setImage` 从没加 `is-loaded` 类 → computed `opacity` 恒为 0。**当时 14 项断言全绿**，因为只查了 `naturalWidth` / `getBoundingClientRect` / 标记 `transform`——这些在 `opacity:0` 时全都正常 | `canvas.js` 的 `onLoad` 里补 `img.classList.add('is-loaded')` + `img.style.opacity='1'`；e2e 新增 `c0-visible`（opacity/`is-loaded`/尺寸硬性断言 + **截图像素亮度** `mean/litRatio` + `#canvas-info` 文本含 `3584×5120`）与 `c0b-enhance`（提亮按钮一次点击只翻转一次）。像素断言用「运行时去掉 `is-loaded`」复现验证：`mean 47.3→16.5`、`litRatio 0.233→0.021`，确认会失败 |
| 6 | **交互语义缺陷（用户反馈）**：① 新建路径点会自动 `armPlacement()` 且切换选中不取消 → 用户点了 A 再去点地图，就把 A「悄悄挪走」了；② `activateDimension/commit` 从没同步 `state.projection`（app 侧一直 null）→「在图上取点」被误判不可用、坐标读数与列表定位失效 | 改为显式语义：点路径点=只选中（`mode==='select'`、`placeFor===null`）；新建不再自动 place；要落位就点顶栏 `#btn-pick-position`（未选中时 disabled）→ place → 点地图；切换选中自动 `disarmPlacement()`、Esc 可取消；`__tool` 增加 `pickPosition()/armPlacement()/disarmPlacement()`。e2e 的 `c5c-place` 按新语义重写，并新增两条核心回归：**点画布空白不移动已选点**、**切换选中自动取消放置** |

# Xaero 地图数据支持（调研 + 工具）

> 结论先说：**别逆向格式了，Xaero 自带「导出 PNG」**（可选「Multiple Unscaled Images」按 1 px = 1 方块导出任意大的范围）。
> 这是拿到「不糊」地图的正道；本目录的 `tools/xaero-probe.mjs` 只用来确认数据内容和覆盖范围，以及给后续拼接/瓦片化做准备。

## 1. 这份数据是什么

`.data/world-map.rar`（265 MB）解压后是 **Xaero's World Map (1.44.x) 的缓存目录**：

```
world-map/
└── <服务器名>/                     ← 例如 Multiplayer_frp-web.com / Multiplayer_frp-all.com
    ├── dimension_config.txt        ← dimensionTypeId:minecraft:overworld / caveModeType
    ├── null/                       ← 主世界
    │   └── mw$default/
    │       ├── <rx>_<rz>.zip       ← 区域数据（里面是 region.xaero）
    │       ├── cache_1/<rx>_<rz>.xwmc  ← 渲染缓存（里面是 cache.xaero）
    │       └── caves/<n>/...       ← 洞穴模式数据
    ├── DIM-1/                      ← 下界
    └── DIM1/                       ← 末地
```

- 区域文件命名 `<rx>_<rz>` 就是**区域坐标**（Xaero 每个区域 512×512 方块）。
- 文件是自定义二进制（NBT 方块状态调色板 + 逐块数据），外层用 ZIP 压缩；Xaero 的存储版本是 **save 6.8 / cache 1.25**（来自 mod jar 里的常量），无公开格式文档。

## 2. 先看覆盖范围（探针工具）

```bash
# 1) 解压（NanaZip / 7-Zip 都行）
7z x .data/world-map.rar -o.data/xaero

# 2) 探测（零依赖，Node 直接跑）
node tools/xaero-probe.mjs .data/xaero/world-map --sample=5
```

输出示例（用户这份数据）：

| 世界 | 维度 | 区域数 | 覆盖范围（方块） |
| --- | --- | --- | --- |
| Multiplayer_frp-web.com | 主世界 | 1335 | X -75776..7168（82944）× Z -9216..2560（11776） |
| Multiplayer_frp-all.com | 主世界 | 358 | X -15360..10240 × Z -72192..13824 |
| Multiplayer_frp-all.com | 下界 / 末地 | 49 / 26 | — |

探针还能从 `region.xaero` 里解出**方块 ID 调色板**（如 `minecraft:gravel`、`minecraft:seagrass`、`minecraft:sandstone`），并输出每个区域 payload 的大小和头部字节，方便以后真要写解码器时对照。

完整结果写到 `.data/xaero-report.json`（`--json=` 可改路径）。

## 3. 拿到清晰地图的正确姿势：Xaero 自带导出

把这份数据放回任意一份 **Xaero World Map 1.4x 客户端**的缓存目录，进游戏就能看到这张图，然后：

1. 进入对应的服务器/存档，按 `M` 打开世界地图；
2. 在图上**右键拖框**选择要导出的范围（或什么都不选，用「Force Full Map」导全图）；
3. 右键菜单里点 **「Export Map as PNG」**（`gui.xaero_right_click_box_map_export`）；
4. 在导出确认界面勾选：
   - **Multiple Unscaled Images** —— 大范围必备：按 **1 px = 1 方块**导出成多张 PNG，不受"太大"限制；
   - 可选 **Force Full Map**（忽略选区导全图）、**Nighttime**（夜景光照）；
5. 导出文件在 `XaeroWorldMap/exports/`（文件名带时间戳；多张时会带序号/坐标后缀）。

> 注意：单张导出有内存上限（「way too big」/「out of memory」就是撞到它了），大范围一定要勾 Multiple Unscaled Images。

## 4. 拿到导出后怎么上站（下一步要做的）

Xaero 导出的是 1 px/方块、可能几十张的大图，站点现在的「单张 PNG + 画幅校准」撑不住（8 万方块 × 1 px = 8 万像素宽）。计划：

1. `tools/stitch-xaero-export.mjs`：按文件名/内容把多张导出拼成一张大图（或直接产出瓦片）；
2. `tools/make-tiles.mjs`：生成 XYZ 瓦片（`tiles/{z}/{x}/{y}.png`）+ `manifest.json`（世界坐标 ↔ 瓦片映射，1 px = 1 方块）；
3. 站点增加「瓦片模式」：`config.json` 里给维度加 `tiles: { minZoom, maxZoom, url }`，前端按视野加载瓦片（替代单张 `image`），校准信息直接从 manifest 读。

这三步都不依赖 Xaero 的二进制格式，先做哪步都不会白做。

## 5. 相关事实（备查）

- Xaero 区域大小：`MapRegion` 128×128 方块（8×8 `MapTileChunk`，每个 chunk 16×16 方块），导出像素 1 px/方块；
- 存储版本常量：`currentSaveMajorVersion=6`、`currentSaveMinorVersion=8`；缓存 `1.25`；
- 数据里带方块状态调色板与生物群系调色板，**颜色由 Xaero 自己按方块渲染**，所以逆向出来也只能得到方块 ID，需要自备配色表 —— 而「导出 PNG」直接拿到渲染好的像素，省掉这一步。

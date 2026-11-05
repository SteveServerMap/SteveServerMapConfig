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

## 6. 二进制格式（已确认部分，来自 8.8 版 jar 字节码）

> 你这份数据是 **save 8.8**（头部 `ff 00 08 00 08`），本机 `xaeroworldmap-fabric-26.3-1.47.0.jar` 正好是这个版本，
> 格式是从它的 `MapSaveLoad.saveRegion/loadRegion/savePixel` 字节码里读出来的。

`region.xaero`（zip 内唯一文件）按 `DataOutputStream` 顺序写：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| 魔数 | 1 字节 | 固定 `0xFF` |
| 版本 | int | `(major << 16) | minor`，8.8 → `0x00080008` |
| flags | 1 字节 | 观察值 `0x07` |
| worldInterpretationVersion | 1 字节 | 仅当 flags 含 `0x02`；观察值 `0xFF` |
| caveStart | int | 仅当 flags 含 `0x04`；`-1` 表示非洞穴图 |
| caveDepth | 1 字节 | 仅当 flags 含 `0x04`；观察值 `0xFF` |
| 区块存在表 | 待定（8~64 字节） | 8×8=64 个 MapTileChunk 的 loadState |
| 每个存在区块 | int + 4×4 个 tile | tile 头 4 字节（0 = 空 tile），然后 16×16 个方块 |
| 每方块 | `savePixel` | 见下面的 `parametres` 位域 |

`parametres`（每方块先写一个 int，位域）：

| 位 | 掩码 | 含义 |
| --- | --- | --- |
| 0 | `0x1` | 有方块状态（否则是草地贴图格） |
| 1 | `0x2` | 有 overlay 层 |
| 8–15 | `0xFF00` | light |
| 12–19 / 25–28 | — | height（12 位：低 8 位在 12..19，高 4 位在 25..28） |
| 20 | `0x100000` | 有 biome |
| 21 | `0x200000` | 方块状态是**内联 NBT**（否则写 int 调色板索引） |
| 22 | `0x400000` | biome 是**内联 UTF 字符串**（否则写 int 索引） |
| 24 | `0x1000000` | 高度与 topHeight 不同 → 多写 1 字节 topHeight |

内联方块状态 NBT 长这样（实测）：`0a 00 00 08 00 02 "id" <len> "minecraft:gravel" 00`；带属性时还有 `properties` 子 compound。
调色板按写入顺序累积：索引 = 写入时 `HashMap.size()`。

**当前进度**：`tools/xaero-decode.mjs` 已实现 zip 解包、NBT 读取、`parametres` 位域、逐方块解出方块 ID 并渲染 PNG；
卡在**区块存在表/区块头的确切字节数**上（头部之后到第一段内联 NBT 之间还有 10 字节没对上），
下一步用"自适应布局探测"（尝试 8 字节位图 / 64 字节数组 / 各 int 组合，取能连续解出合法 `minecraft:*` ID 的那种）来定死。

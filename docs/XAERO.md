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

### 已确认的流布局（8.8，按字节码 + 实测）

```
[6 字节头]  0xFF | int(major<<16|minor) | byte flags
[区块循环]  外层 chunkX(0..7)、内层 chunkZ(0..7)：
            仅「includeInSave」的区块才写：byte((chunkX << 4) | chunkZ)     ← 区块标记
            然后是 4×4 个 tile（外层 tx、内层 tz）：
              空 tile  → writeInt(-1)                                   ← 4 字节
              有数据   → 256 个方块（x 外层 16、z 内层 16，逐个 savePixel）
                         + byte worldInterpretationVersion
                         + int  caveStart
                         + byte caveDepth                               ← 6 字节尾
```

Overlay（方块上的"覆盖层"，如草/雪）的参数位域：

| 位 | 含义 |
| --- | --- |
| bit0 | 有方块状态（**0 = 水层，后面不写状态**） |
| bit4.. | light |
| bits11..14 | opacity & 15 |
| bit10 (`0x400`) | 状态以 NBT 内联（否则写 int 调色板索引） |

实测对照（4 个区域，首段内联 NBT 的偏移与 flags）：

| 区域 | flags | 首个 NBT 偏移 | 说明 |
| --- | --- | --- | --- |
| -100_-12 | 0 | 10 | 头 6 + 首方块 parametres 4 + NBT |
| -101_-12 | 0 | 18 | 头 6 + 两个空 tile(8) + parametres 4 + NBT |
| -103_-13 | 1 | 10 | 同上（flags 不影响区块数据的起点） |
| -102_-13 | 7 | 22 | 头 6 + 四个空 tile(16) + … |

**当前进度：已打通**（`tools/xaero-decode.mjs` 可以把 region 直接解成 PNG）

关键规则（实测 371 个区域里的多个样本，全部精确读到文件末尾、剩余 0 字节）：

```
[6 字节头] 0xFF | int(major<<16|minor) | byte flags
[区块 0]  直接是 16 个 tile（没有标记字节）
[其后每块] byte((chunkX << 4) | chunkZ) + 16 个 tile
每个 tile：[空] writeInt(-1)
           [有] 256 个方块（x 外层 16、z 内层 16） + byte worldInterp + int caveStart + byte caveDepth
```

用法：

```bash
node tools/xaero-decode.mjs <.data/xaero/world-map/<世界>/<维度>/mw$default> --out=out.png
```

实测：单个区域 512×512、0.36 s 解 6 个区域；输出 PNG 里颜色分布合理（砂 6.7%、树叶 6.9%、泥土 10.7%、砂砾 58%、海草 4.4%）。



## 7. 全量解码与降采样

frp-web 主世界（371 个地表区域）实测：

```bash
node tools/xaero-decode.mjs "<..>/Multiplayer_frp-web.com/null/mw$default" --scale=8 --out=overview.png
```

- 输出 **10368×1472** PNG（0.56 MB），**5 秒**解完 371 个区域
- 世界坐标范围 X -75776..7168 · Z -9216..2560
- 探索覆盖率只有 **3.7%**（玩家走的是"路线"，不是整片大陆）
- 主色：沙 19.9%、砂砾 17.5%、石头 6.3%、橡树叶 5.3%、雪 4.8%、泥土 4.1%

`--scale=N` 是整数降采样：N=1 时 1 px = 1 方块（细节图），N=8 时每个像素代表 8×8 方块（总览图）。

**防挖矿**：所有矿石（`*_ore`、`ancient_debris`、原矿块）统一按石头色渲染，地图不会暴露矿点。洞穴层同理（未加矿石配色）。

## 8. 服务器来源（重要）

这份压缩包里是 **3 个不同服务器**的缓存，文件夹名就是服务器地址：

| 服务器 | 主世界地表区域 | 覆盖范围 |
| --- | --- | --- |
| `Multiplayer_frp-web.com` | 371 | X -75,776..7,168（82,944 宽）× Z -9,216..2,560 |
| `Multiplayer_frp-all.com` | 133 | X -15,360..10,240 × Z -72,192..13,824（7.3 万高） |
| `Multiplayer_localhost` | 4 | X -512..512（基本是空世界） |

同坐标区域比对（`(-9,-8)`）：web 与 all 两边都探索的 10,245 像素里，颜色完全一致的只有 **16%**
→ 两份数据**不是同一个世界的两次快照**，不能互补拼接，要按服务器分开出图。

另外每个维度都有两套数据：`mw$default/*.zip` 是**地面模式**，`mw$default/caves/<layer>/*.zip` 是**洞穴模式**
（frp-web 主世界：地表 371 个、洞穴 964 个区域）。`caveModeType:1` 只是"启用洞穴层"的开关。

## 9. 用 Xaero 自带导出（推荐路线）

自研解码器的配色是近似的，和游戏里看到的差别较大。**要 1:1 还原就用 Xaero 自己的导出**：

### 导出步骤（游戏内）

1. 把解压出的 `world-map` 目录放进 `.minecraft/XaeroWorldMap/`（保持 `<服务器名>/<维度>/...` 结构）
2. 进入对应服务器/存档，按 `M` 打开世界地图
3. 右键拖框选中要导出的范围（或什么都不选，用 **Force Full Map** 导全图）
4. 右键菜单点 **Export Map as PNG**
5. 导出界面勾选：
   - **Multiple Unscaled Images** ← 大范围必备：按 1 px = 1 方块导出成多张，不受单图内存限制
   - 可选 Force Full Map（忽略选区导全图）、Nighttime（夜景光照）
6. 导出文件在 `XaeroWorldMap/exports/`（文件名带时间戳 + 坐标后缀）

### 拼接（本仓库工具）

```bash
node tools/stitch-xaero-export.mjs <导出目录> --out=stitched.png
```

- 纯 Node、零依赖：自带 PNG 解码/编码
- **自动识别文件名末尾的两个整数当坐标**（如 `2026-11-05_23.20.00_3_-7.png` → 坐标 (3,-7)），按网格拼
- 文件名没有坐标时，按自然排序铺开，用 `--cols=N` 指定列数
- `--scale=N` 可选整数降采样（大图压缩体积）

已验证：4 张带坐标的测试图能正确拼成 2×2 网格、每个象限颜色对位准确。

> 如果 Xaero 导出的文件名里没有坐标，把文件列表发我，我按实际命名规则调整解析。

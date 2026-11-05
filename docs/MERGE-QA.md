# 地图合并（merge.html）验收记录

## 运行

```bash
# 1) 单元测试（纯算法，不需要浏览器）
node --test tests/merge-core.test.mjs

# 2) 端到端（自起工具服务器 + 临时站点副本 + 无头 Edge）
node tests/merge-e2e.mjs
node tests/merge-e2e.mjs --keep          # 保留临时站点副本便于排查
node tests/merge-e2e.mjs --browser=<path> # 指定 Edge/Chrome
```

素材 `tests/fixtures/{base.png,incoming.png}` 用 Pillow 生成（256×256 / 384×384，红蓝绿方块位置对应已知世界坐标）。
如需重新生成：

```python
from PIL import Image
b = Image.new("RGB", (256, 256), (0, 0, 0))   # 世界 -128..128，原点像素 128,128
b.paste((220, 40, 40), (148, 148, 188, 188))  # 世界 20..60 的红块
b.paste((40, 80, 220), (188, 188, 218, 218))  # 世界 60..90 的蓝块（只存在于目标图）
b.save("tests/fixtures/base.png")

i = Image.new("RGB", (384, 384), (0, 0, 0))   # 世界 -192..192，原点像素 192,192
i.paste((220, 40, 40), (212, 212, 252, 252))  # 同样的红块（世界对齐）
i.paste((40, 200, 90), (92, 92, 132, 132))    # 世界 -100..-60 的绿块（只存在于新图）
i.save("tests/fixtures/incoming.png")
```

## 最近结果

| 时间 | 环境 | 结果 |
| --- | --- | --- |
| 2026-11-05 | Node 24.18 / Edge 155 headless / Windows | `merge-core` 单测 **24/24**；`merge-e2e` **10/10** |

关键实测值：

- 差异分类（tile=16）：`void 223 / onlyBase 8 / onlyIncoming 16 / changed 0 / same 9` —— 与素材设计一致（红块两边同色判 same、蓝块 onlyBase、绿块 onlyIncoming）。
- 合并：`filledTiles=16`、`updatedTiles=0`；结果画布像素采样 (48,48)=`[40,200,90]`（绿）、(168,168)=`[220,40,40]`（红），取消「补空白」后绿块消失、`filledTiles=0`。
- 保存：写入站点副本 `merged-test.png`（约 2.4 KB），根目录项 7→8，未破坏原有文件。
- 性能（真实 3584×5120 两张图、tile=16）：解码 84ms · 重采样 105ms · 分析 172ms · 合成 42ms（合计约 400ms）。

## 已知限制

1. 只支持轴对齐、无旋转的地图；两张图的 `flipZ` 必须一致。
2. 「变更」是像素启发式（tile 平均色差 > 阈值）。渲染调色板/光照不同的两张图会大面积判为变更 —— 必须看叠加层后再合并。
3. 只比较 RGB，不解释透明度语义（透明像素视为空白）。
4. 浏览器 canvas 面积软上限约 2.68 亿像素（单边 16384），超出时页面会直接报错。
5. 端到端用例通过 `window.__merge` 设置原点（模拟画布点击的坐标换算由 `merge-core` 单测覆盖），真实点击路径由人工验收。

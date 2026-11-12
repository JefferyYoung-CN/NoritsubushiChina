# 合成演示数据集

本目录存放一个小型 **合成** 交通网络，让 Web 应用和兼容演示的测试无需任何授权数据即可运行。这里的一切都不是真实的：

- 城市、运营方、线路名、车站名、车站顺序、里程值和坐标都是为演示虚构的；
- 没有从维护者的内部数据包复制任何内容，也不包含任何源自 OpenStreetMap 的数据或署名；
- 虚构名称当然可能与真实地名偶然重合；这不代表任何数据含义。

This is the **test** dataset: the automated gates run on it because it is small and fast.
The richer network used to demonstrate the app lives in [`../demo-showcase/`](../demo-showcase/README.md).

## 布局

```text
demo/
├─ generate.mjs                       # 重新生成下面所有内容
├─ envelopes/
│  ├─ reduced-envelope.json           # 由 prepare:assets 发布给浏览器的信封
│  └─ reviewed-mapping.json           # 演示用的空跨快照白名单
└─ scenarios/
   └─ demo-reduced/                   # 精简（模拟）归档
      ├─ manifest.json
      ├─ source-use.json
      ├─ policies.json
      ├─ reader-payload.json
      └─ LICENSE-OSM.md               # 演示声明；文件名由信封 schema 固定
```

## 数据集

- 一座虚构城市（`示例城`）和一个地铁运营方。
- 一个快照 `simulated-demo-0001`，日期为 `2024-06-01`。
- 两条物理线路、13 座车站、12 个物理区间和两条运营线路。第二条线路与第一条共用 `河湾` 车站，因此可以记录一次带换乘的交通行程。
- 精简数据信封（envelope）声明了 `source_status: simulated` 和 `release_ready: false`。它明确不是授权生产输入。

演示足以覆盖渲染、日期处理、车站选择、记录一次乘车以及完成度统计。它刻意做得较小。

## 重新生成

`generate.mjs` 是已提交文件的唯一来源。它构建归档、计算清单（manifest）摘要（digest）、组装浏览器信封，并且只有真正的精简信封解码器接受结果时才写入。

```bash
node demo/generate.mjs
```

在脚本里改完数据集后重新运行它。输出是确定性的。

## 限制

- 位图图片导出需要授权的署名文本，因此会按设计拒绝合成演示数据；该功能不属于演示。
- 没有跨快照的记录白名单（`reviewed-mapping.json` 为空），因此演示只覆盖单快照记录。
- 演示数据集不能替代私有工作区中使用的授权数据包；如何把工具指向另一个数据根，见 `README.md`。

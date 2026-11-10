# 应用边界

Web 应用共用的、可在浏览器中复用的 ES modules。没有任何第三方运行时依赖；该包通过 `packages/application` 处的 npm workspace 接入。

这些模块在边界处校验不可信输入，返回冻结的、camelCase 命名的路网对象。数据信封（envelope）解码器有两个，是刻意并存的：开发信封解码器只接受授权的 `real-internal-test` 输入，精简信封解码器只接受 `simulated` 输入。本公开仓库附带合成演示数据集，因此默认只会用到精简解码器。

## 模块

`package.json` 导出 16 个运行时模块。测试替身、仅浏览器模块和仅 Node 适配器不属于公开导出面；需要时按相对路径导入。

| 模块 | 类别 | 职责 |
| --- | --- | --- |
| `validation.mjs` | 运行时 | 边界错误，字段/日期/时段校验，摘要（digest），冻结 |
| `reader.mjs` | 运行时 | 把读取器载荷转换为不可变的 camelCase 路网对象 |
| `development-input.mjs` | 运行时 | 授权开发信封：清单（manifest）摘要、来源限制、许可证 |
| `reduced-input.mjs` | 运行时 | 模拟场景信封；拒绝任何真实来源声明 |
| `date-view.mjs` | 运行时 | 日期选择、唯一路径、停运与关闭、名称/里程降级 |
| `records.mjs` | 运行时 | 原始事实校验；通过绑定的端口创建/删除/编辑 |
| `completion.mjs` | 运行时 | 两层完成度、并集总计、车站/城市统计、重新计算 |
| `backup.mjs` | 运行时 | 独立版本、完整性、整体备份拒绝、导入预览与确认 |
| `direction-plan.mjs` | 运行时 | 由环线方向推导的逐段方向计划 |
| `direction-source.mjs` | 运行时 | 从现行运营为已有记录提供方向标签 |
| `folded-loop.mjs` | 运行时 | 把完整的简单环展开为位置序列 |
| `simple-cycle.mjs` | 运行时 | 检测简单环并推导运营中的活跃环 |
| `service-alignment.mjs` | 运行时 | 在业务日期上对齐运营线路与物理区间 |
| `topology-mapping.mjs` | 运行时 | 跨快照记录映射与待处理原因 |
| `history-snapshots.mjs` | 运行时 | 多快照索引与历史日期选择（浏览器安全） |
| `image-export.mjs` | 运行时 | 来源限制、统计与固定署名请求（不生成位图） |
| `fake-storage.mjs` | 测试替身 | 可重置的内存存储端口、提交故障、单写者重开恢复 |
| `idb-storage.mjs` | 仅浏览器 | IndexedDB 单写者存储端口 |
| `canvas-image.mjs` | 仅浏览器 | 通过显式绘制导出 Canvas 2D 位图（不截图） |
| `input-directory.mjs` | 仅 Node | 离线目录适配器；委托给授权导出器 |

## 示例

解码合成演示信封（与 `tools/prepare-web-assets.mjs` 为浏览器发布的形状相同）：

```js
import { readFile } from 'node:fs/promises';
import { decodeReducedEnvelope } from './reduced-input.mjs';
import { sha256 } from './validation.mjs';

const envelope = await readFile('demo/envelopes/reduced-envelope.json', 'utf8');
const { network } = await decodeReducedEnvelope(envelope, await sha256(envelope));
console.log(network.snapshotId, network.stations.length);
```

在内存端口上读取记录并重新计算统计：

```js
import { createMemoryBackend } from './fake-storage.mjs';
import { createRecordApplication } from './records.mjs';
import { buildDateView } from './date-view.mjs';
import { recalculate } from './completion.mjs';

const backend = createMemoryBackend();
const port = backend.open({ tenantId: 'local', profileId: 'default' });
const records = createRecordApplication(port);
const view = buildDateView(network, { onDate, serviceLineId, fromStationId, toStationId });
await records.add(view, { id: crypto.randomUUID(), layer: 'basic' });
await recalculate(port, network, onDate);
const state = port.read(); // 事实、派生、计算结果
```

## 边界规则

- 解码器返回的路网是冻结的，且已经校验；调用方不再重新解析原始载荷。
- 只有物理线路或显式 `sectionIds` 范围可以被停用；范围绝不从运营时间窗推断。
- 计算失败时保留上一次完整结果。事实变更会使旧任务失效；重试读取最新输入。
- 未知快照、无效引用和无法映射的记录保持待处理（未知快照为 `snapshot-mapping-required`），而不是报 `E_SNAPSHOT`。只有未选择快照，或统计日期超出已验证的知识范围时，才使用 `E_SNAPSHOT`。
- 本地存储对每个 `(tenantId, profileId)` 标签页都是单写者。重新打开端口会把已持久化的 `running` 计算改回 `pending`，清除错误，并使旧句柄失效；页面必须显式重试。
- 备份只包含事实：不含租户标识，也不含缓存。导入预览必须先显示固定的警告，调用方才能把预览和显式布尔值传给 `finishImport`。

## 测试

在仓库根目录运行：

```bash
npm run test:application
```

运行器发现 `test/*.test.mjs`，固定预期文件数和用例数（TAP 的 `tests`、`pass`、`fail`），并在文件被清空或测试被跳过时失败。本仓库只附带能在合成演示数据集上运行的测试；绑定授权数据快照的检查维护在私有工作区中。

需要 Node.js 24，与根 `engines` 字段一致。

## 许可证

AGPL-3.0-or-later。见 [LICENSE](../../LICENSE)。

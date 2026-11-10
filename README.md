# Noritsubushi 前端

用于记录交通网络上的行程并计算完成度统计的浏览器前端。应用完全在浏览器中运行：路网来自经过校验、带摘要（digest）检查的 JSON 数据信封（envelope），用户的记录则存储在本地 IndexedDB 中。没有账户体系，也没有服务端存储。

本仓库是公开前端仓库，包含 Web 应用、共享应用模块和一份 **合成** 演示数据集。授权数据快照、数据导出流水线和后端服务不在本仓库中。

## 快速开始

要求：Node.js 24（`>=24.15.0 <25`，见 `.node-version`）与 npm `>=10.8.2 <12`。演示不需要 Python 或其他运行时。

```bash
npm ci --ignore-scripts
npm run dev
```

`npm run dev` 先发布演示信封，然后在 <http://127.0.0.1:5173> 启动 Vite。

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm run prepare:assets` | 解码数据根中的数据信封，并发布给浏览器 |
| `npm run demo:generate` | 重新生成 `demo/` 中的合成演示数据集 |
| `npm run dev` | 准备资源并在 `127.0.0.1:5173` 启动开发服务器 |
| `npm run typecheck` | 准备资源并用 `vue-tsc` 对 Web 应用做类型检查 |
| `npm test` | 先跑应用测试，再跑 Web 测试套件 |
| `npm run build` | 先做类型检查，再构建生产包 |
| `npm run preview` | 在 `127.0.0.1:4173` 上提供现有的 `dist` |
| `npm run verify:gates` | 反向探针，证明类型检查与测试发现确实生效 |

所有命令都应以退出码 0 结束。演示流水线不需要网络连接。

## 数据根

应用在运行时不从固定目录读取数据。资源在构建/启动时从 **数据根** 发布：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `NORITSU_DATA_ROOT` | `demo` | 数据根，相对本仓库（也可用绝对路径） |
| `NORITSU_DEMO_SCENARIO` | `demo-reduced` | 演示测试使用的场景目录，位于 `<data root>/scenarios/` 下 |

数据根包含 `envelopes/reduced-envelope.json`（模拟输入），可选地包含 `envelopes/development-envelope.json`（授权输入）和 `envelopes/reviewed-mapping.json`（跨快照的记录白名单）。演示目录结构见 [`demo/README.md`](demo/README.md)，发布细节见 [`apps/web/README.md`](apps/web/README.md)。

## 仓库结构

```text
.
├─ apps/web/               # Vue 3 Web 应用（源码、测试、Vite/Vitest 配置）
├─ packages/application/   # 共享 ES 模块：读取器、记录、统计、存储
├─ tools/
│  ├─ prepare-web-assets.mjs   # 发布数据信封；写入生成的清单
│  ├─ test-application.mjs     # 应用测试运行器，固定文件数与用例数
│  └─ verify-web-gates.mjs     # 类型门禁与测试发现门禁的反向探针
├─ demo/                   # 合成演示数据集（见 demo/README.md）
├─ package.json            # workspaces 与脚本
└─ LICENSE                 # AGPL-3.0
```

## 演示数据

`demo/` 包含一个刻意做得很小、完全虚构的路网（一座城市、一个运营方、两条线路、13 座车站）。它让项目无需任何授权数据即可克隆、构建和运行。它不是真实数据；生成器和声明文件对此有说明。用 `npm run demo:generate` 可以重新生成。

## 测试与验证

- `npm run test:application` 在演示数据集上运行应用模块的测试。运行器会固定测试发现到的文件数与用例数。
- `npm run test:ui` 运行 `apps/web/test/` 中的 Vitest 测试套件，它们使用合成测试夹具和内存适配器。不需要网络访问。
- `npm run verify:gates` 创建两个临时探针（一个类型错误、一个断言失败），确认两者都因预期原因失败，然后删除它们并验证源文件字节未变。

### 公开测试集为什么只是子集

公开仓库只带能在合成数据上运行的检查：2 个应用测试文件（13 个用例）和 45 个前端测试文件（431 个用例）。测试集的其余部分针对授权数据快照断言——真实拓扑、场景归档和来源评审：14 个应用测试文件 + 14 个前端测试文件。这些测试与数据一起位于私有工作区中。它们在这里并未被跳过，只是不属于本仓库，因此也没有能打开它们的开关。

如果你是能访问授权数据的维护者，完整测试集在私有工作区中运行，那里同时包含这些测试和一个带 `envelopes/` 的数据根。按 [`apps/web/README.md`](apps/web/README.md) 的说明，用 `NORITSU_DATA_ROOT` 把工具指向该数据根；公开仓库有意无法复现那次运行。

## 许可证

本项目采用 GNU Affero 通用公共许可证第 3 版或更高版本（AGPL-3.0-or-later）授权。完整许可证文本见 [`LICENSE`](LICENSE)。

由于本项目以网络服务形式提供，AGPL 的远程网络交互条款适用：如果你将修改后的版本作为服务运行，必须向用户提供其源代码。

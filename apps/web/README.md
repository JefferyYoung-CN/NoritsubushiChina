# Web 前端

用于浏览和搜索交通网络、在地图上绘制路网、在浏览器中记录基础行程与高级行程、计算完成度统计，以及导出/导入备份的 Vue 3 单页应用。记录存储在本地 IndexedDB 中；应用从不写入服务器。

应用加载经过校验的应用数据信封（envelope）。在公开仓库中，信封由 `demo/` 的合成演示数据集构建；授权数据流水线不在本仓库中。

## 要求

- Node.js 24（`>=24.15.0 <25`，已用 `24.22.1` 验证；见 `.node-version`）
- npm `10.8.2`（或 `>=10.8.2 <12` 内的任意版本）
- 演示数据集不需要 Python 或其他运行时。

## 命令

在仓库根目录运行：

```bash
npm ci --ignore-scripts
npm run dev          # 生成演示资源，然后在 http://127.0.0.1:5173 启动 Vite
npm run typecheck    # vue-tsc --noEmit
npm test             # 应用测试 + Web 测试
npm run build        # 先类型检查，再 vite build
npm run preview      # 在 http://127.0.0.1:4173 提供现有的 dist
npm run verify:gates # 类型检查与测试发现的反向探针
```

所有检查都应以退出码 0 结束。开发服务器和预览服务器只绑定 `127.0.0.1`。`preview` 需要先执行过 `npm run build`。

Web Crypto 需要安全上下文；`http://127.0.0.1` 和 `http://localhost` 满足这一要求。远程部署必须使用 HTTPS。

## 资源与数据根

`npm run prepare:assets` 运行 `tools/prepare-web-assets.mjs`。它读取数据根，解码其中找到的数据信封，并把它们发布到 `apps/web/public/application-input/`，同时生成 `apps/web/.generated/` 下的 TypeScript 清单（manifest）。两个输出目录都被 git 忽略，并会由该命令重建。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `NORITSU_DATA_ROOT` | `demo` | 数据根，相对仓库根（也可用绝对路径）。 |
| `NORITSU_DEMO_SCENARIO` | `demo-reduced` | 演示测试使用的场景目录，位于 `<data root>/scenarios/` 下。 |

数据根必须提供 `envelopes/reduced-envelope.json`，也可提供 `envelopes/development-envelope.json` 和 `envelopes/reviewed-mapping.json`。`demo/README.md` 说明了演示目录结构。信封损坏或无法校验时，命令会带着诊断信息停止，而不会把它送进浏览器。

## 测试

- `npm run test:application` 运行 `packages/application` 中能在合成演示数据集上工作的测试；运行器固定测试发现到的文件数与用例数，因此测试发现被悄悄改动会导致门禁失败。
- `npm run test:ui` 运行 `test/` 中的 Vitest 测试套件。它使用合成测试夹具和内存适配器；不需要网络访问。

需要授权数据快照的检查（真实拓扑、场景归档、来源评审）与那份数据一起维护在私有工作区中，并且有意不属于本仓库；公开测试集只是合成数据子集。持有授权数据根的维护者可以在那个私有工作区运行完整测试集，而不是在这里。

## 布局

```text
apps/web/
├─ index.html
├─ src/            # 应用入口、视图、组件、地图、集成辅助模块
├─ test/           # Vitest 测试套件
├─ public/         # 静态文件；application-input/ 为生成目录
├─ vite.config.ts
└─ tsconfig.json
```

## 许可证

AGPL-3.0-or-later。见 [LICENSE](../../LICENSE)。

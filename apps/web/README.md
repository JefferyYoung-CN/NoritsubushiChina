# Web frontend

Vue 3 single-page app for browsing and searching a transit network, drawing the
network on a map, recording basic and advanced trips in the browser, computing
completion statistics, and exporting/importing backups. Records are stored
locally in IndexedDB; the app never writes to a server.

The app loads a verified application envelope. In this public repository the
envelope is built from the synthetic demo dataset in `demo/`; the licensed data
pipeline is not part of this repository.

## Requirements

- Node.js 24 (`>=24.15.0 <25`, verified with `24.22.1`; see `.node-version`)
- npm `10.8.2` (or any version in `>=10.8.2 <12`)
- No Python or other runtime is needed for the demo dataset.

## Commands

Run from the repository root:

```bash
npm ci --ignore-scripts
npm run dev          # generate the demo assets, then start Vite on http://127.0.0.1:5173
npm run typecheck    # vue-tsc --noEmit
npm test             # application tests + web tests
npm run build        # typecheck, then vite build
npm run preview      # serve the existing dist on http://127.0.0.1:4173
npm run verify:gates # negative probes for typecheck and test discovery
```

All checks are expected to exit with code 0. The dev and preview servers bind to
`127.0.0.1` only. `preview` needs a previous `npm run build`.

Web Crypto requires a secure context; `http://127.0.0.1` and
`http://localhost` qualify. A remote deployment must use HTTPS.

## Assets and the data root

`npm run prepare:assets` runs `tools/prepare-web-assets.mjs`. It reads a data
root, decodes the envelopes it finds there, and publishes them to
`apps/web/public/application-input/` plus the generated TypeScript manifest in
`apps/web/.generated/`. Both output directories are ignored by git and are
recreated by the command.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `NORITSU_DATA_ROOT` | `demo` | Data root, relative to the repository root (or absolute). |
| `NORITSU_DEMO_SCENARIO` | `demo-reduced` | Scenario directory used by the demo tests under `<data root>/scenarios/`. |

A data root must provide `envelopes/reduced-envelope.json` and may provide
`envelopes/development-envelope.json` and `envelopes/reviewed-mapping.json`.
`demo/README.md` documents the demo layout. A corrupt or unverifiable envelope
stops the command with a diagnostic instead of reaching the browser.

## Tests

- `npm run test:application` runs the `packages/application` tests that work on
  the synthetic demo dataset; the runner pins the discovered file and test
  counts so a silent discovery change fails the gate.
- `npm run test:ui` runs the Vitest suite in `test/`. It uses synthetic fixtures
  and in-memory adapters; no network access is required.

Checks that need a licensed data snapshot (real topology, scenario archives,
source reviews) are maintained in the private workspace together with that data
and are intentionally not part of this repository; the public suite is the
synthetic-data subset. A maintainer with a licensed data root can run the full
suite from that private workspace, not from here.

## Layout

```text
apps/web/
├─ index.html
├─ src/            # app entry, views, components, map, integration helpers
├─ test/           # Vitest suites
├─ public/         # static files; application-input/ is generated
├─ vite.config.ts
└─ tsconfig.json
```

## License

AGPL-3.0-or-later. See [LICENSE](../../LICENSE).

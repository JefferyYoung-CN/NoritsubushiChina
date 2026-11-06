# Noritsubushi frontend

Browser frontend for recording trips on a transit network and computing
completion statistics. The app runs entirely in the browser: the network comes
from a verified, digest-checked JSON envelope, and the user's records are stored
locally in IndexedDB. There is no account system and no server-side storage.

This repository is the public frontend repository. It contains the web app, the
shared application modules and a **synthetic** demo dataset. The licensed data
snapshots, the data-export pipeline and the backend services are not part of this
repository.

## Quick start

Requirements: Node.js 24 (`>=24.15.0 <25`, see `.node-version`) and npm
`>=10.8.2 <12`. No Python or other runtime is needed for the demo.

```bash
npm ci --ignore-scripts
npm run dev
```

`npm run dev` first publishes the demo envelope, then starts Vite on
<http://127.0.0.1:5173>.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run prepare:assets` | Decode the envelopes in the data root and publish them for the browser |
| `npm run demo:generate` | Regenerate the synthetic demo dataset in `demo/` |
| `npm run dev` | Prepare assets and start the dev server on `127.0.0.1:5173` |
| `npm run typecheck` | Prepare assets and type-check the web app with `vue-tsc` |
| `npm test` | Application tests, then the web test suite |
| `npm run build` | Type-check, then build the production bundle |
| `npm run preview` | Serve the existing `dist` on `127.0.0.1:4173` |
| `npm run verify:gates` | Negative probes proving type-check and test discovery work |

All commands are expected to exit with code 0. The demo pipeline does not need a
network connection.

## Data root

The app does not read data from a fixed directory at runtime. Assets are
published at build/start time from a **data root**:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NORITSU_DATA_ROOT` | `demo` | Data root, relative to this repository (or absolute) |
| `NORITSU_DEMO_SCENARIO` | `demo-reduced` | Scenario directory under `<data root>/scenarios/` used by the demo tests |

A data root contains `envelopes/reduced-envelope.json` (simulated input) and
optionally `envelopes/development-envelope.json` (licensed input) and
`envelopes/reviewed-mapping.json` (cross-snapshot record whitelist). See
[`demo/README.md`](demo/README.md) for the demo layout and
[`apps/web/README.md`](apps/web/README.md) for the publishing details.

## Repository layout

```text
.
├─ apps/web/               # Vue 3 web app (source, tests, Vite/Vitest config)
├─ packages/application/   # Shared ES modules: readers, records, statistics, storage
├─ tools/
│  ├─ prepare-web-assets.mjs   # Publishes envelopes; writes the generated manifest
│  ├─ test-application.mjs     # Application test runner with pinned counts
│  └─ verify-web-gates.mjs     # Negative probes for the type and test gates
├─ demo/                   # Synthetic demo dataset (see demo/README.md)
├─ package.json            # Workspaces and scripts
└─ LICENSE                 # AGPL-3.0
```

## Demo data

`demo/` contains a deliberately small, entirely fictional network (one city, one
operator, two lines, 13 stations). It exists so the project can be cloned,
built and run without any licensed data. It is not real-world data; the
generator and the notice file document this. Recreate it with
`npm run demo:generate`.

## Tests and verification

- `npm run test:application` runs the application modules' tests on the demo
  dataset. The runner pins the discovered file and test counts.
- `npm run test:ui` runs the Vitest suites in `apps/web/test/`, which use
  synthetic fixtures and in-memory adapters. No network access is required.
- `npm run verify:gates` creates two temporary probes (one type error, one
  failing assertion), confirms both fail for the intended reason, then removes
  them and verifies the source bytes are unchanged.

### Why the public test suite is a subset

The public repository ships checks that can run on synthetic data:
2 application test files (13 cases) and 45 web test files (431 cases). The rest
of the test suite asserts against licensed data snapshots — real topology,
scenario archives and source reviews: 14 application test files and 14 web test
files. Those tests live in the private workspace together with the data. They
are not skipped here; they are simply not part of this repository, so there is
no flag that turns them on.

If you are a maintainer with access to the licensed data, the full suite runs
from the private workspace, which contains both those tests and a data root with
`envelopes/`. Point its tools at that root with `NORITSU_DATA_ROOT` as described
in [`apps/web/README.md`](apps/web/README.md); the public repository intentionally
cannot reproduce that run.

## License

This project is licensed under the GNU Affero General Public License, version 3
or later (AGPL-3.0-or-later). The full license text is in [`LICENSE`](LICENSE).

Because the project is offered as a network service, the AGPL's
remote-network-interaction terms apply: if you run a modified version as a
service, you must offer its source to the users.

# Application boundary

Browser-reusable ES modules shared by the web app. There are no third-party
runtime dependencies; the package is wired in through an npm workspace at
`packages/application`.

The modules validate untrusted input at the boundary and return frozen,
camelCase network objects. Two envelope decoders exist on purpose: the
development-envelope decoder accepts only licensed `real-internal-test` input,
while the reduced-envelope decoder accepts only `simulated` input. This public
repository ships the synthetic demo dataset, so only the reduced decoder is
exercised by default.

## Modules

`package.json` exports 16 runtime modules. Test doubles, browser-only modules and
the Node-only adapter are not part of the public export surface; import them by
relative path when needed.

| Module | Category | Responsibility |
| --- | --- | --- |
| `validation.mjs` | runtime | Boundary errors, field/date/period validation, digests, freezing |
| `reader.mjs` | runtime | Converts the reader payload into immutable camelCase network objects |
| `development-input.mjs` | runtime | Licensed development envelope: manifest digests, source restrictions, license |
| `reduced-input.mjs` | runtime | Simulated scenario envelope; rejects any real-source claim |
| `date-view.mjs` | runtime | Date selection, unique paths, suspensions and closures, name/mileage degradation |
| `records.mjs` | runtime | Raw fact validation; create/delete/edit through a bound port |
| `completion.mjs` | runtime | Two-layer completion, union totals, station/city statistics, recalculation |
| `backup.mjs` | runtime | Independent version, integrity, whole-backup rejection, import preview and confirmation |
| `direction-plan.mjs` | runtime | Per-leg direction plan derived from a loop direction |
| `direction-source.mjs` | runtime | Direction labels for existing records from active services |
| `folded-loop.mjs` | runtime | Expands a complete simple loop into a positional sequence |
| `simple-cycle.mjs` | runtime | Detects simple loops and derives the active cycle of a service |
| `service-alignment.mjs` | runtime | Aligns service lines with physical sections on a business date |
| `topology-mapping.mjs` | runtime | Cross-snapshot record mapping and pending reasons |
| `history-snapshots.mjs` | runtime | Multi-snapshot index and historical date selection (browser-safe) |
| `image-export.mjs` | runtime | Source restrictions, statistics and fixed attribution request (no bitmap) |
| `fake-storage.mjs` | test double | Resettable in-memory storage port, commit faults, single-writer reopen recovery |
| `idb-storage.mjs` | browser only | IndexedDB single-writer storage port |
| `canvas-image.mjs` | browser only | Canvas 2D bitmap export by explicit drawing (no screenshots) |
| `input-directory.mjs` | Node only | Offline directory adapter; delegates to the licensed exporter |

## Examples

Decode the synthetic demo envelope (the same shape `tools/prepare-web-assets.mjs`
publishes for the browser):

```js
import { readFile } from 'node:fs/promises';
import { decodeReducedEnvelope } from './reduced-input.mjs';
import { sha256 } from './validation.mjs';

const envelope = await readFile('demo/envelopes/reduced-envelope.json', 'utf8');
const { network } = await decodeReducedEnvelope(envelope, await sha256(envelope));
console.log(network.snapshotId, network.stations.length);
```

Read records and recalculate statistics against an in-memory port:

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
const state = port.read(); // facts, derived, calculation
```

## Boundary rules

- The network returned by a decoder is frozen and already validated; callers do
  not re-parse raw payloads.
- Only physical line or explicit `sectionIds` scopes may be retired; the scope is
  never inferred from service windows.
- A calculation failure keeps the last complete result. A fact change invalidates
  the old task; retries read the latest input.
- Unknown snapshots, invalid references and unmappable records stay pending
  (`snapshot-mapping-required` for an unknown snapshot) instead of reporting
  `E_SNAPSHOT`. `E_SNAPSHOT` is only used when no snapshot was selected or the
  statistics date is outside the verified knowledge horizon.
- Local storage is single-writer per `(tenantId, profileId)` tab. Reopening a
  port turns a persisted `running` calculation back into `pending`, clears the
  error, and fences the old handle; the page must explicitly retry.
- Backups contain facts only: no tenant identifier and no cache. The import
  preview must show the fixed warning before the caller passes the preview and an
  explicit boolean to `finishImport`.

## Tests

From the repository root:

```bash
npm run test:application
```

The runner discovers `test/*.test.mjs`, pins the expected file count and test
count (TAP `tests`, `pass`, `fail`), and fails if a file is emptied or a test is
skipped. This repository only ships tests that run on the synthetic demo
dataset; checks bound to a licensed data snapshot are maintained in the private
workspace.

Node.js 24 is required, matching the root `engines` field.

## License

AGPL-3.0-or-later. See [LICENSE](../../LICENSE).

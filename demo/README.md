# Synthetic demo dataset

This directory holds a small **synthetic** transit network so the web app and the
demo-compatible tests can run without any licensed data. Nothing here is real:

- the city, the operator, the line names, the station names, the order of the
  stations, the mileage values and the coordinates are invented for the demo;
- no content is copied from the maintainers' internal data packages, and no
  OpenStreetMap-derived data or attribution is included;
- fictional names can of course coincide with real place names by chance; that
  carries no data meaning.

## Layout

```text
demo/
├─ generate.mjs                       # regenerates everything below
├─ envelopes/
│  ├─ reduced-envelope.json           # browser envelope published by prepare:assets
│  └─ reviewed-mapping.json           # empty cross-snapshot whitelist for the demo
└─ scenarios/
   └─ demo-reduced/                   # reduced (simulated) archive
      ├─ manifest.json
      ├─ source-use.json
      ├─ policies.json
      ├─ reader-payload.json
      └─ LICENSE-OSM.md               # demo notice; file name is fixed by the envelope schema
```

## Dataset

- One fictional city (`示例城`) and one metro operator.
- One snapshot, `simulated-demo-0001`, as of `2024-06-01`.
- Two physical lines, 13 stations, 12 physical sections and two service lines.
  The second line shares the `河湾` station with the first one, so recording a
  transport with an interchange is possible.
- The reduced envelope declares `source_status: simulated` and
  `release_ready: false`. It is explicitly not a licensed production input.

The demo is enough to exercise rendering, date handling, station selection,
recording a ride, and the completion statistics. It is deliberately small.

## Regenerating

`generate.mjs` is the single source of the committed files. It builds the
archive, computes the manifest digests, assembles the browser envelope, and
refuses to write the result unless the real reduced-envelope decoder accepts it.

```bash
node demo/generate.mjs
```

Re-run it after changing the dataset in the script. The output is deterministic.

## Limitations

- Bitmap image export requires the licensed attribution text and therefore
  rejects the synthetic demo data by design; the feature is not part of the
  demo.
- There is no cross-snapshot record whitelist (`reviewed-mapping.json` is
  empty), so the demo only covers single-snapshot recording.
- The demo dataset is not a substitute for the licensed data packages used in
  the private workspace; see `README.md` for how to point the tools at another
  data root.

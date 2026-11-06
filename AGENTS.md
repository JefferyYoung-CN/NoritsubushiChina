# AGENTS.md

Instructions for AI coding agents working in this repository. Follow the
repository documentation and the code's own conventions when they are more
specific; this file only records rules that are easy to get wrong.

## Repository scope

- This is the public frontend repository. It contains the web app, the shared
  application modules and a synthetic demo dataset.
- Never add licensed or private data, source-restricted snapshots, credentials,
  internal documents, or references to a private workspace. `demo/` is the only
  sample data and it is synthetic.
- Do not add a dependency, a generated directory, or a build artifact unless the
  task explicitly calls for it. `apps/web/.generated/`,
  `apps/web/public/application-input/` and `apps/web/dist/` are generated and
  git-ignored; do not edit or commit them.

## Commands

Use Node.js 24 (`>=24.15.0 <25`; see `.node-version`) and npm `>=10.8.2 <12`.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run verify:gates
npm run demo:generate
```

`typecheck`, `test` and `build` prepare the demo assets first. All commands are
expected to exit 0. If a check cannot run in your environment, report it as not
run with the reason; never report it as passed.

## Data and assets

- The data root is `NORITSU_DATA_ROOT` (default `demo`, resolved against the
  repository root). `NORITSU_DEMO_SCENARIO` selects the scenario directory used
  by demo tests (default `demo-reduced`).
- `tools/prepare-web-assets.mjs` only consumes pre-generated envelopes; it must
  decode and verify them before publishing. Keep it free of licensed-data
  paths and of the private export pipeline.
- `demo/generate.mjs` is the single source of the committed demo files. Change
  the dataset in the script and re-run it; do not hand-edit the generated JSON.
- The demo data must stay obviously synthetic. Do not copy real station names,
  line identifiers, mileage or coordinates into it.

## Tests

- Tests must run on the synthetic demo dataset or in-memory fixtures. Do not add
  tests that need a licensed data snapshot.
- Keep assertion strength. Do not rewrite a test expectation to make a failure
  pass; if the contract changed, update the test deliberately and say so.
- When adding or removing application tests, update `EXPECTED_TEST_FILES` and
  `EXPECTED_TESTS` in `tools/test-application.mjs` in the same change.
- Include a negative check when changing validation, type checking or test
  discovery, and confirm it fails for the intended reason.

## Code

- Validate untrusted input at the boundary and return frozen, validated values.
  Do not leak raw payload shapes into views or storage.
- Keep modules focused and files below roughly 500 lines; split by
  responsibility when a file grows past that.
- Prefer deleting obsolete code over adding compatibility shims.
- Leave a short comment for a non-obvious decision, with its reason and any
  known limitation. Avoid comments that narrate the diff.
- UI work must cover loading, empty, error, retry and feedback states and keep
  keyboard accessibility.

## Git and review

- Do not run `git push`, `git tag`, or publish releases; the maintainers do that.
- Keep commits focused. Do not commit generated output, data files, editor
  configuration, or machine-specific paths.
- In commit messages and pull request text, describe the behavior change and its
  reason. Do not reference private systems, internal task identifiers or private
  paths.

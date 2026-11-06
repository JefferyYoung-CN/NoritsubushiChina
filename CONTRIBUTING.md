# Contributing

Thanks for improving the project. This document describes how to propose a
change and what a reviewable change looks like.

## Before you start

- Read [`README.md`](README.md) and the README of the area you want to change
  (`apps/web/`, `packages/application/`).
- For a non-trivial behavior change, open an issue or a draft pull request first
  so the approach can be discussed before implementation.
- Never submit licensed or private data, credentials, or screenshots of either.
  This repository is public; the demo dataset in `demo/` is synthetic and is the
  only sample data it ships.

## Setup

Requirements: Node.js 24 (`>=24.15.0 <25`, see `.node-version`) and npm
`>=10.8.2 <12`.

```bash
npm ci --ignore-scripts
npm run dev
```

## Checks

Every change must pass:

```bash
npm run typecheck
npm test
npm run build
```

`npm run verify:gates` additionally proves that the type gate and the test
discovery gate still fail for a deliberately broken probe; run it when you touch
those configurations.

Generated directories — `apps/web/.generated/`, `apps/web/public/application-input/`
and `apps/web/dist/` — are ignored by git. Do not edit or commit them; they are
recreated by `npm run prepare:assets` / `npm run build`.

## Tests

- Add or update tests for the behavior you change. Test the user-visible or
  contractual behavior, not private implementation details.
- Tests must be able to run on the synthetic demo dataset and in-memory fixtures.
  Checks that require a licensed data snapshot do not belong in this repository.
- The application test runner (`tools/test-application.mjs`) pins the number of
  discovered test files and test cases. When you add or remove a test, update
  `EXPECTED_TEST_FILES` and `EXPECTED_TESTS` in the same change.
- Do not weaken or delete an assertion to make a test pass. If the business rule
  changed, explain why in the pull request and update the tests deliberately.

## Code guidelines

- Follow the surrounding style; keep modules focused and files below roughly 500
  lines, splitting by responsibility when a file grows past that.
- Keep validation at the boundary. Data coming from an envelope or from the
  user's storage is untrusted; validate it and convert it to the internal
  representation instead of leaking raw shapes into views.
- Do not introduce a dependency for a small utility. Discuss new runtime
  dependencies first; the application package intentionally has none.
- Record the reason for non-obvious decisions and known limitations in a comment
  or documentation, with enough context for the next maintainer.
- UI changes must keep loading, empty, error, retry and feedback states, and must
  remain keyboard accessible.

## Pull requests

A good pull request:

- is focused on one concern and does not mix unrelated refactors;
- states the user-visible or contractual change and the verification performed;
- lists any check that could not be run, with the reason;
- does not include build output, data files, or machine-specific configuration.

Commit messages describe the change and its reason. Reference issue numbers when
they exist.

## License

By contributing you agree that your contribution is licensed under the
project's AGPL-3.0 license (see [`LICENSE`](LICENSE)).

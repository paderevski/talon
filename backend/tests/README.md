# Backend Regression Tests

This folder contains lightweight integration/regression tests for backend behavior.

## Run

From workspace root:

- `npm run test:backend`
- `npm run test:regression`

From `backend/`:

- `npm test`
- `npm run test:regression`

## Current coverage

- `health.test.mjs` checks `/api/health`.
- `hybrid-artifacts.test.mjs` verifies `/api/jobs/:id/files` returns artifacts from both:
  - `output_dir`
  - `repo_changed`

## Add a new regression test

1. Add a new file in `cases/` named `*.test.mjs`.
2. Export:
   - `name` (string)
   - `run({ baseUrl })` (async function)
3. Run `npm run test:backend`.

Keep tests focused on API behavior and avoid assumptions about UI state.

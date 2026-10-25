# Backend Regression Tests

This folder contains lightweight integration/regression tests for backend behavior.

## Run

Needs a local Postgres with an empty database named `talon_test`
(`createdb talon_test`; override with `TEST_DATABASE_URL`). Each run drops and
recreates its schema, runs migrations, and seeds the demo users. Only
databases whose name contains "test" are accepted. Run the two suites one
after the other, not at the same time: they share that database.
`npm run test:postgres --workspace backend` runs the repository, budget and
session tests.

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

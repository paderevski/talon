# Talon

Talon is an educational GPU/CPU job portal for the Academy of Loudoun (LCPS).
Students submit training jobs from a GitHub repository and run them on their
own EC2 machine, teachers manage classes and budgets, and admins oversee
everything.

- **Students** pick a machine (memory, CPUs, price per hour) and a time limit,
  see what the job can cost, and watch logs while it runs. Jobs are charged to
  a personal compute budget per second of use; the maximum is set aside when a
  job starts and the unused part is returned. Output files and results are
  kept for 30 days.
- **Teachers** see their classes, hand out budget from a pool, and view their
  students' jobs read-only.
- **Admins** manage users, roles, classes and budgets (including CSV roster
  import) and can run jobs themselves.

A user can hold several roles. Identity comes only from the session cookie.

## Project structure

- `backend/` Express API: `src/routes`, `src/auth` (sessions, roles, access
  scope), `src/services`, `src/execution` (job adapters), `src/budget/ledger.js`,
  `src/repositories/postgres`, `migrations/` (numbered SQL), `tests/`
- `frontend/` React (Vite) app: `src/App.jsx`, `components/`, `api/client.js`
- `shared/` status and repo helpers used by both
- `infra/` Terraform, scripts and notes for the AWS demo box (start with
  [`infra/README.md`](infra/README.md) and
  [`infra/CURRENT_STATUS.md`](infra/CURRENT_STATUS.md), which is the map of
  what is running, what is done and what is next)
- `infra_2/` an older EKS design, kept for reference only

Money is integer cents in the ledger and dollars in API responses. Jobs and
results are scoped by the signed-in user on the server.

## Run locally

Talon needs a local Postgres 16 (e.g. `brew install postgresql@16`). One-time
setup:

```bash
createdb talon_dev
createdb talon_test                  # only for the test suites
npm install
npm run db:migrate --workspace backend
npm run db:seed:demo --workspace backend   # demo users (wipes the DB; dev only)
```

Then, every time:

```bash
npm run dev                          # applies pending migrations, then starts both servers
```

The backend reads `DATABASE_URL` (default `postgres://localhost/talon_dev`).
This starts the frontend on `http://localhost:5173` and the backend on
`http://localhost:5174`.

### Demo logins

These passwords are public on purpose (they are in this repo), so never expose
a server that has them.

| Role | Username | Password |
|---|---|---|
| admin | `admin` | `admin123` |
| teacher | `teacher_ada` | `teach123` |
| student | `student_a1` | `student123` |
| student | `jane_smith` | `talon123` |

Chrome may show a "password found in a breach" dialog on login; dismiss it.

### Tests

```bash
npm run test:backend                       # HTTP regression tests (resets and seeds talon_test)
npm run test:postgres --workspace backend  # repository, budget, EC2 adapter and session tests
```

Run them one after the other, never in parallel: they share `talon_test`. The
frontend has no automated tests; check UI changes by running the app (or at
least `npm run build --workspace frontend`).

## How jobs run

Job submission goes through an execution adapter
(`start / getStatus / getLogs / listOutputFiles / cancel`). A job's execution
reference names its provider, so status, logs, files and cancel always go to
the adapter that started it.

- **EC2** (students and admins; `EC2_JOBS_ENABLED=true`). Each job gets its own
  EC2 instance. The web server clones the repo, ships it to S3 and launches an
  instance from a launch template; the instance runs the entry script as an
  unprivileged user under a time limit and writes `status.json`, logs and
  output files back to S3, then terminates itself. The web server only reads S3.
  A reconciler on the web server finalizes finished jobs, charges them, and
  terminates stray or overrun instances. Limits: one unfinished job per user
  (admins exempt) and ten in total. Design notes and verification are in
  [`infra/CURRENT_STATUS.md`](infra/CURRENT_STATUS.md).
- **Local** (the default for admins, tests and development). Runs the job as a
  process on the web server. For development, tests and admins only: there is
  no isolation, and in production it is refused for non-admins.

Settings (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `EC2_JOBS_ENABLED` | off | Turn on EC2 jobs and the reconciler |
| `EC2_JOBS_ADMIN_ONLY` | off | Kill switch: limit EC2 jobs to admins |
| `EC2_MAX_JOBS_PER_USER` / `EC2_MAX_JOBS_TOTAL` | 1 / 10 | Unfinished EC2 jobs allowed |
| `EC2_MAX_RUNTIME_CEILING_SECONDS` | 86400 | Longest time limit offered |
| `JOB_RATE_OVERHEAD_CENTS_PER_HOUR` | 1 | Added to the instance rate (IPv4, disk) |
| `JOB_BOOT_ALLOWANCE_SECONDS` | 300 | Boot and upload time added when reserving |
| `TALON_ALLOW_LOCAL_JOBS` | off | Allow local runs for non-admins in production |
| `JOB_MAX_RUNTIME_SECONDS` | 1800 | Time limit for local runs |
| `JOB_RATE_CENTS_PER_HOUR` | 0 | Rate for local runs (0 = free) |

On AWS the bucket, launch template and subnets come from SSM parameters under
`/talon/<env>/` (created by Terraform), not from environment variables.

## API

All routes except `/api/health` and `/api/auth/*` need a signed-in session.

- Auth: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`,
  `POST /api/auth/password`
- Jobs: `GET /api/jobs`, `POST /api/jobs`, `GET /api/jobs/compute-options`,
  `GET /api/jobs/:id`, `GET /api/jobs/:id/logs?cursor=0`,
  `GET /api/jobs/:id/files`, `GET /api/jobs/:id/files/download`,
  `POST /api/jobs/:id/cancel`, `DELETE /api/jobs/:id` (hide),
  `POST /api/jobs/:id/unhide`
- Results and repos: `GET /api/results`, `GET /api/repos/:owner/:repo/tree`
- GitHub credentials: `GET|PUT|DELETE /api/github-credentials`,
  `GET /api/github-credentials/repos/:username`
- Teacher: `/api/teacher/*` (roster and budget allocations)
- Admin: `/api/admin/*` (users, classes, budget adjustments, CSV roster import)

## GitHub PAT setup

Users can save a GitHub personal access token for Talon to use with GitHub
API calls.

- The user pastes the PAT in the **GitHub Credentials** panel. The backend
  validates it (`GET https://api.github.com/user`) and stores it encrypted
  (AES-256-GCM) in the Postgres table `github_credentials`, one row per user.
  It can be replaced or deleted from the same panel. These endpoints are scoped
  to the signed-in user.

### Encryption key

Set `TALON_CREDENTIALS_KEY` in every non-dev environment. In production
(`NODE_ENV=production`) the backend refuses to start without it; in dev a
built-in key is used. On the AWS demo it comes from SSM Parameter Store.

Each stored token records the id of the key that encrypted it
(`TALON_CREDENTIALS_KEY_ID`, default `k1`) and is bound to its owner, so a row
copied to another user will not decrypt. To rotate the key: set the new secret
and a new `TALON_CREDENTIALS_KEY_ID`, list the old one in
`TALON_CREDENTIALS_OLD_KEYS="k1:old-secret"`, restart, run
`npm run db:rotate-credentials-key --workspace backend`, then remove the old
key. Changing the key without following these steps makes stored tokens
unreadable; they must be saved again. Tokens from the old
`githubCredentials.json` file can be loaded once with
`npm run db:import-github-credentials --workspace backend`.

### Security notes

- Never log PAT values. Use a strong, unique `TALON_CREDENTIALS_KEY` per
  environment. Rotate PATs regularly and delete unused ones.

### For users: create a PAT and add it to Talon

1. In GitHub open **Settings**, then **Developer settings**, then **Personal
   access tokens**, and choose **Fine-grained tokens** (recommended).
2. Click **Generate new token**, pick your account or organization, set an
   expiration date and a name (for example `talon-access`).
3. Grant **Contents: Read-only** and **Metadata: Read-only**, then generate the
   token and copy it immediately (GitHub shows it once).
4. In Talon open **GitHub Credentials**, paste the token and click **Save
   Token**. A masked suffix like `...abcd` confirms it. Use **Replace Token** or
   **Delete Token** to change it later.

## Tips for writing jobs

- The entry script runs from the repository root as an unprivileged user; a
  `requirements.txt` there is installed first (that time counts against the
  time limit).
- Print progress: output is unbuffered and appears in the job log while the
  job runs.
- Files written to the directory in the `TALON_OUTPUT_DIR` environment
  variable, and files you create or change in the repository directory, are
  saved (up to 500 files, 200 MB per file and 500 MB in total). Python buffers
  file writes, so call `flush()` or close files as you go: a job stopped by its
  time limit, a cancel or running out of memory loses what was not flushed.
- Exit code 137 usually means the script ran out of memory; choose a machine
  with more memory.

## Deploy

The demo runs on one EC2 instance reachable only through an SSM tunnel. Creating
it, deploying a branch, and the Terraform workflow are documented in
[`infra/README.md`](infra/README.md) (for example
`infra/scripts/deploy.sh <branch>` builds, migrates and restarts), and
[`infra/CURRENT_STATUS.md`](infra/CURRENT_STATUS.md) lists what is blocked and
what the gaps to production are (Entra ID sign-in, the ALB and WAF, student
data compliance, and more).

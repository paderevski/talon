# Talon - notes for Claude Code

Talon is an educational GPU/CPU job portal for the Academy of Loudoun (LCPS):
students submit training jobs, teachers manage classes and budgets, admins
oversee. Express + Postgres backend, React (Vite) frontend, deployed with
Terraform to AWS (two web servers behind an internal ALB, RDS Postgres,
one EC2 instance per job). **This repo is public: never put account IDs,
IPs, instance IDs, emails, secrets or real passwords in tracked files.**

## Where things are

- `backend/` Express API. `src/routes`, `src/auth` (sessions, roles, access
  scope), `src/repositories/postgres`, `src/budget/ledger.js`, `migrations/`
  (numbered SQL, run by `npm run db:migrate`), `tests/`.
- `frontend/src/` React app: `App.jsx`, `components/`, `api/client.js`
  (all API calls), `utils/format.js` (`formatDollars`).
- `shared/` status helpers used by both.
- `infra/ec2` Terraform for the demo (VPC, two web servers in an Auto
  Scaling group behind an internal ALB, RDS, jobs); `infra/state` the state
  bucket; `infra/server` web server config (`configure.sh`) and DB
  bootstrap; `infra/scripts` helper scripts.
- **`infra/CURRENT_STATUS.md` is the map**: what is running, what is done,
  what is blocked, gaps to production, EC2-jobs design notes. Read it first
  and keep it current when you change something it describes.
- `docs/` is gitignored (local only): architecture doc v8 (as built;
  v7 kept for history), the AWS Batch plan and the user-db plan.

## Run it locally

Needs Postgres 16. One time: `createdb talon_dev && createdb talon_test`, then
`npm install`, `npm run db:migrate --workspace backend`,
`npm run db:seed:demo --workspace backend` (wipes the dev DB; demo data only).
Then `npm run dev` (frontend :5173, backend :5174; applies migrations first).

Demo logins (public by design): `admin/admin123`, `teacher_ada/teach123`,
`student_a1/student123`, `jane_smith/talon123`. Chrome may show a "password
found in a breach" dialog; it blocks clicks until dismissed.

## Tests (run before committing)

- `npm run test:backend` (HTTP regression tests; resets and seeds `talon_test`)
- `npm run test:postgres --workspace backend` (repository, budget, session tests)
- Run them one after the other, never in parallel (shared `talon_test`).
- `npm run test:frontend` covers the pure form logic (`frontend/src/utils/jobPlan.js`:
  machine, estimate, budget check). There are no component tests. **Check UI
  changes by running the app** (or at least `npm run build --workspace
  frontend`); do not hand off frontend changes untested.

## Working conventions

- One branch per piece of work. Merge to `main` only when asked.
- `main` is protected (since 2026-11-05): changes arrive only through a
  pull request whose CI (`.github/workflows/ci.yml`: backend, Postgres and
  frontend tests, build) passed on an up-to-date branch; admins included,
  no force pushes. Flow: push the branch, `gh pr create`, wait for
  `gh pr checks <n> --watch`, then `gh pr merge <n> --merge` when asked.
- End commit messages with the Co-Authored-By line the harness specifies.
- Deploy a branch: `infra/scripts/deploy.sh <branch>`. It builds,
  migrates and restarts each server in turn; it never touches the data.
  **Talon is live (go-live 2026-11): the data in RDS is real.** Migrations
  must keep it (no wipes, no reseeds); the demo seed refuses in production
  and a production server disables any demo account at startup. Changing
  `infra/ec2/web_user_data.sh.tftpl` (the web servers' first boot) rolls
  new servers in one at a time on the next apply (instance refresh, no
  downtime); the data in RDS stays. Backups are RDS's (7 days,
  point-in-time restore); the database has deletion protection.
- The database is RDS: the service connects as `talon_app` (rows only) with
  IAM tokens; migrations, the seed and admin scripts switch to
  `talon_migrate` (schema owner) via `useMigrationRole()`. A new script
  that changes the schema or wipes tables must call it.
- Money is integer cents in the ledger and dollars in API responses.
  Jobs/results are scoped by the signed-in user (server side); the client
  must not decide visibility.
- Roles: student, teacher, admin (a user can hold several). Identity comes
  only from the session cookie; ignore any `x-talon-user` style header.
- Demo accounts (local and test databases only) have public passwords:
  never create them on a deployed server.

## AWS rules

- Two accounts. **Work/LCPS = profile `lcps`** (SSO; this is where Talon runs).
  Personal = `patrick`/`default`. Confirm the account before any AWS action.
  The personal Lightsail instance `Nginx-1` must be kept.
- Terraform cannot read `aws login`/SSO credentials directly. Before running
  it: `source infra/scripts/aws-env.sh` (clears stale vars, logs in if needed,
  exports; `... aws-env.sh clear` afterwards),
  then `terraform init -backend-config=backend.hcl` in `infra/ec2`.
- Prefer Terraform (IaC) over console/CLI changes. No em dashes in AWS
  resource names or descriptions.
- Never read secret values into the conversation (no `secretsmanager
  get-secret-value`). App secrets live in SSM under `/talon/demo/` and must
  not be deleted (stored GitHub tokens and backups depend on them).
- The ALB + WAF go-public work is on hold until the exposure and subnet
  decisions are made and LCPS IT adds the DNS records for the planned
  hostname `talon.lcps.org` (see CURRENT_STATUS.md).
- Agent may run `terraform apply` after checking with user.

## Gotchas

- `backend/src/data/` no longer holds job data (it is in Postgres); do not
  recreate JSON stores.
- The local job runner executes student repos on the web server (30 min
  limit). Fine for the private demo only.
- After changing backend routes, check the response shape the frontend reads;
  a self-recursive `apiFetch` once broke login, so smoke-test the client.

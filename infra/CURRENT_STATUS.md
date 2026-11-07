# Talon infra - current status

_Last updated: 2026-11-07 (Connections, Google Drive, Drive jobs and background EC2 launches: Next up items -5 to -2). Before that, 2026-11-05 (status doc refreshed for architecture doc v8; CI and protected `main`; zone resilience and DB failover fixes; web tier phase 3 merged to `main`: two web servers in an Auto Scaling group behind an internal ALB, failover, deploy and reconciler checks pass; changed files skip hidden paths). Earlier the same day: phases 1 and 2 (Talon VPC, RDS with IAM sign-in and split roles, web server from a launch template), per-launch S3 job folders, old box and its code removed. Before that, 2026-11-04 (GPU jobs, build step 4, merged to `main`: one GPU launch template on the PyTorch DLAMI for g4dn.xlarge, g4dn.2xlarge, g6.xlarge and g6e.2xlarge, admin-only; verified on the box with g4dn; the box runs the same code from branch `gpu-jobs`). Before that, 2026-11-03 (GitHub App sign-in, code-source choice, job folders, admin GitHub unlink and script arguments). Before that, 2026-10-28. The cleanup pass is merged and deployed to the box (service healthy after the deploy; the new behavior has not been exercised on a real job yet). The Talon app and job instances were checked on the live box that day; the account-level items in "Gaps to production" were last reviewed 2026-10-25._
Account IDs, instance ID, and IPs are in `CURRENT_STATUS.local.md`
(gitignored). Architecture doc: `docs/talon-architecture-summary-v8.docx`
(local, gitignored; 2026-11-05, describes the system as built, with where
it differs from v7 and a short what-comes-next; v7 kept for history).

## Next up (as of 2026-11-07)

-7. **Test review, second pass** (merged, PR #19, deployed 2026-11-07): more tests (role changes
   mid-session, admin unlock and the throttle window, expired and tampered
   sessions, what a teacher sees after a student leaves or a class moves or
   is archived, provider outages leaving links alone, a final ledger check,
   `formatDollars`, job statuses against the database, client URLs and
   401s, progress edge cases) and test fixes: regression jobs clone from
   local fixture repos instead of github.com, roster tests count from the
   database, `zz-management` uses its own admin, budget and throttle tests
   clean up after themselves. Two small UI fixes: an end line without an
   exit code no longer reads "Exited with code undefined", and
   `formatDollars` shows a dash for blanks and booleans.
-6. **Test review fixes** (merged, PR #17, deployed 2026-11-07): a review of the automated tests found six bugs, fixed with
   tests: the repo browser's GitHub-failure fallback served one user's
   cached private-repo listing to another (now only to the user who loaded
   it); upper-case user ids in admin routes slipped past the self checks
   and session revocation (ids are lower-cased); `..` was accepted as a
   repo owner/name (`isRepoSegment`; `/tree` checks names like
   `/branches`); a finished EC2 job was relabelled "Time limit exceeded"
   (or "cancelled") on a later look (only the job's own `status.json`
   replaces a stored result; cancelling a finished job is 409); a changed
   password was stored untrimmed but login trims; a stray `%` in a pasted
   GitHub URL threw. New regression cases and Postgres cases also cover
   cross-class allocations, sessions ended by password changes and resets,
   EC2 cancel refunds, parallel submits against a budget, file access by
   non-owners, OAuth state checks, tokens out of responses and cross-user
   Drive items. A 502/504 on cancel, hide, unhide or disconnect now says
   the change may have been made (as submit and the admin writes did).
   Accepted, not fixed (decided 2026-11-07): cancel racing a launch (small
   window, the reconciler cleans up), the client taking a non-JSON 200 as
   success (nginx sends all of /api/ to the backend), loose budget amount
   parsing (`"0x10"`, `"1e2"`; teachers and admins only, within limits).
-5. **EC2 launches in the background** (merged, PR #13,
   2026-11-07): submit now answers as soon as the job is reserved (checks,
   source access, budget, limits); fetching the code (clone or Drive copy),
   packing, the S3 upload and RunInstances run in the background on the
   same web server (`services/ec2Jobs.js` `startEc2Job` / `runEc2Launch`).
   Each step is saved as the job's launch progress (migration 013,
   `jobs.launch_progress[_at]`) and shown in the Jobs page's first step.
   Before, a big Drive folder could outlast the 180 s nginx/ALB timeout.
   Cancel while preparing finishes the job in the database (refund), so it
   works whichever server gets it; the launcher checks before
   RunInstances. The reconciler fails and refunds a launch with no
   progress for 10 minutes (the server preparing it restarted, e.g. a
   deploy). This is the first half of item 1 (queue): the background work
   can move to a queue worker later with the same API and UI.
   EC2 jobs are **running** from submit (preparing and a pending instance
   included; PR #15): to the student Talon is already
   working on them, and the Jobs page opens on Running. "Queued" is left
   for jobs waiting their turn (the local runner's queue, later the
   capacity queue).
-4. **Google Drive live on the box** (2026-11-07): `main` deployed
   (`--keep-data`, migration 012), `infra/ec2/google.tf` applied (3 SSM
   settings + read policy, no server replaced), client secret set by hand;
   connecting Drive through the tunnel works. New
   `infra/scripts/secrets.sh` (PR #12): list SSM
   parameters by name (values never shown), `set` (typed hidden, or
   `--from-file`) and `rm` by-hand secrets; refuses Terraform-managed ones
   and `session-secret` / `credentials-key`. Lesson: a mistyped client
   secret gave `invalid_client`, and the servers kept the bad value until
   restarted; the same PR makes Google `invalid_client` and GitHub
   `incorrect_client_credentials` reload settings on the next attempt.
-3. **Google Drive connection** (2026-11-06, merged as PRs #9, #10; live,
   see -4): provider `google_drive` (OAuth with `drive.readonly` because
   a folder picked under `drive.file` comes without its contents; refresh,
   revoke; the Google Picker in the Connections card chooses what Talon
   may read, kept in `connection_items`, migration 012). Uses a personal Google Cloud project (External,
   Testing) for now; an LCPS Internal project later. Local
   dev: `GOOGLE_*` in `backend/.env` (see `.env.example`). Box:
   `infra/ec2/google.tf` (SSM settings and read permission; applied 2026-11-07)
   plus `google-oauth-client-secret` by hand. Merged (PRs #9, #10).
   **Jobs from Drive** (PR #11,
   2026-11-07): a `drive` source copies the chosen folder only; the New Job
   form has a built-in file browser for GitHub and Drive (the Repo Browser
   panel is gone); the local runner takes non-git sources. Notebooks
   (`.ipynb`) cannot be entry scripts yet. Details:
   `docs/connections-and-sources-plan.md`, steps 2 and 3.
-2. ~~**Connections and sources**~~ merged (PR #8) and deployed to the box
   with `--keep-data` 2026-11-06 (59 jobs and 1 GitHub link converted;
   GitHub reconnect checked on the box). Plan and source of truth:
   `docs/connections-and-sources-plan.md` (local). The GitHub panel is now
   **Connections** (one card per provider; GitHub the only one so far;
   `#github` still opens it). Backend abstractions for more providers and
   sources: `src/connections/` (generic token store, provider registry,
   `/api/connections/...`; GitHub's routes stay at `/api/github` because
   the GitHub App has that callback registered), `src/sources/` (source
   registry; git fetcher for any host, records the commit; snapshot packer
   with the safety rules), `src/storage/keys.js` (`users/<id>/...` layout
   for future uploads and home folders). Migration 011: `connections`
   replaces `github_accounts` (rows copied, still decrypt), `job_inputs`
   holds each job's code input (`jobs.repo`/`branch` moved into it, plus
   the snapshot sha256/size and commit for EC2 jobs), `source_label` on
   jobs and results, `reporting.jobs` rebuilt (`source_type`,
   `source_label`, `repo`, `branch`, `commit`, `input_bytes`). Tested:
   backend, Postgres (new cases for all of the above) and frontend tests;
   on local dev the migration ran over 50 jobs and a GitHub link, the link
   still listed its repos, a submitted job recorded its source. Next:
   Google Drive (personal Google Cloud project first, LCPS Internal project
   later; see the plan). Deploying needs migration 011 on RDS (`deploy.sh`
   runs it; Grafana's grants on the rebuilt view are re-applied by the
   migration).
-1. **Grafana on a laptop** (branch `grafana`, 2026-11-06): `infra/grafana`
   (Docker, dashboards as generated JSON, overview plus web server, job,
   student and request drill-downs). Migration 010 adds read-only
   `reporting` views; `db-bootstrap.sh` adds role `talon_grafana` (IAM
   sign-in, SELECT on those views only). Live on RDS 2026-11-06: apply with
   `db_bootstrap = true`, deploy `grafana --keep-data` (migration 010),
   `db-bootstrap.sh`, apply with `db_bootstrap = false`. All Postgres panels
   checked against RDS; the role cannot read tables, write, or run past 10 s.
   The box runs branch `grafana`, which has `gateway-timeouts` merged in
   (that branch was on the box before). That apply also moved the GPU job
   template to AWS's new PyTorch DLAMI (published 2026-11-06; launch
   template version 10) and its AMI allow-list: GPU jobs on it are not
   tested yet.

0. ~~**Web tier phase 3**~~ done and merged 2026-11-05: Auto Scaling group
   of two web servers (1a, 1b) behind an internal ALB, reached through the
   SSM tunnel; all checks pass. Details under "Later: two web servers",
   "Phase 3 as built". Next web tier step is going public (ALB + WAF, item 5).
0b. ~~**Infra cleanup**~~ done and merged 2026-11-05 (`infra-cleanup-2`): legacy
   code and resources removed after three design iterations. `infra_2/` (old
   EKS design) deleted; backups bucket, its KMS key and `backups.tf` removed;
   CloudWatch agent's SSM State Manager associations removed (the agent is
   installed and configured by `infra/server/configure.sh`, at first boot and
   every deploy; config changes reach servers with the next deploy); nginx
   site written only by `configure.sh`; job VPC/subnet override variables
   gone; GPU template a single resource; web role keeps only the
   `ec2:DescribeInstances` describe permission; old `jobs/<id>` folder
   fallback removed (job_boot.sh and backend: a job without its own folder is
   refused); `check-launch-policy.sh` uses `run_ssm`; monthly budget 150 USD,
   standard vCPU alarm 46; unused outputs removed; README rewritten.
   Verified: both servers rebuilt from first boot alone (nginx site, JSON
   logs, CloudWatch agent, no dpkg lock errors); `check-launch-policy.sh` all
   ok; `job-1053` ($0.01, CPU template v12) wrote only its own folder.
   infra_2's old bootstrap state listed `talon-dev-terraform-locks`
   (DynamoDB), `alias/talon-dev-tfstate` (KMS) and a `talon-dev-tfstate-*`
   bucket in another account (not LCPS; not checked: personal session
   expired). If they still exist they are orphans.
0c. ~~**Zone resilience**~~ done 2026-11-05 (branch `multi-az`): RDS
   Multi-AZ (standby in the other zone; converted online with
   `-var db_apply_immediately=true`) and a NAT gateway plus app route table
   per zone, so a single-zone outage leaves the site, job launches and
   GitHub working. About +$47/month at list price.
   Failover tests 2026-11-05 (probe every second through the tunnel):
   - Forced RDS failover, first run: RDS switched in 54 s, but pooled
     connections to the old primary hung (no RST), the site was down about
     2.5 minutes, and the ALB's database-aware health check got a healthy
     server replaced. Fixed on branch `db-failover` (merged, 7973cb7): pool
     `query_timeout` 15 s (a timed-out query's connection is discarded),
     TCP keepalive after 10 s, `withTransaction` and the advisory lock
     discard a connection that failed a query; the ALB checks
     `/api/health/live` (app up, no database); `/api/health` keeps the
     database check and a 30 s background check logs outages.
   - Second run: site unavailable 62 s, back 13 s after RDS finished; no
     server replaced.
   - Backend stopped on one server (10 s x 2 health check): about half the
     requests failed for 20 s (was 44 s at 15 s x 3), none after; the group
     replaced the server, healthy 4 minutes later.
   - Seen during a failover restart: RDS reported the db.t4g.micro
     "critically low on memory" and lowered shared_buffers. Resized to
     db.t4g.small the same day (branch `db-small`): the apply took 13 min,
     users saw 70 s of errors (one failover), no server replaced. RDS also
     lists a pending system update; it applies in the Sunday maintenance
     window as a failover (about a minute).
0d. ~~**CI**~~ done 2026-11-05 (PR #1): GitHub Actions runs the backend,
   Postgres and frontend tests and the build on every push and pull request
   (Postgres 16 service container, no AWS access, about 70 s). `main` is
   protected: pull requests only, the `test` check required on an
   up-to-date branch, enforced for admins. Next (before going public):
   deploys from GitHub through an OIDC role limited to SSM on web servers,
   with deploy.sh's reseed off; later, `terraform plan` on infra PRs.
**Direction (2026-11-07): AWS Batch** is the planned next step for job
execution, replacing the web servers creating EC2 instances directly (plan:
`docs/talon-batch-plan.md`, local only). Until then the EC2 path gets bug
fixes only. Items 1 and 2 below describe the current EC2 path.

1. **Job queue with launch retries** (step 5 without Spot): a launch with no
   capacity waits and retries instead of failing; also gives overnight jobs.
   Plan it together with "Limiting launch exposure" below: the near-term
   choice there (a launcher Lambda fed by SQS) changes where the queue lives.
   A Postgres queue (`FOR UPDATE SKIP LOCKED`, `not_before`) stays possible
   for the web server's own bookkeeping; job instances must never reach
   Postgres.
2. **Baked CPU AMI** (boot stops installing the AWS CLI and pip each time).
3. Downloaded data in "changed files": hidden paths (`.cache/`, `.git/`,
   dotfiles) are skipped since 2026-11-05 on both runners (job template
   v11, checked with `job-1052`). `data/` is still saved: how to handle
   downloaded datasets (skip `data/`? `.talonignore`?) is open.
4. Test g6e.2xlarge on the box when it has capacity. GPU machines are open
   to students (`ec2_gpu_admin_only = false`, the Terraform default since
   2026-11-04; changing it rolls the web servers).
5. Not code: ask LCPS IT for the `talon.lcps.org` DNS records and the Entra
   App Registration (lead time); decide exposure and subnet for ALB/WAF.

## Running now

| Item | Value |
|---|---|
| AWS account | LCPS member account (profile `lcps`, SSO AdministratorAccess) |
| Region | `us-east-1`, Talon VPC `10.20.0.0/16` (`network.tf`): web servers in app subnets 1a/1b behind an internal ALB (private, out via a NAT gateway in each zone), RDS Multi-AZ in data subnets 1a/1b, jobs in public jobs subnets 1a-1d |
| Web servers | Auto Scaling group `talon-demo-web` (`web.tf`): two t4g.small, Ubuntu 24.04 arm64, one per zone, from launch template `talon-demo-web`; tagged `Component=web`. Internal ALB `talon-demo-web` (`alb.tf`), health `GET /api/health/live` (app up, no database) every 10 s, unhealthy after 2 |
| Elastic IP | None for the web servers (private). One per NAT gateway (1a, 1b) |
| Inbound access | None. SSM Session Manager only (`tunnel.sh`: SSM port forward through a web server to the internal ALB) |
| Runtime | Node 24 LTS, nginx (port 80 -> static `frontend/dist`, `/api` -> `127.0.0.1:5174`), systemd `talon-backend`. Postgres 16 on RDS `talon-demo` (`db.t4g.small`, Multi-AZ since 2026-11-05, TLS, IAM sign-in as `talon_app`; migrations as `talon_migrate`). `EC2_JOBS_ENABLED=true` |
| Deployed | `main`, unless `deploy.sh <branch>` put a test branch on the box (normally tested before merge; the branch may stay until the next deploy since it equals `main` after the PR). `infra/scripts/status.sh --deep` shows the commit, template versions and drift |
| Approx cost | ~$165/month at list price, not read from the bill (Cost Explorer shows less: LCPS Savings Plans and discounts): two web servers ~$24 + EBS ~$3.20, internal ALB ~$17, two NAT gateways ~$66 + traffic, RDS db.t4g.small Multi-AZ ~$51, KMS key ~$1, alarms/S3/SNS pennies. Plus job instances, billed per second and charged to budgets |
| Other AWS resources | SSM parameters under `/talon/demo/`, KMS key `alias/talon-demo-secrets`, SNS topic `talon-demo-alerts` (email subscribed and confirmed), CloudWatch alarms (`monitoring.tf`: disk, backend errors, unknown job instance, failed logins, GPU and standard vCPUs; `alb.tf`: healthy hosts, ALB 5xx), CloudWatch agent on each web server (installed and configured by `infra/server/configure.sh`; logs in `/talon/demo/{backend,syslog,nginx-access,nginx-error,bootstrap}`, 30 days; metrics in `Talon/Server`), saved Logs Insights queries `Talon/*` (`log_queries.tf`), S3 state bucket (`infra/state`), jobs bucket, job role, security group and CPU/GPU launch templates (`jobs.tf`), 2 AWS Budgets alerts (`alarms.tf`: 150 USD a month, 10 USD a day) |
| Root volume | 20 GB gp3, encrypted with the default AWS-managed EBS key (the architecture doc asks for a KMS key; not changed) |
| OS patching | `unattended-upgrades` enabled on the box (checked) |
| Terraform state | S3 `talon-tfstate-<account id>` (versioned, locked); `infra/state` stack's own state is local and tiny |

## How to use

```bash
aws sso login --profile lcps     # when credentials expire (usually daily)
infra/scripts/tunnel.sh          # then open http://localhost:8080
infra/scripts/deploy.sh          # deploy origin/main (push first), then reseed demo data
infra/scripts/deploy.sh B --keep-data   # deploy branch B without reseeding
infra/scripts/shell.sh [id]      # shell on a web server (lists the others)
infra/scripts/db-bootstrap.sh    # RDS roles and grants (needs db_bootstrap = true)
infra/grafana/grafana.sh up      # Grafana on this laptop: http://localhost:3000 (infra/grafana/README.md)
```

The scripts find web servers by tag (`Project=talon`, `Component=web`,
`Environment=$TALON_ENV`, default `demo`; `common.sh`). `deploy.sh` deploys
to each server in turn and reseeds once at the end; `TALON_INSTANCE=<id>`
picks the server for `tunnel.sh`, `shell.sh` and `check-launch-policy.sh`.

Demo login: see the main README.

On the box:

```bash
sudo tail -f /var/log/talon/backend.log   # backend (JSON lines; not in journald)
sudo journalctl -u talon-backend          # service start/stop only
sudo tail -f /var/log/talon-bootstrap.log
sudo /usr/local/bin/talon-deploy main
```

Key paths: app `/opt/talon`, config `/etc/talon/talon.env`, secrets
`/etc/talon/secrets.env` (loaded from SSM Parameter Store), service user
`talon`.


### Logs

Everything is in CloudWatch Logs (us-east-1), 30 days:

| Log group | What |
|---|---|
| `/talon/demo/backend` | Backend, one JSON object per line (`backend/src/utils/log.js`): `time`, `level`, `msg`, `event`, plus `requestId`, `userId`, `jobId`, `instanceId`... One `http.request` line per API call (method, path without query, status, `durationMs`) |
| `/talon/demo/nginx-access` | nginx access log, JSON (`talon_json`): `requestId`, `path` (no query), `status`, `requestTime`, `upstreamTime` |
| `/talon/demo/nginx-error` | nginx error log (text) |
| `/talon/demo/syslog` | Everything else: backups, deploys, systemd, kernel |
| `/talon/demo/bootstrap` | First-boot user_data log |
| `/talon/demo/jobs` | Job instances' boot logs (`job_boot.sh`, root's output, not the student's), stream `<job id>/<instance id>`, sent every 5 s and at exit. Last line: JSON `job.boot_summary` (result, exit code, boot/setup/run seconds, instance type). The same log is `jobs/<id>/logs/boot.log` in S3, uploaded every 3 s when changed and on every exit path; the student's `job.log` is in S3 only |

nginx passes its `$request_id` to the backend (`X-Request-Id`, also returned
to the browser), so one `requestId` finds both sides of a request.

- Follow live: `aws logs tail /talon/demo/backend --follow --profile lcps`
  (add `--filter-pattern '{ $.level = "error" }'`), or CloudWatch > Live Tail.
- Search: CloudWatch > Logs Insights > Queries > folder `Talon`: backend
  errors, trace one request, job history, user activity, job lifecycle,
  failed logins, slow requests, traffic by status, nginx 4xx/5xx, syslog
  problems, job boot log, job boot summaries, setup time by instance type,
  job boot problems. Set the placeholder (job id, user id, request id) and run.
- Event names (`event` field) are stable; alarms match them:
  `level = "error"` (backend errors), `ec2.instance_terminated` with reason
  `no job row` (unknown job instance), `auth.login_failed`/`auth.login_locked`
  (failed logins). Others: `auth.login`, `auth.logout`,
  `auth.password_changed`, `job.submitted`, `job.launch_failed`,
  `job.cancel_requested`, `job.finished`, `job.lost`, `ec2.*`, `github.*`,
  `admin.connection_unlinked`, `security.*`.
- Never logged: passwords, tokens, cookies, request bodies, query strings.
  Login failures do log the attempted username.
- How it is wired: `infra/server/configure.sh` (run as root by
  `talon-configure` at first boot and after every deploy, taken from the
  deployed commit) adds a systemd drop-in
  that sends backend output to `/var/log/talon/backend.log` (logrotate,
  14 days), the nginx `talon_json` format and the request id header. The
  agent config (which files go to which group) is in `monitoring.tf`; the
  same script installs the agent and loads that config. A replaced instance
  has all of this from first boot.

## Known limitations (demo mode)

- Users, sessions, budgets, GitHub credentials, jobs and results are in
  Postgres and survive deploys. Student jobs run on their own EC2 instance
  each (see "EC2-launched jobs"); their logs and output files are in the jobs
  bucket and expire after 30 days (`jobs_retention_days`), and they are not in
  the database backups. The local runner (on the web server, no isolation,
  `JOB_MAX_RUNTIME_SECONDS` default 30 minutes) is refused for everyone in
  production, admins included (`TALON_ALLOW_LOCAL_JOBS=true` overrides), and
  remains for development and tests.
- Job instances can reach the internet on 443 (students download datasets
  and models), so jobs are not network-isolated; the instance metadata
  service is blocked for the student user and no secrets are on the box.
  GuardDuty is not enabled (checked 2026-11-04: no detector; Terraform has it
  behind `enable_guardduty`).
- Database backups are RDS's (automated, 7 days, point-in-time restore).
  A restore drill into a new RDS instance has not been done yet. No final
  snapshot and no deletion protection on the demo database (`rds.tf`).
- Demo accounts have public passwords (they are in this repo). Fine only
  because the box is reachable through the SSM tunnel and nothing else; see
  "Going public".
- Plain HTTP on port 80 inside the tunnel (no TLS yet; the ALB adds it).
- Changing `web_user_data.sh.tftpl` (or anything in the web launch
  template) replaces the web servers one at a time on the next apply
  (instance refresh, no downtime, about 12 minutes for two; data in RDS
  stays).
- The local job runner executes `git clone` / `python3` directly on the host
  as the `talon` user, so jobs are not isolated. It passes only PATH, HOME and
  locale (not the server's environment) and sets `AWS_EC2_METADATA_DISABLED`,
  which stops AWS SDKs but not a raw request to the metadata service.

## To-do (in order)

Ordered so each item makes the next one easier. Items 1-8 and 12 are done;
9-11 need other people.

**Foundation**

1. ~~**Postgres-only users**~~ _(done: SQLite code and files removed,
   Postgres is the only provider, tests run against `talon_test`)._
2. ~~**Login throttling per account.**~~ _(done: 5 wrong passwords lock an
   account name for 15 min, even for the right password; tunable with
   `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES`; clear early with
   `npm run db:unlock --workspace backend -- <username>`. Trade-off: anyone who
   knows a username can lock that account for 15 min.)_
3. ~~**Keep the keys safe**~~ _(done 2026-10-25: `SESSION_SECRET` and
   `TALON_CREDENTIALS_KEY` are SSM SecureString parameters under
   `/talon/demo/`, encrypted with KMS `alias/talon-demo-secrets`, created by
   the box on first boot and NOT managed by Terraform, so replacing the
   instance keeps them. `talon-load-secrets` copies them to
   `/etc/talon/secrets.env` before each backend start. Production refuses to
   start without them. Do not delete the parameters: stored GitHub tokens and
   backups depend on them.)_
4. ~~**Nightly backups.**~~ _(done 2026-10-25: `pg_dump` at 03:15 UTC to a
   private, versioned, KMS-encrypted S3 bucket; 35 days of nightly dumps plus
   the first dump of each month for 12 months (variables in `backups.tf`);
   the instance can write/read but not delete. Weekly automatic test restore
   into a scratch DB. Sessions and login-attempt data are not backed up.
   Scripts are in `infra/backup/` and read their settings from
   `/etc/talon/backup.env`, so a separate Postgres server or RDS only needs
   `BACKUP_DATABASE_URL` (and `RESTORE_ADMIN_URL`). Helpers:
   `infra/scripts/backup.sh status|now|restore-test|install`.)_
   _Retired 2026-11-05 with the old box: RDS automated backups replace it.
   The scripts, alarms and server access went first; the bucket (demo-data
   dumps only), its KMS key and `backups.tf` were removed in the infra
   cleanup the same day._
5. ~~**Terraform state to S3**~~ _(done 2026-10-25: bucket from
   `infra/state`; `infra/ec2` uses it with `use_lockfile`; lock tested. The
   old local state files were deleted 2026-10-28.)_

**Data into Postgres** (nothing resets on deploy after these; first step
toward two servers)

6. ~~**GitHub credentials -> Postgres**~~ _(done: table `github_credentials`,
   one row per user id, AES-256-GCM with the key id stored per row and the
   owner bound into the ciphertext; rotation via
   `npm run db:rotate-credentials-key`. They are in the RDS backups, and are
   only readable together with the SSM key.)_
7. ~~**Jobs and results -> Postgres**~~ _(done: tables `jobs` and `results`
   owned by user id; status sync is row-level and idempotent; finishing a job
   stores its result and charges the owner's budget in one transaction, once
   per job; `JOB_RATE_CENTS_PER_HOUR` (default 0) sets the price, submits are
   refused at zero budget once it is above 0; `max_runtime_seconds`,
   `compute_type` and `hourly_rate_cents` are ready for EC2-launched jobs
   (price = instance type's on-demand rate, per-second, 60 s minimum);
   seeded demo jobs match the ledger; JSON files and `demoOwnership.js`
   removed.)_ Still to do for EC2 launches: look up the rate from the Pricing
   API, reserve the maximum cost at launch, and terminate at the time limit.

**Frontend** (can move earlier if the demo needs polish)

8. ~~**Plan step 5 remainder (frontend polish)**~~ _(done: teacher roster is
   one section per class plus budget pool; money shown as dollars; students
   see their remaining budget in the header; the client-side owner filter is
   gone (the server scopes everything; a teacher viewing one student asks
   for `?owner=`); a teacher's student view is read-only (no submit, cancel,
   hide, repo or GitHub panels); the fake "g4dn.xlarge" header pill and the
   "GPU" column ("Compute" now, "Local" for web-server runs) are fixed.
   Checked in a real browser (local dev) as student, teacher and admin.)_

**Jobs on EC2**

12. ~~**Student jobs on their own EC2 instances**~~ _(done 2026-10-28, build
    order steps 1-3 in "EC2-launched jobs"; GPU, Spot and the overnight queue
    are steps 4-5, not started.)_

**GitHub**

13. ~~**GitHub App instead of personal access tokens**~~ _(done 2026-11-03,
    merged to `main`, deployed and verified on the demo box)_. Before this, a saved PAT was only used for API calls (repo
    list, browser); clones were anonymous, so private repos could be browsed
    but failed at the clone. Now: students **Connect GitHub** (install the
    AET-CS-owned Talon app on their account or a class org and pick repos).
    Their GitHub App user token (encrypted in `github_accounts`, migration
    006; `connections`, provider `github`, since migration 011, refreshed automatically, one GitHub account per Talon user) is the
    access check for the repo list, the repo browser and submit; a private
    repo is cloned on the web server with a one-hour, read-only installation
    token limited to that repo, passed to git through the environment (not
    the URL or `.git/config`), never sent to the job instance. Public repos
    still clone anonymously and need no link. No webhooks, so it works
    through the SSM tunnel. PAT table, endpoints, panel and import script
    removed; old backups still hold the (encrypted) PATs.
    Settings: SSM `/talon/demo/github-app-client-id`, `github-app-slug`,
    `public-url` (Terraform, `github.tf`, from tfvars) and
    `github-app-client-secret`, `github-app-private-key` (SecureString, made
    by hand with `alias/talon-demo-secrets`; README "GitHub App"). The backend
    re-reads them every minute while missing, so no restart and no instance
    replacement (user_data unchanged). The app `talon-link` exists
    (2026-11-03). Tested locally (dev server, :5173): install + connect, and a
    job on a private repo cloned and ran; GitHub does pass `state` back
    after an install. Gotcha: after an install GitHub returns to the app's
    *first* callback URL, so the server's own URL must be listed first (or use
    a separate dev app). Applied and deployed to the demo box 2026-11-03
    (`terraform apply`: three SSM settings and one IAM policy; secrets made
    by hand) and verified through the tunnel: connect, then an EC2 job on a
    private repo ran start to finish with live logs and a result download.
    The sign-in link asks GitHub for its account picker
    (`prompt=select_account`) so a student with two GitHub accounts, or on a
    borrowed computer, chooses deliberately; verified on the box (GitHub
    offers "sign in as <login>" or another account). The redesigned panel
    (one Connect button, repo list) and the one-GitHub-account-per-user
    check ("already connected to another Talon user") verified there too.
    Admin "Unlink GitHub (<login>)" on the user edit screen, and the admin
    user search matches GitHub logins (merged). A token GitHub rejects
    (revoked anywhere: disconnecting on one server revokes the app's grant
    for all of them) now unlinks instead of failing.

**Blocked on others**

9. **Entra ID sign-in** - waiting on the LCPS App Registration (ask early;
   IT lead time).
10. **ALB + WAF go-public** - hostname chosen (`talon.lcps.org`, needs
    LCPS IT to add DNS records); still waiting on the exposure and subnet
    decisions (see "Going public" below). Includes the X-Forwarded-Proto
    fix, removing demo users, creating the real admin.
11. **Read-only AWS role** (`lcps-ro`) - ask the LCPS AWS admins.

**Housekeeping**

- ~~Delete the deactivated personal IAM access keys, `~/.aws/credentials-bk`
  and the old local Terraform state copies~~ _(done 2026-10-28; the personal
  user has no access keys, it signs in with `aws login`.)_
- Term end: return leftover teacher pool money to the admin (needs a
  small admin action; see "Gaps to production").

## Probably to do (not scheduled)

Ideas worth doing that are not in the ordered list yet. Move one up into
"To-do (in order)" when it is scheduled.

- **Presigned S3 URLs for job instances, so jobs hold no AWS credentials**
  (from the EC2 runner security review, 2026-11-07). Today every job
  instance shares one role with S3 access to `jobs/*`; a student who gets
  root on a job box could use it (off the box too, until it expires).
  Instead the web server signs, per launch: GETs for `input/run.sh` and
  `input/repo.tgz`, PUTs for `status.json` and `logs/*` (reusable until
  expiry), and POST policies for `output/` and `changed/` (`starts-with`
  the job folder, `content-length-range` up to 200 MB). `job_boot.sh` uses
  curl with them instead of the AWS CLI (no more `snap install aws-cli` at
  boot). Jobs may run 24 h, so the URLs must not be signed with the web
  server's role: URLs die with the temporary credentials that signed them
  (a few hours). Sign with a dedicated IAM user (keys can sign for up to
  7 days):
  - Terraform: user `talon-demo-job-signer`, policy mirroring today's job
    role paths; a bucket policy deny for that user unless the request comes
    through the S3 gateway endpoint (`aws:SourceVpce`), so a leaked key is
    useless outside the VPC.
  - The access key is created by a script straight into SSM (SecureString
    on the secrets KMS key), never in Terraform state; the web server reads
    it at startup and only signs with it.
  - Rotation: two keys per user; switch signing to the new key, delete the
    old one only after the longest job (24 h) has passed.
  - On the box the URLs are bearer tokens: keep them in a root-only file and
    pass them to curl with `-K`, never on a command line (`/proc` shows
    command lines to every user).
  - The job role then keeps at most `logs:PutLogEvents` for the CloudWatch
    boot log (or drop that copy; `boot.log` is in S3), and loses the S3
    statements.
  - About a day of work plus a `terraform apply` and one real job run on the
    box to verify.

## Going public: ALB + WAF (likely needed for the first stakeholder demo)

The ALB is for protection, not load. One instance is plenty for ~100 users.

| Layer | Provides |
|---|---|
| Shield Standard | Automatic L3/L4 DDoS protection (free; already applies to everything) |
| ALB | Only well-formed HTTP reaches the app; instance gets no public exposure; health checks; ACM TLS |
| WAF on the ALB | Rate limits (esp. `/api/auth/login`), IP reputation list, AWS managed rules (common exploits, known bad inputs), optional IP allow-list |
| App | Per-account login throttling (WAF only sees IPs) |

Alternative to price out: CloudFront + WAF with a VPC origin (no ALB).
Verify CloudFront VPC origin support for EC2 before choosing it.

### Decisions needed

1. ~~**Hostname.**~~ _(decided 2026-11-01: **`talon.lcps.org`**. Replaces the
   earlier candidates `talon.aet-cs.org` and `talon.academyofloudoun.org`.)_
   The `lcps.org` zone is on GoDaddy DNS (`domaincontrol.com` nameservers),
   so LCPS IT must add two records: the ACM validation CNAME, then a
   CNAME to the ALB (the apex cannot be a CNAME, but this is a subdomain).
   On 2026-11-01 neither the name nor any record for it existed (NXDOMAIN
   from both authoritative servers). Ask early, like the Entra app
   registration: IT lead time. The personal Lightsail `Nginx-1` is not
   involved.
2. **Exposure for the demo.** Open internet, or allow-list LCPS / known IP
   ranges at the ALB security group or a WAF IP set ("limited exposure").
   Allow-listing is the strongest single control while auth is new.
3. **Instance subnet.** (a) Keep it in a public subnet with **no inbound
   except port 80 from the ALB security group** - no NAT needed; or
   (b) private subnet per the architecture doc - requires a NAT gateway
   (~$32/mo + data) or VPC endpoints for SSM plus egress for apt / npm /
   GitHub. (a) is nearly as safe and simpler for the demo; (b) when moving
   into the LCPS VPC.

### Build list (Terraform in `infra/ec2`, new `alb.tf` / `waf.tf`)

1. ACM certificate for the hostname, DNS-validated.
2. ALB in Talon's two public subnets (1a, 1b), HTTPS:443 listener with
   the ACM cert, HTTP:80 -> 301 to HTTPS. ALB security group: 443/80 from
   the allowed ranges.
3. Target group -> instance port 80 (nginx), health check `GET /api/health/live`
   (as on the internal ALB today).
4. Instance security group: inbound 80 **from the ALB security group only**.
5. WAF web ACL on the ALB: `AWSManagedRulesCommonRuleSet`,
   `AWSManagedRulesKnownBadInputsRuleSet`,
   `AWSManagedRulesAmazonIpReputationList`, a rate-based rule scoped to
   `/api/auth/login` (e.g. 20 per 5 min per IP), a general rate-based rule,
   optional IP-set allow-list. WAF logging to CloudWatch Logs.
6. DNS: CNAME/ALIAS for the hostname -> ALB DNS name.
7. ALB access logs to S3 (optional, useful for incident review).

### App / box changes that must ship with it

- ~~X-Forwarded-Proto through two proxies~~ (web tier phase 1, branch
  `web-tier-phase1`): `configure.sh` makes nginx pass on the ALB's
  `X-Forwarded-Proto` for requests from inside the VPC (`$scheme`
  otherwise), and sets `TALON_TRUSTED_PROXIES=loopback,<VPC range>` (read
  from instance metadata) so Express skips both hops.
- `SESSION_COOKIE_SECURE=true` in `/etc/talon/talon.env`.
- ~~Per-account login throttling~~ (done, item 2).
- **No demo users on a reachable server.** Their passwords are public in
  this repo. Remove `TALON_ALLOW_DEMO_SEED`, disable/delete demo accounts,
  check the backend log for `[security] ... demo account(s)`.
- Create the real first admin:
  `npm run db:create-admin --workspace backend -- --username you@lcps.org`
  (random password, printed once).
- ~~Nightly `pg_dump` to S3~~ (done, item 4).

## EC2-launched jobs: design notes and build status

Student jobs now run on one EC2 instance each (build order steps 1-3 are
done and verified; see "Decided approach" below for the details and what is
left). The local runner (`localExecutionAdapter`, on the web server) remains
for development, the test suite and admins. The notes below record what we
know about AWS and the decisions behind the design.

### What is already in place

- `jobs.compute_type`, `jobs.hourly_rate_cents` (snapshot taken at launch;
  fractions of a cent are allowed), `jobs.max_runtime_seconds`,
  `jobs.cost_cents`, `jobs.execution_ref` (jsonb, put the instance id here).
- Finishing a job stores its result and charges the owner's personal budget
  in one transaction, once per job (ledger has a unique charge per job).
  Cost = `max(seconds, 60) x rate / 3600`, rounded up to a cent.
- Submits are refused (402) when the rate is above 0 and the budget is 0.
- Built: `ec2ExecutionAdapter.js` behind the same adapter interface
  (`start / getStatus / getLogs / listOutputFiles / cancel`), reserve-then-
  settle billing, and the reconciler (see "Decided approach"). The Kubernetes
  adapter stub has been removed.

### Verified against AWS docs (2026-10-25)

- **Billing:** EC2 Linux and Ubuntu are billed **per second with a 60 second
  minimum**, and only while the instance is in the **running** state (not
  pending, not stopped). EBS volumes are also billed per second (60 s
  minimum). So `seconds in running state x hourly rate` is what AWS bills for
  the instance. Boot, `user_data`, `git clone` and `pip install` time is
  billed: measure from the instance reaching *running*, not from the start of
  the training script, and decide whether students pay for setup time.
  ([instance-hour billing](https://repost.aws/knowledge-center/ec2-instance-hour-billing))
- **Rates:** the Price List API (`GetProducts`, service `AmazonEC2`) returns
  on-demand list prices, filterable by instance type, region, operating
  system and tenancy (the exact filter attribute names and values, e.g.
  `preInstalledSw`, `capacitystatus`, are from memory: confirm with
  `DescribeServices` / `GetAttributeValues` before coding). It is served from `api.pricing.us-east-1.amazonaws.com` and has **no VPC
  endpoint**, so the web server needs internet egress for it. Cache the
  rates (daily refresh is plenty) and snapshot the rate on each job. If we
  ever use Spot, the price differs per launch (EC2 spot price history).
- **vCPU quotas (checked in the LCPS account 2026-10-25, us-east-1):** G and
  VT 768, P 768, Standard 1152, DL 96, Inf 128, Trn 256 vCPUs. No increase is
  needed. (AWS's published defaults for a new account are 0 for GPU families
  and 5 for Standard; AWS raises quotas with usage, or LCPS raised them.)
  Spot quotas were not read (the call was rate limited). Re-check with
  `aws service-quotas list-service-quotas --service-code ec2 --profile lcps`
  before relying on a region or family we have not used. **These limits are
  far too high to act as a spending cap** (768 GPU vCPUs is roughly 190
  `g4dn.xlarge` at once), so the real caps must be Talon's own: per-job max
  runtime, reserve-then-settle, a per-user concurrent job limit, and an AWS
  Budgets alarm, plus an IAM/SCP condition limiting which instance types
  may launch.
  ([quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html))
- **Actual-cost reconciliation lags.** Cost allocation tags take up to 24 h
  to show on the Billing page and up to 24 h more after you activate them
  before Cost Explorer uses them, and activation is done in the
  **organization's management account** (LCPS IT owns it; this comes from one
  AWS solution page, so confirm with them). So Cost Explorer
  can reconcile (monthly: our computed totals vs billed totals, grouped by a
  `talon-job` tag), but cannot charge students in real time.

### Design decisions to make

1. **Reserve, then settle.** The ledger already has `charge` and `refund`
   kinds. Plan: at launch charge `rate x max_runtime`, at the end refund the
   unused part. A student can then never spend more than their budget, even
   with many parallel jobs. (Today's charge-at-end is only safe while the
   rate is 0.) Needs: allow the one-charge-per-job index to coexist with a
   refund row (it does: it only covers `kind = 'charge'`), and a per-user
   cap on concurrent jobs.
2. **Always terminate.** Use `terminate`, never `stop` (stopped instances
   still bill for EBS). Defense in depth: set
   `InstanceInitiatedShutdownBehavior=terminate` and make the job script end
   with a shutdown; run the script under `timeout` for `max_runtime`; and
   have the web server (or a scheduled sweeper) terminate any instance past
   its limit or whose job row is finished. Tag every instance
   (`talon-job=<job id>`, `Project=talon`, owner) and sweep for orphans.
3. **What counts as the end of a job.** Record our own timestamps (instance
   running, instance terminated) in the job row and use those for cost, not
   the training script's runtime.
4. **Isolation.** Student code is untrusted. Run it in its own subnet or VPC
   with no route to the Talon web server or Postgres, IMDSv2 required,
   egress limited to what jobs need (GitHub, package mirrors, S3). The
   instance role gets only that job's S3 prefix.
5. **Secrets to the instance.** Do not put a user's GitHub token in
   `user_data` (readable via instance metadata and `DescribeInstanceAttribute`).
   Fetch it at boot from a short-lived, job-scoped place (a one-shot SSM
   parameter or Secrets Manager secret the job role may read once), or clone
   on the web server and ship the code via S3.
6. **Control plane IAM.** The web server role needs `ec2:RunInstances`,
   `ec2:TerminateInstances`, `ec2:DescribeInstances`, `ec2:CreateTags`, and
   `iam:PassRole` for the job role only, restricted with conditions:
   allowed instance types, required tags on create, terminate only
   resources tagged `Project=talon`. Pricing: `pricing:GetProducts`.
7. **Logs, outputs, status.** Replace `backend/data/runs` with S3 (outputs)
   and S3 or CloudWatch Logs (logs); the instance reports completion by
   writing a status object, so no inbound connection to the instance is
   needed. The files/logs endpoints then read from S3. This also fixes
   "output lost when the web server is replaced".
8. **Capacity failures.** `RunInstances` can fail (`InsufficientInstanceCapacity`,
   quota exceeded). Keep the job `queued`, retry with backoff (or another
   AZ), fail it with a clear message after a limit, and never charge for a
   job that never reached *running*.
9. **Other costs not in the per-second compute rate:** EBS root volume,
   public IPv4 address (about $0.005 per hour each; avoid by launching into a
   private subnet with S3 and other endpoints), data transfer, NAT gateway if
   used. Either fold a small markup into the rate or accept the difference;
   the monthly Cost Explorer reconciliation shows how big it is.
10. **Account safety nets** independent of Talon: an AWS Budgets alarm on the
    account, an IAM policy limiting which instance types the web server may
    launch (the vCPU quotas are too high to help), and the 30 minute default
    max runtime.
11. **Keep the local adapter** for development and tests (the test suite
    relies on it) behind the same adapter interface.

### Decided approach for the first build (2026-10-26)

Where this differs from the architecture doc (v7), and why. Build step 1 is
done (below); the adapter and everything after it are not built yet.

**Changes from the doc**

- **S3 status file, not an HTTP callback.** The instance writes
  `status.json`, logs and outputs under `jobs/<id>/` in S3; the web server
  only reads. No inbound path to the web server and no per-job callback
  token (closes the "authenticated completion callback" gap).
- **Postgres is the queue, not SQS + DLQ, to start.** Job state is already in
  Postgres. A dispatcher claims queued rows with `FOR UPDATE SKIP LOCKED`; a
  `not_before` column gives overnight scheduling; capacity failures retry with
  backoff. Build it behind a small `enqueue / claim` interface so SQS can be
  swapped in later (message carries only the job id, Postgres stays the truth).
  Reason SQS is not worth it yet: per-user caps, budget reservation and cancel
  all need DB queries anyway, SQS adds a second place to keep consistent
  (enqueue can fail after the commit), and delays max out at 15 minutes.
- **No Docker / ECR / GPU in the first slice.** First slice is one CPU
  instance type on a stock Ubuntu AMI. Student code runs as an unprivileged
  user with the instance metadata service blocked for that user (iptables
  owner match). The web server clones the repo and ships it to S3, so no
  GitHub token goes near the instance. Docker, ECR images and GPU (`g4dn`
  first; check the current Deep Learning AMI name and SSM parameter before
  relying on it) come after the lifecycle works.
- **A background reconciler is required.** Today a finished job is only
  finalized and charged when someone loads it (`synchronizeJobFromExecution`
  in `jobs.js`). With real instances that would leave a finished instance
  billing. Every 30-60 s the reconciler describes running instances, reads
  each `status.json`, terminates finished or over-limit instances, finalizes
  through the existing path, and sweeps for orphans by tag.

**Build order** (each step shippable)

1. ~~Terraform in `infra/ec2/jobs.tf`~~ _(done and applied 2026-10-27)_:
   encrypted jobs bucket (30-day expiry, variable `jobs_retention_days`;
   **we may need longer retention** for class projects), job security group
   (no inbound; outbound 443 and 53 only), job instance role (SSM plus S3
   limited to `jobs/*/input|status.json|logs|output`), launch template
   (IMDSv2 required, tags readable, terminate on shutdown, encrypted root),
   `job_boot.sh` (runs `run.sh` as user `student` with the metadata service
   blocked for that user, under `timeout`, uploads, powers off), web server
   permissions (allowed instance types, template-only launch, IMDSv2 required,
   terminate only `Project=talon` + `Component=job`), monthly and daily AWS
   Budgets email alerts (account-wide, alerts only). VPC and subnets are
   variables (`job_vpc_id`, `job_subnet_ids`; removed 2026-11-05, jobs now use the Talon VPC jobs subnets). Outbound is open on 443 on
   purpose: students use kagglehub, Hugging Face and online datasets. Risk
   is bounded by the metadata block, no secrets on the box, the time limit
   and budget, and the 443/53-only group; GuardDuty is not enabled yet.
   Smoke test passed: a hand-launched job ran as `student`, metadata was
   blocked, log/output/status reached S3, and the instance terminated itself.
   From the web server's role (dry runs): allowed `t4g.small` and the
   template default; denied a disallowed type, a launch without the template,
   IMDSv2 optional, and terminating the web server. Not tested: `PassRole`
   limit, and a private subnet with NAT. Boot installs the AWS CLI with snap
   each time (billed boot time): bake an AMI later.
2. **Built, deployed to the demo box and verified on AWS (2026-10-27).** `ec2ExecutionAdapter.js` (stateless: clones the repo on
   the web server, ships `repo.tgz` and a generated `run.sh` to S3, launches
   from the launch template, reads `status.json`, logs and outputs back from
   S3, cancel writes `control/cancelled` and terminates), reserve-then-settle
   (migration 005 `jobs.reserved_cents`; launch charges `rate x (limit + 300 s
   allowance)`, finalize keeps the actual cost capped at the reservation and
   refunds the rest once; a failed launch refunds everything),
   `ec2Reconciler.js` (every 45 s: syncs unfinished EC2 jobs so results and
   charges do not wait for someone to load them, terminates instances with no
   job row, a finished job, or past limit + 20 min, the last sweep after the
   script's `timeout` at the limit and the instance's failsafe shutdown at
   limit + 15 min; a job whose instance vanished without a trace is billed
  from its launch time, capped at limit + boot allowance), static rate table
   (`ec2Rates.js`; t4g.small/medium/large plus `JOB_RATE_OVERHEAD_CENTS_PER_HOUR`,
   default 1 cent/h for IPv4 and EBS), admin-only `compute: "ec2"` on
   `POST /api/jobs`, `GET /api/jobs/compute-options`, a "Run on (admin)" select
   in the submit form, and job panels now shown to admins. Job sync moved to
   `services/jobSync.js`; execution calls dispatch on `executionRef.provider`.
   Launch is synchronous: a capacity failure fails the job and refunds (no
   queue yet). Off unless `EC2_JOBS_ENABLED=true`; Terraform
   writes it into `/etc/talon/talon.env` at first boot from the
   `ec2_jobs_enabled` variable (default true), so a rebuilt web server comes
   back configured. Settings come
   from SSM `/talon/demo/jobs-bucket|jobs-launch-template-id|jobs-subnet-ids`
   (created by `jobs.tf`), so a VPC move is a variable change.
   Verified on the box as admin (t4g.small, `paderevski/minimal-rnn`
   `script.py`): a job ran in 74 s, logs came back, cost 1 cent, ledger shows
   one 2-cent charge and one 1-cent refund; a cancel during boot ended as
   failed "Job cancelled" and billed the 60 s minimum; restarting the backend
   mid-job lost nothing: the reconciler finalized and charged the job without
   anyone loading it; no job instances were left running. The first
   `requirements.txt` run failed and found a real bug: on arm64 Ubuntu apt
   uses the regional EC2 ports mirror, which does not serve HTTPS (the job
   security group only allows HTTPS out), so `python3-venv` never installed.
   Fixed in `job_boot.sh` (global `ports.ubuntu.com` over HTTPS, IPv4 only;
   boot output now uploaded as `logs/boot.log`). Re-run after the fix:
   `minimal-rnn` with a Mac `pip freeze` as `requirements.txt` installed
   (including statsmodels, imported by the script) and completed in 151 s,
   1 cent. Not yet exercised: a job that hits its time limit, and the
   `PassRole` limit. Note the
   reconciler terminates any `Project=talon, Component=job` instance without a
   job row, so debug instances must use another `Component` tag.
   Heavy-job findings (2026-10-28, `minimal-rnn` with 4000x4000 SVDs):
   the time limit works (`timeout`, exit 124, "Time limit reached", cost
   capped, instance terminated) and stdout is unbuffered for every job
   (`python3 -u`, `PYTHONUNBUFFERED=1`), so output survives a kill. On
   `t4g.small` (2 GB) it was OOM-killed on the second iteration (exit 137,
   shown as "killed, usually out of memory"); on `t4g.medium` (4 GB) it ran
   about 45-60 s per iteration. `t4g` is burstable (unlimited-credit mode
   bills surplus CPU credits our rate does not cover), so step 3 dropped it.
   Timers, in order: the script's `timeout` at the limit, the instance's
   failsafe shutdown at limit + 15 min, and the reconciler at limit + 20 min
   (the last sweep).
3. **Built, deployed and verified on the demo box (2026-10-28).** Open to all students (kill switch
   `EC2_JOBS_ADMIN_ONLY=true`). Submit form: dead Machine Type / Image selects
   removed; "Machine" menu from the server (c7g.large, c7g.xlarge, m7g.large,
   m7g.xlarge, r7g.large; memory, CPUs and hourly rate shown; prices checked
   against the Price List API 2026-10-28; non-burstable only), "Time limit"
   (30 min to 24 h), a cost line ("up to $X", reserved at start, rest
   refunded), submit disabled when the reserve exceeds the student's budget,
   environment variables now passed to the script (strict names, quoted
   values). Limits: one unfinished EC2 job per user (admins exempt) and 10 in
   total (`EC2_MAX_JOBS_PER_USER`, `EC2_MAX_JOBS_TOTAL`), enforced in the
   reservation transaction under an advisory lock (parallel submits cannot
   slip past). Local runs on the web server are refused for everyone (admins
   too, since 2026-11-04) when `NODE_ENV=production` unless
   `TALON_ALLOW_LOCAL_JOBS=true`. Live logs:
   `job_boot.sh` uploads `job.log` and `boot.log` to S3 every 3 s when they
   changed (separate loop from the output upload, since 2026-11-05); the job
   log starts at boot with `[talon] HH:MM:SS` setup steps; the log panel
   polls every 2 s. **Output files, complete
   solution:** two sources as in the local runner, `output/`
   (`TALON_OUTPUT_DIR`, source `output_dir`) and `changed/` (files created or
   changed in the repo directory since the job started, source
   `repo_changed`, excluding `.git`, `venv`, `__pycache__`, `node_modules`,
   `*.pyc`); symlinks are never uploaded; limits 500 files, 200 MB per file,
   500 MB total, skipped files are noted in the job log; uploaded every 30 s
   and at the end (so a cancel or crash keeps what was already saved); list
   and download honor the source. Verified on the box: a hand-built job
   (both sources, mid-run sync, `__pycache__`/`*.pyc`/`venv`/symlinks left out,
   a 250 MB file skipped with a note in the log), and a real run as
   `student_a1` with `minimal-rnn`: options listed and local runs refused for
   students in production, a second submit rejected with 429 "You already
   have a job running", logs appeared live while the job ran, cancel ended it
   as failed at 1 cent (ledger: 5-cent charge, 4-cent refund), and the
   partial `output.txt` showed in Files (source `repo_changed`) and
   downloaded. Python buffers file writes, so a script killed mid-run loses
   data it has not flushed: tell students to `flush()` or close files
   (student documentation). A missing S3 permission for `changed/` was
   found and fixed during testing.
4. **GPU (merged to `main` 2026-11-04; decided 2026-11-03).** Left: test
   g6e.2xlarge on the box when it has capacity; GPU opened to students
   2026-11-04 (Terraform variable `ec2_gpu_admin_only`, default `false`, written into
   `/etc/talon/talon.env` at first boot like `ec2_jobs_enabled`; changing it
   replaces the web instance, which is fine since demo data is disposable).
   Checked that day in the LCPS account: G and P on-demand quotas 768 vCPUs
   each; on-demand prices g4dn.xlarge $0.526/h, g4dn.2xlarge $0.752/h,
   g6.xlarge $0.805/h, g7e.2xlarge $3.363/h (1x RTX PRO 6000, 96 GB);
   g4dn/g6 offered in us-east-1a-d and f, g7e only in 1b-d, none of the job
   types in 1e. Decisions:
   - **Native on a Deep Learning AMI, no Docker yet** (Docker and ECR move to
     step 4b; containers need their own metadata block, a `DOCKER-USER`
     iptables rule, and add image pull time to every job).
   - **One x86_64 GPU launch template** `talon-demo-job-gpu` next to the arm64
     CPU one (same role, security group, bucket and `job_boot.sh`; tag
     `talon-image` = `cpu` or `gpu`) on the PyTorch 2.12 Ubuntu 24.04 DLAMI,
     for g4dn.xlarge, g4dn.2xlarge, g6.xlarge and **g6e.2xlarge** (1x L40S
     48 GB, $2.242/h, the "big GPU"). IAM lets each template launch only its
     own types. The AMI comes from its SSM parameter at plan time, so it moves
     forward only on `terraform apply`.
   - **g7e dropped for now (2026-11-04).** The user asked for an 80 GB+ GPU;
     g7e.2xlarge (RTX PRO 6000 96 GB) was picked, but no 80 GB+ type had
     on-demand capacity in us-east-1 (capacity check below), so g6e.2xlarge
     replaced it and the Base-DLAMI template built for g7e was removed. To add
     G7e later: a second template on the Base DLAMI
     (`/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-24.04`,
     75 GB, the PyTorch DLAMIs do not list G7e), run.sh installs a CUDA 12.8+
     torch, and test boot time and Blackwell support. Other regions were not
     pursued: us-west-2 offers g7e/p5 with the same 768-vCPU quotas, but jobs
     there need regional Terraform copies, a reconciler sweep per region and
     cross-region S3 traffic; us-east-2's G quota is only 64 vCPUs.
   - **Job subnets:** one per zone in us-east-1a-d (default VPC then; the Talon VPC's jobs subnets since 2026-11-05)
     (`job_availability_zones`), so capacity errors move to the next zone. The adapter must also move on for `Unsupported`
     (type not offered in that zone), not only `InsufficientInstanceCapacity`,
     and should rotate the starting subnet.
   - **Admins only at first** (GPU kill switch, default on), plus a cap on
     GPU jobs at once (default 3).
   - **Time limit ceiling per type** (24 h for g4dn/g6, 8 h for g6e.2xlarge, settings)
     **and limited by the user's available budget**: the options carry the
     budget; the form disables unaffordable time limits (and a machine with
     none); the server keeps its 402 check.
   - Boot allowance: 300 s is enough on the PyTorch template (measured); a
     per-type override exists in the rate table but no type uses it.
   - **Applied 2026-11-03** (templates `talon-demo-job-gpu` and
     `talon-demo-job-gpu-base`, SSM `jobs-gpu-launch-template-id` and
     `jobs-gpu-base-launch-template-id`, 4 job subnets). Dry runs from the web
     server's role: each template launches only its own types (g4dn/g6 on
     `gpu`, g7e on `gpu-base`, CPU types on the CPU template); p5 denied.
     The g6e swap (next apply) removes `talon-demo-job-gpu-base` and its SSM
     parameter and adds g6e.2xlarge to the GPU template's types.
   - **g4dn.xlarge smoke tests (2026-11-04, `Component=debug`):** 43 s from
     launch to the script; AWS CLI already on the DLAMI (no snap install);
     Tesla T4 15 GB, driver 595, CUDA 13.2; `student` can use the GPU (device
     files are 0666) and the metadata service is blocked; apt over HTTPS works
     on x86 (archive and security). **torch lives in the `/opt/pytorch` venv
     on Python 3.13**, not the system 3.12 (so GPU jobs run 3.13, CPU jobs
     3.12). `--system-site-packages` does not see it (it is a venv itself); a
     job venv on `/usr/bin/python3.13` plus a `.pth` file pointing at
     `/opt/pytorch`'s site-packages does: `torch` in requirements.txt is
     "already satisfied", a different pinned version installs into the job
     venv and wins (pip leaves `/opt` alone). First `import torch` takes about
     90 s (the root volume loads lazily from its snapshot; billed). 4096x4096
     matmul: CPU 592 ms, GPU 29 ms.
   - **Big-GPU capacity check (us-east-1, 2026-11-04 about 05:30 UTC):**
     launched and terminated at once, every zone that offers the type. Got
     capacity: g6e.2xlarge (1c), g6e.4xlarge and g6e.8xlarge (1a). None:
     g6e.xlarge and .16xlarge, every g7e size (2xl to 48xl, also with no zone
     given), p5.4xlarge (all 6 zones), p4d, p4de, p5.48xlarge, p5en, p6-b200,
     p6-b300, and the 4x/8x g6e. 80 GB+ on demand looks scarce here (AWS sells
     it through Capacity Blocks and Spot); one snapshot, at night US time.
   - **Verified on the box (2026-11-04, branch `gpu-jobs` deployed, as
     admin through the tunnel):** students get no GPU options and a GPU
     submit is refused (403). `pytorch/examples` `mnist` on g4dn.xlarge:
     1 epoch completed in 2m 15s (98%), 3 cents (ledger: 32 charged, 29
     refunded); `torch`/`torchvision` in requirements.txt installed nothing;
     boot log shows the T4. 100 epochs: 25 min (about 15 s per epoch on the
     T4), 23 cents, so it did not reach its 30-minute limit; the time limit
     itself is the same `job_boot.sh` path verified on CPU. Cancel mid-training:
     failed after 1m 53s, 2 cents, instance terminated. g6e.2xlarge: no
     capacity in any zone at 05:46 UTC (it had some in 1c at 05:25);
     CloudTrail shows the adapter tried 1b, 1c, 1d, 1a (rotation and
     fallback work; the SDK retries each zone 3 times) and the job was
     refunded in full. The raw AWS error it showed named one zone and
     suggested the others, so a launch with no capacity anywhere now fails
     with 503 "No <type> machines are available right now..." (deployed and
     seen on the box, refunded in full). g6e.2xlarge is still untested on the box.
   - **Built on the branch (deployed to the box 2026-11-04):** rate table with GPU types, per-type
     ceilings (`EC2_MAX_RUNTIME_CEILING_SECONDS_<TYPE>`) and overhead; `EC2_GPU_ADMIN_ONLY` (default admin-only) and
     `EC2_MAX_GPU_JOBS_TOTAL` (default 3); adapter picks the template by type,
     moves to the next subnet on `Unsupported` as well as
     `InsufficientInstanceCapacity`, rotates the first subnet, and uses one
     `ClientToken` per subnet attempt; run.sh per image; `job_boot.sh` reads
     `talon-image`, skips apt on the PyTorch image and logs `nvidia-smi`
     (needs a `terraform apply` to reach the templates); form groups CPU and
     GPU machines, shows each machine's own time limits and disables choices
     the budget does not cover.
5. Spot, overnight queue, interruption handling, checkpoint docs.

**Network.** (Superseded 2026-11-05: jobs run in the Talon VPC, `network.tf`.) Stay in the default VPC for steps 1-3 (job security group with
no inbound; never allow it to reach the web server's group), but make VPC and
subnet ids Terraform variables so a Talon-owned or LCPS VPC is a change of
values. Open questions for LCPS IT: do they require their VPC, and which CIDR
ranges do they use (avoid overlap so peering stays possible). Unchecked:
whether the default VPC in the Academies account is shared with other
workloads. A dedicated VPC with private subnets is the go-public (ALB/WAF)
step. A VPC cannot be moved, so the web server would be replaced, not moved;
job instances are ephemeral and simply launch elsewhere.

**Not to use (for now).** No Kubernetes or Fargate to start and stop
instances: the control plane is `RunInstances` / `TerminateInstances` from
Express. Fargate has no GPU (verify current limits) and its sizes fall short
of the largest CPU tiers; it could later be a second backend for small CPU
jobs behind the same adapter. AWS Batch only if the hand-written dispatcher
becomes painful (it can pack several jobs on one instance, and it has no idea
of a student's budget).

**Keeping the door open for shells and notebooks (not planned yet)**

- Admin debugging shell is free: SSM policy on the job role, then
  `aws ssm start-session`. Tag every instance with the job id and owner.
- Student shell or Jupyter would be a separate "interactive session" job type.
  Students have no AWS identity, so the web server must broker access (SSM
  port forwarding or session proxied to the browser), scoped by tag and
  checked against job ownership. Jupyter needs WebSocket proxying and, above
  all, its own origin per job (wildcard certificate and DNS): a notebook runs
  arbitrary JavaScript and must not be served from the Talon origin. Needs an
  idle timeout, a hard session limit and budget reservation.
- Cheaper first step for notebooks: run `.ipynb` entry scripts headless
  (`papermill` / `nbconvert`) and return the executed notebook as output.
- Session secrets do not need sticky sessions behind an ALB: sessions are in
  Postgres and `SESSION_SECRET` / `TALON_CREDENTIALS_KEY` come from the same
  SSM parameters on every server.

### Limiting launch exposure (planned, 2026-11-04)

Today the web role holds `ec2:RunInstances`. The policy pins templates,
types, AMIs, security group, subnets, tags and disk size
(`check-launch-policy.sh`), but IAM cannot cap **how many** instances or limit
**user data**, so a compromised web server could still launch many job
instances running its own code. The vCPU alarms only notice. Options:

- **EC2 Fleet / Spot Fleet: no help.** `CreateFleet` is another launch API
  with the same IAM model and no cap across calls.
- **Launcher Lambda (near term, fits one instance per job).** The web role
  loses `RunInstances` and `iam:PassRole`; it only sends a job id (SQS or
  invoke). The Lambda reads the job settings, counts running Talon instances
  by tag, refuses over the limits, builds user data itself and launches.
  Reserved concurrency 1 so launches are serialized. The cap is code, but
  in a small function that is not internet-facing and never runs student
  code. Closes the user-data gap. Pairs with the launch-retry queue.
- **Auto Scaling group per machine type (structural, AWS-enforced cap).**
  The web role gets only `autoscaling:SetDesiredCapacity` and
  `TerminateInstanceInAutoScalingGroup` on Talon's groups, not
  `UpdateAutoScalingGroup`, so Terraform's `MaxSize` is a hard ceiling (the
  sum of maxes is the worst case). No `RunInstances` or PassRole on the web
  role at all; the ASG service role launches from a fixed template. Costs:
  instances are identical, so it needs a **worker-pull** model (job in SQS,
  instance takes one job, then removes itself with
  `--should-decrement-desired-capacity`, or the ASG replaces it); job role
  needs SQS receive and self-terminate. Gains: retries on no capacity for
  free, Spot via mixed instances, warm pools for faster starts. Verify
  autoscaling resource-level permissions against the docs before building.
- **Account level.** A dedicated Talon account in the LCPS Organization would
  make lower vCPU Service Quotas (support case to decrease) and budget
  actions real caps for Talon alone. SCPs can deny families, regions or
  untagged launches, but not counts.

Suggested order (written before the 2026-11-07 Batch direction, see "Next up"): launcher Lambda with the queue work; ASG + SQS workers
when moving to Spot or warm pools; ask LCPS for a dedicated account before
real students.

## Gaps to production (compared with the architecture doc, 2026-10-25)

Beyond the blocked items above (Entra, ALB/WAF, `lcps-ro`) and EC2-launched
jobs (previous section). Rough priority order.

### 1. Management screens and budget API

Done, merged to `main` and deployed to the demo box (2026-10-25, a78f8ec):
admin Students / Teachers / Admins lists (search, status and class filters,
sort by name (last name), budget or last sign-in; add and edit users, roles,
disable, reset password with a generated one-time password, clear login
lockout; click any budget to add or remove money in place, with a
confirmation step; removal never goes below $0) and a Classes screen
(create, rename, archive, add and remove teachers and students), a CSV
roster import (paste or upload; columns username, name, email, role, class,
budget; preview first, all-or-nothing, up to 500 rows, new classes created,
existing usernames left alone but still added to the class; generated
passwords returned once as a downloadable CSV; `rosterImport.js`), teacher
"add from pool" per student, and self-service change password (user menu). API:
`/api/admin/users|classes|budget/adjustments`, `/api/teacher/allocations`,
`/api/auth/password`; logic in `backend/src/services/management.js`. Still to do:

- ~~Class sections~~ done (migration 009, merged to `main`, d84af17):
  a class is one section, keyed by course name + teacher + block, with its
  own roster ("Calculus" with Tom in block 5, Tom in block 6 and Greg in
  block 5 are three classes). `classes.teacher_id` replaces teacher rows in
  `class_members` (now students only); block is required for new classes,
  NULL only on older ones. The database enforces, for active classes: the
  key is unique, a teacher has one class per block, a student has one class
  per block and one section per course (a trigger; violations are 409s
  with a readable message). Archiving frees the slots for the next year.
  On migrate, a class that had several teachers keeps the first; the others
  get an empty section of their own. CSV import still matches classes by
  name only (errors when a name has several sections); adding block and
  teacher columns to the import is still to do.
- Roster provisioning: only pre-provisioned users may sign in (decided).
  CSV import exists; an SIS sync is still to do.
- Term rollover: reset budgets, return pool money to the admin (archiving
  classes exists), remove graduated students; per-user storage quota
  overrides. No audit screen yet (grants record who did them, nothing reads
  them). New users have no forced password change on first sign-in.
- Submit form: done for on-demand CPU jobs (machine menu, time limit, cost
  estimate, environment variables). Still to do from the design: Spot,
  overnight queue, GPU tiers, and an environment/image choice (the Machine
  Image select was removed because it did nothing).
- Job-finished notification (students run overnight jobs).
- Submit form, code source: a "Code source" choice (GitHub app, public
  repository, Google Drive) above the job fields, merged to `main`
  2026-11-03. GitHub and public repos work; Google Drive
  is a mock-up only (disabled folder picker, submit disabled). Each source
  keeps its own repo when switching. Since branch `connections`
  (2026-11-06) the form sends `source: { type: "github", ... }` and the
  backend has a source registry (`src/sources/`); both git choices are the
  `github` source (no token = anonymous clone). Drive is the next source
  type: `docs/connections-and-sources-plan.md`.
- Job folder (merged, migration 007 `jobs.folder`): a job can run from
  a folder inside the repo (working directory, entry script relative to it,
  its requirements.txt else the root's). Pasting a github.com
  `/tree/<branch>/<folder>` or `/blob/<branch>/<path>.py` URL fills in
  branch, folder and script (a branch name with "/" is read as branch +
  folder). Verified on the box: pytorch/examples `mnist` (public, folder from the
  URL) ran to completion on EC2.
  The local runner still installs no requirements.
- Script arguments (merged, migration 008 `jobs.script_args`):
  an Arguments field next to Environment Variables, split shell-style
  (quotes, backslashes) but never run through a shell, passed after the
  entry script on both runners, recorded on the job. Branch is now a menu
  of the repo's branches (default first, chosen when the current one does
  not exist, e.g. master), free text if GitHub cannot be reached. Tested
  locally and on the box (2026-11-03: pytorch/examples mnist with
  `--save-model --epochs 1` saved `mnist/mnist_cnn.pt`).
- Output files and downloaded data: "changed files" are anything created or
  modified anywhere in the repo, listed relative to the repo root, so a
  dataset a script downloads into the repo (mnist: `../data` from `mnist/`
  -> `data/MNIST/raw/...`, about 65 MB) is saved as output and counts
  against the 500 MB / 500 file limits. To decide: skip common data and
  cache folders (`data/`, `datasets/`, `.cache/`) by default and/or honor a
  `.talonignore` in the repo; student docs should point results at
  `$TALON_OUTPUT_DIR`.
- GitHub: installation tokens last one hour, so a local-runner job queued
  longer than that fails to clone (local runner is dev/admin only). Repo list
  and browser calls for students who have not connected GitHub share the web
  server's anonymous GitHub limit (60 requests per hour per IP).

### 2. Compute pieces beyond the launch itself

- Queue and dispatcher: launches are synchronous today (a capacity failure
  fails the job and refunds it). The decided design is a Postgres queue
  (`FOR UPDATE SKIP LOCKED`, `not_before` for overnight, retry with backoff),
  with SQS only if it becomes painful. Custom GPU AMI (Ubuntu, NVIDIA
  drivers, Docker) and ECR images (general GPU, AlphaFold, R, CPU-only), plus
  a baked CPU AMI so boot stops installing the AWS CLI and pip each time.
- ~~Authenticated completion callback~~ (not needed: the instance writes
  `status.json` to S3 and the web server only reads it; there is no inbound
  path to the web server).
- Spot interruption handling, checkpoint/resume docs and helpers, resubmit.
- S3 per-user storage (`users/{id}/`): quota enforcement (the columns exist
  but nothing updates `storage_used_bytes`), presigned downloads,
  lifecycle to Infrequent Access.
- Isolation of student code: done for the first slice (own instance, student
  user, instance metadata blocked for it, no secrets on the box, HTTPS/DNS
  only outbound, local runner refused in production, admins too). Still
  open: per-job scoped credentials (the job role is shared across jobs),
  optional hardening (`timeout` run as root, cgroup memory/task limits), a
  dedicated VPC with private subnets, and GuardDuty.

### 3. Security and privacy before real students

- Student-data compliance (FERPA/COPPA, retention, privacy and acceptable-use
  notice, whether to encrypt email/name columns). The architecture doc says
  to confirm with LCPS IT before deployment; not settled. Check the 35-day
  backup retention against whatever they require.
- Web hardening: CSRF protection (SameSite=Lax helps; add an Origin check
  or token), security headers and a content security policy, request size
  limits, strict validation of repo and script inputs.
- Remove demo accounts and local password login before anything is public.
  The architecture doc says "no passwords stored"; today there are local
  password hashes for the demo users and the first admin.
- Audit log for admin actions (role and budget changes; grants record who,
  but nothing reads them yet).
- Checked 2026-11-04: CloudTrail has a multi-region trail
  (`management-events`, not an organization trail; its retention not
  checked); GuardDuty has no detector. Not checked: Inspector. (Web servers
  moved to private app subnets with a NAT gateway per zone and an S3
  endpoint, 2026-11-05.)

### 4. Operations

- More alarms: a budget action that stops launches (Budgets only email
  today); queue depth once there is a queue. Disk, backend errors, failed
  logins, unknown job instances and vCPU usage (`monitoring.tf`) and ALB
  healthy hosts and 5xx (`alb.tf`) alarms exist.
- Application logs are in CloudWatch Logs (CloudWatch agent: backend JSON,
  nginx JSON access, nginx error, syslog, bootstrap; see "Logs"). Job
  instance boot logs also go to `/talon/demo/jobs` (shipped with the AWS
  CLI, no agent). SSM session logging is not set up, and no CloudTrail trail
  is defined in this repo's Terraform. The account has exactly one trail, a
  management-events trail created outside Talon (`aws cloudtrail
  list-trails` shows only that one, confirmed 2026-11-07).
- CI/CD: tests run on every push and pull request (done 2026-11-05, item
  0d); deploys are still manual SSM runs. Next: automated deploys through
  an OIDC role.
- End-to-end restore drill onto a brand-new instance; a staging environment
  for the stakeholder demo; a load test at about 100 users; a security
  review.
- Runbooks (who does what in an outage), dependency update checks.

### 5. Documentation and cleanup

- ~~Architecture doc out of date~~ _(done 2026-11-05: v8 describes the
  system as built: own VPC, RDS Multi-AZ, S3 status file instead of
  callbacks, three roles, local passwords until Entra, shared account,
  per-job storage; then public access and AWS Batch as next steps.)_
- Account strategy: the doc wants a dedicated Talon sub-account with its own
  quotas. We are in LCPS's shared "Academies" account; decide if that is
  acceptable.
- Student documentation (budgets, checkpointing examples, how to use Talon).
- ~~Remove the debug panel and the Kubernetes adapter stub~~ _(done 2026-10-28 with the "Save as Template" button; `EXECUTION_PROVIDER` is gone.)_

## Later: two web servers or auto-replacement

Not needed for load. If wanted for availability:

1. ~~Secrets in SSM Parameter Store~~ (done, item 3: every server reads the
   same values).
2. ~~Jobs, results, GitHub credentials in Postgres~~ (done, items 6-7).
3. Move Postgres to **RDS** (Single-AZ to start, Multi-AZ when needed):
   automated backups and point-in-time restore. Connect with RDS-managed
   credentials (Secrets Manager) or IAM auth, TLS, port 5432 only from the
   web security group. One-time `pg_dump` / restore to migrate.
4. Job run directories and the local runner -> S3 + SQS dispatcher (per the
   architecture doc; see "Building EC2-launched jobs").
5. Auto Scaling group of 1 behind the ALB (self-healing), then 2.
   `user_data` currently seeds demo users and creates a local database, so
   it needs a production variant first.

Already compatible: sessions are in Postgres (no sticky sessions needed);
migrations take an advisory lock (concurrent deploys are safe).

The current plan for this is the "Talon Web Tier Plan" doc (4 phases: app
readiness; VPC + RDS; second server + internal ALB; going public). Phase 1,
app readiness (branch `web-tier-phase1`, 2026-11-05):

- Reconciler: each tick takes `pg_try_advisory_lock` (id 727275,
  `backend/src/db/advisoryLock.js`) on its own connection; other servers
  skip that tick.
- Proxy headers: see "App / box changes" under Going public.
- Database over TCP/TLS: `DATABASE_URL=postgres://talon@<host>:5432/talon?sslmode=verify-full&sslrootcert=<RDS CA bundle>`
  with the password in `PGPASSWORD` (from `secrets.env`, never in the
  URL). With `NODE_ENV=production` the backend refuses a remote host
  without `verify-full`. The local socket URL (peer auth) still works and
  is what the box uses until phase 2. Pool: 10 s connect timeout,
  keepalive.
- `/api/health` runs `SELECT 1` (2 s limit) and answers 503
  `{"ok":false,"database":"unavailable"}` when the database is down;
  `health.database_failed` / `health.database_recovered` are logged once
  per change.
- Scripts find web servers by tag (see "How to use").

Phase 2, network and database (2026-11-05; applied, cut over and merged to
`main`; see "Cutover progress" below):

- `network.tf`: VPC `10.20.0.0/16`; public, app and data subnets in 1a and
  1b, jobs subnets (/20, public IP on launch) in 1a-1d; one NAT gateway in
  1a (one per zone since 0c); S3 gateway endpoint on all route tables; default security group
  emptied.
- `rds.tf`: Postgres 16 `db.t4g.micro` (now `db.t4g.small`, Multi-AZ; 0c), 20 GB gp3 (autoscaling to 50),
  encrypted, private, `rds.force_ssl = 1`, 7-day backups, IAM auth on.
  Master user `talon_admin`, password managed by RDS in Secrets Manager.
  The web role gets `rds-db:connect` for `talon_app` and `talon_migrate`;
  `db_bootstrap = true` adds read access to the master secret.
- `web.tf` + `web_user_data.sh.tftpl`: launch template and one web server
  (`talon-demo-web`, app subnet 1a, no public IP). No local Postgres, no
  seeding, no backup timers; RDS CA bundle at `/etc/talon/rds-ca.pem`;
  `talon.env` has `DATABASE_URL` (talon_app), `DATABASE_MIGRATE_URL`
  (talon_migrate), `DATABASE_IAM_AUTH=true`. Replacing it keeps the data.
- Backend: `connectionConfig` signs IAM tokens (`@aws-sdk/rds-signer`);
  `useMigrationRole()` in the migrate, seed and create-admin scripts.
- `infra/server/db-bootstrap.sh` (via `infra/scripts/db-bootstrap.sh`):
  creates the roles, database `talon` owned by `talon_migrate`, and
  `talon_app`'s grants and default privileges. Idempotent.
- Jobs: job security group and subnets move to the new VPC by default.
- Old box: `legacy_web_server` (default true) keeps it, retagged
  `Component=web-legacy` so the scripts skip it; the backup alarms follow
  it. CloudWatch agent associations target by tag; the disk alarm watches
  the new server.
- Tested locally: bootstrap SQL as a non-superuser master (twice); migrate
  and seed as `talon_migrate`; all 27 HTTP regression cases with the server
  as `talon_app`; `talon_app` refused CREATE, TRUNCATE, DROP, ALTER; the
  IAM password path over `verify-full` with a stand-in signer. Not testable
  locally: real IAM tokens against RDS.

**Phase 2 cutover** (you run the applies; the old box stays until step 8):

1. `terraform plan`, then `terraform apply -var db_bootstrap=true`. Builds
   the VPC, NAT, RDS (about 10 minutes) and the new web server. Its first
   boot builds the app; the first migration fails by design (no roles yet).
2. Wait for "talon bootstrap complete" in `/var/log/talon-bootstrap.log`
   (`infra/scripts/shell.sh`, about 10 minutes).
3. `infra/scripts/db-bootstrap.sh`. It takes its SQL from the deployed
   commit, and first boot builds `git_ref` (default `main`): until phase 2
   is merged, run `deploy.sh web-tier-phase1 --keep-data` once first (it
   checks out and builds the branch, then fails at the migration, which is
   expected without roles). Until a deploy succeeds, nginx still serves its
   default site (404): first boot does not reload it.
4. `infra/scripts/deploy.sh web-tier-phase1` (migrates as `talon_migrate`,
   reseeds, applies `configure.sh`).
5. `infra/scripts/tunnel.sh` (now the new server): `/api/health`, log in.
6. Stop the old box (`aws ec2 stop-instances` on
   `terraform output -raw legacy_instance_id`). Both servers run a
   reconciler against different databases, and each would terminate the
   other's job instances ("no job row"): no jobs while both run.
7. Run a CPU test job end to end; `infra/scripts/check-launch-policy.sh`.
8. `terraform apply -var db_bootstrap=false -var legacy_web_server=false`:
   removes the old box, its Elastic IP and security group, the backup
   alarms and the master secret access.

Found in the cutover (2026-11-05): the bootstrap makes the master
(`talon_admin`) a member of `talon_migrate`, which is in `rds_iam`; RDS's
`pg_hba` rule `+rds_iam` matches indirect members, so from then on the
master's password is refused ("PAM authentication failed") and it signs in
with an IAM token. `db_bootstrap = true` therefore also allows
`rds-db:connect` as `talon_admin`, and `db-bootstrap.sh` tries a token
first (the Secrets Manager password only works on a brand-new database).
To restore password sign-in: `REVOKE talon_migrate FROM talon_admin`.

Also found: the CloudWatch agent install (State Manager) failed on the new
server at first boot, most likely racing first boot's own apt. Re-run the
two associations after a server's first boot completes, until phase 3 adds
a proper wait.

Cutover progress (2026-11-05): steps 1-7 done. Bootstrap (IAM token),
deploy and reseed on RDS; old box stopped; CloudWatch agent re-run; launch
policy check all ok from the new server; CPU test job `job-1001`
(paderevski/minimal-rnn, c7g.large, jobs subnet 1a) ran 1m 58s, $0.01,
output collected, instance powered off. Step 8 done the same day: old
box, its Elastic IP and security group, backup alarms and master sign-in
removed; `legacy_web_server` now defaults to false; a plain plan shows no
changes. **Phase 2 cutover complete.**

**Bug found, fixed on branch `job-s3-prefix` (2026-11-05):** job S3 folders were keyed by job id
only (`jobs/<id>/`), and the fresh RDS database restarted ids at 49, which
the old box had used (ids 49-72 still in the jobs bucket, 30-day expiry).
`job-49` picked up an October `status.json`: marked completed at $0.00 and
its instance terminated after 20 s; it would also have shown the old
job's logs and files (possibly another student's). Worked around by
`setval('job_id_seq', 1000)` on RDS. Fix: each launch gets
`jobs/<id>-<128 random bits>`, stored as `executionRef.s3Prefix` and passed
as the `talon-s3-prefix` tag; the launch's ClientToken uses the random part
too (a token from a reused id could return the old instance). Older jobs
keep `jobs/<id>`. Roll out with `terraform apply` (new job template
versions) BEFORE deploying the app: the new boot script falls back to the
old folder (fallback removed later, 0b), but the old one ignores the tag. Applied and deployed 2026-11-05;
verified on the box: `job-1002` wrote only to `jobs/job-1002-<random>/`;
with the counter set back so a new `job-58` reused an id whose old folder
held a succeeded status and model snapshots, the new job ran normally and
showed only its own `output.txt` (old snapshot download: 404). Counter
restored to 1002.


After the cutover: ~~delete `user_data.sh.tftpl`, `infra/backup/`,
`backup.sh` and the old-box code in `main.tf`~~ (done on branch
`infra-cleanup`, 2026-11-05, with the first-boot fixes: nginx reloaded,
CloudWatch agent installed and started by first boot itself); the backups
bucket stays until its copies expire. Applied the same day (web server
replaced, launch template version 2) and merged to `main` (98cac53). The
new server's first boot deployed `main` and served in about 2 minutes with
no manual step; all 52 jobs kept (data in RDS); the CloudWatch agent was
running and shipping logs and metrics without re-running the associations
(their first runs still show Failed on the package lock, harmlessly).

### Phase 3 as built (2026-11-05, merged to `main`)

An Auto Scaling group of two web servers (one per zone, from launch
template `talon-demo-web`) behind an internal ALB, reached through the SSM
tunnel. Plan doc "Talon Web Tier Plan" has the design. Built on branch
`web-tier-phase3`:
- `web.tf`: `aws_instance.web` replaced by Auto Scaling group
  `talon-demo-web` (`web_server_count` = 2, app subnets 1a/1b, ELB health
  checks, 10 min grace, rolling instance refresh that launches before it
  terminates). The launch template copies the provider's default tags
  (ASG-launched instances do not get them; scripts find servers by them).
- `alb.tf`: internal ALB `talon-demo-web` (idle timeout 180 s, drops
  invalid headers), target group port 80, health `GET /api/health` (now
  `/api/health/live`, see item 0c), 30 s
  drain; SG rules web->ALB:80 (tunnel) and ALB->web:80; alarms for
  healthy hosts < 2 for 10 min and ALB 5xx.
- Disk alarm is a Metrics Insights query (fullest disk of any server).
- First boot runs `infra/server/configure.sh` through
  `/usr/local/bin/talon-configure`, called by `talon-deploy`, and waits
  for the dpkg lock (`DPkg::Lock::Timeout`): SSM State Manager's
  CloudWatch agent install runs at registration and won the race on one
  server, whose first boot then died on `apt-get install`.
- `tunnel.sh` forwards to the ALB through a web server
  (`AWS-StartPortForwardingSessionToRemoteHost`); `TALON_DIRECT=1` goes to
  one server's nginx. Outputs: `web_asg_name`, `alb_dns_name`.
- RDS connections checked: `max_connections` 79, two pools of 10 fit.
Apply notes: the first group in the account creates
`AWSServiceRoleForAutoScaling`; launches failed for a minute while it
propagated, Terraform timed out and tainted the group (`terraform untaint`,
then apply). The template fix rolled through with no downtime (instance
refresh, ~12 min for two servers; a new server is healthy ~2.5 min after
launch). `terraform plan`: no changes.
Verified 2026-11-05: both servers healthy (1a, 1b, template v4), JSON logs
and proxy config from first boot with no deploy.sh; tunnel through the
ALB; requests spread over both servers; a login session works on both.
Seen once: one server's health check timed out on `SELECT 1` (2 s) for
13 s at 18:19 UTC, no outage. The pool has no `idleTimeoutMillis` (pg
default 10 s), so most health checks open a new TLS + IAM-token
connection; fixed on the branch (`idleTimeoutMillis` 5 min, not yet
deployed).
Failover check 2026-11-05 (backend stopped on the 1a server at 19:03:51,
probing through the tunnel every 2 s): the ALB marked it unhealthy at
19:04:35; until then about half the requests got 502 from that server's
nginx; none failed after. The group replaced it at 19:04:49 (ELB health),
the new server was healthy at 19:07:18; no alarm fired. This also covers
"terminate one". Health check tightened on the branch to 10 s x 2 (~20 s
window), applied 2026-11-05.
Deploy check 2026-11-05: `deploy.sh web-tier-phase3` (40 s) updated both
servers in turn (4ffaf1a, includes the idle timeout), migrations already
current, configure ran (twice per server, no changes the second time),
reseeded once on the first server.
Reconciler check: `job-1051` (paderevski/minimal-rnn `script.py`,
c7g.large) completed in 2 min, $0.01. Status picked up by the 1b
server's request sync; instance terminated once, by the 1a server's
reconciler; ledger has one reserve (-5c) and one refund (+4c).
All phase 3 checks pass. Merged to `main` 2026-11-05; `deploy.sh` no longer
runs configure itself (talon-deploy does, once per server).

## History

- 2026-11-05: Web tier phases 1-2 complete and merged to `main`: cutover
  done (old box removed), per-launch S3 job folders (`job-s3-prefix`,
  merge f1ac0b6; fixes job-id reuse reading another job's files), old-box
  code removed and first boot fixed (`infra-cleanup`, merge 98cac53; web
  server replaced and verified).
- 2026-11-05: Web tier phase 2 code (`web-tier-phase1`, not applied):
  Talon VPC, RDS with IAM auth, `talon_migrate` / `talon_app` roles, web
  server from a launch template without local Postgres, seeding or
  backups; old box kept behind `legacy_web_server` for the cutover.
- 2026-11-05: Web tier phase 1 (`web-tier-phase1`, deployed and checked):
  reconciler advisory lock, proxy headers through ALB and nginx, database
  over TLS (socket path kept), database-aware `/api/health`, scripts find
  web servers by tag, `deploy.sh` loops over servers and reseeds once.
- 2026-11-04: Logging (`logging-structured`). Backend JSON logs with stable
  event names and request ids in `/talon/demo/backend`; nginx JSON access log
  sharing the request id; job instance boot logs in `/talon/demo/jobs` with
  a timing summary; 16 saved Logs Insights queries; failed-logins alarm; the
  backend-errors and unknown-instance alarms moved to JSON events. Checked on
  the box (applied, deployed, merged): request tracing across nginx and
  backend, no query strings logged, alarms matching the JSON events; jobs
  69-72 logged submitted -> finished once (a double `job.finished` from
  concurrent syncs was fixed; billing was never doubled); boot logs and
  summaries arrived for CPU (m7g, c7g: about 12-22 s boot, 42 s setup) and
  GPU (g4dn: 67 s boot, 6 s setup), and `boot.log` reached S3. Still to do:
  a Talon-managed CloudTrail trail (ask LCPS IT about an organization trail first), SSM
  session logging, a database audit log for admin actions.
- 2026-11-04: Hardening (`harden-ec2-cloudwatch`), applied, deployed and
  checked on the box. Local runs refused in production for everyone and
  given only PATH/HOME/locale. Web role may launch only the job templates'
  AMIs, root volumes up to 500 GB (`job_max_volume_gb`; templates stay
  30 / 60 GB, a per-job disk size in the app is later work), tags it cannot
  override; `infra/scripts/check-launch-policy.sh` dry-runs all of this from
  the box (all as expected; user data override still allowed, IAM cannot
  limit it). Jobs get `TALON_SCRATCH_DIR` (GPU instance-store NVMe, verified
  on g4dn). CloudWatch agent, server logs and the new alarms above.
  GuardDuty in Terraform behind `enable_guardduty` (off; account-wide in a
  shared account, agree with LCPS IT). Hard spending cap still missing: a
  lower vCPU quota (support case) or a budget action.
- 2026-10-25: Torn down old EKS test stacks (`app`, `platform`, `bootstrap`)
  and stray EC2s in the personal account. Old IAM access keys for user
  `patrick` deactivated (deleted 2026-10-28).
- 2026-10-25: Created `infra/ec2` and launched this instance.
- 2026-10-25: Instance replaced to move app secrets into SSM (item 3); demo
  data reset.
- 2026-10-25: Nightly backups and alarms added; instance replaced again so
  first-boot installs the timers (SSM secrets survived the rebuild). Terraform
  state moved to S3. GitHub credentials, jobs and results moved to Postgres.
  Frontend polish merged. All to-do items 1-8 done and deployed from `main`.
- 2026-10-27: EC2-launched jobs built and applied (steps 1-2): jobs bucket,
  job role and launch template, web-server launch permissions, budget
  alerts, the EC2 adapter with reserve-then-settle billing, and the
  reconciler. Web instance replaced so `EC2_JOBS_ENABLED` comes from
  Terraform. Verified on the box (see build order).
- 2026-10-28: Step 3 built and verified: student-facing machine menu, time
  limits, per-user and system caps, live logs, output files from both
  sources. Fixes found by testing: apt over HTTPS on arm64, unbuffered
  Python output, the `changed/` S3 permission. Merged to `main`.
- 2026-10-28: Cleanup pass, merged to `main` (dead code removed,
  jobSync/reconciler/form tests, lost jobs billed for runtime). Walking the app
  as each role found: failed jobs showed no reason, the repo browser said only
  "Request failed: 422", and the live-log endpoint had no UI. Fixed: the result
  card shows the error, repo and branch errors say what is wrong, and a "Logs"
  button on each job row opens a log panel (polls while the job runs).
  Follow-ups: job lists no longer request every job's details and files on
  each refresh, the `[github-credentials]` debug logging is gone, logout
  clears the typed username, an over-pool allocation says so, and the roster
  message no longer shifts the table. Tests: `npm run test:frontend` is new
  (form estimate/budget logic in `frontend/src/utils/jobPlan.js`), and
  `jobSync` and the reconciler's lost-job path are covered in
  `backend/tests/postgres/run.mjs`. Not exercised on a real instance: the
  lost-job billing change, the log panel on EC2 jobs, and the new error
  messages; check them on the box now that it is deployed.
- 2026-11-03: GitHub App sign-in replaces PATs (item 13); merged to `main`.
- 2026-11-06: Connections and sources (merged, PR #8): Connections panel, generic connection store and routes, job inputs with source and snapshot (migration 011); plan in `docs/connections-and-sources-plan.md`.
- 2026-11-03: Code-source choice (GitHub / public / Drive mock-up), job folders (migration 007), admin GitHub unlink, revoked-token handling; merged to `main`.
- 2026-11-03: Script arguments (migration 008) and a branch menu; merged to `main`.
- 2026-11-04: Class sections (migration 009), merged to `main` (d84af17): a class is name + teacher + block; see Management screens.
- `infra_2/` (the older EKS design) was deleted 2026-11-05 (0b).

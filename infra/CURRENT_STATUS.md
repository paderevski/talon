# Talon infra - current status

_Last updated: 2026-10-28 (cleanup pass merged; the box runs it only after a redeploy, see History). The Talon app and job instances were last checked on the live box that day, before the cleanup pass; the account-level items in "Gaps to production" were last reviewed 2026-10-25._
Account IDs, instance ID, and IPs are in `CURRENT_STATUS.local.md`
(gitignored). Architecture doc: `docs/talon-architecture-summary-v7.docx`
(see "Gaps to production" for where it and reality differ).

## Running now

| Item | Value |
|---|---|
| AWS account | LCPS member account (profile `lcps`, SSO AdministratorAccess) |
| Region | `us-east-1` (default VPC, `us-east-1a`) |
| Instance | `talon-demo-app`, t4g.small, Ubuntu 24.04 arm64 |
| Elastic IP | Yes (no ports open; reserved for future DNS) - `terraform output public_ip` |
| Inbound access | None. SSM Session Manager only |
| Runtime | Node 24 LTS, nginx (port 80 -> static `frontend/dist`, `/api` -> `127.0.0.1:5174`), systemd `talon-backend`, Postgres 16 (local socket, peer auth). `EC2_JOBS_ENABLED=true` in `/etc/talon/talon.env` (written by Terraform at first boot) turns on EC2 jobs and the reconciler |
| Deployed | `origin/main` (EC2 jobs merged 2026-10-28) |
| Approx cost | ~$20/month (instance ~$12, EBS ~$1.60, public IPv4 ~$3.65, 2 KMS keys ~$2, alarms/S3/SNS pennies). Estimate, not read from the bill. Plus job instances (c7g/m7g/r7g, roughly 8-17 cents per hour each), billed per second while they run and charged to students' budgets |
| Other AWS resources | S3 backups bucket (`backups.tf`), SSM parameters under `/talon/demo/`, KMS keys `alias/talon-demo-secrets` and `alias/talon-demo-backups`, SNS topic `talon-demo-alerts` (email subscribed and confirmed), 2 CloudWatch alarms (`alarms.tf`), S3 state bucket (`infra/state`), jobs bucket, job role, security group and launch template (`jobs.tf`), 2 AWS Budgets alerts |
| Root volume | 20 GB gp3, encrypted with the default AWS-managed EBS key (the architecture doc asks for a KMS key; not changed) |
| OS patching | `unattended-upgrades` enabled on the box (checked) |
| Terraform state | S3 `talon-tfstate-<account id>` (versioned, locked); `infra/state` stack's own state is local and tiny |

## How to use

```bash
aws sso login --profile lcps     # when credentials expire (usually daily)
infra/scripts/tunnel.sh          # then open http://localhost:8080
infra/scripts/deploy.sh          # deploy origin/main (push first)
infra/scripts/shell.sh           # shell on the box
infra/scripts/backup.sh status   # newest backups (also: now, restore-test, install)
```

Demo login: see the main README.

On the box:

```bash
sudo journalctl -u talon-backend -f
sudo tail -f /var/log/talon-bootstrap.log
sudo /usr/local/bin/talon-deploy main
```

Key paths: app `/opt/talon`, config `/etc/talon/talon.env`, secrets
`/etc/talon/secrets.env` (loaded from SSM Parameter Store), service user
`talon`.

## Known limitations (demo mode)

- Users, sessions, budgets, GitHub credentials, jobs and results are in
  Postgres and survive deploys. Student jobs run on their own EC2 instance
  each (see "EC2-launched jobs"); their logs and output files are in the jobs
  bucket and expire after 30 days (`jobs_retention_days`), and they are not in
  the database backups. The local runner (on the web server, no isolation,
  `JOB_MAX_RUNTIME_SECONDS` default 30 minutes) is refused for non-admins in
  production and remains for development, tests and admins.
- Job instances can reach the internet on 443 (students download datasets
  and models), so jobs are not network-isolated; the instance metadata
  service is blocked for the student user and no secrets are on the box.
  GuardDuty is not enabled.
- Nightly database backups exist, but restoring onto a new instance is manual
  and has only been tested into a scratch database.
- Demo accounts have public passwords (they are in this repo). Fine only
  because the box is reachable through the SSM tunnel and nothing else; see
  "Going public".
- Plain HTTP on port 80 inside the tunnel (no TLS yet; the ALB adds it).
- Changing `user_data.sh.tftpl` replaces the instance (database is reset;
  restore from a backup by hand if it matters).
- The local job runner executes `git clone` / `python3` directly on the host
  as the `talon` user, so jobs are not isolated.

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
   CloudWatch alarms (`alarms.tf`): no successful backup in 36 hours, and
   a failed weekly restore test, both to SNS topic `talon-demo-alerts`. The
   alert email is set (`alert_email` in `terraform.tfvars`, gitignored) and
   the subscription is confirmed; both alarms were OK on 2026-10-25. The
   weekly restore test not running at all is not alarmed (CloudWatch cannot
   look back 8 days at weekly metrics).
   Still to do: restoring onto a replacement instance is only tested in a
   scratch DB, not end to end.
5. ~~**Terraform state to S3**~~ _(done 2026-10-25: bucket from
   `infra/state`; `infra/ec2` uses it with `use_lockfile`; lock tested. The
   old local state files were deleted 2026-10-28.)_

**Data into Postgres** (nothing resets on deploy after these; first step
toward two servers)

6. ~~**GitHub credentials -> Postgres**~~ _(done: table `github_credentials`,
   one row per user id, AES-256-GCM with the key id stored per row and the
   owner bound into the ciphertext; rotation via
   `npm run db:rotate-credentials-key`; old JSON file can be imported with
   `db:import-github-credentials`. They are in the nightly backups, and the
   backup is only readable together with the SSM key.)_
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

**Blocked on others**

9. **Entra ID sign-in** - waiting on the LCPS App Registration (ask early;
   IT lead time).
10. **ALB + WAF go-public** - waiting on hostname, exposure, and subnet
    decisions (see "Going public" below). Includes the X-Forwarded-Proto
    fix, removing demo users, creating the real admin.
11. **Read-only AWS role** (`lcps-ro`) - ask the LCPS AWS admins.

**Housekeeping**

- ~~Delete the deactivated personal IAM access keys, `~/.aws/credentials-bk`
  and the old local Terraform state copies~~ _(done 2026-10-28; the personal
  user has no access keys, it signs in with `aws login`.)_
- Term end: return leftover teacher pool money to the admin (needs a
  small admin action; see "Gaps to production").

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

1. **Hostname.** `talon.aet-cs.org` (DNS in personal Lightsail, can be done
   today; that record currently points to Lightsail Nginx-1, so repoint or
   use a new name like `talon-demo.aet-cs.org`) or
   `talon.academyofloudoun.org` (needs LCPS IT for the ACM validation CNAME
   and the ALIAS/CNAME to the ALB).
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
2. ALB in two public subnets (default VPC has six), HTTPS:443 listener with
   the ACM cert, HTTP:80 -> 301 to HTTPS. ALB security group: 443/80 from
   the allowed ranges.
3. Target group -> instance port 80 (nginx), health check `GET /api/health`.
4. Instance security group: inbound 80 **from the ALB security group only**.
5. WAF web ACL on the ALB: `AWSManagedRulesCommonRuleSet`,
   `AWSManagedRulesKnownBadInputsRuleSet`,
   `AWSManagedRulesAmazonIpReputationList`, a rate-based rule scoped to
   `/api/auth/login` (e.g. 20 per 5 min per IP), a general rate-based rule,
   optional IP-set allow-list. WAF logging to CloudWatch Logs.
6. DNS: CNAME/ALIAS for the hostname -> ALB DNS name.
7. ALB access logs to S3 (optional, useful for incident review).

### App / box changes that must ship with it

- **X-Forwarded-Proto through two proxies.** Chain is ALB (TLS) -> nginx
  (HTTP) -> Node. nginx currently sends `X-Forwarded-Proto $scheme`, which
  is `http` behind the ALB, so Express would think the request is HTTP and
  **refuse to set `Secure` session cookies (login silently fails)**. Pass
  the ALB's header through (`$http_x_forwarded_proto`) and set Express
  `trust proxy` to cover both hops.
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
   variables (`job_vpc_id`, `job_subnet_ids`). Outbound is open on 443 on
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
   slip past). Local runs on the web server are refused for non-admins when
   `NODE_ENV=production` unless `TALON_ALLOW_LOCAL_JOBS=true`. Live logs:
   `job_boot.sh` uploads the job log every 30 s. **Output files, complete
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
4. GPU: Deep Learning AMI, Docker, ECR image, `g4dn` first.
5. Spot, overnight queue, interruption handling, checkpoint docs.

**Network.** Stay in the default VPC for steps 1-3 (job security group with
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
  only outbound, local runner refused for non-admins in production). Still
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
- Not verified (not checked this session): CloudTrail with 90-day retention,
  GuardDuty, Inspector on the account; private subnet + NAT + VPC endpoints
  for the web server (it is in a public subnet today).

### 4. Operations

- More alarms: ALB health, dead-letter queue depth, abnormal compute spend
  (AWS Budgets). Only backup alarms exist.
- Application logs to CloudWatch Logs (journald only today) and SSM
  session logging.
- CI/CD: nothing runs the test suites automatically; deploys are manual SSM
  runs. Add tests on every push and automated deploys.
- End-to-end restore drill onto a brand-new instance; a staging environment
  for the stakeholder demo; a load test at about 100 users; a security
  review.
- Runbooks (who does what in an outage), dependency update checks.

### 5. Documentation and cleanup

- The architecture doc is out of date relative to what was built: it has
  two roles (we have student/teacher/admin), no passwords, Secrets Manager
  (we use SSM Parameter Store), a users table without classes or budgets,
  and an `infra/` EKS scaffold that now lives in `infra_2/`. A v8 would
  keep reviewers from being confused.
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

## History

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
  messages; check them after the next deploy.
- `infra_2/` is the older EKS design, kept for reference only.

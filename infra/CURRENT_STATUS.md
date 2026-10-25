# Talon infra - current status

_Last updated: 2026-10-25_. Account IDs, instance ID, and IPs are in
`CURRENT_STATUS.local.md` (gitignored).

## Running now

| Item | Value |
|---|---|
| AWS account | LCPS member account (profile `lcps`, SSO AdministratorAccess) |
| Region | `us-east-1` (default VPC, `us-east-1a`) |
| Instance | `talon-demo-app`, t4g.small, Ubuntu 24.04 arm64 |
| Elastic IP | Yes (no ports open; reserved for future DNS) - `terraform output public_ip` |
| Inbound access | None. SSM Session Manager only |
| Runtime | Node 24 LTS, nginx (port 80 -> static `frontend/dist`, `/api` -> `127.0.0.1:5174`), systemd `talon-backend`, Postgres 16 (local socket, peer auth) |
| Deployed | `origin/main` |
| Approx cost | ~$17/month (instance ~$12, EBS ~$1.60, public IPv4 ~$3.65) |
| Terraform state | S3 `talon-tfstate-<account id>` (versioned, locked); `infra/state` stack's own state is local and tiny |

## How to use

```bash
aws sso login --profile lcps     # when credentials expire (usually daily)
infra/scripts/tunnel.sh          # then open http://localhost:8080
infra/scripts/deploy.sh          # deploy origin/main (push first)
infra/scripts/shell.sh           # shell on the box
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
  Postgres and survive deploys. Job output files and the runner's live state
  are still on the instance disk, and jobs run on the web server itself
  (30 minute limit per run, `JOB_MAX_RUNTIME_SECONDS`).
- Nightly database backups exist, but restoring onto a new instance is manual.
- Changing `user_data.sh.tftpl` replaces the instance (database is reset;
  restore from a backup by hand if it matters).
- The local job runner executes `git clone` / `python3` directly on the host
  as the `talon` user, so jobs are not isolated.

## To-do (in order)

Ordered so each item makes the next one easier. Items 1-7 need no outside
decisions.

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
   a failed weekly restore test, both to SNS topic `talon-demo-alerts`. Set
   `alert_email` in `terraform.tfvars`, apply, and confirm the email AWS
   sends, or nobody is notified. The weekly restore test running at all is
   not alarmed (CloudWatch cannot look back 8 days at weekly metrics).
   Still to do: restoring onto a replacement instance is only tested in a
   scratch DB, not end to end.
5. ~~**Terraform state to S3**~~ _(done 2026-10-25: bucket from
   `infra/state`; `infra/ec2` uses it with `use_lockfile`; lock tested. Old
   local files kept as `*.migrated-to-s3` in `infra/ec2`: delete after a week
   if nothing broke.)_

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

8. **Plan step 5 remainder.** Teacher classes shown separately, dollar
   formatting, remove the client-side owner filter (the server filters
   now). Best after 7 so it targets the final API shapes.

**Blocked on others**

9. **Entra ID sign-in** - waiting on the LCPS App Registration (ask early;
   IT lead time).
10. **ALB + WAF go-public** - waiting on hostname, exposure, and subnet
    decisions (see "Going public" below). Includes the X-Forwarded-Proto
    fix, removing demo users, creating the real admin.
11. **Read-only AWS role** (`lcps-ro`) - ask the LCPS AWS admins.

**Housekeeping**

- **~2026-11-01:** delete the deactivated IAM access keys on the personal
  account and `~/.aws/credentials-bk` if nothing broke.
- Term end: return leftover teacher pool money to the admin (needs a
  small admin action; do with 7 or later).

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
- Per-account login throttling in `/api/auth/login` (lock or slow down after
  repeated failures).
- **No demo users on a reachable server.** Their passwords are public in
  this repo. Remove `TALON_ALLOW_DEMO_SEED`, disable/delete demo accounts,
  check the backend log for `[security] ... demo account(s)`.
- Create the real first admin:
  `npm run db:create-admin --workspace backend -- --username you@lcps.org`
  (random password, printed once).
- Nightly `pg_dump` to S3 (users now live only on this instance).

## Building EC2-launched jobs (notes for when we get there)

Today every job runs on the web server itself (`localExecutionAdapter`), with
a 30 minute limit. Moving to one EC2 instance per job fixes isolation and
makes cost real. What we know, and what to decide.

### What is already in place

- `jobs.compute_type`, `jobs.hourly_rate_cents` (snapshot taken at launch;
  fractions of a cent are allowed), `jobs.max_runtime_seconds`,
  `jobs.cost_cents`, `jobs.execution_ref` (jsonb, put the instance id here).
- Finishing a job stores its result and charges the owner's personal budget
  in one transaction, once per job (ledger has a unique charge per job).
  Cost = `max(seconds, 60) x rate / 3600`, rounded up to a cent.
- Submits are refused (402) when the rate is above 0 and the budget is 0.
- To add: an execution adapter that launches/terminates instances (the
  adapter interface is `start / getStatus / getLogs / listOutputFiles /
  cancel`), plus the pieces below. The Kubernetes adapter file is an old
  stub, not a guide.

### Verified against AWS docs (2026-10-25)

- **Billing:** EC2 Linux and Ubuntu are billed **per second with a 60 second
  minimum**, and only while the instance is in the **running** state (not
  pending, not stopped). EBS volumes are also billed per second (60 s
  minimum). So `seconds in running state x hourly rate` is what AWS bills for
  the instance. Boot, `user_data`, `git clone` and `pip install` time is
  billed: measure from the instance reaching *running*, not from the start of
  the training script, and decide whether students pay for setup time.
  ([instance-hour billing](https://repost.aws/knowledge-center/ec2-instance-hour-billing))
- **Rates:** the Price List API (`GetProducts`, service `AmazonEC2`, filter by
  instance type, region, `operatingSystem=Linux`, `tenancy=Shared`,
  `preInstalledSw=NA`, `capacitystatus=Used`) returns on-demand list prices.
  It is served from `api.pricing.us-east-1.amazonaws.com` and has **no VPC
  endpoint**, so the web server needs internet egress for it. Cache the
  rates (daily refresh is plenty) and snapshot the rate on each job. If we
  ever use Spot, the price differs per launch (EC2 spot price history).
- **vCPU quotas (checked in the LCPS account 2026-10-25, us-east-1):** G and
  VT 768, P 768, Standard 1152, DL 96, Inf 128, Trn 256 vCPUs. No increase is
  needed (a brand-new account would start at 0 for GPU families and 5 for
  Standard; this account has grown past that). Re-check with
  `aws service-quotas list-service-quotas --service-code ec2 --profile lcps`
  before relying on a region or family we have not used. **These limits are
  far too high to act as a spending cap** (768 GPU vCPUs is roughly 190
  `g4dn.xlarge` at once), so the real caps must be Talon's own: per-job max
  runtime, reserve-then-settle, a per-user concurrent job limit, and an AWS
  Budgets alarm. Optionally lower the quota ourselves (Service Quotas does
  not allow decreasing; use an IAM/SCP condition on allowed instance types
  instead).
  ([quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html))
- **Actual-cost reconciliation lags.** Cost allocation tags take up to 24 h
  to show on the Billing page and up to 24 h more after you activate them
  before Cost Explorer uses them, and activation is done in the
  **organization's management account** (LCPS IT owns it). So Cost Explorer
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

## Later: two web servers or auto-replacement

Not needed for load. If wanted for availability:

1. Move `SESSION_SECRET` and `TALON_CREDENTIALS_KEY` to SSM Parameter Store
   / Secrets Manager. **They must be identical on every server** (today
   each box generates its own).
2. Move jobs, results, and GitHub credentials from JSON files into Postgres.
3. Move Postgres to **RDS** (Single-AZ to start, Multi-AZ when needed):
   automated backups and point-in-time restore. Connect with RDS-managed
   credentials (Secrets Manager) or IAM auth, TLS, port 5432 only from the
   web security group. One-time `pg_dump` / restore to migrate.
4. Job run directories and the local runner -> S3 + SQS dispatcher (per the
   architecture doc).
5. Auto Scaling group of 1 behind the ALB (self-healing), then 2.

Already compatible: sessions are in Postgres (no sticky sessions needed);
migrations take an advisory lock (concurrent deploys are safe).

## History

- 2026-10-25: Torn down old EKS test stacks (`app`, `platform`, `bootstrap`)
  and stray EC2s in the personal account. Old IAM access keys for user
  `patrick` deactivated (delete after a week if nothing breaks).
- 2026-10-25: Created `infra/ec2` and launched this instance.
- 2026-10-25: Instance replaced to move app secrets into SSM (item 3); demo data reset.
- `infra_2/` is the older EKS design, kept for reference only.

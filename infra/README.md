# Talon infra (LCPS account)

Talon's private demo in the LCPS AWS account (profile `lcps`; account ID in
`ec2/terraform.tfvars`). Nothing is exposed to the internet: you reach the app
through an SSM Session Manager port forward. `CURRENT_STATUS.md` is the map of
what is running, what is done and what is next.

## What gets created (`infra/ec2`)

| File | What |
|---|---|
| `network.tf` | Talon's VPC `10.20.0.0/16`: public subnets (a NAT gateway per zone), private app subnets (web servers, ALB), data subnets (RDS, no route out), jobs subnets (job instances, own public IP, no inbound); S3 gateway endpoint |
| `web.tf` | Launch template and Auto Scaling group: two `t4g.small` web servers (Ubuntu 24.04 arm64), one per zone; no inbound except port 80 from the ALB |
| `alb.tf` | Internal ALB in front of them (health check `GET /api/health/live`), its security group rules and alarms |
| `rds.tf` | Postgres 16 on RDS (`db.t4g.small`, Multi-AZ, TLS, IAM sign-in; roles `talon_app` for the servers and `talon_migrate` for operators) |
| `jobs.tf` | Student jobs: jobs bucket, CPU and GPU job launch templates, job role, and the web servers' limited permission to launch and terminate job instances |
| `deploy.tf` | SSM parameter `deployed-commit` (the commit new servers deploy; written by `deploy.sh`) and the web role's read access to it |
| `secrets.tf`, `github.tf` | KMS key for app secrets and GitHub App settings in SSM (`/talon/<env>/`) |
| `monitoring.tf`, `log_queries.tf` | CloudWatch log groups, agent config, alarms, saved Logs Insights queries `Talon/*`; optional GuardDuty |
| `alarms.tf` | Alert topic (email) and account cost budgets |
| `main.tf` | Web server IAM role and the Ubuntu AMI |

The web servers' first boot (`web_user_data.sh.tftpl`) installs a pinned Node
(tarball from nodejs.org, checked against its SHA-256; `NODE_VERSION` and
`NODE_SHA256_ARM64` at the top of the template), nginx and the AWS CLI,
creates the `talon` service user, a loader for the app secrets in SSM (the
servers can read them, not write them; a new environment creates them once
with `infra/scripts/secrets.sh init`) and the `talon-deploy` /
`talon-configure` tools, then deploys. A server never migrates the database:
it can only sign in as `talon_app`.

What a server deploys is a commit SHA: `deploy.sh` resolves the branch to a
SHA once, every server checks out exactly that, and when all have it the SHA
is written to SSM `/talon/<env>/deployed-commit` (`deploy.tf`; Terraform only
sets the first value, `git_ref`). A replacement server deploys that commit,
not the tip of a branch. `talon-deploy` fetches into a root-owned clone
(`/var/lib/talon-deploy/repo.git`), installs with `npm ci --ignore-scripts`,
and records the commit in `/etc/talon/deployed-sha`. Scripts that run as root
(`talon-configure` -> `infra/server/configure.sh`, `db-bootstrap.sh`) come
from that root-owned clone at the recorded commit through
`talon-repo-script`, never from `/opt/talon`, which the `talon` user can
write. `configure.sh` pins the CloudWatch agent (`CWA_VERSION`,
`CWA_SHA256_ARM64`; its comment says how to bump). The backend unit is
sandboxed (`ProtectSystem=strict`, writable: `/tmp`, `/var/lib/talon`,
`/opt/talon/backend/data`). A server
serves about 2.5 minutes after launch with no manual step.

Changes to `web_user_data.sh.tftpl` reach servers only by replacing them (the
instance refresh after `terraform apply`), not by `deploy.sh`; changes to
`configure.sh` arrive with the next deploy.

Job instances boot from `job_boot.sh` (fetch input from S3, run the student's
script as an unprivileged user, upload results, power off).

## One-time setup

```bash
brew install --cask session-manager-plugin
aws sso login --profile lcps
```

## Terraform

Terraform cannot read `aws login` / SSO profile credentials directly, so
export them first. `aws-env.sh` clears stale ones, runs `aws sso login` if the
session has expired, checks the account, and exports. Source it again when
Terraform reports `ExpiredToken`; `source infra/scripts/aws-env.sh clear` when done.

```bash
source infra/scripts/aws-env.sh
cd infra/ec2
cp terraform.tfvars.example terraform.tfvars   # first time: fill in account_id, owner
cp backend.hcl.example backend.hcl             # first time: put your account id in the bucket name
terraform init -backend-config=backend.hcl
terraform plan -out=plan.tfplan && terraform apply plan.tfplan
```

The provider is pinned to the LCPS account via `allowed_account_ids`, so it
will refuse to run against your personal account. A change to
`web_user_data.sh.tftpl` (or anything else in the web launch template) rolls
through the web servers one at a time (instance refresh: a new server starts
and passes health checks before an old one stops), about 12 minutes for two.

A brand-new environment needs `infra/scripts/secrets.sh init` once (after the
first apply: the servers cannot create the two app secrets themselves), and a
brand-new database one bootstrap: apply with `db_bootstrap = true`, run
`infra/scripts/db-bootstrap.sh`, deploy, then apply with `db_bootstrap = false`
(see `rds.tf`).

### Migrations and admin scripts

The web servers sign in to RDS as `talon_app` (rows only). Anything that
changes the schema or needs the schema owner runs from your laptop as
`talon_migrate`, with your own AWS credentials (your identity needs
`rds-db:connect` as that role; AdministratorAccess has it):

- `deploy.sh` migrates before it touches any server, from the exact commit
  it deploys. `--no-migrate` skips that.
- `infra/scripts/db-run.sh [--as talon_migrate|talon_app] [--ref <sha-or-branch>] -- <command>`
  runs any backend command that way: an SSM port forward through a web
  server to RDS, an IAM token, TLS `verify-full`, in a clean checkout of
  `--ref` (default `origin/main`) with `npm ci --ignore-scripts`. For example
  `db-run.sh -- npm run db:create-admin --workspace backend -- --username you@lcps.org`.
  The tunnel and token code is `infra/scripts/rds-tunnel.sh` (also usable
  from your own scripts).
- Row-only scripts that need the app's secrets run on a web server as the
  service (`infra/scripts/shell.sh`):
  `sudo -u talon bash -c 'set -a; . /etc/talon/talon.env; . /etc/talon/secrets.env; set +a; cd /opt/talon && npm run db:unlock --workspace backend -- <username>'`
  (same for `db:rotate-credentials-key`).
- `db:wipe` and `db:seed:demo` are for local databases; against production
  the seed refuses and a wipe is a deliberate `db-run.sh` call.

## Daily use

```bash
infra/scripts/tunnel.sh                    # then open http://localhost:8080 (through the ALB)
infra/scripts/deploy.sh                    # migrate from this laptop, then deploy origin/main to every web server
infra/scripts/deploy.sh my-branch
infra/scripts/db-run.sh -- <command>       # run a backend script against RDS as talon_migrate (see Migrations)
infra/scripts/shell.sh                     # shell on a web server
infra/scripts/check-launch-policy.sh       # dry-run what the web role may launch
infra/scripts/status.sh [--deep] [--plan]  # one-screen status: servers, ALB, RDS, jobs, network, IAM, alarms, cost
infra/scripts/secrets.sh [list|set|rm|init] # SSM secrets by name, values never shown; type secrets hidden
```

On a web server:

```bash
tail -f /var/log/talon/backend.log        # backend (JSON lines)
sudo tail -f /var/log/talon-bootstrap.log # first boot
```

From a laptop, `aws logs tail /talon/demo/backend --follow` (all servers), or
the saved Logs Insights queries `Talon/*`.

## Demo-mode caveats

- All data is in RDS (automated backups, 7 days, point-in-time restore) and
  survives server replacement. `deploy.sh` never touches the data.
- Output files of student jobs are in the jobs bucket and expire after 30
  days. Jobs run by the local runner (development only; refused in
  production) keep output on the server's disk.
- Demo users have public passwords: the seed refuses in production and a
  production server disables any it finds at startup.
- Terraform state lives in S3 (`talon-tfstate-<account id>`, versioned,
  encrypted, native locking), created by the small `infra/state` stack, whose
  own state stays local. If you ever lose `infra/state/terraform.tfstate`,
  re-import the bucket (`terraform import aws_s3_bucket.state <bucket name>`)
  and apply.

## Going public

Not built yet: an internet-facing ALB with HTTPS on `talon.lcps.org` and
WAF. It waits on LCPS IT (DNS records) and the exposure and subnet
decisions; see `CURRENT_STATUS.md`, "Going public".

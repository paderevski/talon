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
| `rds.tf` | Postgres 16 on RDS (`db.t4g.small`, Multi-AZ, TLS, IAM sign-in; roles `talon_app` and `talon_migrate`) |
| `jobs.tf` | Student jobs: jobs bucket, CPU and GPU job launch templates, job role, and the web servers' limited permission to launch and terminate job instances |
| `secrets.tf`, `github.tf` | KMS key for app secrets and GitHub App settings in SSM (`/talon/<env>/`) |
| `monitoring.tf`, `log_queries.tf` | CloudWatch log groups, agent config, alarms, saved Logs Insights queries `Talon/*`; optional GuardDuty |
| `alarms.tf` | Alert topic (email) and account cost budgets |
| `main.tf` | Web server IAM role and the Ubuntu AMI |

The web servers' first boot (`web_user_data.sh.tftpl`) installs Node 24,
nginx and the AWS CLI, creates the `talon` service user, the app secrets in
SSM (only if they do not exist; they survive server replacement) and the
`talon-deploy` / `talon-configure` tools, then deploys `git_ref`.
`talon-configure` runs `infra/server/configure.sh` from the deployed commit:
nginx site, JSON logging, proxy headers and the CloudWatch agent. A server
serves about 2.5 minutes after launch with no manual step.

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

A brand-new database needs one bootstrap: apply with `db_bootstrap = true`,
run `infra/scripts/db-bootstrap.sh`, deploy, then apply with `db_bootstrap =
false` (see `rds.tf`).

## Daily use

```bash
infra/scripts/tunnel.sh                    # then open http://localhost:8080 (through the ALB)
infra/scripts/deploy.sh                    # deploy origin/main to every web server, reseed demo data
infra/scripts/deploy.sh my-branch --keep-data
infra/scripts/shell.sh                     # shell on a web server
infra/scripts/check-launch-policy.sh       # dry-run what the web role may launch
infra/scripts/status.sh [--deep] [--plan]  # one-screen status: servers, ALB, RDS, jobs, network, IAM, alarms, cost
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
  survives server replacement. `deploy.sh` reseeds fresh demo data by default
  (all users, classes, jobs); `--keep-data` skips it.
- Output files of student jobs are in the jobs bucket and expire after 30
  days. Jobs run by the local runner (development only; refused in
  production) keep output on the server's disk.
- Demo users (`TALON_ALLOW_DEMO_SEED=true`) have public passwords: never make
  a server with them reachable from the internet.
- Terraform state lives in S3 (`talon-tfstate-<account id>`, versioned,
  encrypted, native locking), created by the small `infra/state` stack, whose
  own state stays local. If you ever lose `infra/state/terraform.tfstate`,
  re-import the bucket (`terraform import aws_s3_bucket.state <bucket name>`)
  and apply.

## Going public

Not built yet: an internet-facing ALB with HTTPS on `talon.lcps.org` and
WAF. It waits on LCPS IT (DNS records) and the exposure and subnet
decisions; see `CURRENT_STATUS.md`, "Going public".

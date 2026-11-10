# Grafana for Talon (laptop)

One screen for the whole system (load balancer, web servers, database, jobs,
money, NAT gateways, backend logs) with drill-downs to a single web server,
job, student or request. Runs in Docker on your laptop, bound to
`127.0.0.1:3000`; nothing is deployed to AWS.

```bash
infra/grafana/grafana.sh up            # RDS database over an SSM tunnel (see below)
infra/grafana/grafana.sh up --local    # local talon_dev database instead
infra/grafana/grafana.sh status
infra/grafana/grafana.sh down
```

Then open http://localhost:3000 (no login: the port is local only).

## How it reads data

| Source | How | Notes |
|---|---|---|
| CloudWatch metrics and Logs Insights | `lcps` SSO profile. `grafana.sh` writes the temporary credentials to `~/.talon-grafana/aws/creds.json` and Grafana reads them with `credential_process = cat …`, so it reloads them when they expire | A background loop refreshes the file every 5 minutes. When the SSO session itself expires, run `grafana.sh up` again |
| Postgres | Role `talon_grafana`: `SELECT` on the `reporting` views only (migration 010), read-only transactions, 10 s statement timeout, 5 connections | No access to tables, password hashes, sessions or GitHub tokens |
| RDS mode | SSM port forward through a web server to RDS on `127.0.0.1:15432`; IAM token as the password, renewed every 5 minutes; TLS `verify-full` (the RDS host name maps to the tunnel inside the container) | Needs `talon_grafana` on RDS: `infra/scripts/db-bootstrap.sh` (with `db_bootstrap = true`), then a deploy so migration 010 runs |

AWS resources are found by tag (`Project=talon`, `Environment=$env`), so the
dashboards hold no account or resource ids.

## Dashboards

`build-dashboards.mjs` generates `dashboards/*.json`. Edit the generator,
then `node infra/grafana/build-dashboards.mjs`; Grafana reloads within 10 s.
Changes made in the Grafana UI are not saved to the repo (export the JSON
if you want to keep one).

| Dashboard | Drill-downs |
|---|---|
| Talon overview | Click a web server line, a job, a student, a request id or a server in the log table |
| Talon web server | CPU, memory, disk, network; nginx requests by status and slowest; backend warnings; nginx errors; first boot log |
| Talon running jobs | Jobs running or queued now (refreshes every 30 s): counts, time left, a table linking to each job, CPU and network of the running machines, jobs finished in the last 2 hours, job warnings and errors. Linked from "Jobs now" on the overview |
| Talon job | Database row, ledger entries, machine CPU and network, job machine log, backend events |
| Talon student | Balance, jobs, cost, classes, ledger |
| Talon request trace | nginx and backend lines for one request id |

Gaps: no VPC flow logs (network shows NAT and server traffic only); job
machines have basic EC2 metrics only, one point every 5 minutes (no memory or GPU use); CloudWatch alarm
states are not shown; spend comes from the ledger (job cost), not AWS billing.

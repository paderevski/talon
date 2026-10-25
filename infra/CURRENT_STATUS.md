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

- Users/sessions/budgets are in Postgres and survive deploys; jobs and
  results are still tracked JSON files and reset on each deploy.
- Nightly database backups exist, but restoring onto a new instance is manual.
- `githubCredentials.json` is untracked, so it survives deploys but not
  instance replacement. Changing `user_data.sh.tftpl` replaces the instance.
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
   Still to do: an alarm if no dump has landed in 36 hours (today you must
   run `backup.sh status` to notice), and restoring from a dump onto a
   replacement instance is only tested in the scratch DB, not end to end.
5. ~~**Terraform state to S3**~~ _(done 2026-10-25: bucket from
   `infra/state`; `infra/ec2` uses it with `use_lockfile`; lock tested. Old
   local files kept as `*.migrated-to-s3` in `infra/ec2`: delete after a week
   if nothing broke.)_

**Data into Postgres** (nothing resets on deploy after these; first step
toward two servers)

6. **GitHub credentials -> Postgres**, still encrypted with
   `TALON_CREDENTIALS_KEY`, keyed by user id. Replaces
   `githubCredentials.json` (which also ends its world-readable file mode).
   Store a **key id** with each encrypted token so the key can be rotated
   without everyone re-entering tokens.
7. **Jobs and results -> Postgres**, owned by user id, with the budget
   ledger charging jobs. Removes the JSON files and the demo owner
   assignment (`demoOwnership.js`).

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

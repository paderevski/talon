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
| Terraform state | **Local only**: `infra/ec2/terraform.tfstate` (gitignored) - do not delete |

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

Key paths: app `/opt/talon`, config `/etc/talon/talon.env` (contains the
generated `TALON_CREDENTIALS_KEY`), service user `talon`.

## Known limitations (demo mode)

- Users/sessions/budgets are in Postgres and survive deploys; jobs and
  results are still tracked JSON files and reset on each deploy.
- No database backups yet (instance replacement loses users).
- `githubCredentials.json` is untracked, so it survives deploys but not
  instance replacement. Changing `user_data.sh.tftpl` replaces the instance.
- The local job runner executes `git clone` / `python3` directly on the host
  as the `talon` user, so jobs are not isolated.
- No backups. The instance is disposable; rebuild with `terraform apply`.

## Next steps

1. Commit `infra/`, README updates, and the `githubCredentials.json` untrack.
2. Move Terraform state to S3 (with `use_lockfile`) in the LCPS account.
3. Move GitHub credentials to Postgres or AWS Secrets Manager / SSM.
4. Move runtime data out of the repo tree (e.g. `/var/lib/talon`) so deploys
   don't reset it.
5. Ask LCPS AWS admins for a read-only permission set (`lcps-ro` profile).

## Going public (later)

1. Add 80/443 ingress to the security group (or restrict to LCPS ranges).
2. Point `talon.aet-cs.org` at the Elastic IP. DNS is in Lightsail on the
   **personal** account; that record currently points to another server,
   so check nothing there still needs it.
3. `sudo certbot --nginx -d talon.aet-cs.org` on the box.
4. **No demo users on a reachable server.** Their passwords are public in
   this repo. Check the backend log for `[security] ... demo account(s)`,
   and never set `TALON_ALLOW_DEMO_SEED=true` there.
5. Create the real first admin with
   `npm run db:create-admin --workspace backend -- --username you@lcps.org`
   (random password, printed once).
6. In `/etc/talon/talon.env`: remove `TALON_ALLOW_DEMO_SEED`, add
   `SESSION_COOKIE_SECURE=true` (`SESSION_SECRET` is already generated).

## History

- 2026-10-25: Torn down old EKS test stacks (`app`, `platform`, `bootstrap`)
  and stray EC2s in the personal account. Old IAM access keys for user
  `patrick` deactivated (delete after a week if nothing breaks).
- 2026-10-25: Created `infra/ec2` and launched this instance.
- `infra_2/` is the older EKS design, kept for reference only.

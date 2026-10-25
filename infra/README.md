# Talon infra - single EC2 demo (LCPS account)

One Ubuntu 24.04 Graviton instance running nginx + the Node backend, in the
LCPS AWS account (profile `lcps`; account ID in `ec2/terraform.tfvars`). Nothing is exposed to the
internet: you reach the app through an SSM Session Manager port forward.

`infra_2/` is the older EKS design, kept for reference.

## What gets created (`infra/ec2`)

- EC2 `t4g.small` in the default VPC, encrypted 20 GB gp3, IMDSv2 required
- Security group with **no inbound rules**
- IAM role with `AmazonSSMManagedInstanceCore` (shell + port forwarding)
- Elastic IP (reserved for pointing `talon.aet-cs.org` here later)

First boot (`user_data.sh.tftpl`) installs Node 24, nginx, git, python3 and
Postgres 16, creates a `talon` service user and a `talon` database it reaches
over the Unix socket with peer auth (no DB password), creates
`TALON_CREDENTIALS_KEY` and `SESSION_SECRET` in SSM Parameter Store
(`/talon/<env>/`, only if they do not exist; they survive instance
replacement) and loads them into `/etc/talon/secrets.env` at each start,
clones this repo to `/opt/talon`, builds, runs migrations, seeds the demo
users once, and starts `talon-backend` under systemd. About 5 minutes.

## One-time setup

```bash
brew install --cask session-manager-plugin
aws sso login --profile lcps
```

## Create / destroy

Terraform cannot read `aws login` / SSO profile credentials directly, so
export them first (valid for the current session):

```bash
eval "$(aws configure export-credentials --profile lcps --format env)"
cd infra/ec2
cp terraform.tfvars.example terraform.tfvars   # first time: fill in account_id, owner
cp backend.hcl.example backend.hcl             # first time: put your account id in the bucket name
terraform init -backend-config=backend.hcl
terraform plan
terraform apply
terraform destroy
```

The provider is pinned to the LCPS account via `allowed_account_ids`, so it
will refuse to run against your personal account.

## Daily use

```bash
infra/scripts/tunnel.sh        # then open http://localhost:8080
infra/scripts/deploy.sh        # deploy origin/main (push first!)
infra/scripts/deploy.sh my-branch
infra/scripts/shell.sh         # shell on the box
```

On the box:

```bash
sudo journalctl -u talon-backend -f       # backend logs
sudo tail -f /var/log/talon-bootstrap.log # first-boot log
sudo /usr/local/bin/talon-deploy main     # same as deploy.sh
sudo -u talon psql talon                  # database shell
```

## Demo-mode caveats

- Users, roles, classes, budgets, and sessions live in Postgres and
  **survive deploys** (`deploy.sh` runs migrations). They do not survive
  instance replacement; there are no backups yet.
- Jobs and results are still JSON files in the git tree
  (`backend/src/data/*.json`) and reset to the committed version on every
  deploy. Untracked files such as `githubCredentials.json` survive deploys.
- Demo users are seeded once on first boot (`TALON_ALLOW_DEMO_SEED=true` in
  the env file). Their passwords are public: see "Going public".
- Changing `user_data.sh.tftpl` replaces the instance on the next `apply`.
- Terraform state lives in S3 (`talon-tfstate-<account id>`, versioned,
  encrypted, native locking), created by the small `infra/state` stack, whose
  own state stays local. Rebuilding on a new machine needs only
  `terraform init -backend-config=backend.hcl`. If you ever lose
  `infra/state/terraform.tfstate`, re-import the bucket
  (`terraform import aws_s3_bucket.state <bucket name>`) and apply.

## Later: going public

1. Add 80/443 ingress to the security group.
2. Point `talon.aet-cs.org` (Lightsail DNS, personal account) at the
   `public_ip` output, or move the zone to Route 53 in this account.
3. `sudo certbot --nginx -d talon.aet-cs.org` on the box.
4. Replace the `x-talon-user` header auth before real users arrive.

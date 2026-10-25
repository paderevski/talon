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

First boot (`user_data.sh.tftpl`) installs Node 24, nginx, git, python3,
creates a `talon` service user, generates `TALON_CREDENTIALS_KEY` into
`/etc/talon/talon.env`, clones this repo to `/opt/talon`, builds, and starts
`talon-backend` under systemd. It takes about 5 minutes after `apply`.

## One-time setup

```bash
brew install --cask session-manager-plugin
aws sso login --profile lcps
```

## Create / destroy

```bash
cd infra/ec2
cp terraform.tfvars.example terraform.tfvars   # first time: fill in account_id, owner
terraform init
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
```

## Demo-mode caveats

- `deploy.sh` force-syncs to `origin/<branch>`: tracked data files
  (`backend/src/data/*.json`, `users.txt`, `backend/data/talon-demo.sqlite`)
  reset to the committed version on every deploy. Untracked files such as
  `githubCredentials.json` survive deploys but not instance replacement.
- Changing `user_data.sh.tftpl` replaces the instance on the next `apply`.
- Terraform state is local (`infra/ec2/terraform.tfstate`, gitignored).
  Move it to S3 before sharing this stack.

## Later: going public

1. Add 80/443 ingress to the security group.
2. Point `talon.aet-cs.org` (Lightsail DNS, personal account) at the
   `public_ip` output, or move the zone to Route 53 in this account.
3. `sudo certbot --nginx -d talon.aet-cs.org` on the box.
4. Replace the `x-talon-user` header auth before real users arrive.

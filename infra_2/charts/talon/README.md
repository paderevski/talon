# Talon Helm Chart

This chart deploys Talon workloads onto Kubernetes/EKS.

## Components

- API deployment + service + optional ingress
- Dispatcher deployment
- Runner Job template (on-demand)
- Service accounts for each component (optional create flag)

By default, dispatcher and runner service accounts are set to use existing names:

- talon-dispatcher
- talon-runner

This aligns with the IRSA service accounts provisioned by Terraform in the app layer.

## Quick Start

Render templates locally:

```bash
helm template talon ./infra/charts/talon -n talon
```

Install API + dispatcher to cluster:

```bash
helm upgrade --install talon ./infra/charts/talon \
  -n talon \
  --create-namespace \
  -f ./infra/charts/talon/values.dev.yaml
```

## Runner Job Model

The runner is job-based. It does not run as an always-on Deployment.

To create a one-off runner job from this chart, set `runnerJob.create=true` with a unique job name:

```bash
helm upgrade --install talon ./infra/charts/talon \
  -n talon \
  -f ./infra/charts/talon/values.dev.yaml \
  --set runnerJob.create=true \
  --set runnerJob.name=talon-run-001
```

Helper command:

```bash
./infra/charts/talon/scripts/submit-runner-job.sh talon-run-001 dev talon
```

Build and push runner image helper:

```bash
./infra/charts/talon/scripts/build-push-runner-image.sh dev us-east-1 706194210592 linux/amd64
```

Recommended usage in automation:

- Keep chart release managing API + dispatcher with `runnerJob.create=false`
- Create per-job Kubernetes Job objects from backend/dispatcher logic

## Typical IRSA Setup

If Terraform app layer already created service accounts with IRSA:

- Keep `dispatcher.serviceAccount.create=false`
- Keep `runner.serviceAccount.create=false`
- Use names `talon-dispatcher` and `talon-runner`

For API, set `api.serviceAccount.create` based on whether API needs AWS role access.

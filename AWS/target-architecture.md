# Target Architecture (Small Start, Production-Ready Path)

## 1) Networking and Security Foundation

- Single `VPC` across at least 2 AZs.
- Public subnets: `ALB`, `NAT Gateway`.
- Private subnets: API/service runtime, worker orchestration, `RDS`.
- No direct SSH to compute nodes; use `SSM Session Manager`.
- Security groups with least privilege between tiers.
- `WAF` on `ALB` for IP reputation + rate limiting rules.

## 2) App/API Tier

- Start with `ECS Fargate` or EC2-hosted container service for API/backend.
- `ALB` + `ACM` TLS certificates.
- Horizontal scaling based on CPU/latency/queue depth.
- Store app config/secrets in `Secrets Manager` / `SSM Parameter Store`.

## 3) Authentication and Authorization

- Prefer `Amazon Cognito` for local + OAuth providers.
- Issue JWTs to frontend, validate at API.
- Define RBAC roles (`user`, `admin`, `operator`).
- Log auth events for auditability.

## 4) Data Plane

- `RDS PostgreSQL` for user records, job metadata/history, billing counters.
- `S3` for large datasets, model artifacts, and archived outputs.
- `EBS` only for short-lived local scratch or controlled app home data.
- Encryption at rest via `KMS` for `RDS`, `S3`, `EBS`, and queue payloads.

## 5) Job Queue and Execution

- `SQS` standard queue for job intake; add FIFO only if strict ordering is needed.
- `DLQ` for poison messages.
- Worker service pulls from queue and submits to `AWS Batch` GPU compute environments.
- Cap at 4 GPU nodes initially with queue/compute environment limits.
- Make job execution idempotent (job token + status machine in DB).

## 6) Cost Supervisor and Guardrails

- Dedicated supervisor service (or scheduled controller) checks:
  - per-job budget
  - per-user/project daily budget
  - global monthly budget
- On threshold breach:
  - stop new dispatch
  - terminate running job where allowed
  - mark terminal status in DB
  - persist partial artifacts to `S3` when feasible
- Budget and anomaly alarms via `AWS Budgets` + `Cost Anomaly Detection`.

## 7) Observability and Ops

- Centralized logs in `CloudWatch Logs` (API + workers + scheduler + supervisor).
- Metrics dashboards:
  - API latency/error rate
  - queue depth/age
  - job throughput/failure rates
  - GPU utilization
  - cost burn rate vs budget
- Alerts routed to Slack/email/PagerDuty.

## 8) Backups and Disaster Recovery

- `RDS` automated backups + PITR.
- `S3` versioning + lifecycle rules (Standard -> IA -> Glacier where appropriate).
- Optional cross-region backup copy for critical data.
- Run quarterly restore test drills.

## 9) CI/CD and Infrastructure as Code

- Infrastructure managed via `Terraform` or `AWS CDK`.
- CI pipeline (lint/test/build/security scan).
- CD pipeline with staged rollout and rollback path.
- Separate AWS accounts/environments for `dev`, `staging`, `prod`.

---

## Minimal Service Set to Launch

- `ALB`, `ECS` (or EC2 app service)
- `Cognito`
- `RDS PostgreSQL`
- `S3`
- `SQS` + `DLQ`
- `AWS Batch` GPU compute (max 4 nodes)
- `CloudWatch` + alarms
- `KMS`, `Secrets Manager`, `WAF`

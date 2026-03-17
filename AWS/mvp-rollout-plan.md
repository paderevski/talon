# MVP Rollout Plan (2–3 Weeks + Hardening)

## Phase 0: Foundation (Days 1–3)

- Create AWS account structure and baseline IAM roles.
- Stand up VPC, subnets, security groups, NAT, ALB, ACM.
- Set up IaC repo/modules and environment separation (`dev`, `staging`, `prod`).
- Add Secrets Manager and KMS keys.

**Exit criteria**
- Network and identity baseline deployed by IaC in `dev` and `staging`.

## Phase 1: Core App + Auth + DB (Days 4–7)

- Deploy API service to ECS (or hardened EC2 service as interim).
- Add Cognito auth (local + one OAuth provider).
- Add RDS Postgres schema for:
  - users
  - jobs
  - job events
  - usage counters
- Move large payloads/artifacts to S3.

**Exit criteria**
- User can sign in, submit job metadata, and view persisted job state.

## Phase 2: Queue + GPU Execution (Days 8–12)

- Introduce SQS + DLQ job intake.
- Build worker dispatcher to submit jobs into AWS Batch.
- Configure GPU compute environment (max 4 nodes).
- Ensure idempotent job state transitions in DB.

**Exit criteria**
- End-to-end async job lifecycle works under retry/failure scenarios.

## Phase 3: Cost Supervisor + Reliability (Days 13–16)

- Implement budget policy engine:
  - per-job cap
  - per-user/project cap
  - monthly global cap
- Add kill/stop logic for over-budget jobs.
- Add artifact finalization policy (S3 preferred, EBS only when needed).
- Add CloudWatch dashboards + alarms + on-call notifications.

**Exit criteria**
- System halts/terminates work when budget limits are crossed and surfaces clear operator state.

## Phase 4: Hardening (Days 17–21)

- Add WAF baseline protections.
- Add backup lifecycle + restore runbook.
- Add load test and failure-mode test (queue flood, worker failures, DB failover drill).
- Finalize runbooks and SLOs.

**Exit criteria**
- Team can deploy, observe, recover, and control spend with confidence.

---

## First Post-MVP Enhancements

- Spot diversification for GPU workers.
- Per-tenant quota and isolation model.
- Multi-region read strategy if global users emerge.
- Deeper tracing (`X-Ray` or OpenTelemetry).

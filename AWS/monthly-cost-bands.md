# Monthly Cost Bands (Rough Order-of-Magnitude)

These are directional ranges, not quotes. Actual cost depends on region, instance families, traffic, storage growth, and GPU hours.

## Assumptions

- ~100 active users
- Moderate API traffic
- Async jobs with occasional GPU demand
- Max GPU fleet size = 4 nodes
- Storage in S3 grows over time

## Estimated Bands

### A) Baseline Platform (no heavy GPU usage)

- API runtime (`ECS`/EC2), ALB, NAT, CloudWatch, WAF, Secrets/KMS, light SQS: **$200–$700 / month**
- RDS Postgres (small production shape + backups): **$150–$500 / month**
- S3 (small/moderate footprint): **$20–$200 / month**

**Subtotal:** **~$370–$1,400 / month**

### B) GPU Workload Add-on

- Depends mostly on GPU hours and instance type.
- Light use: **$300–$1,500 / month**
- Moderate use: **$1,500–$6,000 / month**
- Heavy use near cap (up to 4 nodes often active): **$6,000+ / month**

### C) Practical Total Range

- Early MVP with limited GPU: **~$700–$3,000 / month**
- Active production with steady GPU jobs: **~$3,000–$10,000+ / month**

## Cost-Control Guardrails to Enable on Day 1

- `AWS Budgets` alerts at 50%, 75%, 90%, 100%.
- Cost anomaly detection with immediate notification.
- Queue-based admission control when monthly burn exceeds threshold.
- Use Spot where retry-tolerant; keep critical jobs on On-Demand.
- S3 lifecycle policies + data retention policy.
- Per-user/project quotas in DB-enforced supervisor logic.

## What to Measure Weekly

- Cost per successful job (by job type).
- GPU utilization and idle time.
- Retry/failure rates causing wasted compute.
- Storage growth and stale artifact ratio.

# AWS Buildout Starter

This folder contains a practical, small-to-production AWS infrastructure plan for Talon.

## Files

- `target-architecture.md` — production-grade reference architecture for your requirements.
- `mvp-rollout-plan.md` — phased implementation plan (roughly 2–3 weeks for MVP + hardening).
- `monthly-cost-bands.md` — rough monthly cost ranges and cost-control guardrails.

## Current assumptions

- Initial active users: ~100
- Current deployment: single EC2 instance
- Compute profile: queue-based async jobs, some requiring GPU
- GPU max concurrency target: up to 4 nodes

## Suggested operating principle

Start with managed AWS services where possible (`RDS`, `SQS`, `AWS Batch`, `Cognito`, `CloudWatch`) and keep custom code focused on product logic (job payloads, cost policy, result handling).

# Production Environment

Use the same layered structure as dev:

- bootstrap
- platform
- app

Recommended production controls:

- Separate AWS account
- CI-only apply permissions
- Protected Terraform apply workflow with approvals
- Stronger RDS/EKS sizing and availability defaults

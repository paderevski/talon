# Talon Infrastructure (Terraform)

This folder provides a from-scratch Terraform foundation for Talon on AWS.

## Goals

- Zero-to-talon path in a new AWS account
- Reusable modules for core platform services
- Environment layering (`bootstrap` -> `platform` -> `app`)
- Consistent project grouping via tags + AWS Resource Group

## Stack Layout

- `modules/` reusable building blocks
- `environments/dev/bootstrap` Terraform state bucket, lock table, state KMS key
- `environments/dev/platform` VPC, EKS, ECR, S3 artifacts, SQS/DLQ, RDS, observability, resource group
- `environments/dev/app` Kubernetes namespace + IRSA service accounts for dispatcher/runner
- `charts/talon` Helm chart for Talon workloads (api, dispatcher, runner)

`staging/` and `prod/` are placeholders for the same layering pattern.

## Required Tooling

- Terraform `>= 1.7`
- AWS CLI configured to the target account
- `kubectl` (for post-deploy verification)

## Mandatory Resource Grouping Strategy

Every resource is tagged with:

- `Project=talon`
- `Environment=<env>`
- `ManagedBy=terraform`
- `Owner=<team>`
- `CostCenter=<finance tag>`

The platform layer creates an AWS Resource Group filtered by `Project` + `Environment` tags.

## Zero-to-Talon (Dev) Quickstart

1. Create var files from examples:

```bash
cd infra/environments/dev/bootstrap
cp terraform.tfvars.example terraform.tfvars
```

Set a globally unique `state_bucket_name`.

2. Apply bootstrap layer (local state for first apply):

```bash
terraform init
terraform plan
terraform apply
```

3. Configure remote backend for platform layer with `-backend-config` flags:

```bash
cd ../platform
cp terraform.tfvars.example terraform.tfvars
terraform init \
  -backend-config="bucket=<state-bucket-name>" \
  -backend-config="key=talon/dev/platform/terraform.tfstate" \
  -backend-config="region=<aws-region>" \
  -backend-config="dynamodb_table=<lock-table-name>" \
  -backend-config="encrypt=true"
terraform plan
terraform apply
```

4. Configure remote backend for app layer and apply:

```bash
cd ../app
cp terraform.tfvars.example terraform.tfvars
terraform init \
  -backend-config="bucket=<state-bucket-name>" \
  -backend-config="key=talon/dev/app/terraform.tfstate" \
  -backend-config="region=<aws-region>" \
  -backend-config="dynamodb_table=<lock-table-name>" \
  -backend-config="encrypt=true"
terraform plan
terraform apply
```

5. Verify:

```bash
aws eks update-kubeconfig --name talon-dev-eks --region <aws-region>
kubectl get ns
kubectl get sa -n talon
```

## Notes

- This scaffold prioritizes reproducibility and sane defaults over app-specific deployment details.
- A starter Helm chart is included at `infra/charts/talon` for API/dispatcher/runner deployment.
- Next step is wiring chart values to CI/CD image tags and EKS execution adapter runtime settings.
- For production: use separate AWS accounts and CI-based Terraform apply with OIDC.

## Cost Parking (Dev)

For test periods, you can park and unpark the expensive layers:

```bash
./infra/charts/talon/scripts/talon-terraform-lifecycle.sh park
./infra/charts/talon/scripts/talon-terraform-lifecycle.sh unpark
```

Modes:

- `standard` (default): destroys/recreates `app` + `platform`, keeps `bootstrap` state infra.
- `full`: destroys/recreates `app` + `platform` + `bootstrap`.

Examples:

```bash
./infra/charts/talon/scripts/talon-terraform-lifecycle.sh park standard
./infra/charts/talon/scripts/talon-terraform-lifecycle.sh unpark standard

./infra/charts/talon/scripts/talon-terraform-lifecycle.sh park full
./infra/charts/talon/scripts/talon-terraform-lifecycle.sh unpark full
```

After `unpark`, redeploy workloads:

```bash
helm upgrade --install talon infra/charts/talon -n talon -f infra/charts/talon/values.dev.yaml
```

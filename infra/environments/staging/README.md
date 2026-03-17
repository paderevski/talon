# Staging Environment

Use the same layered structure as dev:

- bootstrap
- platform
- app

Recommended next step:
- Copy `infra/environments/dev/*` into staging equivalents
- Update defaults (`environment = "staging"`)
- Use separate Terraform state key prefixes and dedicated AWS account when possible

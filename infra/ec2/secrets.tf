# App secrets live in SSM Parameter Store (SecureString), encrypted with a
# customer-managed KMS key. The parameters are NOT created here: their values
# are generated on the instance at first boot (put-parameter --no-overwrite)
# so they never appear in Terraform state, and they are deliberately outside
# Terraform so `terraform destroy` or an instance replacement cannot delete
# them. Names: <secrets_prefix>/session-secret and <secrets_prefix>/credentials-key.
data "aws_caller_identity" "current" {}

locals {
  secrets_prefix = "/talon/${var.environment}"
  secret_names   = ["session-secret", "credentials-key"]
}

resource "aws_kms_key" "secrets" {
  description             = "Talon ${var.environment} app secrets (SSM SecureString)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${local.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

data "aws_iam_policy_document" "app_secrets" {
  statement {
    sid     = "ReadAndCreateAppSecrets"
    actions = ["ssm:GetParameter", "ssm:PutParameter"]
    resources = [
      for n in local.secret_names :
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.secrets_prefix}/${n}"
    ]
  }

  statement {
    sid       = "UseSecretsKeyViaSsmOnly"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.secrets.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "app_secrets" {
  name   = "${local.name}-app-secrets"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.app_secrets.json
}

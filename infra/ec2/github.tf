# GitHub App sign-in ("Connect GitHub"). The app belongs to the AET-CS
# GitHub org and is created by hand on github.com (see README "GitHub App").
#
# Non-secret settings are SSM String parameters from the variables below.
# The two secrets are SecureString parameters created BY HAND (not here, so
# they never appear in Terraform state), encrypted with the app secrets key:
#   <prefix>/github-app-client-secret
#   <prefix>/github-app-private-key      (the .pem file's contents)
# The backend reads all five at first use and re-checks every minute while
# any is missing, so no restart or instance replacement is needed. Without
# them GitHub sign-in is off and public repos still work.

locals {
  github_app_settings = {
    for k, v in {
      "github-app-client-id" = var.github_app_client_id
      "github-app-slug"      = var.github_app_slug
      "public-url"           = var.public_url
    } : k => v if v != ""
  }
  github_app_secret_names = ["github-app-client-secret", "github-app-private-key"]
}

resource "aws_ssm_parameter" "github_app" {
  for_each = local.github_app_settings
  name     = "${local.secrets_prefix}/${each.key}"
  type     = "String"
  value    = each.value
}

data "aws_iam_policy_document" "github_app" {
  statement {
    sid     = "ReadGithubAppSettings"
    actions = ["ssm:GetParameters"]
    # By name, so the hand-made secrets are covered before they exist.
    resources = [
      for n in concat(keys(local.github_app_settings), local.github_app_secret_names) :
      "arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter${local.secrets_prefix}/${n}"
    ]
  }
  # kms:Decrypt on the secrets key (via SSM only) is already granted in secrets.tf.
}

resource "aws_iam_role_policy" "github_app" {
  name   = "${local.name}-github-app"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.github_app.json
}

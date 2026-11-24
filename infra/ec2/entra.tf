# Sign in with Microsoft (Entra ID, the LCPS tenant). The App Registration
# is LCPS IT's (Web platform, delegated openid/profile/email with admin
# consent, user assignment limited to Talon's users). It must also add the
# optional ID token claims `email` and `xms_edov` (Token configuration):
# Talon trusts only an email Microsoft marks verified, so without them only
# accounts an admin linked (db-link-entra) can sign in. Only plain students
# are linked by email automatically. See backend/src/auth/entra.js.
#
# Non-secret settings are SSM String parameters from the variables below.
# The client secret is a SecureString parameter created BY HAND (never in
# Terraform state), encrypted with the app secrets key:
#   <prefix>/entra-client-secret
# The backend reads them at first use and re-checks every minute while any
# is missing, so no restart is needed. Without them the login page shows no
# Microsoft button. Redirect URIs registered on the app:
#   <public_url>/api/auth/entra/callback
#   http://localhost:5173/api/auth/entra/callback   (local dev)
#   http://localhost:8080/api/auth/entra/callback   (SSM tunnel)
# The client secret expires (IT sets 6-24 months): replace the SSM value
# before then, or Microsoft sign-in stops (logged as entra.invalid_client).

locals {
  entra_settings = {
    for k, v in {
      "entra-tenant-id"     = var.entra_tenant_id
      "entra-client-id"     = var.entra_client_id
      "entra-auto-create"   = var.entra_auto_create
      "entra-email-domains" = var.entra_email_domains
    } : k => v if v != ""
  }
}

resource "aws_ssm_parameter" "entra" {
  for_each = local.entra_settings
  name     = "${local.secrets_prefix}/${each.key}"
  type     = "String"
  value    = each.value
}

data "aws_iam_policy_document" "entra" {
  statement {
    sid     = "ReadEntraSettings"
    actions = ["ssm:GetParameters"]
    # By name (all of them), so settings added later and the hand-made
    # secret are covered before they exist.
    resources = [
      for n in ["entra-tenant-id", "entra-client-id", "entra-auto-create", "entra-email-domains", "entra-client-secret"] :
      "arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter${local.secrets_prefix}/${n}"
    ]
  }
  # kms:Decrypt on the secrets key (via SSM only) is already granted in secrets.tf.
}

resource "aws_iam_role_policy" "entra" {
  name   = "${local.name}-entra"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.entra.json
}

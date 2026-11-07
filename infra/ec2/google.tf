# Google Drive connection (Connections panel). The OAuth client lives in a
# Google Cloud project created by hand (personal project for testing first,
# an LCPS Workspace project later; see docs/connections-and-sources-plan.md).
#
# Non-secret settings are SSM String parameters from the variables below.
# The picker API key is sent to browsers by design; restrict it in Google
# Cloud to the Picker API and Talon's origins. The client secret is a
# SecureString parameter created BY HAND (never in Terraform state),
# encrypted with the app secrets key:
#   <prefix>/google-oauth-client-secret
# The backend reads them at first use and re-checks every minute while any
# is missing, so no restart is needed. Without them the Google Drive card
# says "not set up". Redirect URI to register in Google Cloud:
#   <public_url>/api/connections/google_drive/callback

locals {
  google_settings = {
    for k, v in {
      "google-oauth-client-id" = var.google_oauth_client_id
      "google-project-number"  = var.google_project_number
      "google-picker-api-key"  = var.google_picker_api_key
    } : k => v if v != ""
  }
  google_secret_names = ["google-oauth-client-secret"]
}

resource "aws_ssm_parameter" "google" {
  for_each = local.google_settings
  name     = "${local.secrets_prefix}/${each.key}"
  type     = "String"
  value    = each.value
}

data "aws_iam_policy_document" "google" {
  statement {
    sid     = "ReadGoogleSettings"
    actions = ["ssm:GetParameters"]
    # By name (all of them), so settings added later and the hand-made
    # secret are covered before they exist.
    resources = [
      for n in ["google-oauth-client-id", "google-project-number", "google-picker-api-key", "google-oauth-client-secret"] :
      "arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter${local.secrets_prefix}/${n}"
    ]
  }
  # kms:Decrypt on the secrets key (via SSM only) is already granted in secrets.tf.
}

resource "aws_iam_role_policy" "google" {
  name   = "${local.name}-google"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.google.json
}

# The commit the web servers run. infra/scripts/deploy.sh writes the commit
# SHA it deployed here (after every server has it), and a server started by
# the Auto Scaling group (first boot, replacement) deploys exactly that commit
# instead of the tip of a branch. Terraform only creates the parameter, with
# git_ref as its first value; the value then belongs to deploy.sh, so changes
# to it are ignored. The web role can read it, not write it: only someone
# allowed to put parameters (an operator) can choose what new servers run.
resource "aws_ssm_parameter" "deployed_commit" {
  name        = "${local.secrets_prefix}/deployed-commit"
  description = "Commit the web servers deploy at first boot (written by infra/scripts/deploy.sh)"
  type        = "String"
  value       = var.git_ref

  lifecycle {
    ignore_changes = [value]
  }
}

data "aws_iam_policy_document" "deployed_commit" {
  statement {
    sid       = "ReadDeployedCommit"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.deployed_commit.arn]
  }
}

resource "aws_iam_role_policy" "deployed_commit" {
  name   = "${local.name}-deployed-commit"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.deployed_commit.json
}

locals {
  name       = "talon-${var.environment}"
  account_id = var.account_id # the provider refuses any other account
}

# Ubuntu 24.04 arm64 for the web server (web.tf) and CPU job instances (jobs.tf).
data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

# The web server's role and instance profile. Its permissions are attached in
# the files that need them: secrets.tf (app secrets), rds.tf (database
# sign-in), jobs.tf (launching jobs), monitoring.tf (CloudWatch agent).
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${local.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Session Manager (shell, port forwarding, Run Command): the only way in.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-instance"
  role = aws_iam_role.instance.name
}

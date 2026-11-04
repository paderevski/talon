#!/bin/bash
# Check what the web server's role may launch, from the web server itself
# (SSM Run Command, the instance role's own credentials). Every call is
# `run-instances --dry-run`: AWS checks permissions and launches nothing.
# Usage: infra/scripts/check-launch-policy.sh
source "$(dirname "$0")/common.sh"

ID="$(instance_id)"
PREFIX="/talon/${TALON_ENV:-demo}"

# Things the server's role cannot look up itself: an AMI that is not a
# template's, and a security group that is not the job one (the server's own).
OTHER_AMI="$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)"
OTHER_SG="$(aws ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)"

read -r -d '' REMOTE <<EOF || true
export AWS_REGION=$AWS_REGION AWS_PAGER=""
param() { aws ssm get-parameter --name "$PREFIX/\$1" --query Parameter.Value --output text; }
LT=\$(param jobs-launch-template-id)
GPU_LT=\$(param jobs-gpu-launch-template-id)
SUBNET=\$(param jobs-subnet-ids | cut -d, -f1)
TAGS='ResourceType=instance,Tags=[{Key=Project,Value=talon},{Key=Component,Value=job}]'
FAIL=0
check() {
  local want=\$1 label=\$2 out got; shift 2
  out=\$(aws ec2 run-instances --dry-run --subnet-id "\$SUBNET" "\$@" 2>&1)
  case "\$out" in
    *DryRunOperation*) got=allowed ;;
    *UnauthorizedOperation*) got=denied ;;
    *) got="error: \$(echo "\$out" | tail -1)" ;;
  esac
  if [ "\$got" = "\$want" ]; then echo "ok    \$label: \$got"; else echo "FAIL  \$label: expected \$want, got \$got"; FAIL=1; fi
}
check allowed "CPU template as the app launches it" --launch-template "LaunchTemplateId=\$LT,Version=\\\$Default" --tag-specifications "\$TAGS"
check allowed "GPU template, g4dn.xlarge" --launch-template "LaunchTemplateId=\$GPU_LT,Version=\\\$Default" --instance-type g4dn.xlarge --tag-specifications "\$TAGS"
check denied "another AMI" --launch-template "LaunchTemplateId=\$LT,Version=\\\$Default" --image-id $OTHER_AMI --tag-specifications "\$TAGS"
check denied "another security group" --launch-template "LaunchTemplateId=\$LT,Version=\\\$Default" --security-group-ids $OTHER_SG --tag-specifications "\$TAGS"
check denied "instance type not on the list" --launch-template "LaunchTemplateId=\$LT,Version=\\\$Default" --instance-type c7g.4xlarge --tag-specifications "\$TAGS"
check allowed "500 GB root volume (the cap)" --launch-template "LaunchTemplateId=\$LT,Version=\\\$Default" --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":500}}]' --tag-specifications "\$TAGS"
check denied "1000 GB root volume" --launch-template "LaunchTemplateId=\$LT,Version=\\\$Default" --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":1000}}]' --tag-specifications "\$TAGS"
check allowed "no tags in the call (the template adds Talon's)" --launch-template "LaunchTemplateId=\$LT,Version=\\\$Default"
check denied "tags overridden (Project=other)" --launch-template "LaunchTemplateId=\$LT,Version=\\\$Default" --tag-specifications 'ResourceType=instance,Tags=[{Key=Project,Value=other},{Key=Component,Value=job}]'
check denied "no launch template" --image-id $OTHER_AMI --instance-type c7g.large --tag-specifications "\$TAGS"
echo "known gap (IAM cannot limit it):"
check allowed "  user data override" --launch-template "LaunchTemplateId=\$LT,Version=\\\$Default" --user-data "#!/bin/bash" --tag-specifications "\$TAGS"
exit \$FAIL
EOF

PARAMS="$(python3 -c 'import json,sys; print(json.dumps({"commands": sys.stdin.read().splitlines()}))' <<<"$REMOTE")"
CMD_ID="$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
  --comment "talon check launch policy" --parameters "$PARAMS" \
  --query Command.CommandId --output text)"
aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$ID" || true
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$ID" \
  --query '[StandardOutputContent,StandardErrorContent]' --output text
STATUS="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$ID" --query Status --output text)"
[ "$STATUS" = "Success" ] || { echo "Check $STATUS"; exit 1; }

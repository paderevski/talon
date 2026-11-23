#!/bin/bash
# Job images: which AMI each job launch template boots, the newest candidate,
# and a smoke test of a candidate before it goes live.
#
#   infra/scripts/job-image.sh status
#   infra/scripts/job-image.sh test cpu|gpu <ami-id>
#
# The images are pinned in infra/ec2/terraform.tfvars (cpu_job_ami_id,
# gpu_job_ami_id), so a new image goes live only on purpose:
#   1. `status` shows the pinned image and the newest one (the CPU image is
#      rebuilt with OS security updates on the 1st of each month, image.tf;
#      the GPU image is Amazon's newest build of the pinned PyTorch line);
#   2. `test` runs a smoke job on the candidate (Python, a pip install in a
#      venv, the metadata block; on GPU also CUDA and PyTorch);
#   3. put the new id in terraform.tfvars and apply. Roll back by restoring
#      the previous id; keep that image until the next month's switch.
#
# The test instance is tagged Component=manual-test, so the backend's
# reconciler leaves it alone; it uses the repo's job_boot.sh (the same
# script the launch templates carry), shuts itself down, and its S3 folder is
# deleted afterwards. Costs a few cents (CPU) or about 10 cents (GPU).
source "$(dirname "$0")/common.sh"

NAME="talon-$TALON_ENV"
CPU_CANDIDATE_PARAM="/imagebuilder/$NAME/cpu-job" # image.tf (local.cpu_image_param)
GPU_CANDIDATE_PARAM="${TALON_GPU_AMI_PARAMETER:-/aws/service/deeplearning/ami/x86_64/oss-nvidia-driver-gpu-pytorch-2.12-ubuntu-24.04/latest/ami-id}" # jobs.tf default

template_name() { if [ "$1" = gpu ]; then echo "$NAME-job-gpu"; else echo "$NAME-job"; fi; }
pinned_ami() {
  aws ec2 describe-launch-template-versions --launch-template-name "$(template_name "$1")" --versions '$Default' \
    --query 'LaunchTemplateVersions[0].LaunchTemplateData.ImageId' --output text
}
candidate_ami() {
  local param=$CPU_CANDIDATE_PARAM
  [ "$1" = gpu ] && param=$GPU_CANDIDATE_PARAM
  aws ssm get-parameter --name "$param" --query Parameter.Value --output text 2>/dev/null || echo "-"
}
describe_ami() {
  [ "$1" = "-" ] && { echo "(none)"; return; }
  aws ec2 describe-images --image-ids "$1" --query 'Images[0].[Name,CreationDate]' --output text 2>/dev/null | tr '\t' ' ' || echo "(not found)"
}

status() {
  local kind live cand
  for kind in cpu gpu; do
    live="$(pinned_ami "$kind")"; cand="$(candidate_ami "$kind")"
    printf '%s\n  live:      %s  %s\n  candidate: %s  %s\n' "$kind" "$live" "$(describe_ami "$live")" "$cand" "$(describe_ami "$cand")"
    if [ "$live" = "$cand" ]; then echo "  -> up to date"; else echo "  -> newer image available: test it with: $0 test $kind $cand"; fi
  done
  echo
  echo "Our own images (deregister ones no template uses, and their snapshots):"
  aws ec2 describe-images --owners self --query 'sort_by(Images,&CreationDate)[].[ImageId,Name]' --output text | sed 's/^/  /'
}

smoke_script() {
  if [ "$1" = gpu ]; then cat <<'EOF'
echo "image check (gpu)"
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
/opt/pytorch/bin/python3 -c 'import sys, torch; print("python", sys.version.split()[0]); print("torch", torch.__version__, "cuda", torch.version.cuda, "available", torch.cuda.is_available()); x = torch.randn(1024, 1024, device="cuda"); print("matmul ok", float((x @ x).sum()) == float((x @ x).sum()))'
EOF
  else cat <<'EOF'
echo "image check (cpu)"
. /etc/os-release && echo "$PRETTY_NAME"
python3 --version
python3 -m venv /work/venv && . /work/venv/bin/activate && pip install --progress-bar off -q requests && python -c 'import requests; print("pip install ok, requests", requests.__version__)'
EOF
  fi
  cat <<'EOF'
if curl -sS -m 5 -o /dev/null http://169.254.169.254/latest/meta-data/ 2>/dev/null; then echo "METADATA REACHABLE"; exit 1; else echo "metadata blocked"; fi
echo ok > output/ok.txt
echo "image check passed"
EOF
}

test_image() {
  local kind=$1 ami=$2
  [[ "$kind" =~ ^(cpu|gpu)$ ]] && [[ "$ami" =~ ^ami-[0-9a-f]+$ ]] || { echo "Usage: $0 test cpu|gpu <ami-id>" >&2; exit 2; }
  local lt bucket prefix dir id="" subnet state
  lt="$(template_name "$kind")"
  bucket="$(aws ec2 describe-launch-template-versions --launch-template-name "$lt" --versions '$Default' \
    --query 'LaunchTemplateVersions[0].LaunchTemplateData.TagSpecifications[0].Tags[?Key==`talon-bucket`]|[0].Value' --output text)"
  prefix="jobs/manual-test-image-$kind-$(date -u +%Y%m%d%H%M%S)"
  dir="$(mktemp -d)"
  smoke_script "$kind" > "$dir/run.sh"
  gzip -9 -c "$INFRA_DIR/ec2/job_boot.sh" > "$dir/user-data.gz"
  aws s3 cp "$dir/run.sh" "s3://$bucket/$prefix/input/run.sh" --only-show-errors
  echo "Testing $kind image $ami ($(describe_ami "$ami")) with template $lt"
  for subnet in $(aws ec2 describe-subnets --filters "Name=tag:Name,Values=$NAME-jobs-*" --query 'Subnets[].SubnetId' --output text); do
    if id="$(aws ec2 run-instances --launch-template "LaunchTemplateName=$lt,Version=\$Default" --image-id "$ami" \
      --subnet-id "$subnet" --count 1 --user-data "fileb://$dir/user-data.gz" \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=talon},{Key=Component,Value=manual-test},{Key=Name,Value=$NAME-image-test-$kind},{Key=talon-s3-prefix,Value=$prefix},{Key=talon-max-seconds,Value=600},{Key=talon-owner,Value=image-test}]" \
      --query 'Instances[0].InstanceId' --output text 2>"$dir/err")"; then break; fi
    grep -q -E "InsufficientInstanceCapacity|Unsupported" "$dir/err" || { cat "$dir/err" >&2; rm -rf "$dir"; exit 1; }
    id=""
  done
  [ -n "$id" ] || { echo "No capacity in any job subnet; try again later." >&2; rm -rf "$dir"; exit 1; }
  echo "Launched $id; waiting for it to finish (2 to 6 minutes)..."
  for _ in $(seq 1 60); do
    state="$(aws ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].State.Name' --output text)"
    [ "$state" = terminated ] && break
    sleep 15
  done
  echo "--- status"; aws s3 cp "s3://$bucket/$prefix/status.json" - 2>/dev/null || echo "(no status: instance $state)"
  echo; echo "--- job log"; aws s3 cp "s3://$bucket/$prefix/logs/job.log" - 2>/dev/null | grep -v '^\[talon\]' | tail -20
  echo "--- boot warnings"; aws s3 cp "s3://$bucket/$prefix/logs/boot.log" - 2>/dev/null | grep -i warning || echo "(none)"
  local ok=0
  aws s3 cp "s3://$bucket/$prefix/logs/job.log" - 2>/dev/null | grep -q "^image check passed" && aws s3 cp "s3://$bucket/$prefix/status.json" - 2>/dev/null | grep -q '"succeeded"' && ok=1
  aws s3 rm "s3://$bucket/$prefix/" --recursive --only-show-errors
  rm -rf "$dir"
  if [ "$ok" = 1 ]; then
    echo; echo "PASSED. To switch: set ${kind}_job_ami_id = \"$ami\" in infra/ec2/terraform.tfvars, plan and apply (note the old id for rollback)."
  else
    echo; echo "FAILED: keep the current image." >&2; exit 1
  fi
}

case "${1:-}" in
  status) status ;;
  test) test_image "${2:-}" "${3:-}" ;;
  *) echo "Usage: $0 status | test cpu|gpu <ami-id>" >&2; exit 2 ;;
esac

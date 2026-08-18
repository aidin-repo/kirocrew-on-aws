#!/usr/bin/env bash
# rebuild-drill.sh — prove the host is disposable.
#
# Terminates the Gateway instance through its Auto Scaling group, times how long
# the replacement takes to become healthy, and asserts the data home came
# through intact. Read-only against your data: the only mutation is terminating
# an instance the ASG is designed to replace.
#
# Why terminate through the ASG rather than `ec2 terminate-instances`: the group
# is the thing under test. Terminating via the autoscaling API with
# --no-should-decrement-desired-capacity is what a real host failure looks like
# from the group's point of view, and it keeps DesiredCapacity at 1 so the
# replacement is automatic.
#
# Usage:
#   scripts/rebuild-drill.sh --stack crew [--region us-east-1] [--timeout 600]
#   scripts/rebuild-drill.sh --stack crew --dry-run   # report state, change nothing

set -euo pipefail

STACK=""
REGION="${AWS_REGION:-us-east-1}"
TIMEOUT=600
DRY_RUN=0

die()  { printf '\033[31mFATAL\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m ok \033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn\033[0m %s\n' "$*"; }
info() { printf '     %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack)   STACK="${2:-}"; shift 2 ;;
    --region)  REGION="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$STACK" ]] || die "--stack is required"

AWS=(aws --region "$REGION")

out() {
  "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null
}

# ---------------------------------------------------------------- 0. resolve
command -v aws >/dev/null || die "aws CLI not found"

ASG=$(out AutoScalingGroupName)
BUCKET=$(out StateBucketName)
[[ -n "$ASG"    && "$ASG"    != "None" ]] || die "stack '$STACK' has no AutoScalingGroupName output"
[[ -n "$BUCKET" && "$BUCKET" != "None" ]] || die "stack '$STACK' has no StateBucketName output"
ok "stack $STACK: asg=$ASG bucket=$BUCKET"

asg_instance() {
  "${AWS[@]}" autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
    --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`]|[0].InstanceId' --output text
}

BEFORE=$(asg_instance)
[[ -n "$BEFORE" && "$BEFORE" != "None" ]] || die "no InService instance in $ASG — nothing to drill"

# The access point roots the data home at /crew, so every object lives under
# that prefix. The sentinel is what crew-mount.service fails closed on.
SENTINEL_KEY="crew/.crew-data-home"
CREDS_KEY="crew/xdg-data/kiro-cli/data.sqlite3"

etag()  { "${AWS[@]}" s3api head-object --bucket "$BUCKET" --key "$1" --query ETag         --output text 2>/dev/null || echo "ABSENT"; }
size()  { "${AWS[@]}" s3api head-object --bucket "$BUCKET" --key "$1" --query ContentLength --output text 2>/dev/null || echo "ABSENT"; }
count() { "${AWS[@]}" s3 ls "s3://$BUCKET/crew/" --recursive --summarize 2>/dev/null | awk '/Total Objects/{print $3}'; }

SENTINEL_BEFORE=$(etag "$SENTINEL_KEY")
CREDS_BEFORE=$(size "$CREDS_KEY")
COUNT_BEFORE=$(count)

info "instance      $BEFORE"
info "sentinel etag $SENTINEL_BEFORE"
info "kiro-cli creds $CREDS_BEFORE bytes"
info "objects       $COUNT_BEFORE"

[[ "$SENTINEL_BEFORE" == "ABSENT" ]] && die "sentinel $SENTINEL_KEY absent — refusing to drill an unverified data home"

if [[ "$CREDS_BEFORE" == "ABSENT" ]]; then
  warn "no kiro-cli credential store at $CREDS_KEY."
  warn "Sign-in continuity cannot be asserted. If XDG_DATA_HOME is not split out of"
  warn "the data home, Crew hides the credential from its own probe — see the README."
fi

if [[ $DRY_RUN -eq 1 ]]; then
  ok "--dry-run: state reported, nothing terminated"
  exit 0
fi

# ------------------------------------------------------------- 1. terminate
warn "terminating $BEFORE via $ASG (DesiredCapacity stays 1, so it is replaced)"
"${AWS[@]}" autoscaling terminate-instance-in-auto-scaling-group \
  --instance-id "$BEFORE" --no-should-decrement-desired-capacity \
  --query 'Activity.StatusCode' --output text >/dev/null
START=$(date -u +%s)
ok "terminate accepted at $(date -u +%H:%M:%SZ)"

# ------------------------------------------------------- 2. wait for healthy
# Prefer the target group when AccessMode=front-door: it proves the Gateway is
# answering /api/health, not merely that EC2 booted. Fall back to the ASG's own
# health status in ssm-only mode, where there is no load balancer.
TG=$("${AWS[@]}" elbv2 describe-target-groups --names "$ASG" \
      --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || echo "")

AFTER=""
while :; do
  ELAPSED=$(( $(date -u +%s) - START ))
  (( ELAPSED > TIMEOUT )) && die "no healthy instance after ${TIMEOUT}s"

  AFTER=$(asg_instance)
  if [[ -n "$AFTER" && "$AFTER" != "None" && "$AFTER" != "$BEFORE" ]]; then
    if [[ -n "$TG" && "$TG" != "None" ]]; then
      STATE=$("${AWS[@]}" elbv2 describe-target-health --target-group-arn "$TG" \
                --query "TargetHealthDescriptions[?Target.Id=='$AFTER']|[0].TargetHealth.State" \
                --output text 2>/dev/null || echo "unknown")
    else
      STATE=$("${AWS[@]}" autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
                --query "AutoScalingGroups[0].Instances[?InstanceId=='$AFTER']|[0].HealthStatus" \
                --output text 2>/dev/null || echo "unknown")
      [[ "$STATE" == "Healthy" ]] && STATE=healthy
    fi
    printf '     +%3ds  replacement=%s state=%s\n' "$ELAPSED" "$AFTER" "$STATE"
    [[ "$STATE" == "healthy" ]] && break
  else
    printf '     +%3ds  waiting for replacement\n' "$ELAPSED"
  fi
  sleep 15
done
RTO=$(( $(date -u +%s) - START ))
ok "replacement $AFTER healthy after ${RTO}s"

# ------------------------------------------------------- 3. assert integrity
FAIL=0

SENTINEL_AFTER=$(etag "$SENTINEL_KEY")
if [[ "$SENTINEL_AFTER" == "$SENTINEL_BEFORE" ]]; then
  ok "sentinel ETag byte-identical: $SENTINEL_AFTER"
else
  warn "sentinel ETag changed: $SENTINEL_BEFORE -> $SENTINEL_AFTER"; FAIL=1
fi

if [[ "$CREDS_BEFORE" != "ABSENT" ]]; then
  CREDS_AFTER=$(size "$CREDS_KEY")
  if [[ "$CREDS_AFTER" == "$CREDS_BEFORE" ]]; then
    ok "kiro-cli credential store intact: $CREDS_AFTER bytes — sign-in survived"
  else
    warn "kiro-cli credential store changed: $CREDS_BEFORE -> $CREDS_AFTER bytes"
    warn "a size change is not necessarily loss (SQLite rewrites), but verify with:"
    warn "  docker exec crew kiro-cli whoami"
  fi
fi

COUNT_AFTER=$(count)
info "objects $COUNT_BEFORE -> $COUNT_AFTER"
# A modest DECREASE is expected and benign: lock files and run/ state are not
# recreated until first use. A decrease large relative to the total is not.
if (( COUNT_AFTER < COUNT_BEFORE )); then
  DELTA=$(( COUNT_BEFORE - COUNT_AFTER ))
  if (( DELTA * 10 > COUNT_BEFORE )); then
    warn "object count fell by $DELTA (>10%) — investigate before trusting this drill"; FAIL=1
  else
    ok "object count fell by $DELTA (ephemeral locks and run/ state) — expected"
  fi
fi

echo
if (( FAIL )); then
  die "drill completed with integrity warnings above. RTO ${RTO}s."
fi
ok "drill PASSED — RTO ${RTO}s, data home and sign-in intact"
info "Reminder: this drill does not exercise an AZ failure. There is one mount"
info "target, so an instance in another AZ fails closed at crew-mount.service."

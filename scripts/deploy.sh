#!/usr/bin/env bash
# Deploy Kiro Crew on AWS.
#
#   scripts/deploy.sh --params infra/params.json [--stack kirocrew] [--profile P]
#
# Order is deliberate: pre-flight the things CloudFormation cannot check, then
# lint, then deploy. A subnet with no egress route produces a Gateway that never
# starts and a CloudFormation error pointing at the wrong resource, so these
# checks run before anything is created.
set -euo pipefail

STACK=kirocrew
PARAMS=infra/params.json
PROFILE=""
REGION=us-east-1
TEMPLATE=infra/kirocrew.yaml
VALIDATE_ONLY=0

die()  { printf '\033[31mFAIL\033[0m  %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m ok \033[0m  %s\n' "$*"; }
warn() { printf '\033[33mwarn\033[0m  %s\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack)   STACK="$2"; shift 2 ;;
    --params)  PARAMS="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --template) TEMPLATE="$2"; shift 2 ;;
    --validate-only) VALIDATE_ONLY=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

EXTRA_OVERRIDES=()
AWS=(aws --region "$REGION")
[[ -n "$PROFILE" ]] && AWS+=(--profile "$PROFILE")

# ---------------------------------------------------------------- prerequisites
step "Prerequisites"
command -v aws >/dev/null      || die "aws CLI not found"
command -v cfn-lint >/dev/null || die "cfn-lint not found: pip install cfn-lint"
command -v python3 >/dev/null  || die "python3 not found"
[[ -f "$TEMPLATE" ]] || die "template not found: $TEMPLATE"
[[ -f "$PARAMS" ]]   || die "params not found: $PARAMS (copy infra/params.example.json)"
python3 -c "import json,sys; json.load(open('$PARAMS'))" || die "$PARAMS is not valid JSON"
ok "tooling and inputs present"

CALLER=$("${AWS[@]}" sts get-caller-identity --output json) || die "no usable AWS credentials"
ACCOUNT=$(python3 -c "import json,sys;print(json.load(sys.stdin)['Account'])" <<<"$CALLER")
ok "account $ACCOUNT in $REGION"

# Region is a hard constraint, and the template asserts it too. Checking here
# gives a readable failure instead of a rules violation mid-create.
[[ "$REGION" == "us-east-1" ]] || die "this template only deploys to us-east-1"

pval() {  # read one parameter value out of the params file
  python3 - "$PARAMS" "$1" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
items=d if isinstance(d,list) else d.get("Parameters",[])
for p in items:
    if p.get("ParameterKey")==sys.argv[2]:
        print(p.get("ParameterValue","")); break
PY
}

ACCESS_MODE=$(pval AccessMode);  ACCESS_MODE=${ACCESS_MODE:-ssm-only}
NETWORK_MODE=$(pval NetworkMode); NETWORK_MODE=${NETWORK_MODE:-existing}
ok "AccessMode=$ACCESS_MODE  NetworkMode=$NETWORK_MODE"

# ------------------------------------------------------- S3 Files availability
step "S3 Files availability"
python3 - <<PY || die "S3 Files is not reachable in $REGION with these credentials"
import boto3,sys
try:
    boto3.client("s3files", region_name="$REGION").list_file_systems()
except Exception as e:
    print(e, file=sys.stderr); sys.exit(1)
PY
ok "s3files API answers in $REGION"
# The AWS CLI only grew an s3files command recently; botocore is the portable path.

# --------------------------------------------------- network pre-flight (5 checks)
if [[ "$NETWORK_MODE" == "existing" ]]; then
  step "Network pre-flight (NetworkMode=existing)"
  VPC_ID=$(pval VpcId)
  SUBNETS=$(pval PrivateSubnetIds)
  [[ -n "$VPC_ID" ]]  || die "VpcId is required when NetworkMode=existing"
  [[ -n "$SUBNETS" ]] || die "PrivateSubnetIds is required when NetworkMode=existing"
  IFS=',' read -r -a SUBNET_ARR <<<"$SUBNETS"
  [[ ${#SUBNET_ARR[@]} -eq 2 ]] || die "PrivateSubnetIds must contain exactly two subnets"

  # check 4 first: cheap, and a DNS-disabled VPC cannot mount S3 Files at all
  for attr in enableDnsSupport enableDnsHostnames; do
    key="$(tr '[:lower:]' '[:upper:]' <<<"${attr:0:1}")${attr:1}"
    v=$("${AWS[@]}" ec2 describe-vpc-attribute --vpc-id "$VPC_ID" \
          --attribute "$attr" --query "$key.Value" --output text)
    [[ "$v" == "True" ]] || die "check 4: $attr is $v on $VPC_ID; S3 Files needs DNS resolution"
  done
  ok "check 4: VPC DNS support and hostnames enabled"

  # checks 1 and 2: distinct AZs, and a default route to a NAT or transit gateway
  AZS=()
  for s in "${SUBNET_ARR[@]}"; do
    read -r az vpc_of_subnet < <("${AWS[@]}" ec2 describe-subnets --subnet-ids "$s" \
      --query 'Subnets[0].[AvailabilityZone,VpcId]' --output text)
    [[ "$vpc_of_subnet" == "$VPC_ID" ]] || die "check 2: $s is not in $VPC_ID"
    AZS+=("$az")

    rt=$("${AWS[@]}" ec2 describe-route-tables \
          --filters "Name=association.subnet-id,Values=$s" \
          --query 'RouteTables[0].RouteTableId' --output text)
    [[ "$rt" != "None" && -n "$rt" ]] || die "check 1: $s has no explicit route table association"
    tgt=$("${AWS[@]}" ec2 describe-route-tables --route-table-ids "$rt" \
          --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].[NatGatewayId,TransitGatewayId,GatewayId]' \
          --output text | tr '\t' '\n' | grep -v '^None$' | head -1)
    case "$tgt" in
      nat-*|tgw-*) ok "check 1: $s egresses via $tgt" ;;
      igw-*) die "check 1: $s routes to an internet gateway, so it is public. Use a private subnet." ;;
      ""|None) die "check 1: $s has no default route. The Gateway would hang on the image pull." ;;
      *) die "check 1: $s default route target '$tgt' is not a NAT or transit gateway" ;;
    esac
  done
  [[ "${AZS[0]}" != "${AZS[1]}" ]] || die "check 2: both subnets are in ${AZS[0]}; the ALB needs two AZs"
  ok "check 2: distinct AZs (${AZS[0]}, ${AZS[1]})"

  # check 3 cannot be answered by any API: S3 Files AZ support is proven only by
  # CreateMountTarget succeeding. Say so rather than implying it was verified.
  warn "check 3: S3 Files mount-target support in ${AZS[0]} is unverifiable up front; the stack will fail at CreateMountTarget if absent"

  # check 5: any OTHER security group admitting these subnets by CIDR is a
  # lateral path into a neighbouring workload from a shell-capable agent.
  # The SG list and the subnet CIDRs go to temp files: a heredoc occupies stdin,
  # so piping into the same python invocation silently loses the pipe.
  SG_JSON=$(mktemp); CIDR_TXT=$(mktemp)
  trap 'rm -f "$SG_JSON" "$CIDR_TXT"' EXIT
  "${AWS[@]}" ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" \
    --output json > "$SG_JSON"
  for s in "${SUBNET_ARR[@]}"; do
    "${AWS[@]}" ec2 describe-subnets --subnet-ids "$s" \
      --query 'Subnets[0].CidrBlock' --output text >> "$CIDR_TXT"
  done

  set +e
  python3 - "$SG_JSON" "$CIDR_TXT" <<'PY'
import json,sys,ipaddress
sgs=json.load(open(sys.argv[1]))["SecurityGroups"]
cidrs=[ipaddress.ip_network(l.strip()) for l in open(sys.argv[2]) if l.strip()]
hits=set()
for g in sgs:
    for p in g.get("IpPermissions",[]):
        for r in p.get("IpRanges",[]):
            c=r.get("CidrIp")
            if not c: continue
            try: net=ipaddress.ip_network(c)
            except ValueError: continue
            for s in cidrs:
                if s.subnet_of(net) or net.subnet_of(s):
                    hits.add(f"{g['GroupId']} ({g.get('GroupName','?')}) "
                             f"{p.get('IpProtocol')} {p.get('FromPort')}-{p.get('ToPort')} from {c}")
if hits:
    print(f"check 5 FINDING: {len(hits)} rule(s) admit the Crew subnets by CIDR:",file=sys.stderr)
    for h in sorted(hits): print("   "+h,file=sys.stderr)
    print("A compromised agent could reach these laterally. Set "
          "KIROCREW_ACCEPT_SHARED_VPC=1 to proceed deliberately.",file=sys.stderr)
    sys.exit(3)
print(f"check 5: none of {len(sgs)} security groups admit the Crew subnets by CIDR")
PY
  rc=$?
  set -e
  if [[ $rc -eq 3 ]]; then
    [[ "${KIROCREW_ACCEPT_SHARED_VPC:-0}" == "1" ]] \
      || die "check 5 failed. Review the findings above, then re-run with KIROCREW_ACCEPT_SHARED_VPC=1 to accept."
    warn "check 5: findings accepted via KIROCREW_ACCEPT_SHARED_VPC=1"
  elif [[ $rc -ne 0 ]]; then
    die "check 5 could not complete"
  else
    ok "check 5: clean"
  fi
else
  step "Network pre-flight skipped (NetworkMode=create)"
fi

# ---------------------------------------------------- front-door prerequisites
if [[ "$ACCESS_MODE" == "front-door" ]]; then
  step "Front-door prerequisites"
  for p in DomainName HostedZoneId CertificateArn; do
    [[ -n "$(pval "$p")" ]] || die "$p is required when AccessMode=front-door"
  done
  for p in CertificateArn; do
    arn=$(pval "$p")
    st=$("${AWS[@]}" acm describe-certificate --certificate-arn "$arn" \
          --query 'Certificate.Status' --output text) || die "$p: cannot read $arn"
    [[ "$st" == "ISSUED" ]] || die "$p: certificate status is $st, not ISSUED"
    ok "$p issued"
  done

  # Resolve the CloudFront origin-facing prefix list so the operator never has to.
  # This is the only single-pass way to let CloudFront reach an internal ALB: the
  # service-managed CloudFront-VPCOrigins-Service-SG does not exist until after the
  # VPC origin is created.
  PREFIX_LIST=$(pval CloudFrontPrefixListId)
  if [[ -z "$PREFIX_LIST" ]]; then
    PREFIX_LIST=$("${AWS[@]}" ec2 describe-managed-prefix-lists \
      --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
      --query 'PrefixLists[0].PrefixListId' --output text 2>/dev/null)
    [[ -n "$PREFIX_LIST" && "$PREFIX_LIST" != "None" ]] \
      || die "could not resolve the CloudFront origin-facing managed prefix list"
    ok "resolved CloudFront prefix list $PREFIX_LIST"
    EXTRA_OVERRIDES+=("CloudFrontPrefixListId=$PREFIX_LIST")
  else
    ok "CloudFrontPrefixListId supplied explicitly ($PREFIX_LIST)"
  fi
else
  step "Front-door prerequisites skipped (AccessMode=ssm-only)"
fi

# ------------------------------------------------------------------- validation
step "Template validation"
# cfn-lint exits 4 for warnings and 2 for errors. Warnings must not block a
# deploy (an unused parameter is not a defect), so raise the bar to errors and
# still show the warnings.
cfn-lint "$TEMPLATE" --non-zero-exit-code error || die "cfn-lint reported errors"
ok "cfn-lint clean (warnings above, if any, are non-blocking)"

if command -v cfn-guard >/dev/null && [[ -d infra/guard-rules ]]; then
  cfn-guard validate --data "$TEMPLATE" --rules infra/guard-rules || die "cfn-guard reported violations"
  ok "cfn-guard clean"
else
  warn "cfn-guard skipped (binary or infra/guard-rules absent)"
fi

# CloudFormation accepts a template body inline only up to 51,200 bytes. Past that
# it MUST be staged in S3 - for validate-template and for the deploy itself. The
# bucket is created on first use and reused thereafter; it holds only templates.
TEMPLATE_BYTES=$(wc -c < "$TEMPLATE" | tr -d ' ')
INLINE_LIMIT=51200
STAGING_BUCKET=""

if (( TEMPLATE_BYTES > INLINE_LIMIT )); then
  STAGING_BUCKET="kirocrew-cfn-staging-${ACCOUNT}-${REGION}"
  warn "template is ${TEMPLATE_BYTES} bytes, over the ${INLINE_LIMIT}-byte inline limit: staging in S3"

  if ! "${AWS[@]}" s3api head-bucket --bucket "$STAGING_BUCKET" >/dev/null 2>&1; then
    "${AWS[@]}" s3api create-bucket --bucket "$STAGING_BUCKET" >/dev/null \
      || die "could not create staging bucket $STAGING_BUCKET"
    "${AWS[@]}" s3api put-public-access-block --bucket "$STAGING_BUCKET" \
      --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
    "${AWS[@]}" s3api put-bucket-encryption --bucket "$STAGING_BUCKET" \
      --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}' >/dev/null
    "${AWS[@]}" s3api put-bucket-tagging --bucket "$STAGING_BUCKET" --tagging \
      'TagSet=[{Key=Project,Value=kirocrew-on-aws},{Key=auto-delete,Value=no}]' >/dev/null
    ok "created staging bucket $STAGING_BUCKET (private, encrypted)"
  else
    ok "staging bucket $STAGING_BUCKET present"
  fi

  KEY="templates/$(basename "$TEMPLATE").$(date -u +%Y%m%dT%H%M%SZ)"
  "${AWS[@]}" s3 cp "$TEMPLATE" "s3://$STAGING_BUCKET/$KEY" --only-show-errors \
    || die "could not upload the template"
  "${AWS[@]}" cloudformation validate-template \
    --template-url "https://$STAGING_BUCKET.s3.$REGION.amazonaws.com/$KEY" >/dev/null \
    || die "CloudFormation rejected the template"
  ok "CloudFormation accepted the template (validated from S3)"
else
  "${AWS[@]}" cloudformation validate-template --template-body "file://$TEMPLATE" >/dev/null \
    || die "CloudFormation rejected the template"
  ok "CloudFormation accepted the template"
fi

# ----------------------------------------------------------------------- deploy
if [[ $VALIDATE_ONLY -eq 1 ]]; then
  step "Validate-only: stopping before deploy"
  ok "all pre-flight and validation checks passed; nothing was created"
  exit 0
fi

step "Deploy"
# Built with a read loop rather than `mapfile`: mapfile is a bash 4+ builtin and
# macOS still ships bash 3.2, so mapfile makes this script fail on a large share
# of developer machines.
OVERRIDES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && OVERRIDES+=("$line")
done < <(python3 - "$PARAMS" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
items=d if isinstance(d,list) else d.get("Parameters",[])
for p in items:
    print(f"{p['ParameterKey']}={p['ParameterValue']}")
PY
)

S3ARGS=()
[[ -n "$STAGING_BUCKET" ]] && S3ARGS=(--s3-bucket "$STAGING_BUCKET" --s3-prefix "deploy/$STACK")

"${AWS[@]}" cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$TEMPLATE" \
  ${S3ARGS[@]+"${S3ARGS[@]}"} \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --tags "Project=kirocrew-on-aws" "Owner=$(pval OwnerTag)" "auto-delete=no" \
  --parameter-overrides "${OVERRIDES[@]}" ${EXTRA_OVERRIDES[@]+"${EXTRA_OVERRIDES[@]}"}

step "Outputs"
"${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs' --output table

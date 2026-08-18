# Design — Deploy Kiro Crew to AWS

**Spec:** `i-want-to-deploy-kiro` · **Phase:** Design · **Status:** draft, awaiting review

## 1. Shape of the system

One EC2 host runs the official Crew container. Humans arrive through CloudFront and an
internal ALB that authenticates them against Cognito. Programmatic clients arrive through SSM
port forwarding. The data home is an S3-backed filesystem, so the host holds nothing that
cannot be thrown away.

```
                    +---------------------------------------------+
 browser / phone -->| CloudFront                                  |
                    |  ACM cert (us-east-1), custom domain        |
                    |  WAF: managed common set + rate limit       |
                    |  AllViewer origin request policy            |
                    |  CachingDisabled on all paths               |
                    +----------------+----------------------------+
                                     | VPC origin (https-only, TLSv1.2)
                    +----------------v----------------------------+
                    | internal ALB (private subnets, no public IP)|
                    |  :443 HTTPS, ACM cert in region             |
                    |  rule 1  /api/* + /ws  authenticate-cognito |
                    |                        onUnauth = deny      |
                    |  rule 2  default       authenticate-cognito |
                    |                        onUnauth = authenticate
                    +----------------+----------------------------+
                                     | HTTP :5476, SG-to-SG only
  Claude client ---- SSM ------+     |
  break-glass shell -----------+     |
                    +---------v------v----------------------------+
                    | EC2 (Graviton, 16 GiB, private subnet)      |
                    |  systemd -> docker -> kirocrew:<pinned>     |
                    |  KIROCREW_HOME=/mnt/crewhome                |
                    |  instance role, IMDSv2, hop limit 1         |
                    +---------+-----------------------------------+
                              | NFSv4 TCP 2049
                    +---------v-----------------------------------+
                    | S3 Files file system                        |
                    |  access point, UID/GID matched to container |
                    |  linked bucket: versioning + SSE-KMS + BPA  |
                    +---------------------------------------------+
```

## 2. Decision log

| # | Decision | Rationale | Req |
|---|---|---|---|
| D1 | EC2 with the official container under systemd | Fargate deletes service-task EBS volumes and cannot run Crew's user-namespace sandbox; AgentCore has no HTTP surface and is invocation-scoped | R1 |
| D2 | S3 Files as the live data home, gated on verification | POSIX semantics with locking plus native S3 durability and versioning; makes the host stateless with zero RPO | R6, R7 |
| D3 | EBS gp3 plus scheduled S3 replication as fallback | Known-good documented configuration if D2 fails verification | R8 |
| D4 | CloudFront to internal ALB via VPC origin | Public HTTPS front door with the ALB and instance off the public internet | R2 |
| D5 | `authenticate-cognito` on the ALB, not Lambda@Edge | Native, no code to maintain; the ALB is already the enforcement point | R2.5 |
| D6 | Host header forwarded to the origin | Makes the ALB certificate match, and makes the ALB build its OIDC redirect against the public domain rather than its internal DNS name | R2.5 |
| D7 | SSM port forwarding as the only programmatic path | ALB Cognito auth has no bearer-token path, so a non-browser client cannot traverse the front door | R2.7 |
| D8 | `kiro-cli` token material in Secrets Manager | Makes host replacement unattended, which is the point of state living in S3 | R9.3 |
| D9 | Plain Docker under systemd rather than ECS on EC2 | One container that cannot scale horizontally does not need a control plane; R12 keeps the fleet path open via parameterisation | R1.3 |
| D10 | Single AZ for the instance, AZ-independent state | The Gateway is a singleton, so a second AZ buys it nothing; S3 keeps the data portable | R6.5 |

## 3. Network layer

The network is the part most likely to already exist in a real account, so it is
parameterised rather than assumed. `NetworkMode` selects between two shapes.

### 3.1 `NetworkMode = existing` (default)

The stack creates no VPC, no subnets, no internet gateway, no NAT, and no route tables. It
consumes `VpcId` and two `PrivateSubnetIds` and creates only the three security groups, the
S3 Files mount target, and the instance. This is the right mode for any account that already
has a landing zone, and it removes the NAT gateway line item entirely by reusing egress that
is already paid for.

**Preconditions the stack cannot verify itself**, so `scripts/deploy.sh` pre-flights them and
fails before stack creation with a specific message rather than letting the instance boot and
hang on the container pull:

1. Each supplied subnet has a default route to a NAT gateway, NAT instance, or transit
   gateway. A subnet with no egress produces a Gateway that never starts, and the CloudFormation
   failure would point at the wrong thing.
2. The subnets are in distinct Availability Zones, since the ALB requires two.
3. The AZ of the first subnet supports an S3 Files mount target.
4. DNS hostnames and DNS resolution are enabled on the VPC, which the S3 Files mount requires
   to resolve its mount target hostname.
5. No other security group in the VPC grants inbound access from the supplied subnets' CIDR
   ranges. See the security note below for why this one matters.

### 3.2 `NetworkMode = create`

For an account with no suitable VPC, and for a reader following the blog post from nothing.
Creates a VPC, two private subnets across two AZs, two public subnets, an internet gateway,
route tables, and an egress path selected by `EgressMode`:

- **`nat-gateway`** — simplest, roughly $32/month plus data processing.
- **`nat-instance`** — a t4g.nano, a few dollars a month, at the cost of owning a piece of
  network infrastructure that can fail.

Interface VPC endpoints are deliberately not part of either mode. They would not remove the
egress requirement, because the GHCR image pull and the Kiro model endpoints are on the public
internet regardless, and each interface endpoint bills hourly. They are a posture improvement,
not a cost one, and should not be sold as the latter.

### 3.3 Security groups (both modes)

Three, each referencing the next by group ID rather than CIDR:

| SG | Inbound | Outbound |
|---|---|---|
| `alb-sg` | 443 from the CloudFront VPC origin | 5476 to `host-sg` |
| `host-sg` | 5476 from `alb-sg` | 443 to 0.0.0.0/0; 2049 to `fs-sg` |
| `fs-sg` | 2049 from `host-sg` | 2049 to `host-sg` |

`host-sg` has no rule permitting any internet source and no rule on port 22. Its egress is
deliberately narrow: HTTPS out for the image pull, model traffic, and AWS APIs, plus NFS to
the file system. Nothing else.

### 3.4 The security cost of sharing a VPC

`existing` mode places a host that runs a shell-capable agent, holds an instance role, and has
internet egress inside a network shared with other workloads. Group-ID-based rules mean this
stack grants nothing to anyone else, but the reverse is not guaranteed: **other** workloads in
that VPC may have CIDR-based inbound rules that happen to include the Crew subnets, which
would let a compromised agent reach them laterally. That is why pre-flight check 5 exists.

For a shared VPC that already hosts another agentic system with its own IAM roles, `create`
with `EgressMode = nat-instance` buys a dedicated network for a few dollars a month and is the
better trade. This is a judgement call the operator makes per account, which is precisely why
both modes exist rather than one being hardcoded.

### 3.5 To investigate during implementation

Kiro documents VPC endpoints (AWS PrivateLink) for its own service. If they cover the model
endpoint `kiro-cli` uses, model traffic leaves the public internet entirely and the egress
requirement shrinks to the image pull and OS updates — which would make an
endpoints-plus-no-NAT shape viable in `create` mode. An investigation task, not an assumption.

## 4. Compute layer

**Instance.** Graviton, 16 GiB minimum, private subnet A. Instance type is a parameter,
defaulting to a 2 vCPU / 16 GiB Graviton type. IMDSv2 required, metadata hop limit 1, no key
pair.

**Supervision.** A systemd unit wraps `docker run` with `Restart=always` and
`WantedBy=multi-user.target`, so the container survives a crash and the host survives a
reboot. The image is pinned by digest.

**Boot sequence.** Ordered systemd units, each a hard dependency of the next, so a failure
stops the chain rather than producing a half-configured Gateway:

1. `crew-mount.service` — install the mount helper if absent, mount the S3 Files access point
   at `/mnt/crewhome`, verify a sentinel file from the data home is readable. Fails the chain
   if the mount does not establish.
2. `crew-secrets.service` — fetch channel credentials and `kiro-cli` token material from
   Secrets Manager with the instance role, restore the token material into the data home,
   write the container environment file, and perform the audit-epoch rotation in section 5.2.
3. `crew-gateway.service` — `docker run` with `KIROCREW_HOME=/mnt/crewhome` and
   `KIROCREW_BIND=0.0.0.0` inside the container, published to the host port the ALB targets.
4. `crew-health.timer` — poll the local health endpoint and the data home, publishing custom
   CloudWatch metrics so alarm state does not depend on the ALB's view alone.

**Why the mount unit fails closed.** If the mount silently does not happen, Crew starts against
an empty directory, initialises a fresh data home, and writes new state to the root volume. The
owner sees a Gateway with no memory while unbacked-up state accumulates. Hence the sentinel
check before the Gateway is allowed to start.

**Sandbox.** The entrypoint probes whether Crew's user-namespace sandbox works under the host's
Docker configuration. The design does not set `KIROCREW_ALLOW_UNSANDBOXED`. If the probe fails,
agent execution stays disabled and that is a defect to fix, not a switch to flip. Confirming
the probe passes is an implementation task with captured evidence.

## 5. Storage layer

### 5.1 Primary — S3 Files

**Resources.** An S3 bucket with versioning enabled (the service requires it), SSE-KMS with a
customer-managed key, Block Public Access fully on, and a policy denying
`aws:SecureTransport = false`. An S3 Files file system linked to that bucket. A mount target in
private subnet A. An access point rooted at the data home, with POSIX UID and GID matching the
user the Crew container runs as.

**Mount.** Established by `crew-mount.service` using the S3 Files mount helper, which registers
an `s3files` filesystem type compatible with standard `mount`. No `/etc/fstab` entry, because a
failed fstab mount at boot is harder to surface than a failed systemd unit.

**What lands in the bucket.** The entire data home — `conversations/`, `workspace/memory/`,
`workspace/lessons.jsonl`, `workspace/knowledge/`, `crons.json`, `tasks/`, `skills/`,
`agents/`, `config.json`, `audit.log`, and both SQLite databases. No sync script, no scheduled
job, no backup-staleness alarm. State is in S3 because that is where the filesystem writes.

**Deliberately not on the mount.** The embedding model cache is a large regenerable blob whose
churn would pollute version history for no benefit; it is baked into the AMI or seeded from a
separate prefix by object copy.

`.env` stays on the root volume, written by `crew-secrets.service` to `/etc/crew/channels.env`
and handed to the container, so it is never part of the data home. `.local_secret` was
*intended* to stay off the mount too, but cannot — see the measured note above.

**Host replacement.** Launch in an AZ with a mount target, mount the same access point, start.
No restore step.

**Measured, not assumed (see `docs/storage-verification.md`).** Export to S3 is
**asynchronous**: `ExportAge` measured 66.4 seconds under light load, so the RPO is roughly a
minute, not zero as an earlier draft of this design claimed. Still far better than the
15-minute sync of the fallback path, but not instantaneous.

Two consequences the design has to own:

- **A SQLite database is three objects, exported independently.** `memory.db`, `memory.db-wal`
  and `memory.db-shm` sync as separate objects at separate timestamps, with no atomicity across
  the set, and almost all live data sits in the uncheckpointed WAL (measured: 4 KB database,
  148 KB WAL). A restore taken mid-export could pair mismatched files. Before relying on a
  restore, or before deliberately replacing a host, stop the container so SQLite checkpoints
  and the WAL drains.
- **`.local_secret` cannot be kept off the mount.** `KIROCREW_HOME` *is* the mount, so Crew
  writes it into the bucket with everything else. A replacement host therefore inherits the
  previous value instead of regenerating it. That preserves dashboard-token continuity across a
  rebuild, but it contradicts Crew's host-scoped guidance and means a host secret is replicated
  to S3 under the customer-managed key.

### 5.2 The audit-log HMAC problem

`sel_hmac.key` is host-scoped and regenerated on a new host, but `audit.log` lives on the mount
and survives. A fresh key cannot verify entries written under the previous one, so
`kirocrew security verify` would fail on historical entries.

**Resolution.** Treat the audit log as a sequence of host epochs. On replacement,
`crew-secrets.service` rotates `audit.log` to `audit.log.<epoch-timestamp>` on the mount and
stores the retiring HMAC key in Secrets Manager under a versioned secret keyed to that epoch.
The live segment then verifies cleanly, and a historical segment verifies by supplying its
archived key. The runbook documents the procedure. A deliberate design choice, not an accepted
gap.

### 5.3 Fallback — EBS with replication

Adopted only if R7 verification fails. An encrypted gp3 volume with `DeleteOnTermination=false`
holds the data home. A systemd timer every 15 minutes plus a shutdown hook runs
`sqlite3 .backup` on both databases into a staging directory, then `aws s3 sync` for the
staging directory and the non-database paths. A restore unit runs before the Gateway when the
volume is empty. Same-AZ replacement reattaches the volume; anything else restores from S3. A
`StateSyncAge` alarm fires if no sync has succeeded in 45 minutes.

The IaC keeps this behind a `StorageMode` parameter, so switching is a stack update rather than
a rewrite.

### 5.4 Verification plan (R7)

Runs before anything else is committed to. One throwaway instance, one S3 Files mount, no ALB,
no CloudFront.

| Question | Method | Pass condition |
|---|---|---|
| Does SQLite WAL work on the mount? | Seed a real data home, run a memory-heavy session with repeated recall and lesson writes, then `PRAGMA integrity_check` on `memory.db` and `memory_index.db` | Both report `ok`, before and after a container stop/start |
| Does it survive replacement? | Terminate, launch a second instance, mount the same access point | `kirocrew doctor` clean, integrity clean, agent recalls a pre-termination fact |
| What is the latency cost? | Time a fixed set of memory searches on the mount and on a local gp3 volume | Owner judges interactive feel acceptable; record numbers either way |
| What does the write pattern cost? | Count object versions and measure bucket growth per prefix over the session | Growth is bounded and a lifecycle policy can hold it; record the measured rate |
| Is the audit chain intact? | `kirocrew security verify` after the section 5.2 epoch rotation | Live segment verifies; historical segment verifies with its archived key |

Results go to `docs/storage-verification.md` with numbers, pass or fail. That file is source
material for the blog post.

## 6. Identity and access

### 6.1 Mode A — the Cognito front door

**A registered domain is a hard prerequisite for this mode.** `authenticate-cognito` is valid
only on an HTTPS listener, an HTTPS listener needs a certificate matching the host CloudFront
forwards, and ACM will not issue a certificate for a `cloudfront.net` name. There is no
no-domain variant of the front door: without a domain the chain cannot be built at all. Users
in that position deploy `AccessMode = ssm-only` and reach the dashboard over port forwarding.
The README states this as a prerequisite rather than letting a deploy fail halfway through a
twelve-minute CloudFront creation.

**Certificates.** Two ACM certificates for the same custom domain: one in `us-east-1` for the
CloudFront viewer connection, one in the deployment region for the ALB's HTTPS listener. Both
are required.

**CloudFront.** Viewer protocol policy `redirect-to-https`, minimum TLS 1.2. The `AllViewer`
managed origin request policy so the Host header reaches the ALB — this is what makes the ALB's
certificate match and what makes the ALB construct its Cognito redirect against the public
domain. `CachingDisabled` on every behaviour, since nothing here is cacheable and a cached
authenticated response would be a security bug. A WAF web ACL with the AWS managed common rule
set plus a rate-based rule. Access logging on.

**VPC origin.** `OriginProtocolPolicy = https-only`, `OriginSslProtocols = TLSv1.2`, ARN
pointing at the internal ALB.

**ALB.** Internal scheme, private subnets, HTTPS listener on 443 with the regional certificate.
`authenticate-cognito` is valid only on an HTTPS listener, which is why the internal ALB
terminates TLS rather than accepting plain HTTP from CloudFront. Two rules:

- **Priority 1 — `/api/*` and the WebSocket path:** `authenticate-cognito` with
  `OnUnauthenticatedRequest = deny`. An expired session then returns 401 to an XHR or WebSocket
  attempt instead of a 302 to a Cognito HTML page, which an SPA cannot follow. The ALB docs call
  this out specifically for single-page applications.
- **Priority 2 — default:** `authenticate-cognito` with
  `OnUnauthenticatedRequest = authenticate`, so a browser at the root gets the hosted UI and
  acquires the session cookie.

`SessionTimeout` set to 8 hours rather than the 7-day default. Target group forwards HTTP to the
instance on the Gateway port, health-checked against Crew's health endpoint.

**Cognito.** One user pool. One app client with a generated client secret — the ALB requires
one — authorization-code grant, `openid email` scopes, callback URL
`https://<domain>/oauth2/idpresponse`. A user pool domain for the hosted UI. MFA required. An
external identity provider federated in with `SupportedIdentityProviders` set accordingly, so
the login is not a standalone password.

**WebSocket.** CloudFront and the ALB both pass WebSocket through. The two settings that make it
work are the `AllViewer` origin request policy, which forwards `Upgrade` and `Connection` along
with the auth cookie, and `CachingDisabled`. This is the most likely thing to be subtly wrong,
so the implementation task verifies live streaming in the dashboard rather than treating a 200
on the document as proof.

### 6.2 Mode B — SSM

No inbound anything. `aws ssm start-session --document-name AWS-StartPortForwardingSession`
forwards the Gateway port to the laptop, requiring an Identity Center session. Used for the
Claude client, the one-time `kiro-cli` sign-in, and break-glass when the front door is
misconfigured.

The Claude client cannot use Mode A: `authenticate-cognito` recognises only its own session
cookie and has no bearer-token path, so a programmatic caller is redirected to HTML or denied. A
property of the front door, not a gap to fix.

### 6.3 IAM

**Instance role** — the only identity with data access to state:

- `s3:GetObject`, `PutObject`, `DeleteObject`, `ListBucket` and version operations, on the state bucket only
- `s3files:ClientMount`, `ClientWrite`, `GetAccessPoint`, conditioned on the access point ARN
- `kms:Decrypt`, `GenerateDataKey` on the state key and the secrets key
- `secretsmanager:GetSecretValue` on specific secret ARNs, plus `PutSecretValue` on the audit-epoch secret
- `logs:CreateLogStream`, `PutLogEvents` on the deployment log group
- `cloudwatch:PutMetricData` scoped by namespace
- The AWS-managed SSM core policy
- No IAM actions, no EC2 mutation, no other bucket

**Owner permission set** — deliberately cannot read conversation content:

- `ssm:StartSession` on the one instance ARN and the port-forwarding document
- `ssm:TerminateSession`, `ResumeSession` scoped to own sessions
- `logs:FilterLogEvents`, `GetLogEvents` on the deployment log group
- No S3 data-plane access to the state bucket, no `kms:Decrypt` on the state key

**Deployment role** — used by the IaC, separate from both, not used at runtime.

### 6.4 Crew's own layers

`agent.sandbox` at `auto`. A `security_policy.json` sets the capability ceiling, with
`kirocrew policy show` captured into the runbook as evidence. Deny rules stay at defaults,
including the IMDS rule, composing with IMDSv2 and hop limit 1. Dashboard tokens minted at 2
hours or less. `dashboard.url` set to the CloudFront domain so Slack links resolve to the front
door instead of an unreachable loopback address.

## 7. Secrets

| Secret | Contents | Consumer |
|---|---|---|
| `crew/channels` | Slack bot token, Slack app token, owner ID | `crew-secrets.service`, handed to the container so Crew's entrypoint writes `.env` at mode 600 and clears them from the process environment |
| `crew/kiro-cli` | `kiro-cli` token material from the one-time device-code sign-in | `crew-secrets.service`, restored into the data home before the Gateway starts |
| `crew/audit-epochs` | Retired `sel_hmac.key` values keyed by epoch | Operator, for historical audit verification |
| `crew/cognito-client` | Cognito app client secret | The IaC, at deploy time |

All encrypted with a customer-managed KMS key. No secret value appears in user data, the launch
template, the image, any template, or any log line. Rotation is a Secrets Manager update plus
`systemctl restart crew-gateway`.

## 8. Observability

**Logs.** Container stdout and stderr to CloudWatch Logs via the awslogs driver, plus host
system logs, on parameterised retention. ALB and CloudFront access logs to a separate logging
bucket, not the state bucket.

**Alarms.** Each routes to an SNS topic with an email subscription, so notification does not
depend on the Gateway or Slack being healthy:

| Alarm | Condition | Distinguishes |
|---|---|---|
| `GatewayUnhealthy` | Custom health metric missing or zero for 2 periods | Crew itself is down |
| `TargetGroupUnhealthy` | ALB `UnHealthyHostCount` >= 1 | Front-door path broken while Crew may be fine |
| `MountMissing` | Custom metric reporting the data home unreadable | The storage layer detached |
| `CloudFront5xx` | 5xx rate above threshold | Edge or origin-connection failure |
| `StateSyncAge` | Fallback path only: no successful sync in 45 minutes | Silent backup failure |

`MountMissing` exists because a detached mount with a still-running container is the failure
mode most likely to look healthy while quietly losing data.

**Tags.** `Project=remote-kirocrew`, `Owner`, `Environment`, and `auto-delete=no` on every
resource, the last to survive automated account cleanup sweeps.

## 9. Cost model

Priced against the AWS pricing calculator during implementation rather than asserted here. The
itemisation to fill in:

| Line | Driver | Notes |
|---|---|---|
| EC2 instance | 2 vCPU / 16 GiB Graviton, 730 h | Largest line. A Savings Plan is the main lever on a 24/7 workload |
| Egress path | NAT gateway hourly plus data, or NAT instance | See section 3; the recommended option is the more expensive one |
| ALB | Hourly plus LCU | Low LCU at one user |
| S3 Files | Service charges plus S3 storage and requests | R7 measurement feeds this; version churn is the unknown |
| Root EBS volume | gp3, modest size | |
| KMS | Two keys plus requests | |
| Secrets Manager | Four secrets plus API calls | |
| CloudFront, Cognito, CloudWatch, SNS | Rounding errors at this scale | Cognito is within the free tier for one user |

The runbook documents stopping the instance to cut the largest line, and notes that the front
door returns 503 while stopped and that ALB, CloudFront, and NAT charges continue.

## 10. Infrastructure as code

**One CloudFormation template.** Around 50 resources, well under the 500-per-template limit,
so nesting buys nothing and costs a packaging step: nested children must be staged in S3
before deploy, which requires a bootstrap bucket and `aws cloudformation package` in the
loop. A single template deploys with `aws cloudformation deploy --template-file` and no
bucket. The usual argument for nesting — updating one component without disturbing others —
does not apply, because a change set on a single stack only touches resources whose
properties actually changed.

```
kirocrew-on-aws/
  README.md                    # prerequisites, one-command deploy, parameter table, teardown
  LICENSE
  infra/
    kirocrew.yaml              # the entire stack
    params.example.json        # parameter values, no secrets
  runbook.md                   # bootstrap, access, rebuild drill, rotation, teardown
  docs/storage-verification.md # R7 results, cited by the blog post
  scripts/
    deploy.sh                  # pre-flight, cfn-lint, cfn-guard, cloudformation deploy
    verify-image.sh            # gh attestation verify on the pinned digest
    rebuild-drill.sh           # terminate, relaunch, time recovery, assert integrity
```

The repository is the deliverable, not just this one deployment. A reader clones it, fills in
`params.json`, and runs `scripts/deploy.sh`. No build toolchain, no bootstrap stack, no
staging bucket, nothing to install but the AWS CLI.

**Region is pinned to us-east-1.** CloudFront's viewer certificate must be in us-east-1, and
a `Scope: CLOUDFRONT` WAF web ACL must be created there too. A single-region template cannot
create either from elsewhere without a custom resource or a second stack, which would
reintroduce the complexity the single template removes. Deploying in us-east-1 puts the
viewer certificate, the WAF web ACL, and the ALB's regional certificate in one place.
`Region` is therefore a documented constraint rather than a parameter.

**Resource groups within the template**, in dependency order: KMS keys and secret shells →
S3 bucket, bucket policy, lifecycle → S3 Files file system, mount target, access point →
VPC, subnets, routing, egress (only when `NetworkMode = create`) → three security groups →
instance role and profile → launch
template and instance → Cognito user pool, client, domain → internal ALB, target group,
listener with the two authenticate rules → WAF web ACL, VPC origin, CloudFront distribution →
log groups, SNS topic, alarms.

**Parameters**, kept deliberately few because the repository's point is being easy to deploy:

| Parameter | Values | Notes |
|---|---|---|
| `AccessMode` | `front-door` or `ssm-only` | `front-door` requires a registered domain, see section 6.1 |
| `NetworkMode` | `existing` or `create` | `existing` reuses your VPC and NAT |
| `VpcId`, `PrivateSubnetIds` | — | Required when `NetworkMode = existing` |
| `EgressMode` | `nat-gateway` or `nat-instance` | Ignored when `NetworkMode = existing` |
| `DomainName`, `HostedZoneId` | — | Required when `AccessMode = front-door` |
| `InstanceType` | — | Defaults to a 2 vCPU / 16 GiB Graviton type |
| `LogRetentionDays`, `NotificationEmail`, `OwnerTag` | — | |

`AccessMode` and `NetworkMode` are the two axes driving `Conditions`. Everything from Cognito
onward in the resource ordering above is created only when `AccessMode = front-door`;
`ssm-only` skips the ALB, CloudFront, WAF, Cognito, and both certificates, which is the
cheapest and most locked-down shape and the one a user without a domain can still deploy.

`StorageMode` is deliberately absent. The R7 spike settles the storage question before the
template is written, so the template carries only the path that passed and the runbook
documents the alternative. Carrying a losing path as a live parameter would add config surface
to a repository whose point is being easy to deploy. This is a change from R8.1, which
anticipated a parameter switch: switching storage now means a template edit rather than a
stack update.

Every globally unique name derives from the stack name plus `OwnerTag`, satisfying R12.

`scripts/deploy.sh` runs the section 3.1 pre-flight checks when `NetworkMode = existing`, then
`cfn-lint` and `cfn-guard`, then `aws cloudformation deploy` — so validation is not an optional
step someone remembers.

## 11. Open items for implementation

1. **Confirm us-east-1 supports both S3 Files and Cognito as an ALB identity provider.** The region is pinned to us-east-1 by section 10, so this is a go/no-go check rather than a selection. Cognito on ALB is not available in every region. If either is missing, the single-template design needs revisiting alongside the region.
2. **Kiro PrivateLink.** Determine whether Kiro's documented VPC endpoints cover the model endpoint `kiro-cli` uses. If so, model traffic leaves the public internet and section 3 changes.
3. **S3 Files write amplification.** Resolved by the R7 measurement, not by reading docs. The lifecycle policy is sized from the result.
4. **Sandbox probe under Docker on the chosen AMI.** Must pass. If it does not, that is a defect to fix, not a reason to set `KIROCREW_ALLOW_UNSANDBOXED`.
5. **Mount-helper provisioning.** The S3 Files mount helper ships in `amazon-efs-utils`. Decide between baking it into a custom AMI and installing at first boot; baking removes a boot-time dependency on a package mirror.
6. **Which VPC to reuse.** In `existing` mode, run the section 3.1 pre-flight against the candidate VPC, and specifically resolve check 5: whether any security group there admits the Crew subnets by CIDR. If the candidate already hosts another agentic system with its own IAM roles, weigh section 3.4 and consider `create` with `nat-instance` instead.

## 12. Traceability

| Requirement | Design section |
|---|---|
| R1 always-on Gateway | 4 |
| R2 two access modes | 3, 6.1, 6.2 |
| R3 credentialed access | 6.2, 6.3 |
| R4 S3 system of record | 5.1 |
| R5 SQLite write semantics | 5.1, 5.4 |
| R6 S3 Files primary | 5.1 |
| R7 verification gate | 5.4 |
| R8 EBS fallback | 5.3 |
| R9 secrets | 7 |
| R10 security posture | 6.3, 6.4 |
| R11 observability and cost | 8, 9 |
| R12 forward compatibility | 10 |
| R13 reproducible from code | 10 |
| R14 bootstrap and seeding | 4, runbook |
| R15 blog post | 5.4 |

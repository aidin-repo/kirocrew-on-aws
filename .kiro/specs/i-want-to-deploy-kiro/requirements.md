# Requirements — Deploy Kiro Crew to AWS

**Spec:** `i-want-to-deploy-kiro` · **Type:** feature · **Status:** draft, awaiting review

## 1. Overview

Run a single-tenant Kiro Crew Gateway 24/7 inside the owner's AWS account. Humans reach
it through a public HTTPS front door authenticated by Amazon Cognito; programmatic clients
reach it through an AWS-authenticated control-plane path with no open ports. All durable
agent state — sessions, memory, lessons, crons, skills, task specs — is held in Amazon S3
so the compute host is disposable. The finished deployment is written up as a public blog
post.

Kiro Crew's architecture constrains the design. Per the official docs, the Gateway, the
agent session runtime, the ACP processes, and the data home all live together on one host;
`kiro-cli` over ACP is the only LLM provider (`agent.provider = acp`); the data home holds
SQLite databases in write-ahead-logging mode; and the dashboard authenticates every request
with a short-lived minted token. This spec deploys that shape faithfully rather than
inventing a distributed one.

**Reference material:** [kirodotdev/KiroCrew](https://github.com/kirodotdev/kirocrew),
[Running 24/7](https://kiro.dev/docs/crew/running-24-7/),
[Installation](https://kiro.dev/docs/crew/installation/),
[Security](https://kiro.dev/docs/crew/security/),
[S3 Files](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-attach-compute.html).

## 2. Goals

- One always-on Crew Gateway in AWS that survives reboots, crashes, and full host replacement.
- Easy human access from a browser or phone, gated by Cognito and a short-lived Crew token.
- No open inbound ports on the host, and no SSH key pairs or bastion anywhere in the design.
- S3 as the system of record for durable state, so a replacement host resumes work.
- A repeatable, code-defined deployment. No console-created resource is load-bearing.
- A publishable blog post describing the architecture and the reasoning behind it.

## 3. Non-goals

- Horizontal scaling of the Gateway. Crew co-locates runtime and state on one host and its data home is single-writer SQLite. The recovery story is fast replacement, not active-active.
- Replacing `kiro-cli` as the LLM provider, or pointing Crew's model traffic directly at Amazon Bedrock. Crew supports exactly one provider.
- Hosting Crew on AWS Fargate, Amazon EKS, or Amazon Bedrock AgentCore Runtime. Section 7 records why each was rejected.
- Serving multiple users from one Gateway. Crew is single-owner. R12 covers forward compatibility only.
- Migrating the owner's existing local Crew installation in place. State import is a one-way seeding step (R8).

## 4. Actors

| Actor | Description |
|---|---|
| **Owner** | The single human operator. Holds an AWS IAM Identity Center identity, a Cognito user, and is the Slack and dashboard owner. |
| **Gateway host** | An EC2 instance running the Crew Gateway container 24/7. Holds an instance role; no long-lived AWS keys. |
| **State store** | The S3 bucket that is the system of record for durable agent state. |
| **Claude client** | A Claude session on the owner's laptop that drives the deployed Gateway programmatically. |

## 5. Architecture summary

Settled before requirements were finalised, and binding on the design:

```
Browser / phone → CloudFront (WAF, TLS, custom domain)
                → VPC origin → internal ALB (authenticate-oidc → Cognito)
                → EC2:5476 in a private subnet, no public IP
                → Crew's own minted session token

Claude client / break-glass → SSM Session Manager port forwarding → same EC2:5476

State → Amazon S3, as the live data home via S3 Files if R7 verification passes,
        otherwise as a versioned replica of an EBS data home
```

## 6. Requirements

### R1 — Always-on Gateway in the owner's AWS account

**Story:** As the owner, I want the Crew Gateway running continuously in my AWS account so
that crons, the task runner, and channel bots keep working while my laptop is closed.

**Acceptance criteria**

1. The Gateway runs from the official multi-arch container image `ghcr.io/kirodotdev/kirocrew`, pinned to an immutable version tag or digest. Never `stable` or `latest`.
2. The image's SLSA build provenance is verified against `kirodotdev/KiroCrew` before first run, and the verification command is recorded in the runbook.
3. The container is supervised by systemd on the host so it restarts after a crash and starts after an instance reboot, with no human action.
4. Given the instance is stopped and started again, when the host finishes booting, then the Gateway answers its health endpoint successfully within 5 minutes and no state is lost.
5. The instance provides at least 16 GB RAM, satisfying the documented requirement of roughly 10 GB minimum with headroom for MCP cold starts and parallel subagents. Instance type is a stack parameter; Graviton is preferred since `linux/arm64` is published under every image tag.
6. `kirocrew doctor` reports `kiro-cli` present, authenticated, config valid, and embeddings available.
7. At least one cron job fires on schedule during a 72-hour continuous-uptime observation window.

### R2 — Two access modes, each with a stated threat model

**Story:** As the owner, I want easy browser and phone access without giving the host an
open port, and I want the programmatic path to stay separate.

**Acceptance criteria**

1. The instance runs in a private subnet with no public IPv4 address and no Elastic IP.
2. The instance security group accepts traffic only from the ALB's security group on the Gateway port. It has no rule permitting any internet source, and no inbound rule on port 22.
3. No EC2 key pair is associated with the instance.
4. The ALB is internal, with no public IP, and is reachable only as a CloudFront VPC origin. Given an actor attempts to reach the ALB directly by DNS name or IP from the internet, then the attempt fails.
5. **Mode A, human access:** CloudFront terminates TLS on a custom domain, applies a WAF web ACL with at minimum a rate-based rule and the AWS managed common rule set, and forwards to the internal ALB. The ALB's default listener action is `authenticate-oidc` against a Cognito user pool; unauthenticated requests are redirected to the Cognito hosted UI and never reach the instance.
6. Mode A survives the WebSocket upgrade: the ALB and CloudFront configuration forwards the `Upgrade` and `Connection` headers and the ALB auth session cookie, and caching is disabled for the dashboard path, so the dashboard's live streaming works end to end.
7. **Mode B, programmatic and break-glass access:** AWS Systems Manager Session Manager port forwarding to the Gateway port, requiring a valid IAM identity and recording the session in CloudTrail. This mode requires no security-group change and no public endpoint.
8. Cognito enforces MFA and is configured to federate to an external identity provider, so the human login is not a standalone password.
9. Crew's own token authentication remains in force behind both modes. Cognito is an additional layer, never a replacement, and the deployment never disables Crew's token requirement.
10. The Crew config's `dashboard.url` is set to the CloudFront domain, so Slack-issued dashboard links resolve to the front door rather than to an unreachable loopback address.
11. Instance Metadata Service v2 is required with a hop limit of 1.

### R3 — Credentialed access, revocable and short-lived

**Story:** As the owner, I want to connect with credentials I can revoke centrally, not
with a static secret in a config file.

**Acceptance criteria**

1. Mode B AWS access is obtained via IAM Identity Center (`aws sso login`), producing temporary credentials with a bounded lifetime.
2. A dedicated IAM permission set grants the owner exactly: `ssm:StartSession` on the one instance, the port-forwarding session document, termination and resumption of their own sessions, and read access to the deployment's CloudWatch log group. It grants no S3 data-plane access to the state store and no KMS decrypt on the state key.
3. Dashboard tokens are minted on demand with a TTL of 2 hours or less. No long-lived dashboard cookie or shared password exists.
4. Given the owner's Identity Center access is revoked, when they next attempt a port-forwarding session, then it fails. Given their Cognito user is disabled, when they next open the front door, then they cannot authenticate. Neither requires any change on the host.
5. Session starts, port-forwarding sessions, Cognito sign-ins, and Crew token mints are all recorded — in CloudTrail, Cognito logs, and the Crew audit log respectively.
6. No AWS access key or secret access key is ever written to the instance. The host authenticates to AWS solely through its instance role.

### R4 — S3 is the system of record for durable state

**Story:** As the owner, I want every piece of agent state I care about to live in S3, so a
replacement host picks up where the last one left off.

**Acceptance criteria**

1. The following are all held durably in S3: `workspace/memory/`, `workspace/lessons.jsonl`, `workspace/knowledge/`, `conversations/`, `crons.json`, `tasks/`, `skills/`, `agents/`, `config.json`, `audit.log`, and the `memory.db` and `memory_index.db` databases.
2. Host-specific secrets are excluded from S3 and recovered by other means: `.env` is rebuilt from Secrets Manager, and `.local_secret` is regenerated. This follows the documented guidance that these files are host-scoped.
3. The embedding model cache is provisioned so a replacement host does not spend an extended period with memory search degraded to keyword matching.
4. Given a running deployment, when the instance is terminated and a replacement is launched from the same infrastructure definition, then the owner's memories, lessons, preferences, crons, skills, and prior conversations are all present. Verification is behavioural: ask the agent to recall a fact stored before termination.
5. The recovery time objective from termination to a healthy Gateway with restored state is 30 minutes or less, and the runbook records the measured value.
6. The recovery point objective is stated and measured. The S3 Files path in R6 targets zero; the fallback path in R7 targets 15 minutes or better.
7. The bucket has Block Public Access fully enabled, versioning on, default encryption with a customer-managed KMS key, and a bucket policy denying non-TLS requests.
8. Noncurrent object versions expire on a documented lifecycle schedule so version history does not grow without bound.
9. Only the instance role has data-plane access to the bucket. The owner's own permission set does not, so conversation content is not exposed through the human access path.

### R5 — The data home has correct write semantics for SQLite

**Story:** As the owner, I want the deployment to be correct about where SQLite can safely
live, so my memory database is not silently corrupted.

**Acceptance criteria**

1. The live data home sits on a filesystem providing in-place random writes, byte-range file locking, and strong data consistency.
2. FUSE-style object-storage mounts that do not provide those semantics — Mountpoint for Amazon S3 and S3 File Gateway among them — are explicitly excluded as data-home candidates, and the design records why so a reader of the blog post does not attempt it.
3. Whichever storage path is chosen, `PRAGMA integrity_check` on `memory.db` and `memory_index.db` passes after a full stop-and-restart cycle and after a host replacement.
4. `kirocrew security verify` runs cleanly against the audit log for entries written under the current host epoch. Where the HMAC key changes on host replacement, the design states how historical entries remain verifiable rather than leaving the gap undocumented.

### R6 — S3 Files as the data home (primary path)

**Story:** As the owner, I want the data home to be an S3-backed filesystem, so state is
natively in a bucket and a replacement instance is current the moment it mounts.

**Acceptance criteria**

1. An S3 Files file system, linked to the state bucket with S3 Versioning enabled as the service requires, is mounted on the host at the Crew data home path, with `KIROCREW_HOME` pointed at it.
2. The mount is established at boot via the S3 Files mount helper, and a failed mount prevents the Gateway from starting rather than letting it come up against an empty directory.
3. Mount targets exist in the instance's Availability Zone, and the security groups permit NFS on TCP 2049 between the instance and the mount targets in both directions.
4. The access point's POSIX UID and GID match the identity the Crew container process runs as, so the Gateway can write its own data home.
5. Given the instance is terminated and a replacement is launched in an Availability Zone with a mount target, when it mounts the same file system, then Crew resumes with no restore step and no data loss.
6. The chosen region supports both S3 Files and Cognito as an ALB identity provider. This is confirmed before the region is fixed, since Cognito on ALB is not available in every region.
7. Object-version growth in the linked bucket from Crew's database write pattern is measured over a representative working period, and the lifecycle policy in R4.8 is sized against the measured rate rather than a guess.
8. This path is adopted only if R7 verification passes.

### R7 — Verify the storage path before building on it

**Story:** As the owner, I want the storage decision settled by evidence, because it is the
one choice whose failure loses everything the agent has learned.

**Acceptance criteria**

1. A time-boxed verification precedes the rest of the build and answers three questions: does Crew's SQLite write-ahead logging work correctly on an S3 Files mount; what is the query latency penalty against a local block device; and what volume of object versions and storage growth does Crew's write pattern generate in the linked bucket.
2. The verification exercises a memory-heavy session, then checks `kirocrew doctor`, `kirocrew security verify`, and `PRAGMA integrity_check` on both databases, and repeats the checks after a stop and restart.
3. The measured results are recorded in the repository, pass or fail, with enough detail to be cited in the blog post.
4. **Pass criteria:** integrity checks clean across restarts, no database corruption, and interactive latency the owner judges acceptable in use.
5. Given verification fails on any pass criterion, when the design proceeds, then it adopts the R8 fallback and records the failure as the reason.

### R8 — EBS with S3 replication (fallback path)

**Story:** As the owner, I want a known-good storage design ready if the S3-backed
filesystem does not hold up.

**Acceptance criteria**

1. The live data home sits on an encrypted EBS gp3 volume, which provides the semantics R5.1 requires and is the configuration Crew documents.
2. State is pushed to the S3 bucket every 15 minutes or less, and additionally on graceful shutdown.
3. SQLite databases are captured with a genuine online-backup operation producing a self-consistent file, not a copy of a live database, with the write-ahead log accounted for so no recent write is lost.
4. A restore runs at boot before the Gateway starts, so a replacement host comes up with state already in place.
5. The volume is retained on instance termination and reattached to the replacement host as the fast path, giving effectively zero data loss for same-Availability-Zone replacement. S3 remains the authoritative path for Availability Zone loss, region moves, instance-family changes, and volume deletion.
6. A CloudWatch alarm fires when a state sync has not succeeded within a defined window, so a silent backup failure is detected before a restore needs it.

### R9 — Secrets are brokered, never baked in

**Story:** As the owner, I want channel tokens and the Kiro sign-in recoverable without
pasting secrets into user data or an image.

**Acceptance criteria**

1. Channel credentials (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `KIROCREW_OWNER_ID`, and any other channel tokens) are stored in AWS Secrets Manager encrypted with a customer-managed KMS key.
2. At container start the host fetches them with its instance role and hands them to Crew's documented environment path, so Crew's entrypoint writes them into the data home's `.env` at mode 600 and clears them from the long-lived process environment.
3. `kiro-cli` token material is stored in Secrets Manager and restored on a replacement host, so a rebuild completes with no interactive sign-in. The secret is encrypted with a customer-managed key, access is limited to the instance role, and reads are recorded in CloudTrail.
4. No secret value appears in EC2 user data, the launch template, the container image, any infrastructure-as-code source file, or any CloudWatch log line.
5. Rotation is a Secrets Manager update plus a container restart. No rebuild, no code change.
6. Given the agent is asked to read a credential path or echo a credential-bearing variable, when the tool call is evaluated, then Crew's sensitive-path block and output redaction prevent the value reaching any chat surface.

### R10 — Security posture is enforced, not assumed

**Story:** As the owner, I want the agent's own guardrails configured deliberately, because
a compromised agent on this host can reach AWS through the instance role.

**Acceptance criteria**

1. The OS sandbox is confirmed working under the container runtime at first start and `agent.sandbox` is set to `auto` or `strict`. If the sandbox probe fails, agent command execution stays disabled rather than silently running unsandboxed, and `KIROCREW_ALLOW_UNSANDBOXED` is not set.
2. The instance role follows least privilege: read and write on the state bucket, mount and write on the S3 Files access point, decrypt with the designated KMS keys, read the specific secrets, write to the deployment's log group, and the Session Manager permissions. It grants no IAM, no EC2 mutation, and no access to unrelated buckets.
3. The agent is prevented from reaching the instance metadata endpoint through Crew's deny rules, in addition to the IMDSv2 and hop-limit settings in R2.11.
4. A governance policy file sets the tool-capability ceiling on this host, and `kirocrew policy show` output is captured in the runbook as evidence of the effective policy.
5. The audit log is part of the durable state in R4.1, so tool-call history survives host replacement.
6. Given an attempt to weaken protection by editing an agent config, when the tool gate evaluates a denied command, then it is still blocked. Deny rules are enforced outside the agent config.

### R11 — Observability and cost control

**Story:** As the owner, I want to know the Gateway is healthy and what it costs before the
bill tells me.

**Acceptance criteria**

1. Gateway logs and host system logs ship to CloudWatch Logs with a defined retention period. CloudFront access logs and ALB access logs are enabled.
2. An alarm fires when the Gateway health endpoint fails or the container stops, and notifies the owner through a channel that does not depend on the Gateway being healthy.
3. An alarm fires on sustained ALB target-health failure, so a front-door break is distinguishable from a Gateway break.
4. The design states expected steady-state monthly cost itemised by instance, storage, NAT or equivalent egress, ALB, CloudFront, KMS, and Secrets Manager, priced against the AWS pricing calculator rather than estimated from memory. The runbook documents how to stop the instance to reduce cost when Crew is not needed, and what that does to the front door.
5. The egress path for the private subnet is a documented decision with its cost stated, since a NAT gateway is a significant line item relative to the rest of the deployment.
6. All resources carry consistent tags identifying owner, project, and environment, including a tag that protects them from automated cleanup sweeps.

### R12 — Forward compatibility for more than one Gateway

**Story:** As the owner, I want the design not to paint me into a corner if other people
want their own Crew later.

**Acceptance criteria**

1. The design states the unit of scale explicitly: one Gateway and one data home per person, stamped from the same infrastructure definition. Not multiple users on one Gateway.
2. Resources that would collide across instantiations — bucket names, secret names, log groups, Cognito app clients, DNS names — are derived from a stack-name or owner parameter rather than hardcoded.
3. The design names which components are shareable across Gateways (CloudFront distribution, Cognito user pool, WAF web ACL, VPC) and which must be per-Gateway (data home, state bucket prefix, instance, secrets).
4. No multi-user implementation is built now. This requirement is satisfied by parameterisation and a documented path, not by working multi-tenancy.

### R13 — Deployment is reproducible from code

**Story:** As the owner, I want to tear the whole thing down and rebuild from the
repository, because that is what makes the blog post credible.

**Acceptance criteria**

1. Every AWS resource is defined as infrastructure as code in this repository.
2. One documented command deploys the stack from a clean account state; a second tears it down.
3. Templates are validated and linted before deployment, and the validation command is part of the documented workflow.
4. Given the stack is destroyed and redeployed, when bootstrap and restore complete, then the deployment reaches the same healthy state with state recovered from S3. Any component that does not recover automatically is named explicitly with its manual step.
5. Region, instance type, retention periods, sync interval where applicable, log retention, and domain name are parameters with documented defaults.

### R14 — First-run bootstrap and state seeding

**Story:** As the owner, I want the deployed Crew to start with the memory, lessons, and
preferences I already have locally, so it is useful on day one.

**Acceptance criteria**

1. A documented one-time bootstrap covers `kiro-cli` device-code sign-in on the host, capturing its token material into Secrets Manager per R9.3, minting the first dashboard token, creating the Cognito user, and confirming `kirocrew doctor` is clean.
2. Sign-in is performed through an interactive Session Manager session. No inbound SSH and no public endpoint is used to complete it.
3. Existing local state — `workspace/memory/`, both memory databases including write-ahead log files, `config.json`, `crons.json`, `tasks/`, `skills/` — is seeded into the deployment, with the host-specific secrets in R4.2 excluded from the transfer.
4. Given seeding has completed, when the owner asks the deployed agent about a project recorded only in their local memory, then the agent answers from the migrated memory.
5. The runbook states how long a first start takes, including embedding-model provisioning.

### R15 — Blog post deliverable

**Story:** As the owner, I want a publishable write-up so this becomes shareable content
rather than a private runbook.

**Acceptance criteria**

1. A draft blog post exists in the repository covering: why run Crew remotely; the architecture; the S3-backed-filesystem decision and what the R7 verification actually measured; why Fargate, EKS, and AgentCore Runtime were rejected; the two access modes; and the measured recovery numbers.
2. The post includes an architecture diagram and the real commands a reader would run.
3. Every behavioural claim corresponds to something verified during implementation. Recovery timings, cost figures, latency numbers, and health results are measured values, not estimates presented as fact.
4. The post contains no account identifiers, ARNs with account numbers, bucket names, domain names, secret names, or other environment-specific identifiers. Those are replaced with placeholders.
5. The post states the security caveats plainly, including that the agent on this host holds an instance role, and that the front door is a public endpoint.

## 7. Rejected alternatives

Recorded so the design does not relitigate them and the blog post can explain them.

| Option | Why rejected |
|---|---|
| **AWS Fargate** | ECS deletes EBS volumes attached to service-managed tasks whenever the task terminates, forcing the data home onto a network filesystem. More decisively, Fargate cannot run Crew's Linux user-namespace sandbox, so agent execution either stays disabled fail-closed or requires `KIROCREW_ALLOW_UNSANDBOXED=1`, removing a security layer on a task holding an IAM role. Costs at or above the equivalent EC2. |
| **Amazon EKS** | Every Fargate objection plus a control-plane bill, for a single container that cannot scale horizontally. |
| **Bedrock AgentCore Runtime** | Has no arbitrary HTTP surface — invocation is `InvokeAgentRuntime` with a SigV4-signed payload — so the CloudFront and ALB front door has nowhere to point and the dashboard cannot be served. Invocation-scoped rather than always-on: idle sessions terminate after 15 minutes and instances are replaced at max lifetime, so crons do not fire and Slack Socket Mode drops. Its managed session storage is additionally wiped on runtime version update. Persistent storage does not give a persistent process. |
| **Mountpoint for Amazon S3 / S3 File Gateway as the data home** | Neither provides the in-place random writes, locking, and consistency SQLite write-ahead logging requires. |
| **Cloudflare Tunnel plus Cloudflare Access** | A working and cheaper alternative to the CloudFront and ALB front door, and the pattern Crew's own docs suggest. Rejected because it terminates TLS at a third party positioned to observe dashboard traffic, which for this dashboard is source code, conversations, and tool output. Keeping the data path and the audit trail inside the account was judged worth roughly $20 a month. |
| **Plain EFS as the data home** | Viable and multi-AZ, but it puts state in a filesystem with no S3 representation, which does not meet the goal of state living in S3. Reconsider only if R7 fails and the R8 fallback proves inadequate. |

## 8. Success criteria

The deployment is done when all of the following hold:

1. The Gateway has been continuously healthy for 72 hours with at least one cron firing on schedule in that window.
2. A host termination and rebuild drill has been performed, with RPO and RTO measured and recorded.
3. The storage verification in R7 has a recorded result, and the adopted path matches it.
4. A scan of the instance and the ALB from outside the account finds nothing reachable except CloudFront.
5. The owner has held a full conversation through the Cognito front door from a browser and from a phone.
6. The owner has driven a full conversation from the Claude client on their laptop over Mode B.
7. Revoking Identity Center access and disabling the Cognito user have each been shown to cut off their respective access mode with no host-side change.
8. `PRAGMA integrity_check` passes on both databases after the rebuild drill.
9. The blog post draft is complete and free of environment-specific identifiers.

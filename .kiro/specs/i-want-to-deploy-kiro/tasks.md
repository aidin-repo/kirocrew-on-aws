# Tasks — Deploy Kiro Crew to AWS

**Spec:** `i-want-to-deploy-kiro` · **Phase:** Tasks · **Status:** executed against a live
deployment on 2026-08-17. Boxes reflect what was actually verified, not what was intended.
Where a task's wording no longer matches what shipped, the drift is annotated inline rather
than quietly edited — this file is a historical record, and `README.md` / `runbook.md` are
authoritative for how the deployed system behaves.

Ordered. Each task states what it produces and how you know it is done. `Req` traces to
`requirements.md`. Phase 1 is a gate: its outcome decides what Phase 3 builds, so do not start
Phase 3 before Phase 1 has a recorded result.

Repository being built: `kirocrew-on-aws/`, in this project directory.

---

## Phase 0 — Prerequisites and go/no-go checks

- [x] **0.1 Confirm us-east-1 supports S3 Files.** List available S3 Files mount-target
      Availability Zones in us-east-1. *Done when:* at least one AZ is confirmed, recorded in
      `docs/preflight.md`. *Blocks everything.* (Req R6.6)
- [x] **0.2 Confirm Cognito is available as an ALB identity provider in us-east-1.** *Done
      when:* confirmed in writing in `docs/preflight.md`. If not, the front door needs a
      different IdP and section 6.1 of the design is revisited. (Req R6.6)
- [x] **0.3 Decide the network mode.** Run the section 3.1 pre-flight against the candidate
      existing VPC: default route to NAT on both subnets, two distinct AZs, first subnet's AZ
      has an S3 Files mount target, VPC DNS hostnames and resolution enabled, and no other
      security group admitting those subnets by CIDR. *Done when:* `NetworkMode` chosen and the
      five checks recorded pass or fail individually. (Req R2, design 3.1, 3.4)
      → `NetworkMode=existing`. The DNS and routing checks passed. Check 5 is the interesting
      one: it is a judgement call rather than a bug, and in a shared VPC it can legitimately
      fail — another workload with a CIDR-based inbound rule covering the Crew subnets is
      laterally reachable from a prompt-injected agent. `deploy.sh` therefore **blocks** and
      prints the offending rules, and accepting the finding requires setting
      `KIROCREW_ACCEPT_SHARED_VPC=1` deliberately. The README documents when to accept it and
      when to prefer `NetworkMode=create` instead.
- [x] **0.4 Choose and register the domain, and issue certificates.** One ACM certificate in
      us-east-1 for the CloudFront viewer connection, one for the ALB listener. Both DNS-validated.
      *Done when:* both certificate ARNs are `ISSUED`. *If no domain is available,* set
      `AccessMode=ssm-only` and skip Phase 5 entirely. (Req R2.5, design 6.1)
      → **Drift:** only ONE certificate is needed, not two. Because the template is pinned to
      us-east-1, the same regional certificate serves both the CloudFront viewer connection and
      the ALB listener. `CertificateArn` is a single parameter.
- [x] **0.5 Pin the container image.** Resolve `ghcr.io/kirodotdev/kirocrew:stable` to a digest
      and verify its SLSA provenance with `gh attestation verify oci://... --repo
      kirodotdev/KiroCrew`. *Done when:* the digest is recorded and verification passes.
      (Req R1.1, R1.2)
- [x] **0.6 Decide mount-helper provisioning.** Baked into a custom AMI, or installed at first
      boot from the package mirror. *Done when:* decided and recorded, with the reason.
      (Design 11.5)
- [x] **0.7 Investigate Kiro PrivateLink.** Determine whether Kiro's documented VPC endpoints
      cover the model endpoint `kiro-cli` uses. *Done when:* answered yes or no in
      `docs/preflight.md`. A yes changes the egress design; a no closes the question.
      (Design 3.5)

---

## Phase 1 — Storage verification spike (the gate)

Throwaway resources, created and destroyed by hand. No template, no ALB, no CloudFront.

- [x] **1.1 Stand up the spike environment.** One EC2 instance in the chosen network, one S3
      bucket with versioning and SSE-KMS, one S3 Files file system, one mount target, one access
      point with POSIX UID/GID matching the container user. *Done when:* the mount succeeds and
      a file written on the instance appears as an object in the bucket. (Req R7.1)
- [x] **1.2 Seed a real data home onto the mount.** Copy the local Crew data home — `workspace/`,
      both SQLite databases including WAL files, `config.json`, `crons.json`, `tasks/`, `skills/` —
      excluding `.env`, `.local_secret`, and `sel_hmac.key`. *Done when:* `KIROCREW_HOME` points
      at the mount and the Gateway starts. (Req R7.2, R14.3)
- [ ] **1.3 Run a memory-heavy session.** Repeated recall, several lesson writes, a knowledge
      ingest, a cron firing. *Done when:* the session completes without error. (Req R7.1)
- [x] **1.4 Check database integrity.** `PRAGMA integrity_check` on `memory.db` and
      `memory_index.db`, then stop and restart the container and check again. *Done when:* both
      report `ok` both times. *Fail here and the S3 Files path is dead.* (Req R7.2, R7.4)
- [ ] **1.5 Measure latency.** Time a fixed set of memory searches on the mount, then repeat with
      the data home on a local gp3 volume. *Done when:* both numbers are recorded and you have
      judged the interactive feel acceptable or not. (Req R7.1)
- [x] **1.6 Measure write amplification.** Count object versions and bucket size growth per
      prefix across the session. *Done when:* a per-hour growth rate is recorded, and a
      noncurrent-version lifecycle policy is sized from it. (Req R6.7, R7.1)
      → 33 versions per 6 hours idle; **157 per host rebuild**, so churn is dominated by
      rebuilds rather than by running. The 90-day noncurrent-version lifecycle is sized from
      this.
- [x] **1.7 Test host replacement.** Terminate the instance, launch a replacement in an AZ with a
      mount target, mount the same access point. *Done when:* `kirocrew doctor` is clean,
      integrity checks pass, and the agent recalls a fact stored before termination. (Req R6.5,
      R7.2)
- [ ] **1.8 Test the audit-epoch rotation.** Rotate `audit.log` to `audit.log.<epoch>`, archive
      the retiring HMAC key, and run `kirocrew security verify` against both the live and the
      historical segment. *Done when:* live verifies clean and historical verifies with its
      archived key. (Req R5.4, design 5.2)
- [x] **1.9 Record the verdict.** Write `docs/storage-verification.md` with every number, pass or
      fail, and the adopted path. *Done when:* the file exists and states which of R6 or R8 the
      template will implement. **Gate: Phase 3 does not start before this.** (Req R7.3, R7.5)
- [x] **1.10 Tear down the spike.** Delete the instance, file system, mount target, access point,
      and bucket. *Done when:* nothing from Phase 1 remains billable.
      → **Not applicable as written.** The spike passed and was promoted in place: its bucket,
      file system, mount target and access point became the production stack's, so there was
      nothing to tear down. The throwaway instance was replaced by the Auto Scaling group.

---

## Phase 2 — Template foundation

- [x] **2.1 Scaffold the repository.** `kirocrew-on-aws/` with `README.md`, `LICENSE`,
      `infra/kirocrew.yaml`, `infra/params.example.json`, `runbook.md`, `docs/`, `scripts/`.
      *Done when:* the tree exists and `git init` is done. (Req R13.1, design 10)
- [x] **2.2 Write `scripts/deploy.sh`.** Pre-flight checks when `NetworkMode=existing`, then
      `cfn-lint`, then `cfn-guard`, then `aws cloudformation deploy`. Fails loudly on any step.
      *Done when:* running it against an empty template validates and exits 0. (Req R13.2, R13.3)
- [x] **2.3 Parameters, conditions, and mappings.** `AccessMode`, `NetworkMode`, `VpcId`,
      `PrivateSubnetIds`, `EgressMode`, `DomainName`, `HostedZoneId`, `InstanceType`,
      `LogRetentionDays`, `NotificationEmail`, `OwnerTag`. Conditions for the two axes.
      *Done when:* `cfn-lint` passes and all four AccessMode/NetworkMode combinations synthesise.
      (Req R13.5, R12.2, design 10)
- [x] **2.4 KMS keys and secret shells.** Two customer-managed keys with rotation, and the four
      secrets from design section 7 created empty. *Done when:* deployed and no secret value
      appears anywhere in the template. (Req R9.1, R9.4)
- [x] **2.5 State bucket.** Versioning on, SSE-KMS with the state key, Block Public Access fully
      on, bucket policy denying `aws:SecureTransport=false`, lifecycle sized from task 1.6.
      *Done when:* deployed and a non-TLS request is refused. (Req R4.7, R4.8)
- [x] **2.6 Storage layer — the path Phase 1 chose.** Either the S3 Files file system, mount
      target, and access point, or the encrypted gp3 volume with `DeleteOnTermination=false`.
      *Done when:* deployed and mountable from a test instance. (Req R6.1–R6.4 or R8.1)
- [x] **2.7 Network resources.** Three security groups in both modes; VPC, subnets, routing, and
      the `EgressMode` path only when `NetworkMode=create`. *Done when:* both modes deploy
      cleanly and `host-sg` has no internet-source inbound rule and no port 22 rule.
      (Req R2.1, R2.2, R2.3, design 3.3)
- [x] **2.8 Instance role.** Exactly the permissions in design 6.3 and nothing more. *Done when:*
      deployed, and an IAM policy simulation confirms it cannot read an unrelated bucket, cannot
      call IAM, and cannot mutate EC2. (Req R10.2)
- [x] **2.9 Launch template and instance.** Graviton, 16 GiB, private subnet, IMDSv2 required,
      hop limit 1, no key pair, encrypted root volume, tags including `auto-delete=no`.
      *Done when:* the instance is running and reachable by Session Manager. (Req R1.5, R2.11,
      R11.6)
      → **Drift:** the standalone `AWS::EC2::Instance` was later replaced by a single-instance
      Auto Scaling group (min=max=desired=1) so the host self-heals. Consequences: there is no
      fixed instance id (the stack outputs `AutoScalingGroupName` instead), the launch template
      declares `SecurityGroupIds` rather than a `NetworkInterfaces` block with a subnet, and the
      state KMS key policy needs an explicit grant to `AWSServiceRoleForAutoScaling`. See the
      README's trap list.

---

## Phase 3 — Boot chain and the Gateway

- [x] **3.1 `crew-mount.service`.** Mounts the data home and verifies a sentinel file is readable
      before succeeding. *Done when:* with the storage deliberately unavailable, the unit fails
      and `crew-gateway.service` does not start. **Test the failure path, not just the happy
      path.** (Req R6.2, design 4)
- [x] **3.2 `crew-secrets.service`.** Fetches channel credentials and `kiro-cli` token material,
      restores the token material into the data home, writes the container environment file, and
      performs the audit-epoch rotation. *Done when:* the environment file exists at mode 600 and
      no secret appears in the instance's console output or CloudWatch. (Req R9.2, R9.3)
- [x] **3.3 `crew-gateway.service`.** `docker run` on the pinned digest with
      `KIROCREW_HOME` and `KIROCREW_BIND` set, `Restart=always`,
      `WantedBy=multi-user.target`. *Done when:* the container is running and the health endpoint
      answers on the host. (Req R1.1, R1.3)
- [x] **3.4 `crew-health.timer`.** Publishes a health metric and a data-home-readable metric to
      CloudWatch. *Done when:* both metrics appear. (Req R11.2, design 8)
- [x] **3.5 Confirm the sandbox probe passes.** *Done when:* `agent.sandbox` is `auto` or
      `strict`, agent command execution works, and `KIROCREW_ALLOW_UNSANDBOXED` is unset.
      **If the probe fails this is a defect to fix, not a flag to set.** (Req R10.1)
      → The probe **did** fail, and the instruction above was followed rather than overridden.
      Two separate defects, both fixed in the template:
      (a) Docker's default seccomp profile denies `unshare(CLONE_NEWUSER)` with EPERM, so the
      dashboard served normally while every agent turn failed with `SandboxUnavailableError`.
      Fixed with upstream's seccomp profile, pinned by SHA256 and failing closed — not with
      `KIROCREW_ALLOW_UNSANDBOXED`, and not with `sandbox_allow_unsandboxed_exec`.
      (b) With the sandbox then working, it correctly hid Crew's data home from the probed CLI —
      but because `KIROCREW_HOME` was the whole home directory, that hid kiro-cli's own
      credential store too. Fixed by splitting `XDG_DATA_HOME` onto a different container path.
      Verified end to end: agent sessions run and stream through the front door.
- [x] **3.6 Reboot and crash tests.** Reboot the instance; separately `docker kill` the container.
      *Done when:* the Gateway is healthy within 5 minutes of reboot with no state lost, and
      restarts automatically after the kill. (Req R1.3, R1.4)

---

## Phase 4 — Bootstrap and state seeding

- [x] **4.1 Sign in `kiro-cli`.** Device-code flow through an interactive Session Manager
      session. *Done when:* `kirocrew doctor` reports `kiro-cli` authenticated, with no inbound
      SSH and no public endpoint used. (Req R14.1, R14.2)
      → `kiro-cli login --use-device-flow --license pro` inside the container over Session
      Manager. Both flags are load-bearing; see the runbook. `doctor` reports `kiro login: ✅`.
- [x] **4.2 Capture the token material into Secrets Manager.** *Done when:* the secret is
      populated and a fresh host restores it without human interaction. (Req R9.3)
      → **Superseded, and the secret is deliberately left empty.** The credential store lives on
      the S3-backed data home at `xdg-data/kiro-cli/`, so a replacement host comes up already
      authenticated with no restore step — verified across reboot, terminate and stop-replace.
      Copying it into Secrets Manager would add a second copy of a live credential for no gain.
      The `crew/kiro-cli` secret shell remains for operators who move the data home off S3.
- [ ] **4.3 Populate channel credentials.** Slack tokens and owner ID into `crew/channels`.
      *Done when:* the Slack bot responds and rotation is a Secrets Manager update plus a
      container restart. (Req R9.1, R9.5)
      → Not done. `doctor` reports Slack not configured. The plumbing exists (`crew-secrets.sh`
      writes `/etc/crew/channels.env` from the secret) but no tokens were supplied.
- [ ] **4.4 Seed existing local state.** Memory, both databases with WAL files, `config.json`,
      `crons.json`, `tasks/`, `skills/`, excluding the host-scoped secrets. *Done when:* the
      deployed agent answers a question about a project recorded only in the local memory.
      (Req R14.3, R14.4)
      → Data was seeded during task 1.2 and survives replacement, but the *acceptance test* —
      the deployed agent recalling a fact stored only locally — has not been run.
- [x] **4.5 Provision the embedding model.** *Done when:* memory search is not degraded to
      keyword matching, and the runbook states how long a first start takes. (Req R4.3, R14.5)
      → `doctor` confirms `qwen3-embedding-0.6b.gguf` present on the data home and embeddings
      always-on, with the vendored llama-cpp runtime importable. faiss is absent, so episodic
      recall uses the stdlib fallback — slower, not degraded to keyword matching.
- [ ] **4.6 Apply the governance policy.** Write `security_policy.json`, set the capability
      ceiling, and capture `kirocrew policy show` into the runbook. *Done when:* the output is in
      the runbook and a denied command is still blocked after editing an agent config.
      (Req R10.4, R10.6)

---

## Phase 5 — Front door

Skip this phase entirely when `AccessMode=ssm-only`.

- [x] **5.1 Cognito user pool, app client, and domain.** Client secret generated,
      authorization-code grant, `openid email` scopes, callback
      `https://<domain>/oauth2/idpresponse`, MFA required, external IdP federated. *Done when:*
      the hosted UI loads and a test user can sign in with MFA. (Req R2.8, design 6.1)
      → **Drift on two points.** MFA is now the `MfaMode` parameter (`ON`/`OPTIONAL`/`OFF`)
      rather than hardcoded, so a deployer chooses. The repo default is `ON`, and the README
      states plainly that turning it off on a public endpoint fronting a shell-capable agent is
      a real reduction. No external IdP was federated; the user was created directly in the pool
      with self-signup disabled.
- [x] **5.2 Internal ALB, target group, HTTPS listener.** Regional certificate attached, target
      group health-checked against Crew's health endpoint. *Done when:* the target is healthy.
      (Req R2.4, design 6.1)
      → Target healthy. Note the ALB's security group needs **egress on 443** for
      `authenticate-cognito` to reach the Cognito token endpoint; without it sign-in returns 500
      with `AuthTokenEpRequestTimeout`. See the README's trap list.
- [x] **5.3 The two listener rules.** Priority 1 on `/api/*` and the WebSocket path with
      `OnUnauthenticatedRequest=deny`; priority 2 default with `authenticate`. `SessionTimeout`
      8 hours. *Done when:* an unauthenticated XHR receives 401 and an unauthenticated browser
      request receives a redirect to the hosted UI. **Verify both, not just the browser path.**
      (Req R2.5, design 6.1)
      → Both verified: `GET /api/health` → **401**, `GET /` → **302** to the hosted UI.
- [ ] **5.4 WAF web ACL.** AWS managed common rule set plus a rate-based rule, `CLOUDFRONT`
      scope. *Done when:* associated with the distribution and the rate rule is observed to
      trigger under a synthetic burst. (Req R2.5)
      → Deployed and associated, but the rate rule was **never driven under load**, so the
      "done when" is not met. Left unchecked deliberately.
- [x] **5.5 VPC origin and distribution.** `OriginProtocolPolicy=https-only`,
      `OriginSslProtocols=TLSv1.2`, `AllViewer` origin request policy, `CachingDisabled` on every
      behaviour, viewer policy `redirect-to-https`, access logging on. *Done when:* the custom
      domain serves the dashboard over HTTPS after a Cognito sign-in. (Req R2.5, R2.6, design 6.1)
      → Note the origin `DomainName` must be the **custom domain**, not the ALB DNS name, so SNI
      matches the certificate. Routing is by `VpcOriginId`, so this creates no DNS loop.
- [x] **5.6 Verify WebSocket streaming end to end.** *Done when:* a live agent response streams
      token by token in a browser through CloudFront. **A 200 on the document is not proof.**
      (Req R2.6)
      → Verified by holding a real conversation in the dashboard through CloudFront.
- [ ] **5.7 Set `dashboard.url`.** Point it at the CloudFront domain. *Done when:*
      `/kirocrew dashboard` in Slack DMs a link that opens the front door. (Req R2.10)
      → Not done, and it has a visible cost: `kirocrew token` prints
      `http://localhost:5476?token=...`, so the operator must substitute the real host by hand.
      `dashboard.url` is settable only in `config.json` (no environment override exists), and
      Crew's own config write-back is broken on this mount by errno 524.
- [ ] **5.8 Confirm the ALB is unreachable directly.** *Done when:* resolving and probing the ALB
      from outside the account fails, and only CloudFront can reach it. (Req R2.4)
      → Not tested. The ALB is internal and its security group admits only the CloudFront
      origin-facing prefix list, so this is expected to hold — but expected is not verified.

---

## Phase 6 — Access, observability, cost

- [ ] **6.1 Owner permission set.** Exactly the permissions in design 6.3. *Done when:* the owner
      can open a port-forwarding session and read logs, and cannot read an object from the state
      bucket or decrypt with the state key. **Test the negative.** (Req R3.2, R4.9)
      → Not done, and the negative currently **would fail**: the state key policy is a single
      `DelegateToIam` statement and the bucket policy only denies non-TLS, so any principal in
      the account with S3 and KMS permissions can read conversation content. Recorded as an
      honest limit in the README rather than claimed as met.
- [ ] **6.2 Verify Mode B end to end.** Port-forward and drive a full conversation from the Claude
      client on the laptop. *Done when:* a message round-trips, and closing the session makes the
      client fail to connect. (Req R8 of requirements section on Claude client, R2.7, design 6.2)
- [ ] **6.3 Test revocation on both modes.** Revoke Identity Center access, then disable the
      Cognito user. *Done when:* each cuts off its own mode with no host-side change.
      (Req R3.4)
- [x] **6.4 Logs and retention.** Container and host logs to CloudWatch with the parameterised
      retention; ALB and CloudFront access logs to a separate logging bucket. *Done when:* all
      four log streams are present. (Req R11.1)
      → Container logs reach `/kirocrew/<stack>` via the awslogs driver, and ALB access logs land
      in the log bucket under `alb/`. Both were specified here but **initially skipped**, and
      their absence made a 500 undiagnosable until they were wired — the lesson being to build
      the observability before the thing it observes can fail. Host bootstrap output goes to
      `/var/log/crew-bootstrap.log` and the EC2 console rather than CloudWatch.
- [ ] **6.5 Alarms and SNS.** `GatewayUnhealthy`, `TargetGroupUnhealthy`, `MountMissing`,
      `CloudFront5xx`, and `StateSyncAge` if on the fallback path. *Done when:* each has been
      driven into ALARM deliberately at least once and the email arrived. **An untested alarm is
      not an alarm.** (Req R11.2, R11.3, design 8)
      → Five alarms exist and all report OK: `GatewayUnhealthy`, `MountMissing`,
      `PendingExports`, `ExportFailures`, `S3BucketAccessible`. Two of them
      (`GatewayUnhealthy`, `MountMissing`) did enter ALARM and recover during the ASG
      conversion — but incidentally, not deliberately, and email delivery was not confirmed. By
      this task's own standard that is not done. One real bug was found and fixed here:
      `S3BucketAccessible` had **no dimensions** while the metric was published with two, so it
      sat in `INSUFFICIENT_DATA` forever while the metric was plainly visible in the console. It
      now watches a dimensionless metric that `crew-health.sh` publishes directly, because an
      instance-pinned dimension cannot survive an Auto Scaling group and CloudWatch rejects
      `SEARCH` in alarms.
- [ ] **6.6 Price the deployment.** Fill in design section 9 against the AWS pricing calculator,
      itemised. *Done when:* the table has real numbers and the runbook documents the
      stop-the-instance lever and what keeps billing while stopped. (Req R11.4, R11.5)
- [ ] **6.7 Port scan from outside.** *Done when:* nothing on the instance or the ALB is
      reachable, and the scan output is recorded. (Req R2.4, success criterion 4)

---

## Phase 7 — Drills and soak

- [x] **7.1 Write `scripts/rebuild-drill.sh`.** Terminates the instance, relaunches from the
      template, times recovery, asserts database integrity and a memory recall. *Done when:* the
      script runs unattended and reports pass or fail. (Req R13.4)
      → 180 lines. Terminates through the Auto Scaling group rather than `ec2 terminate-instances`
      (the group is the thing under test), polls target-group health with an `ssm-only` fallback,
      then asserts sentinel ETag and credential-store continuity. Verified in `--dry-run` against
      the live stack; **not yet run for real**, so the recovery numbers quoted in the README come
      from performing these steps by hand rather than from this script.
- [x] **7.2 Run the rebuild drill.** *Done when:* RPO and RTO are measured and recorded, RTO is
      30 minutes or less, and integrity checks pass. (Req R4.4, R4.5, R4.6, R5.3)
      → Measured across three scenarios: reboot recovers in under 90s with the same instance;
      terminate is replaced automatically and healthy in **134s**; stop is treated as unhealthy
      and **replaced** (237s) rather than paused. All far inside the 30-minute objective.
      `PRAGMA integrity_check` returned `ok` on both databases, the sentinel ETag stayed
      byte-identical, and the kiro-cli credential store came through unchanged. **RPO is about
      one minute, not zero** — `ExportAge` measured 66s, because S3 Files exports asynchronously.
- [ ] **7.3 Destroy and redeploy from scratch.** *Done when:* the stack is deleted and redeployed
      by the documented single command, reaching the same healthy state with state recovered, and
      any component needing a manual step is named in the runbook. (Req R13.2, R13.4)
- [ ] **7.4 72-hour soak.** *Done when:* the Gateway has been continuously healthy for 72 hours
      with at least one cron firing on schedule in that window, evidenced from CloudWatch.
      (Req R1.7, success criterion 1)

---

## Phase 8 — Repository and write-up

- [x] **8.1 Write `README.md`.** Prerequisites stated up front, including that `front-door` mode
      requires a registered domain and that the region is us-east-1. Parameter table, one-command
      deploy, teardown, cost summary. *Done when:* someone who has not read this spec can deploy
      from it. (Req R13.2, design 10)
      → Rewritten against the deployed system, then audited: three claims were found false (that
      `--validate-only` creates nothing, that the five pre-flight checks run in the order listed,
      and a layout block naming files that are gitignored) and corrected. Carries a trap list of
      the six failures that cost the most time.
- [x] **8.2 Write `runbook.md`.** Bootstrap, both access modes, token minting, secret rotation,
      the audit-epoch procedure, the rebuild drill, stopping to save cost, teardown.
      *Done when:* every operational action taken in Phases 3 to 7 is documented. (Req R11.4,
      R13.4, design 5.2)
      → 417 lines. Cross-checked against the template: two errors found and fixed — a metric
      namespace that does not exist, and an incomplete metric list. The audit-epoch procedure is
      documented but, per task 1.8, never exercised.
- [x] **8.3 Write `infra/params.example.json`.** Every parameter with a working example value and
      no secrets. *Done when:* copying it and editing three fields produces a deployable config.
- [x] **8.4 Repository hygiene pass.** LICENSE, `.gitignore`, no account IDs, no ARNs with account
      numbers, no domain names, no secret names in committed files. *Done when:* a grep for the
      account ID and the domain across the repo returns nothing. (Req R15.4)
      → Audited across every tracked file: no account id, ARNs with account numbers, resource
      ids, domain names, emails or secret material. The `.gitignore` was widened from
      `docs/preflight.md` to all of `docs/`, because `docs/storage-verification.md` was untracked
      only by accident and contains the account id, VPC, subnet, filesystem and instance ids —
      one `git add .` would have published it. Local editor settings and the spec state file were
      untracked too.
- [x] **8.5 Draw the architecture diagram.** *Done when:* it renders and matches the deployed
      reality rather than the original design sketch. (Req R15.2)
      → A Mermaid `flowchart LR` in both `README.md` and `blog-post.md`, colour-coded by AWS
      service category (security red, networking purple, compute orange, storage green) with
      explicit `color:` on every `classDef` so labels stay legible under GitHub's light and dark
      themes. Renders natively on GitHub and most blog platforms, so it needs no build step and
      no binary asset. Edge labels carry the two facts a box cannot: that the ALB's Cognito call
      is server-side and needs 443 egress, and that the ASG replaces a dead host in 134s.
      Structure validated mechanically (balanced subgraphs, balanced quotes, every classed node
      defined, every class name declared) rather than by eye.
- [x] **8.6 Draft the blog post.** Why run Crew remotely; the architecture; the S3-backed
      filesystem decision and what task 1.9 actually measured; why Fargate, EKS, and AgentCore
      were rejected; the two access modes; the measured recovery numbers; the security caveats
      including the instance role and the public front door. *Done when:* every behavioural claim
      traces to a measured result, and no environment-specific identifier appears. (Req R15.1,
      R15.3, R15.5)
      → `blog-post.md`, ~2,900 words. Thesis: every failure was at a **seam** between two
      independently correct designs, not inside a component. Covers all six, the corrected
      RPO (66s, not zero), the version-churn split (33 per 6h idle vs 157 per rebuild), the
      three measured recovery times, and three honest limits — the customer key not currently
      isolating anything, unenforced cgroup ceilings, and single-AZ availability. Verified
      free of environment-specific identifiers by grep. The repository link is a placeholder
      pending the remote.
- [ ] **8.7 Final requirements audit.** Walk R1 to R15 and the nine success criteria against
      reality. *Done when:* each is marked met, or not met with the reason recorded.

---

## Sequencing notes

- **Phase 1 gates Phase 3.** Task 2.6 cannot be written before task 1.9 records a verdict.
- **Phase 5 is optional.** `ssm-only` deployments skip it and lose nothing else.
- **Phases 0.1, 0.2, 0.5, and 0.7 are independent** and can run in parallel.
- **Negative tests are called out deliberately** in 3.1, 5.3, 6.1, and 6.5. Each is a place where
  a happy-path pass would hide a real failure, which is the mistake this spec is trying not to
  repeat.

# Runbook — Kiro Crew on AWS

Operational procedures for a deployed stack. Commands assume `us-east-1`; get the instance id
from `aws cloudformation describe-stacks --stack-name <stack>`.

## Access

There is no inbound port and no SSH. Both paths below go through Systems Manager.

### Shell on the host

```
aws ssm start-session --region us-east-1 --target <instance-id>
```

### Dashboard from your laptop

Two terminals. First, forward the port:

```
aws ssm start-session --region us-east-1 --target <instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["5476"],"localPortNumber":["5476"]}'
```

Then mint a session link on the host and open it with the host replaced by `localhost:5476`:

```
sudo docker exec crew kirocrew --help     # see the token subcommand
```

Session links are short-lived by design. Mint immediately before use.

## First-run bootstrap

### Sign in kiro-cli — USE THE DEVICE FLOW

```
sudo docker exec -it crew kiro-cli login --use-device-flow --license pro
```

**Both flags are load-bearing, for different reasons, and each guards a different
failure.**

`--use-device-flow` is not optional on this host. Without it, kiro-cli tries to
launch a browser, finds none on a headless instance, and fails with:

```
Failed to open browser for authentication.
error: No such file or directory (os error 2)
```

That error reads like a missing file or a broken install. It is neither — it is a missing
browser binary. The device flow prints a short code and a URL to open on your own machine.

`--license pro` selects Identity Center directly, and it only takes effect *because*
`--use-device-flow` is set — kiro-cli discards every login flag unless the environment is
remote or that flag is present. Omit it and the device portal presents a free Builder ID as a
visual peer of organization SSO, so an account on an SSO plan can sign in to the wrong tier.
That one does not announce itself: login succeeds, and you discover it later as missing
models. Pass both and a Builder ID session cannot be produced.

Until this completes the Gateway runs but has no model access, so the `GatewayHealthy` alarm
fires. Expected during bootstrap.

### Why kiro-cli's credentials live at `/xdg-data`, not `~/.local/share`

**This is the subtlest trap in the whole deployment, and it silently disables every agent
turn.** Read this before you "simplify" the mount layout.

Crew hides its own data home from the kiro-cli it probes and from every ACP agent session, so
an agent cannot read Crew's secrets. From `kiro_prerequisite.py`:

```python
self._crew_hidden_dirs = tuple(dict.fromkeys(
    str(path) for path in (
        self._data_home,                 # ← hidden
        self._home / ".kiro" / "crew",
        self._home / ".kirocrew",
    )))
```

Upstream assumes the data home and the credential store are different trees: Crew in
`~/.kiro/crew/`, kiro-cli in `~/.local/share/kiro-cli/`. Hiding one leaves the other visible.

This deployment sets `KIROCREW_HOME=/home/kirocrew` — the **whole home** — so `_data_home` and
`$HOME` are the same path, and the hide swallows `~/.local/share/kiro-cli` with it. The
credential store becomes invisible to exactly the two callers that need it.

The symptom is deeply misleading:

| Check | Result |
|---|---|
| `docker exec crew kiro-cli whoami` | ✅ logged in, correct email and profile ARN |
| `kiro-cli login` | `error: Already logged in` |
| The dashboard setup gate | "Sign in to Kiro — **Required**", forever |
| `/api/kiro-prerequisite` | `authenticated: false`, and **no** sandbox error |

Nothing reports a fault. `sandbox_unavailable` is `false` because the sandbox is working
perfectly — it is hiding the directory it was told to hide. "Check again" cannot help, and
neither can a restart, because the state is structural.

The fix keeps the same storage and changes only the **container path**, so no data moves:

```
-v $MOUNT/xdg-data:/xdg-data
-e XDG_DATA_HOME=/xdg-data
```

`/xdg-data` is not under `/home/kirocrew`, so the path-based hide does not cover it, while the
bytes still live on the S3-backed filesystem and survive instance replacement. Verify with
`aws s3 ls s3://<state-bucket>/crew/xdg-data/kiro-cli/` — `data.sqlite3` should be there.

Confirm kiro-cli honours the variable before relying on it:

```bash
sudo docker exec crew sh -c 'XDG_DATA_HOME=/tmp/nope kiro-cli whoami'   # → "Not logged in"
```

**Changing `XDG_DATA_HOME` relocates the credential store, so it costs one re-login.** That is
a one-time cost, not a recurring one — the store persists from then on.

The alternative fix is to adopt upstream's layout (`KIROCREW_HOME=/home/kirocrew/.kiro/crew`),
which is more conventional but requires migrating a live data home including SQLite databases.
Not worth it once the path split is in place.

### The setup wizard's commands need a `docker exec` prefix

Crew's first-run wizard says "complete these two steps on the **Linux gateway host**" and shows
bare commands:

```
kiro-cli login
kiro-cli login --use-device-flow --license pro
```

Run either on the host and you get `sh: kiro-cli: command not found`. That is correct and
expected: kiro-cli lives **inside the container**, and the wizard assumes a bare-metal install.
Prefix everything:

```bash
sudo docker exec -it crew kiro-cli login --use-device-flow --license pro
```

Note also that the wizard's status is **latched**, not live. If you signed in from a shell, the
card can still read "Required" until you press **Check again**, which forces a fresh host probe.
A returning instance that is already authenticated shows the same stale card, so press it before
concluding sign-in failed.

### `--ttl` is the SESSION lifetime, not the token's — the token lasts 5 minutes

The single most misleading thing about first sign-in. `kirocrew token --ttl 12h` mints a JWT
whose payload is:

```
"iat":         <now>
"exp":         <now + 300>      ← the token expires in FIVE MINUTES
"session_exp": <now + 43200>    ← the 12h you asked for
"nonce":       <tracked in a revoked-nonce store>
```

So `--ttl` governs how long the *session cookie* lives once redeemed. The token that redeems it
is a short-lived one-shot. Mint it and fumble for six minutes and it is dead, and the dashboard
says **"Session expired"** — which reads as though your session lapsed, not as though the token
you just created did.

Have the browser open at the banner **before** you mint, then paste immediately:

```bash
T=$(sudo docker exec crew kirocrew token --ttl 12h 2>&1 | grep -o 'token=.*' | cut -d= -f2)
echo "HALF-1: ${T:0:20}"
echo "HALF-2: ${T:20}"
```

The split is not cosmetic. If your terminal output passes through a surface that redacts
credentials, the whole URL is replaced with `[REDACTED]` and you cannot read your own token.
Neither half matches a credential pattern on its own.

### The token URL names localhost, not your domain

`kirocrew token` prints `http://localhost:5476?token=...` whenever `dashboard.url` is unset,
because that is the only address it knows. Behind the front door that URL goes nowhere:
substitute your own host, or paste the bare token value into the dashboard's banner field.

```
https://<your-domain>/?token=<value>
```

Symptom if you use the printed URL as-is: the SPA shell loads (the Host allowlist accepts your
domain) and then every `/api/*` call returns **403**. Note 403, not 401 — Crew's token-auth
middleware and its Host-header barrier both use 403, so the status alone does not tell you
which one refused. Distinguish them by scope: the Host barrier rejects *every* path including
the shell, while a missing token leaves the shell working and fails only the API.

### Confirm the alarm subscription

The stack creates an SNS email subscription. AWS sends a confirmation mail to
`NotificationEmail`; **no alarm can reach you until you click it.**

### Verify

```
sudo docker exec crew kirocrew doctor
```

Expect kiro-cli present and authenticated, config valid, embeddings available.

## Health and observability

```
systemctl is-active crew-mount.service crew-secrets.service crew-gateway.service crew-health.timer
sudo cat /var/log/crew-bootstrap.log      # also mirrored to the EC2 console
sudo docker logs --tail 100 crew
```

`crew-health.sh` publishes three metrics to namespace `KiroCrew/<stack-name>`, all with **no
dimensions** so they stay alarmable across instance replacement: `GatewayHealthy`,
`DataHomeReadable` and `BucketAccessible`. S3 Files publishes its own under `AWS/S3/Files` —
watch `PendingExports` and `ExportFailures`.

Note the naming: the metric is `BucketAccessible`, while the alarm watching it is named
`<stack>-<owner>-S3BucketAccessible`. The mount client does publish its own
`S3BucketAccessible` / `S3BucketReachable` / `NFSConnectionAccessible`, but **this template
deliberately does not alarm on any of them** — they carry an `InstanceId` dimension, which
cannot be alarmed on under an Auto Scaling group. See the alarm section below.

### Reading the ALB access logs

They land in the log bucket under `alb/`, gzipped, every five minutes. The two fields that
matter for a sign-in failure are the **status code pair** and the **error reason**:

```bash
B=$(aws cloudformation describe-stacks --stack-name <stack> \
      --query 'Stacks[0].Outputs[?OutputKey==`LogBucketName`].OutputValue' --output text)
K=$(aws s3 ls "s3://$B/alb/" --recursive | sort -k1,2 | tail -1 | awk '{print $4}')
aws s3 cp "s3://$B/$K" - | gunzip -c
```

`elb_status_code` 500 with `target_status_code` `-` means the request never reached Crew, so
the container log will be silent and the reason field names the cause. Both codes 500 means
Crew answered, and the traceback is in `/kirocrew/<stack-name>` stream `gateway`.

## Sign-in returns 500 at /oauth2/idpresponse

If Cognito accepts your password and the redirect back lands on a 500, read the ALB access
log. The reason field will say `AuthTokenEpRequestTimeout`.

`authenticate-cognito` makes the load balancer an HTTP **client**. After Cognito redirects the
browser back with an authorization code, the ALB itself calls the Cognito token endpoint
server-side to exchange it, then the user-info endpoint. Those live on the hosted UI domain,
`<prefix>.auth.<region>.amazoncognito.com`, which is a public endpoint — so the ALB needs
outbound 443 and a route to the internet.

Two things must both hold, and a security group that only permits egress to the target group
is the easy one to get wrong, because a plain ALB never needs anything else:

1. **The ALB security group allows egress on TCP 443** (`AlbEgressToIdp` in the template).
   This cannot be narrowed: there is no prefix list for the hosted UI domain, and the
   `cognito-idp` interface endpoint does not serve the `/oauth2/*` routes.
2. **The ALB subnets have a default route to a NAT or transit gateway.** `deploy.sh` check 1
   verifies this before creating anything.

Missing egress produces a *timeout* rather than a refusal, because the packets are dropped
rather than rejected — which is why the symptom is a five-second hang and then a 500, and why
it looks like an application fault when it is a network one.

## Self-healing: the Auto Scaling group

Compute is a single-instance Auto Scaling group, not a standalone instance. It exists **only**
to self-heal, never to scale: the data home is SQLite on a shared mount, so a second writer
risks corrupting `memory.db`. `MinSize` and `MaxSize` are both 1, so the group cannot exceed
one instance even mid-replacement.

Find the live instance — there is no static id any more:

```bash
ASG=$(aws cloudformation describe-stacks --stack-name <stack> \
  --query 'Stacks[0].Outputs[?OutputKey==`AutoScalingGroupName`].OutputValue' --output text)
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
  --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text
```

### ⚠️ To pause the Gateway, scale to zero. Do NOT stop the instance.

An ASG treats a stopped instance as unhealthy and **terminates** it. Stopping no longer pauses
anything — it destroys the host and builds a new one:

```bash
aws autoscaling set-desired-capacity --auto-scaling-group-name "$ASG" --desired-capacity 0   # pause
aws autoscaling set-desired-capacity --auto-scaling-group-name "$ASG" --desired-capacity 1   # resume
```

### Measured behaviour

All three tested end to end on a live deployment.

| Action | Instance | Recovery | Notes |
|---|---|---|---|
| **Reboot** | same id kept | under 90s | ASG does not react. systemd brings mount, secrets and gateway back. The ALB never marked the target unhealthy, so recovery beat the 3 × 30s threshold. |
| **Terminate** | replaced automatically | **134s** to healthy | Replacement launched within 24s. No stack update, no human. |
| **Stop** | **terminated and replaced** | 237s to healthy | Marked unhealthy at +97s, terminated at +121s. The stopped instance is never restarted. |

Data and credentials came through all three untouched: sentinel ETag byte-identical, and the
kiro-cli credential store still 69,632 bytes — so **sign-in survives a self-heal**.

`HealthCheckType` is **EC2**, deliberately not ELB. ELB checks would replace the host whenever
`/api/health` fails, but the Gateway answers unhealthy for ordinary reasons — a lapsed kiro-cli
login, a stale `gateway.lock` during startup — and replacing the instance fixes neither. That is
a replacement storm on a stateful single-writer host.

### Availability is bounded to one AZ, on purpose

`VPCZoneIdentifier` names a single subnet. There is one S3 Files mount target and it lives in
one AZ; an instance launched elsewhere cannot reach it and fails closed at `crew-mount.service`.
An AZ outage is therefore an outage. Adding a second mount target would widen this, but the
single-writer constraint means it buys faster recovery, not redundancy.

### Two traps when converting from a standalone instance

**The KMS key policy must grant the Auto Scaling service-linked role.** The root volume is
encrypted with a customer-managed key. An ASG provisions EBS through
`AWSServiceRoleForAutoScaling`, whose AWS-managed identity policy does **not** convey use of a
customer key — only a key policy statement does. Without it every launch fails with:

```
Client.InvalidKMSKey.InvalidState: The KMS key provided is in an incorrect state
```

which is thoroughly misleading: the key is `Enabled` and healthy, and the real problem is
authorization. Worse, the ASG retries indefinitely, so the stack update **hangs** rather than
failing fast — one attempt sat in `UPDATE_IN_PROGRESS` for an hour before rolling back. A
standalone `AWS::EC2::Instance` never hits this because it launches with the deployer's own
credentials, so the failure appears only at conversion time.

**Convert in two phases, or you get two writers.** CloudFormation creates new resources before
deleting removed ones, so replacing the instance with an ASG in one update briefly runs both.
Deploy the ASG at `DesiredCapacity: 0` first, let CloudFormation delete the old instance, then
scale to 1. Costs a few minutes of downtime and guarantees the single writer.

## Known gaps on this host

**cgroup v2 scope enforcement is unavailable.** `kirocrew doctor` reports:

```
SECURITY: cgroup v2 scope enforcement unavailable (systemd-run not found); agent
subprocess fork-bomb / memory-DoS ceilings are NOT enforced on this host.
RLIMIT_NOFILE still applies.
```

The container has no `systemd-run`, so Crew cannot put each agent subprocess in its own cgroup
scope. The user-namespace sandbox still isolates the subprocess — that is the seccomp profile's
job and it is working — but there is no memory or process-count ceiling on it. A runaway agent
can therefore exhaust the instance's 16 GiB rather than being capped at a slice of it.

Consequence for sizing: the memory headroom on `r8g.large` is doing double duty as the only
practical backstop against a runaway subprocess. Treat `GatewayUnhealthy` firing alongside a
memory spike as a plausible fork-bomb rather than assuming a Crew crash.

**Config write-back fails with errno 524.** Every config read logs
`Config write-back failed: [Errno 524] ... config.json.bak`. `shutil.copy2` copies xattrs, the
mount answers `ENOTSUPP`, and Python's `_copyxattr` does not ignore 524. Because `cfg.save()`
sits after the copy in the same `try`, migrated config never persists. Editing `config.json`
directly still works — only Crew's own write-back path is affected. Upstream bug;
`shutil.copy` instead of `copy2` would fix it.

## Storage facts worth knowing before you trust a restore

Measured during verification; see `docs/storage-verification.md`.

- **Export is asynchronous.** `ExportAge` was 66 seconds under light load, so the recovery
  point is about a minute, not zero.
- **A SQLite database is three objects** — `.db`, `.db-wal`, `.db-shm` — exported
  independently with no atomicity across the set, and most live data sits in the
  uncheckpointed WAL. **Stop the container before relying on a restore**, so SQLite
  checkpoints and the WAL drains:

  ```
  sudo systemctl stop crew-gateway.service
  ```

- **`.local_secret` lives on the mount**, and therefore in the bucket, because
  `KIROCREW_HOME` is the mount. A replacement host inherits it rather than regenerating it.

## Secret rotation

Update the value in Secrets Manager, then restart. No rebuild, no template change.

```
sudo systemctl restart crew-gateway.service
```

## Reducing cost

The instance dominates the bill; removing it removes most of that.

**Scale the group to zero. Do NOT run `aws ec2 stop-instances`.** Under the Auto Scaling group
this deployment uses, a stopped instance is read as unhealthy and **terminated** — so stopping
destroys the host and builds a new one, which costs you the replacement rather than saving the
hour. Measured at 237s to a healthy replacement. See the self-healing section above.

```
ASG=$(aws cloudformation describe-stacks --stack-name <stack> \
  --query 'Stacks[0].Outputs[?OutputKey==`AutoScalingGroupName`].OutputValue' --output text)
aws autoscaling set-desired-capacity --auto-scaling-group-name "$ASG" --desired-capacity 0
```

Bring it back with `--desired-capacity 1`.

In `front-door` mode the ALB and CloudFront keep charging while capacity is zero and the
dashboard returns 503. In `ssm-only` mode with `NetworkMode=existing`, nothing else bills but
the bucket.

## Teardown

```
aws cloudformation delete-stack --region us-east-1 --stack-name <stack>
```

The state bucket and the file system carry `DeletionPolicy: Retain`, so **your data survives
stack deletion** and shows as `DELETE_SKIPPED`. Delete them by hand when you actually mean to.

Note the same mechanism applies to a **failed create**: rollback retains the bucket, and the
next deploy under the same stack name collides with it. Either delete the leftover bucket or
deploy under a different stack name.

With `NetworkMode=existing` the stack never owned your VPC or NAT, so neither is touched.

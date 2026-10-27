import * as cdk from 'aws-cdk-lib';
import { Validations } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { KubectlV34Layer } from '@aws-cdk/lambda-layer-kubectl-v34';
import { Construct } from 'constructs';

/** One entry per person who gets their own Kiro Crew pod. */
export interface CrewUser {
  /** DNS-safe name. Becomes the namespace (user-<name>) and the Cognito group. */
  readonly name: string;
  /** Local port the tester forwards to (kubectl port-forward). Also the Cognito callback port. */
  readonly localPort: number;
}

export interface PerUserCrewStackProps extends cdk.StackProps {
  readonly users: CrewUser[];
  /** Multi-arch index digest of ghcr.io/kirodotdev/kirocrew (see scripts in the parent repo: verify-image.sh). */
  readonly crewImageDigest: string;
  /**
   * IAM role ARN that gets cluster-admin through an EKS access entry, so you can run kubectl.
   * For an IAM Identity Center role use the role ARN including its path, for example
   * arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdministratorAccess_xxxx
   * Pass it as: cdk deploy -c adminRoleArn=<arn>
   */
  readonly adminRoleArn?: string;
  /**
   * CIDR blocks allowed to reach the public Kubernetes API endpoint. Leave unset for the default (open to the
   * internet, still IAM-authenticated). Set it to your own address range for anything beyond a short test.
   */
  readonly apiAllowedCidrs?: string[];
}

// Third-party images are pinned by multi-arch index digest, so a moved tag cannot change what runs.
// To update: resolve the new tag's index digest from the registry and change both the tag comment and the digest.
const OAUTH2_PROXY_IMAGE =
  'quay.io/oauth2-proxy/oauth2-proxy@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916'; // v7.15.5
const NGINX_IMAGE =
  'public.ecr.aws/nginx/nginx-unprivileged@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6'; // 1.29-alpine
const GATEWAY_PORT = 5476;

/**
 * Option B: one Kiro Crew pod per user on EKS.
 *
 * Request path for each user (inside ONE pod, all on the pod's loopback):
 *
 *   browser -> nginx :8080 -> auth_request -> oauth2-proxy :4180 (Cognito, group == this user)
 *                          -> Crew gateway 127.0.0.1:5476 (dashboard cookie injected by nginx)
 *
 * The gateway binds loopback only, so nothing but the sidecar chain can reach it,
 * with or without NetworkPolicy.
 */
export class PerUserCrewStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PerUserCrewStackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------ network
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1, // POC: one NAT. Production: one per AZ.
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      ],
      // Network flow records, for troubleshooting and for evidence that tenants really cannot reach each other.
      flowLogs: {
        all: {
          trafficType: ec2.FlowLogTrafficType.ALL,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'VpcFlowLogs', {
              retention: logs.RetentionDays.ONE_MONTH,
              removalPolicy: cdk.RemovalPolicy.DESTROY, // POC only
            }),
          ),
        },
      },
    });

    // ------------------------------------------------------------------ identity
    const pool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${this.stackName}-users`,
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      // TOTP is available to every user. It is OPTIONAL rather than REQUIRED only so the scripted browser test can
      // sign in with a password. Set REQUIRED for anything real.
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.NONE, // admin-managed users, no self-service reset
      removalPolicy: cdk.RemovalPolicy.DESTROY, // POC only
    });
    const domain = pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `kirocrew-eks-poc-${this.account}` },
    });
    const client = pool.addClient('ProxyClient', {
      generateSecret: true,
      authFlows: { userSrp: true },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        // http is allowed by Cognito for localhost only. A real deployment uses an HTTPS host.
        callbackUrls: props.users.map((u) => `http://localhost:${u.localPort}/oauth2/callback`),
        // Lets Cognito end its own session and then hand the browser to oauth2-proxy's sign-out, which clears the
        // proxy cookie. Together they give a clean "signed out of everything" state (see the SignOut outputs).
        logoutUrls: props.users.map((u) => `http://localhost:${u.localPort}/oauth2/sign_out`),
      },
    });
    const issuerUrl = `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`;

    for (const u of props.users) {
      const group = new cognito.CfnUserPoolGroup(this, `Group-${u.name}`, {
        userPoolId: pool.userPoolId,
        groupName: u.name,
      });
      const user = new cognito.CfnUserPoolUser(this, `User-${u.name}`, {
        userPoolId: pool.userPoolId,
        username: u.name,
        messageAction: 'SUPPRESS', // no invite email; the password is set out of band
        userAttributes: [
          { name: 'email', value: `${u.name}@example.com` },
          { name: 'email_verified', value: 'true' },
        ],
      });
      const attach = new cognito.CfnUserPoolUserToGroupAttachment(this, `Attach-${u.name}`, {
        userPoolId: pool.userPoolId,
        groupName: u.name,
        username: u.name,
      });
      attach.node.addDependency(group, user);
    }

    // ------------------------------------------------------------------ cluster
    const cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: `${this.stackName}`,
      version: eks.KubernetesVersion.V1_34,
      kubectlLayer: new KubectlV34Layer(this, 'KubectlLayer'),
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 0,
      // Control plane audit and diagnostic logs to CloudWatch (EKS security best practice).
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUDIT,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
        eks.ClusterLoggingTypes.CONTROLLER_MANAGER,
        eks.ClusterLoggingTypes.SCHEDULER,
      ],
      // Envelope encryption of Kubernetes Secrets with a customer-managed key (rotating), on top of the default
      // encryption EKS applies to all Kubernetes API data. Changing this later replaces the cluster.
      secretsEncryptionKey: new kms.Key(this, 'SecretsKey', {
        description: `${this.stackName} Kubernetes secrets envelope encryption`,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY, // POC only. Retain in production.
      }),
      endpointAccess: props.apiAllowedCidrs?.length
        ? eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom(...props.apiAllowedCidrs)
        : eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      // Access entries (the current EKS access model) alongside the aws-auth ConfigMap CDK still uses internally.
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
    });

    if (props.adminRoleArn) {
      new eks.AccessEntry(this, 'AdminAccess', {
        cluster,
        principal: props.adminRoleArn,
        accessPolicies: [
          eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
            accessScopeType: eks.AccessScopeType.CLUSTER,
          }),
        ],
      });
    }

    // VPC CNI with NetworkPolicy enforcement. Without this, NetworkPolicy objects are accepted and ignored.
    const vpcCni = new eks.CfnAddon(this, 'VpcCniAddon', {
      clusterName: cluster.clusterName,
      addonName: 'vpc-cni',
      configurationValues: JSON.stringify({ enableNetworkPolicy: 'true' }),
      resolveConflicts: 'OVERWRITE',
    });

    // No addDependency(cluster) on the add-ons: that would also depend on the cluster's aws-auth manifest, which
    // depends on the node role, which depends on the add-on. The reference to cluster.clusterName is enough.
    const podIdentityAgent = new eks.CfnAddon(this, 'PodIdentityAgentAddon', {
      clusterName: cluster.clusterName,
      addonName: 'eks-pod-identity-agent',
      resolveConflicts: 'OVERWRITE',
    });

    // The Crew image is multi-arch. Graviton keeps the POC cheap.
    const nodes = cluster.addNodegroupCapacity('Nodes', {
      instanceTypes: [new ec2.InstanceType('m7g.xlarge')], // 4 vCPU / 16 GiB, room for two idle pods
      amiType: eks.NodegroupAmiType.AL2023_ARM_64_STANDARD,
      minSize: 1,
      maxSize: 2,
      desiredSize: 1,
      diskSize: 50,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    nodes.node.addDependency(vpcCni);

    // EBS CSI driver for the per-user volumes, using EKS Pod Identity (no node-role permissions).
    const ebsCsiRole = new iam.Role(this, 'EbsCsiRole', {
      assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEBSCSIDriverPolicy'),
      ],
    });
    ebsCsiRole.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.ServicePrincipal('pods.eks.amazonaws.com')],
      }),
    );
    const ebsCsi = new eks.CfnAddon(this, 'EbsCsiAddon', {
      clusterName: cluster.clusterName,
      addonName: 'aws-ebs-csi-driver',
      resolveConflicts: 'OVERWRITE',
      podIdentityAssociations: [
        { roleArn: ebsCsiRole.roleArn, serviceAccount: 'ebs-csi-controller-sa' },
      ],
    });
    ebsCsi.node.addDependency(nodes, podIdentityAgent);

    const storageClass = cluster.addManifest('Gp3StorageClass', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'gp3-encrypted' },
      provisioner: 'ebs.csi.aws.com',
      volumeBindingMode: 'WaitForFirstConsumer',
      reclaimPolicy: 'Delete',
      parameters: { type: 'gp3', encrypted: 'true' },
    });
    storageClass.node.addDependency(ebsCsi);

    // ------------------------------------------------------------ per-user pods
    for (const u of props.users) {
      const ns = `user-${u.name}`;
      const origin = `http://localhost:${u.localPort}`;

      // POC shortcut: a random 32-character cookie secret is generated at deploy time and copied into a Kubernetes
      // Secret through the stack. (A Secrets Manager dynamic reference does not resolve inside a kubectl manifest, so
      // it would arrive as the literal "{{resolve:...}}" text.) Production: Secrets Store CSI Driver or External
      // Secrets with EKS Pod Identity, so no secret value passes through the template at all.
      const cookieSecret = new cr.AwsCustomResource(this, `CookieSeed-${u.name}`, {
        onCreate: {
          service: 'SecretsManager',
          action: 'getRandomPassword',
          parameters: { PasswordLength: 32, ExcludePunctuation: true },
          physicalResourceId: cr.PhysicalResourceId.of(`${this.stackName}-${u.name}-cookie-secret`),
        },
        installLatestAwsSdk: false,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({ actions: ['secretsmanager:GetRandomPassword'], resources: ['*'] }),
        ]),
      });

      const labels = { app: 'kirocrew', 'kirocrew.io/user': u.name };

      const namespace = {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: ns,
          labels: {
            'kirocrew.io/user': u.name,
            // baseline forbids privileged pods and host namespaces. restricted would force a seccomp profile
            // that blocks the unshare calls Crew's agent sandbox needs, so it is only audited and warned on.
            'pod-security.kubernetes.io/enforce': 'baseline',
            'pod-security.kubernetes.io/audit': 'restricted',
            'pod-security.kubernetes.io/warn': 'restricted',
          },
        },
      };

      // Tenant resource limits, so one user's runaway agent cannot starve the other pods on the node.
      // The gateway container alone is allowed 6Gi, so the quota leaves room for the sidecars and a restart overlap.
      const resourceQuota = {
        apiVersion: 'v1',
        kind: 'ResourceQuota',
        metadata: { name: 'tenant-quota', namespace: ns },
        spec: {
          hard: {
            pods: '4',
            'requests.cpu': '2',
            'requests.memory': '4Gi',
            'limits.memory': '8Gi',
            'requests.storage': '40Gi',
            persistentvolumeclaims: '2',
            services: '4',
            'count/secrets': '10',
          },
        },
      };

      // Defaults for any container that forgets to set requests or limits, which the quota above would otherwise reject.
      const limitRange = {
        apiVersion: 'v1',
        kind: 'LimitRange',
        metadata: { name: 'tenant-defaults', namespace: ns },
        spec: {
          limits: [
            {
              type: 'Container',
              defaultRequest: { cpu: '10m', memory: '32Mi' },
              default: { memory: '512Mi' },
            },
          ],
        },
      };

      const serviceAccount = {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: 'kirocrew', namespace: ns },
        automountServiceAccountToken: false,
      };

      const oauthSecret = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'oauth2-proxy', namespace: ns },
        type: 'Opaque',
        stringData: {
          'client-id': client.userPoolClientId,
          'client-secret': client.userPoolClientSecret.unsafeUnwrap(),
          'cookie-secret': cookieSecret.getResponseField('RandomPassword'),
        },
      };

      // nginx is the only listener the user ever reaches. It asks oauth2-proxy "is this the owner?" before every
      // request, then swaps in the dashboard session cookie that the token refresher minted for this pod.
      // The browser never sees, stores or sends that cookie.
      const nginxConf = [
        'map $http_upgrade $connection_upgrade { default upgrade; "" close; }',
        // Access log with the upstream's redirect target, which is what you need when a sign-in loops. Never logs cookies.
        `log_format edge '$remote_addr [$time_local] "$request" $status up=$upstream_status loc="$upstream_http_location"';`,
        'server {',
        '  listen 8080;',
        '  access_log /dev/stdout edge;',
        '  include /shared/kc-token.conf;  # defines $kc_token',
        // oauth2-proxy stores the Cognito tokens in its session cookie (split across several cookies), so both the
        // request headers it sends and the Set-Cookie headers it returns outgrow nginx's 4-8 KB defaults.
        // Too small and nginx answers 502 "upstream sent too big header" right after a successful sign-in.
        '  large_client_header_buffers 4 32k;',
        '  proxy_buffer_size 32k;',
        '  proxy_buffers 8 32k;',
        '  proxy_busy_buffers_size 64k;',
        '  location = /healthz { access_log off; return 200 "ok"; }',
        '  location = /oauth2/auth {',
        '    internal;',
        '    proxy_pass http://127.0.0.1:4180;',
        '    proxy_set_header Host $host;',
        '    proxy_set_header Content-Length "";',
        '    proxy_pass_request_body off;',
        '  }',
        '  location /oauth2/ {',
        '    proxy_pass http://127.0.0.1:4180;',
        '    proxy_set_header Host $host;',
        '    proxy_set_header X-Auth-Request-Redirect $request_uri;',
        '  }',
        '  location / {',
        '    auth_request /oauth2/auth;',
        '    error_page 401 = /oauth2/sign_in;',
        '    proxy_pass http://127.0.0.1:' + GATEWAY_PORT + ';',
        '    proxy_http_version 1.1;',
        '    proxy_set_header Upgrade $http_upgrade;',
        '    proxy_set_header Connection $connection_upgrade;',
        `    proxy_set_header Host localhost:${GATEWAY_PORT};`,
        // The gateway redirects "/" to its canonical dashboard URL, http://localhost:5476/. Point such redirects back at the
        // address the browser actually used, or the browser is sent to a loopback address that does not exist for it.
        `    proxy_redirect ~*^https?://localhost:${GATEWAY_PORT}(.*)$ $scheme://$http_host$1;`,
        '    proxy_set_header Cookie $kc_token;',
        '    proxy_set_header Authorization "";',
        '    proxy_read_timeout 3600s;',
        '    proxy_buffering off;',
        '  }',
        '}',
        '',
      ].join('\n');

      const nginxConfig = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'edge', namespace: ns },
        data: { 'default.conf': nginxConf },
      };

      // Runs INSIDE the gateway container, started in the background before the gateway itself. Waits until the
      // gateway is ready, asks the Crew CLI for a dashboard session token (the documented way; the token never
      // leaves the pod), and writes it as an nginx include. The maximum session lifetime is 20 hours, so it
      // re-mints every 10 hours and the edge container reloads nginx on change.
      //
      // It has to live in the gateway container: the gateway only mints a token for a caller it can verify shares its
      // own namespaces (mount, pid, user). A separate sidecar container, even with shareProcessNamespace, is refused
      // with HTTP 403 "could not verify this process as the local owner".
      const refresherScript = [
        'while :; do',
        `  until curl -fsS http://127.0.0.1:${GATEWAY_PORT}/api/ready >/dev/null 2>&1; do sleep 3; done`,
        '  out=$(kirocrew token --ttl 20h 2>/tmp/mint.err); rc=$?',
        '  t=$(printf "%s" "$out" | grep -o "token=[A-Za-z0-9_.-]*" | head -1 | cut -d= -f2)',
        '  if [ -n "$t" ]; then',
        `    printf 'set $kc_token "mc_token_${GATEWAY_PORT}=%s";\\n' "$t" > /shared/kc-token.conf.tmp`,
        '    chmod 644 /shared/kc-token.conf.tmp && mv /shared/kc-token.conf.tmp /shared/kc-token.conf',
        '    echo "token refreshed"',
        '    sleep 36000',
        '  else',
        '    echo "token mint failed (rc=$rc); stderr follows, stdout is shown with any token redacted"',
        '    head -c 600 /tmp/mint.err; printf "%s" "$out" | sed "s/token=[A-Za-z0-9_.-]*/token=REDACTED/g" | head -c 600',
        '    sleep 20',
        '  fi',
        'done',
      ].join('\n');

      // Background the refresher, then hand the container to the image's own entrypoint, unchanged.
      const gatewayStart = ['(', refresherScript, ') &', 'exec kirocrew-entrypoint gateway'].join('\n');

      const edgeScript = [
        'until [ -s /shared/kc-token.conf ]; do sleep 2; done',
        "nginx -g 'daemon off;' &",
        'pid=$!',
        'last=$(md5sum /shared/kc-token.conf)',
        'while sleep 30; do',
        '  kill -0 $pid 2>/dev/null || exit 1',
        '  cur=$(md5sum /shared/kc-token.conf)',
        '  if [ "$cur" != "$last" ]; then nginx -s reload; last="$cur"; fi',
        'done',
      ].join('\n');

      const hardenedContainer = {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      };

      const statefulSet = {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata: { name: 'kirocrew', namespace: ns, labels },
        spec: {
          serviceName: 'kirocrew',
          replicas: 1, // Crew's data home is SQLite: exactly one writer
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              serviceAccountName: 'kirocrew',
              automountServiceAccountToken: false,
              securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
              // Native sidecar (Kubernetes 1.29+): starts first and stays up. The next containers wait for its startupProbe.
              initContainers: [
                {
                  name: 'gateway',
                  image: `ghcr.io/kirodotdev/kirocrew@${props.crewImageDigest}`,
                  restartPolicy: 'Always',
                  command: ['/bin/sh', '-c', gatewayStart],
                  env: [
                    // Loopback only. Not reachable from the pod IP, so only the sidecars in this pod can talk to it.
                    { name: 'KIROCREW_BIND', value: '127.0.0.1' },
                    // The browser's Origin, so Crew's CSRF and WebSocket origin checks accept the proxied dashboard.
                    { name: 'KIROCREW_CORS_ORIGINS', value: origin },
                  ],
                  startupProbe: {
                    exec: { command: ['curl', '-fsS', `http://127.0.0.1:${GATEWAY_PORT}/api/ready`] },
                    periodSeconds: 5,
                    failureThreshold: 90,
                  },
                  resources: {
                    requests: { cpu: '250m', memory: '1Gi' },
                    limits: { memory: '6Gi' },
                  },
                  securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
                  volumeMounts: [
                    { name: 'data', mountPath: '/home/kirocrew' },
                    { name: 'shared', mountPath: '/shared' },
                  ],
                },
              ],
              containers: [
                {
                  name: 'auth-proxy',
                  image: OAUTH2_PROXY_IMAGE,
                  args: [
                    '--provider=oidc',
                    `--oidc-issuer-url=${issuerUrl}`,
                    `--redirect-url=${origin}/oauth2/callback`,
                    '--http-address=127.0.0.1:4180',
                    '--upstream=static://202',
                    '--reverse-proxy=true',
                    '--email-domain=*',
                    '--scope=openid email profile',
                    '--oidc-groups-claim=cognito:groups',
                    `--allowed-group=${u.name}`,
                    '--skip-provider-button=true',
                    '--cookie-secure=false', // plain http on localhost for the POC
                    '--cookie-samesite=lax',
                    '--set-xauthrequest=true',
                  ],
                  env: [
                    { name: 'OAUTH2_PROXY_CLIENT_ID', valueFrom: { secretKeyRef: { name: 'oauth2-proxy', key: 'client-id' } } },
                    { name: 'OAUTH2_PROXY_CLIENT_SECRET', valueFrom: { secretKeyRef: { name: 'oauth2-proxy', key: 'client-secret' } } },
                    { name: 'OAUTH2_PROXY_COOKIE_SECRET', valueFrom: { secretKeyRef: { name: 'oauth2-proxy', key: 'cookie-secret' } } },
                  ],
                  resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '128Mi' } },
                  securityContext: { ...hardenedContainer, readOnlyRootFilesystem: true },
                },
                {
                  name: 'edge',
                  image: NGINX_IMAGE,
                  command: ['/bin/sh', '-c', edgeScript],
                  ports: [{ name: 'http', containerPort: 8080 }],
                  readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 5 },
                  resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '128Mi' } },
                  securityContext: { ...hardenedContainer, readOnlyRootFilesystem: true },
                  volumeMounts: [
                    { name: 'shared', mountPath: '/shared', readOnly: true },
                    { name: 'edge-tmp', mountPath: '/tmp' }, // pid file and proxy temp files
                    { name: 'edge-conf', mountPath: '/etc/nginx/conf.d/default.conf', subPath: 'default.conf', readOnly: true },
                  ],
                },
              ],
              volumes: [
                { name: 'shared', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
                { name: 'edge-tmp', emptyDir: { sizeLimit: '64Mi' } },
                { name: 'edge-conf', configMap: { name: 'edge' } },
              ],
            },
          },
          volumeClaimTemplates: [
            {
              metadata: { name: 'data' },
              spec: {
                accessModes: ['ReadWriteOnce'],
                storageClassName: 'gp3-encrypted',
                resources: { requests: { storage: '20Gi' } },
              },
            },
          ],
        },
      };

      const service = {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'edge', namespace: ns },
        spec: { selector: labels, ports: [{ name: 'http', port: 8080, targetPort: 'http' }] },
      };

      // Tenant isolation at the network layer.
      //  - Ingress: only pods in the same namespace. Other users' pods cannot connect.
      //  - Egress: DNS, plus the public internet (Kiro, GitHub, Jira, MCP). Private ranges are blocked, which also
      //    blocks other tenants' pod IPs and the node metadata service (169.254.169.254).
      const networkPolicy = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: { name: 'tenant-isolation', namespace: ns },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress', 'Egress'],
          ingress: [{ from: [{ podSelector: {} }] }],
          egress: [
            {
              to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
              ports: [
                { protocol: 'UDP', port: 53 },
                { protocol: 'TCP', port: 53 },
              ],
            },
            {
              to: [
                {
                  ipBlock: {
                    cidr: '0.0.0.0/0',
                    except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'],
                  },
                },
              ],
            },
          ],
        },
      };

      const manifest = cluster.addManifest(
        `User-${u.name}`,
        namespace,
        resourceQuota,
        limitRange,
        serviceAccount,
        oauthSecret,
        nginxConfig,
        service,
        networkPolicy,
        statefulSet,
      );
      manifest.node.addDependency(storageClass, ebsCsi);
    }

    // ------------------------------------------------------- cdk-nag acknowledgements
    // Every finding that is deliberate for this proof of concept is acknowledged here with its reason, so a NEW
    // finding still fails the synth. Revisit each one before using this for anything beyond a test.
    const ack = (id: string, reason: string) => Validations.of(this).acknowledge({ id, reason });
    ack(
      'AwsSolutions-COG2',
      'MFA is OPTIONAL (TOTP available) so the scripted browser test can sign in with a password. Set mfa: REQUIRED for real use.',
    );
    ack(
      'AwsSolutions-COG8',
      'The Cognito Plus feature plan (advanced threat protection) costs per monthly active user and is out of scope for a test pool.',
    );
    ack(
      'AwsSolutions-EKS1',
      'The API endpoint is public so kubectl works from a laptop, and every call is IAM-authenticated. Restrict it with -c apiAllowedCidrs=<cidr> or use a private endpoint plus a bastion.',
    );
    // IAM4 and IAM5 report one finding per policy or per wildcard, so each is acknowledged by its exact id. The
    // Lambda-handler ids below are logical ids inside the CDK EKS construct; they are stable for the pinned
    // aws-cdk-lib version, and a CDK upgrade that changes them makes the synth fail loudly so they get re-reviewed.
    const awsManaged =
      'AWS managed policy documented for EKS (cluster, worker node, CNI, ECR pull, EBS CSI driver) or used by a CDK-generated Lambda.';
    [
      'AmazonEC2ContainerRegistryPullOnly',
      'AmazonEC2ContainerRegistryReadOnly',
      'AmazonEKSClusterPolicy',
      'AmazonEKSWorkerNodePolicy',
      'AmazonEKS_CNI_Policy',
      'service-role/AWSLambdaBasicExecutionRole',
      'service-role/AWSLambdaVPCAccessExecutionRole',
      'service-role/AmazonEBSCSIDriverPolicy',
    ].forEach((name) =>
      ack(`AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/${name}]`, awsManaged),
    );
    ack(
      'AwsSolutions-IAM4[Policy::{"Fn::If":["ClusterHasEcrPublic8EE1114E",{"Fn::Join":["",["arn:",{"Ref":"AWS::Partition"},":iam::aws:policy/AmazonElasticContainerRegistryPublicReadOnly"]]},{"Ref":"AWS::NoValue"}]}]',
      awsManaged,
    );
    // cdk-nag prints a concrete account and region when the stack has them, and the pseudo-parameter names when not.
    const nagAccount = cdk.Token.isUnresolved(this.account) ? '<AWS::AccountId>' : this.account;
    const nagRegion = cdk.Token.isUnresolved(this.region) ? '<AWS::Region>' : this.region;
    const eksInternals = 'Generated by the CDK EKS construct (cluster resource provider, kubectl handler); not configurable here.';
    [
      '<Handler886CB40B.Arn>:*',
      '<IsCompleteHandler7073F4DA.Arn>:*',
      '<OnEventHandler42BEBAE0.Arn>:*',
      '<ProviderframeworkisComplete26D7B0CB.Arn>:*',
      '<ProviderframeworkonTimeout0B47CA38.Arn>:*',
      `arn:<AWS::Partition>:eks:${nagRegion}:${nagAccount}:cluster/${this.stackName}/*`,
      `arn:<AWS::Partition>:eks:${nagRegion}:${nagAccount}:fargateprofile/${this.stackName}/*`,
    ].forEach((r) => ack(`AwsSolutions-IAM5[Resource::${r}]`, eksInternals));
    ack(
      'AwsSolutions-IAM5[Resource::*]',
      'secretsmanager:GetRandomPassword (cookie secret generation) and the CDK EKS construct do not support resource-level permissions for these actions.',
    );
    ack('AwsSolutions-L1', 'These Lambda functions belong to the CDK EKS construct and are not configurable here.');
    ack('AwsSolutions-SF1', 'This state machine belongs to the CDK EKS cluster provider and is not configurable here.');
    ack('AwsSolutions-SF2', 'This state machine belongs to the CDK EKS cluster provider and is not configurable here.');

    // ------------------------------------------------------------------ outputs
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'UpdateKubeconfig', {
      value: `aws eks update-kubeconfig --region ${this.region} --name ${cluster.clusterName}`,
    });
    new cdk.CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'HostedUiDomain', { value: domain.baseUrl() });
    // Open one of these in the browser to drop BOTH the Cognito session and the proxy cookie for that pod, so the next
    // visit shows the Cognito sign-in page again. Useful for repeating the sign-in test without closing every window.
    for (const u of props.users) {
      new cdk.CfnOutput(this, `SignOut-${u.name}`, {
        value: `${domain.baseUrl()}/logout?client_id=${client.userPoolClientId}&logout_uri=${encodeURIComponent(
          `http://localhost:${u.localPort}/oauth2/sign_out`,
        )}`,
      });
    }
    new cdk.CfnOutput(this, 'PortForwards', {
      value: props.users
        .map((u) => `kubectl -n user-${u.name} port-forward svc/edge ${u.localPort}:8080`)
        .join(' ; '),
    });
  }
}

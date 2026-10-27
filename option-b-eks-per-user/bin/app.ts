#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { PerUserCrewStack } from '../lib/per-user-crew-stack';

const app = new cdk.App();

const stack = new PerUserCrewStack(app, 'kirocrew-eks-poc', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  // Two test users are enough to prove (or break) isolation. Add more rows to add pods.
  users: [
    { name: 'alice', localPort: 8081 },
    { name: 'bob', localPort: 8082 },
  ],
  // Multi-arch index digest of ghcr.io/kirodotdev/kirocrew:stable, resolved and provenance-checked with
  // ../scripts/verify-image.sh. Re-resolve before every deployment.
  crewImageDigest: 'sha256:b6d0b9a3a666df30d99fcadc6a71ab83cbf4ed1c6521e1b81f0333c5553f3e90',
  // Optional: the IAM role that should get kubectl access. Pass with: cdk deploy -c adminRoleArn=<role arn>
  adminRoleArn: app.node.tryGetContext('adminRoleArn'),
  // Optional: restrict the public Kubernetes API endpoint to these CIDRs, comma separated.
  // Pass with: cdk deploy -c apiAllowedCidrs=203.0.113.4/32
  apiAllowedCidrs: app.node.tryGetContext('apiAllowedCidrs')?.split(',').map((c: string) => c.trim()),
  // Tags applied to every resource. Add your organization's required tags (cost center, owner, or the tag a cleanup
  // tool honors) without editing code: cdk deploy -c extraTags=owner=me,keep=true
  tags: {
    Project: 'kirocrew-on-aws',
    Option: 'b-eks-per-user',
    ...Object.fromEntries(
      String(app.node.tryGetContext('extraTags') ?? '')
        .split(',')
        .map((kv: string) => kv.split('='))
        .filter(([k, v]: string[]) => k && v)
        .map(([k, v]: string[]) => [k.trim(), v.trim()]),
    ),
  },
});

// Static best-practice checks on every synth. Findings that are deliberate for a proof of concept are suppressed
// inside the stack with a written reason, so anything new shows up as an error.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
void stack;

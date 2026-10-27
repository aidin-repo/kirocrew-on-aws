#!/usr/bin/env bash
# Remove Option B completely.
#
# Order matters: delete the user namespaces FIRST so the EBS CSI driver can delete each user's volume.
# If the cluster is destroyed first, those volumes are orphaned and keep billing.
set -euo pipefail

STACK=kirocrew-eks-poc
REGION=us-east-1

cd "$(dirname "$0")/.."

echo "Deleting user namespaces (releases the EBS volumes)..."
for ns in $(kubectl get ns -l kirocrew.io/user -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
  kubectl delete ns "$ns" --wait=true --timeout=300s
done

echo "Destroying the CDK stack..."
npx cdk destroy "$STACK" --force

echo "Checking for leftover volumes tagged to this cluster..."
aws ec2 describe-volumes --region "$REGION" \
  --filters "Name=tag:kubernetes.io/cluster/$STACK,Values=owned" \
  --query 'Volumes[].[VolumeId,State,Size]' --output text
echo "(an empty list above means nothing is left behind)"

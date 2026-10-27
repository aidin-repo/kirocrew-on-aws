#!/usr/bin/env bash
# Isolation and wiring checks for Option B. Read-only: it never prints, mints or reads a dashboard token.
#
#   scripts/smoke-test.sh [user-a] [user-b]      # defaults: alice bob
#
# Needs: kubectl pointed at the cluster (see the UpdateKubeconfig stack output), curl.
set -uo pipefail

A="${1:-alice}"
B="${2:-bob}"
PASS=0
FAIL=0

check() {  # check <description> <expected: ok|fail> <command...>
  local desc="$1" want="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then got=ok; else got=fail; fi
  if [[ "$got" == "$want" ]]; then
    printf '\033[32m PASS \033[0m %s\n' "$desc"; PASS=$((PASS + 1))
  else
    printf '\033[31m FAIL \033[0m %s (wanted %s, got %s)\n' "$desc" "$want" "$got"; FAIL=$((FAIL + 1))
  fi
}

podip() { kubectl -n "user-$1" get pod kirocrew-0 -o jsonpath='{.status.podIP}'; }
ex()    { kubectl -n "user-$1" exec kirocrew-0 -c "$2" -- "${@:3}"; }

echo "== Pods"
for u in "$A" "$B"; do
  check "user-$u: pod kirocrew-0 is Ready (gateway, auth-proxy, edge)" ok \
    kubectl -n "user-$u" wait --for=condition=Ready pod/kirocrew-0 --timeout=60s
done

IPA=$(podip "$A"); IPB=$(podip "$B")
echo "   $A pod $IPA   $B pod $IPB"

echo "== The gateway is not reachable from the network"
check "$A gateway port 5476 refuses connections on the pod IP (loopback bind)" fail \
  ex "$A" gateway curl -sS --max-time 4 "http://$IPA:5476/api/health"
check "$A gateway answers on its own loopback" ok \
  ex "$A" gateway curl -fsS --max-time 4 "http://127.0.0.1:5476/api/ready"

echo "== Tenant isolation (NetworkPolicy)"
check "$A cannot reach $B's edge ($IPB:8080)" fail \
  ex "$A" gateway curl -sS --max-time 5 "http://$IPB:8080/healthz"
check "$B cannot reach $A's edge ($IPA:8080)" fail \
  ex "$B" gateway curl -sS --max-time 5 "http://$IPA:8080/healthz"
check "$A cannot reach the node metadata service" fail \
  ex "$A" gateway curl -sS --max-time 4 http://169.254.169.254/latest/meta-data/
check "$A can still reach the public internet" ok \
  ex "$A" gateway curl -fsS --max-time 8 -o /dev/null https://example.com

echo "== Front door"
check "positive control: $A's own pod IP serves the edge (so the cross-tenant failures above are the policy)" ok \
  ex "$A" gateway curl -fsS --max-time 5 "http://$IPA:8080/healthz"
check "unauthenticated request to the dashboard is redirected to sign-in (302), not served" ok bash -c \
  "[[ \"\$(kubectl -n user-$A exec kirocrew-0 -c gateway -- curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://$IPA:8080/)\" == 302 ]]"
check "unauthenticated request to the API is not served either (302)" ok bash -c \
  "[[ \"\$(kubectl -n user-$A exec kirocrew-0 -c gateway -- curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://$IPA:8080/api/sessions)\" == 302 ]]"

echo "== Agent sandbox on this node type (kirocrew doctor, Sandbox section)"
kubectl -n "user-$A" exec kirocrew-0 -c gateway -- kirocrew doctor 2>/dev/null | grep -A1 -E "^Sandbox" | head -3 || true
check "sandbox backend is 'namespace' (Crew's user-namespace sandbox works, no opt-out needed)" ok bash -c \
  "kubectl -n user-$A exec kirocrew-0 -c gateway -- kirocrew doctor 2>/dev/null | grep -E 'backend:' | grep -q namespace"

echo
echo "passed: $PASS   failed: $FAIL"
[[ $FAIL -eq 0 ]]

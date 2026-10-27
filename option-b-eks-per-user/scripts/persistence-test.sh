#!/usr/bin/env bash
# Proves a user's data home survives the pod being deleted and recreated.
# It deletes ONE pod (the user's volume stays), so run it deliberately.
#
#   scripts/persistence-test.sh [user]        # default: alice
set -euo pipefail

U="${1:-alice}"
NS="user-$U"
MARK="persisted-$(date +%s)"

kubectl -n "$NS" exec kirocrew-0 -c gateway -- sh -c "echo $MARK > /home/kirocrew/.persistence-marker"
OLD=$(kubectl -n "$NS" get pod kirocrew-0 -o jsonpath='{.metadata.uid}')
kubectl -n "$NS" delete pod kirocrew-0 --wait=true --timeout=180s >/dev/null

for _ in $(seq 1 60); do
  NEW=$(kubectl -n "$NS" get pod kirocrew-0 -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
  READY=$(kubectl -n "$NS" get pod kirocrew-0 -o jsonpath='{.status.containerStatuses[?(@.name=="edge")].ready}' 2>/dev/null || true)
  [[ -n "$NEW" && "$NEW" != "$OLD" && "$READY" == "true" ]] && break
  sleep 8
done
[[ "${NEW:-}" != "$OLD" ]] || { echo "FAIL  the pod was not replaced"; exit 1; }

GOT=$(kubectl -n "$NS" exec kirocrew-0 -c gateway -- cat /home/kirocrew/.persistence-marker)
kubectl -n "$NS" exec kirocrew-0 -c gateway -- rm -f /home/kirocrew/.persistence-marker
if [[ "$GOT" == "$MARK" ]]; then
  echo "PASS  data written before the pod was deleted is present in the replacement pod"
else
  echo "FAIL  expected '$MARK', found '$GOT'"; exit 1
fi

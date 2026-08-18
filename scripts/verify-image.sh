#!/usr/bin/env bash
# Resolve ghcr.io/kirodotdev/kirocrew to an immutable digest and verify its SLSA
# build provenance.
#
#   scripts/verify-image.sh [tag]        # default: stable
#
# Prints the multi-arch index digest to stdout on success, so it can be captured:
#   DIGEST=$(scripts/verify-image.sh stable)
#
# Requires: gh (authenticated), curl, python3. Docker is NOT required.
set -euo pipefail

TAG="${1:-stable}"
IMAGE=ghcr.io/kirodotdev/kirocrew
REPO=kirodotdev/KiroCrew

log() { printf '%s\n' "$*" >&2; }
die() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

command -v gh      >/dev/null || die "gh not found"
command -v curl    >/dev/null || die "curl not found"
command -v python3 >/dev/null || die "python3 not found"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated: run 'gh auth login'"

# ------------------------------------------------------------ resolve digest
# Straight to the registry API. Anonymous pull tokens are enough for a public
# package, and this avoids needing a container runtime on the operator's machine.
log "resolving $IMAGE:$TAG ..."
TOKEN=$(curl -fsS "https://ghcr.io/token?scope=repository:kirodotdev/kirocrew:pull&service=ghcr.io" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])') \
        || die "could not obtain an anonymous pull token from ghcr.io"

HDR=$(mktemp); MAN=$(mktemp)
trap 'rm -f "$HDR" "$MAN"' EXIT

curl -fsS -D "$HDR" -o "$MAN" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://ghcr.io/v2/kirodotdev/kirocrew/manifests/$TAG" \
  || die "could not fetch the manifest for tag '$TAG'"

DIGEST=$(grep -i '^docker-content-digest:' "$HDR" | tr -d '\r' | awk '{print $2}')
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "no usable digest in the registry response"

log ""
log "index digest   $DIGEST"
python3 - "$MAN" <<'PY' >&2
import json,sys
m=json.load(open(sys.argv[1]))
for x in m.get("manifests",[]):
    p=x.get("platform",{})
    if p.get("architecture") in ("amd64","arm64"):
        log=f'  {p.get("os")}/{p.get("architecture"):<6} {x["digest"]}'
        print(log)
PY
log ""
log "Pin the INDEX digest above, not a per-architecture digest, so one value"
log "works on Graviton and x86 alike."
log ""

# -------------------------------------------------------- verify provenance
# Two traps, both encountered for real:
#   1. On a machine that once had Docker Desktop, gh reads ~/.docker/config.json,
#      finds credsStore=desktop, and dies with
#      'docker-credential-desktop: executable file not found'. An isolated empty
#      config bypasses the stale helper.
#   2. In default output format the command prints NOTHING on success, so the
#      exit status is the only signal. Empty output is not evidence either way.
log "verifying SLSA provenance against $REPO ..."
TMPCFG=$(mktemp -d); printf '{}' > "$TMPCFG/config.json"
trap 'rm -f "$HDR" "$MAN"; rm -rf "$TMPCFG"' EXIT

if DOCKER_CONFIG="$TMPCFG" gh attestation verify \
     "oci://${IMAGE}@${DIGEST}" --repo "$REPO" --format json > "$TMPCFG/att.json" 2>"$TMPCFG/err"; then
  COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$TMPCFG/att.json" 2>/dev/null || echo 0)
  [[ "$COUNT" -ge 1 ]] || die "verify exited 0 but returned no attestations; treat as unverified"
  log "provenance verified: $COUNT attestation(s) from $REPO"
else
  log "--- gh stderr ---"; cat "$TMPCFG/err" >&2
  die "provenance verification FAILED for $DIGEST"
fi

# The digest is the only thing on stdout, so this script composes.
printf '%s\n' "$DIGEST"

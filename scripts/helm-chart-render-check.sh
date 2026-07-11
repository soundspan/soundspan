#!/usr/bin/env bash
set -euo pipefail

CHART_PATH="${1:-charts/soundspan}"
RELEASE_NAME="${2:-soundspan}"

if ! command -v helm >/dev/null 2>&1; then
  echo "[ERROR] helm is required but not found in PATH" >&2
  exit 1
fi

if command -v rg >/dev/null 2>&1; then
  line_match() {
    local pattern="$1"
    local file="$2"
    rg -q "$pattern" "$file"
  }
else
  line_match() {
    local pattern="$1"
    local file="$2"
    grep -Eq "$pattern" "$file"
  }
fi

tmp_aio="$(mktemp)"
tmp_individual_ha="$(mktemp)"
tmp_global_env="$(mktemp)"
tmp_sidecars="$(mktemp)"
tmp_secret="$(mktemp)"
tmp_secret_explicit="$(mktemp)"
tmp_secret_existing="$(mktemp)"
trap 'rm -f "$tmp_aio" "$tmp_individual_ha" "$tmp_global_env" "$tmp_sidecars" "$tmp_secret" "$tmp_secret_explicit" "$tmp_secret_existing"' EXIT

echo "[CHECK] helm lint (${CHART_PATH})"
helm lint "$CHART_PATH"

echo "[CHECK] render default AIO mode"
helm template "$RELEASE_NAME" "$CHART_PATH" >"$tmp_aio"
if ! line_match '^kind: Deployment$' "$tmp_aio"; then
  echo "[ERROR] AIO render missing Deployment resource" >&2
  exit 1
fi
if ! line_match '^  name: '"$RELEASE_NAME"'$' "$tmp_aio"; then
  echo "[ERROR] AIO render missing expected deployment name: ${RELEASE_NAME}" >&2
  exit 1
fi

echo "[CHECK] render HA individual mode with worker split"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set haMode.enabled=true \
  --set backendWorker.enabled=true \
  >"$tmp_individual_ha"

if ! line_match '^  name: '"$RELEASE_NAME"'-backend$' "$tmp_individual_ha"; then
  echo "[ERROR] Individual HA render missing backend deployment" >&2
  exit 1
fi
if ! line_match '^  name: '"$RELEASE_NAME"'-backend-worker$' "$tmp_individual_ha"; then
  echo "[ERROR] Individual HA render missing backend-worker deployment" >&2
  exit 1
fi
if ! perl -0777 -ne 'exit((/name:\s+BACKEND_PROCESS_ROLE\s+value:\s+"api"/s && /name:\s+BACKEND_PROCESS_ROLE\s+value:\s+"worker"/s) ? 0 : 1)' "$tmp_individual_ha"; then
  echo "[ERROR] Individual HA render missing expected BACKEND_PROCESS_ROLE env values (api + worker)" >&2
  exit 1
fi
if ! perl -0777 -ne 'exit((/name:\s+LISTEN_TOGETHER_STATE_STORE_ENABLED\s+value:\s+"true"/s) ? 0 : 1)' "$tmp_individual_ha"; then
  echo "[ERROR] Individual HA render missing LISTEN_TOGETHER_STATE_STORE_ENABLED=true" >&2
  exit 1
fi

echo "[CHECK] render global.env config map + envFrom wiring"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set global.env.TEST_FLAG=1 \
  >"$tmp_global_env"

if ! line_match '^kind: ConfigMap$' "$tmp_global_env"; then
  echo "[ERROR] global.env render missing ConfigMap resource" >&2
  exit 1
fi
if ! line_match '^  name: '"$RELEASE_NAME"'-global-env$' "$tmp_global_env"; then
  echo "[ERROR] global.env render missing expected ConfigMap name" >&2
  exit 1
fi
if ! line_match '^  TEST_FLAG: "1"$' "$tmp_global_env"; then
  echo "[ERROR] global.env render missing TEST_FLAG value" >&2
  exit 1
fi
if ! perl -0777 -ne 'exit((/configMapRef:\s+name:\s+soundspan-global-env/s) ? 0 : 1)' "$tmp_global_env"; then
  echo "[ERROR] global.env render missing envFrom configMapRef wiring" >&2
  exit 1
fi

# Sidecar auth (F31): the default renders never enable the HTTP sidecars, so
# without this check the tidal/ytmusic templates are never exercised at all.
# Both must consume INTERNAL_API_SECRET from the chart-managed Secret
# (soundspan.secretName -> fullname, i.e. the release name by default).
echo "[CHECK] render HTTP sidecars with INTERNAL_API_SECRET secretKeyRef"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set tidalSidecar.enabled=true \
  --set ytmusicStreamer.enabled=true \
  >"$tmp_sidecars"

for sidecar in tidal ytmusic; do
  if ! line_match '^  name: '"$RELEASE_NAME"'-'"$sidecar"'$' "$tmp_sidecars"; then
    echo "[ERROR] sidecar render missing ${sidecar} deployment/service resources" >&2
    exit 1
  fi
  if ! perl -0777 -ne '
      for my $doc (split /^---/m, $_) {
          next unless $doc =~ /kind:\s*Deployment/;
          next unless $doc =~ /^  name: '"$RELEASE_NAME"'-'"$sidecar"'$/m;
          exit 0 if $doc =~ /name:\s+INTERNAL_API_SECRET\s+valueFrom:\s+secretKeyRef:\s+name:\s+'"$RELEASE_NAME"'\s+key:\s+INTERNAL_API_SECRET/s;
      }
      exit 1' "$tmp_sidecars"; then
    echo "[ERROR] ${sidecar} sidecar Deployment missing INTERNAL_API_SECRET secretKeyRef (name: ${RELEASE_NAME}, key: INTERNAL_API_SECRET)" >&2
    exit 1
  fi
done

# Secret generation (F22): the stable-lookup template must still render a
# complete Secret on first install / dry-run (where `lookup` returns nil and the
# chain falls back to generation), honor explicit secrets.*, and stay skipped
# when an external existingSecret is referenced. The lookup-reuse-on-upgrade
# behavior itself requires a live cluster (server-side `lookup`) and is verified
# out-of-band per docs/UPGRADING.md; here we guard the client-renderable paths.
echo "[CHECK] render default Secret has all generated keys"
helm template "$RELEASE_NAME" "$CHART_PATH" >"$tmp_secret"
for key in SESSION_SECRET SETTINGS_ENCRYPTION_KEY INTERNAL_API_SECRET POSTGRES_PASSWORD; do
  if ! perl -0777 -ne 'exit((/'"$key"':\s+"[^"]+"/s) ? 0 : 1)' "$tmp_secret"; then
    echo "[ERROR] default Secret render missing non-empty ${key}" >&2
    exit 1
  fi
done

echo "[CHECK] explicit secrets.* values are honored"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set secrets.sessionSecret=fixed-session-value \
  >"$tmp_secret_explicit"
if ! line_match '^  SESSION_SECRET: "fixed-session-value"$' "$tmp_secret_explicit"; then
  echo "[ERROR] explicit secrets.sessionSecret not honored in Secret render" >&2
  exit 1
fi

echo "[CHECK] existingSecret suppresses the managed Secret"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set secrets.existingSecret=external-secret \
  >"$tmp_secret_existing"
if line_match '^kind: Secret$' "$tmp_secret_existing"; then
  echo "[ERROR] existingSecret set but chart still rendered a managed Secret" >&2
  exit 1
fi

echo "[OK] Helm render checks passed"

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

assert_service_selectors_isolated() {
  local render_name="$1"
  local manifest_file="$2"
  local checker="${BASH_SOURCE[0]%/*}/ci/helm-service-selector-check.mjs"

  if ! node "$checker" "$manifest_file"; then
    echo "[ERROR] Service selector isolation failed (${render_name})" >&2
    exit 1
  fi
}

assert_database_urls() {
  local mode="$1"
  local manifest_file="$2"
  shift 2
  local checker="${BASH_SOURCE[0]%/*}/ci/helm-database-url-check.mjs"

  if ! node "$checker" "$mode" "$manifest_file" "$@"; then
    echo "[ERROR] DATABASE_URL check failed (${mode})" >&2
    exit 1
  fi
}

assert_deployment_image() {
  local render_name="$1"
  local manifest_file="$2"
  local deployment_name="$3"
  local expected_image="$4"

  if ! DEPLOYMENT_NAME="$deployment_name" EXPECTED_IMAGE="$expected_image" perl -0777 -ne '
      for my $doc (split /^---/m, $_) {
          next unless $doc =~ /kind:\s*Deployment/;
          next unless $doc =~ /^  name: \Q$ENV{DEPLOYMENT_NAME}\E$/m;
          exit 0 if $doc =~ /^          image: "\Q$ENV{EXPECTED_IMAGE}\E"$/m;
      }
      exit 1' "$manifest_file"; then
    echo "[ERROR] ${render_name} missing digest-bound image ${expected_image}" >&2
    exit 1
  fi
}

tmp_aio="$(mktemp)"
tmp_aio_sidecars="$(mktemp)"
tmp_aio_rotated_secrets="$(mktemp)"
tmp_aio_secret_overrides="$(mktemp)"
tmp_aio_digests="$(mktemp)"
tmp_aio_reserved_labels="$(mktemp)"
tmp_individual_ha="$(mktemp)"
tmp_individual_component_database="$(mktemp)"
tmp_individual_external_database="$(mktemp)"
tmp_individual_digests="$(mktemp)"
tmp_individual_reserved_labels="$(mktemp)"
tmp_global_env="$(mktemp)"
tmp_sidecars="$(mktemp)"
tmp_secret="$(mktemp)"
tmp_secret_explicit="$(mktemp)"
tmp_secret_existing="$(mktemp)"
tmp_frontend_uid="$(mktemp)"
trap 'rm -f "$tmp_aio" "$tmp_aio_sidecars" "$tmp_aio_rotated_secrets" "$tmp_aio_secret_overrides" "$tmp_aio_digests" "$tmp_aio_reserved_labels" "$tmp_individual_ha" "$tmp_individual_component_database" "$tmp_individual_external_database" "$tmp_individual_digests" "$tmp_individual_reserved_labels" "$tmp_global_env" "$tmp_sidecars" "$tmp_secret" "$tmp_secret_explicit" "$tmp_secret_existing" "$tmp_frontend_uid"' EXIT

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
assert_service_selectors_isolated "default AIO" "$tmp_aio"

echo "[CHECK] reserved selector labels override global labels in AIO mode"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set-string 'global.labels.app\.kubernetes\.io/name=user-name' \
  --set-string 'global.labels.app\.kubernetes\.io/instance=user-instance' \
  --set-string 'global.labels.app\.kubernetes\.io/component=user-component' \
  >"$tmp_aio_reserved_labels"
assert_service_selectors_isolated "AIO with reserved global labels" "$tmp_aio_reserved_labels"

for key in INTERNAL_API_SECRET POSTGRES_PASSWORD; do
  if ! perl -0777 -ne '
      for my $doc (split /^---/m, $_) {
          next unless $doc =~ /kind:\s*Deployment/;
          next unless $doc =~ /^  name: '"$RELEASE_NAME"'$/m;
          exit 0 if $doc =~ /name:\s+'"$key"'\s+valueFrom:\s+secretKeyRef:\s+name:\s+'"$RELEASE_NAME"'\s+key:\s+'"$key"'/s;
      }
      exit 1' "$tmp_aio"; then
    echo "[ERROR] AIO Deployment missing ${key} secretKeyRef" >&2
    exit 1
  fi
done

echo "[CHECK] render AIO secret rotations with optional HTTP sidecars"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set secrets.internalApiSecret=rotated-internal-secret \
  --set secrets.postgresPassword=rotated-postgres-password \
  --set tidalSidecar.enabled=true \
  --set ytmusicStreamer.enabled=true \
  >"$tmp_aio_rotated_secrets"

for expected_secret in \
  'INTERNAL_API_SECRET: "rotated-internal-secret"' \
  'POSTGRES_PASSWORD: "rotated-postgres-password"'; do
  if ! line_match "^  ${expected_secret}$" "$tmp_aio_rotated_secrets"; then
    echo "[ERROR] explicit Secret rotation missing ${expected_secret}" >&2
    exit 1
  fi
done
for deployment in "$RELEASE_NAME" "${RELEASE_NAME}-tidal" "${RELEASE_NAME}-ytmusic"; do
  if ! DEPLOYMENT_NAME="$deployment" SECRET_NAME="$RELEASE_NAME" perl -0777 -ne '
      for my $doc (split /^---/m, $_) {
          next unless $doc =~ /kind:\s*Deployment/;
          next unless $doc =~ /^  name: \Q$ENV{DEPLOYMENT_NAME}\E$/m;
          exit 0 if $doc =~ /name:\s+INTERNAL_API_SECRET\s+valueFrom:\s+secretKeyRef:\s+name:\s+\Q$ENV{SECRET_NAME}\E\s+key:\s+INTERNAL_API_SECRET/s;
      }
      exit 1' "$tmp_aio_rotated_secrets"; then
    echo "[ERROR] ${deployment} does not consume the rotated chart INTERNAL_API_SECRET" >&2
    exit 1
  fi
done

echo "[CHECK] render explicit AIO secret env overrides"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set aio.env.INTERNAL_API_SECRET=aio-internal-override \
  --set aio.env.POSTGRES_PASSWORD=aio-postgres-override \
  >"$tmp_aio_secret_overrides"

for expected_override in \
  'INTERNAL_API_SECRET\s+value:\s+"aio-internal-override"' \
  'POSTGRES_PASSWORD\s+value:\s+"aio-postgres-override"'; do
  if ! perl -0777 -ne 'exit(/name:\s+'"$expected_override"'/s ? 0 : 1)' "$tmp_aio_secret_overrides"; then
    echo "[ERROR] AIO explicit env override missing for ${expected_override%%\\*}" >&2
    exit 1
  fi
done
if ! perl -0777 -ne '
    for my $doc (split /^---/m, $_) {
        next unless $doc =~ /kind:\s*Deployment/;
        next unless $doc =~ /^  name: '"$RELEASE_NAME"'$/m;
        exit 0 if $doc !~ /name:\s+(?:INTERNAL_API_SECRET|POSTGRES_PASSWORD)\s+valueFrom:/s;
    }
    exit 1' "$tmp_aio_secret_overrides"; then
  echo "[ERROR] AIO explicit secret env overrides rendered duplicate secretKeyRefs" >&2
  exit 1
fi

echo "[CHECK] render AIO mode with HTTP sidecars for Service selector isolation"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set tidalSidecar.enabled=true \
  --set ytmusicStreamer.enabled=true \
  >"$tmp_aio_sidecars"
assert_service_selectors_isolated "AIO with HTTP sidecars" "$tmp_aio_sidecars"

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
assert_service_selectors_isolated "HA individual" "$tmp_individual_ha"

echo "[CHECK] reserved selector labels override global labels in individual mode"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set backendWorker.enabled=true \
  --set tidalSidecar.enabled=true \
  --set ytmusicStreamer.enabled=true \
  --set audioAnalyzer.enabled=true \
  --set audioAnalyzerClap.enabled=true \
  --set-string 'global.labels.app\.kubernetes\.io/name=user-name' \
  --set-string 'global.labels.app\.kubernetes\.io/instance=user-instance' \
  --set-string 'global.labels.app\.kubernetes\.io/component=user-component' \
  >"$tmp_individual_reserved_labels"
assert_service_selectors_isolated "individual with reserved global labels" "$tmp_individual_reserved_labels"

echo "[CHECK] construct component DATABASE_URL values with percent-encoded credentials"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set-string secrets.postgresUser='user@tenant' \
  --set-string secrets.postgresPassword='p@ss:w/rd' \
  --set backendWorker.enabled=true \
  --set audioAnalyzer.enabled=true \
  --set audioAnalyzerClap.enabled=true \
  >"$tmp_individual_component_database"

if ! line_match '^  POSTGRES_PASSWORD: "p@ss:w/rd"$' "$tmp_individual_component_database"; then
  echo "[ERROR] component database render did not preserve the reserved-character Secret value" >&2
  exit 1
fi
POSTGRES_USER='user@tenant' \
  POSTGRES_PASSWORD='p@ss:w/rd' \
  POSTGRES_DB='soundspan' \
  assert_database_urls \
  component \
  "$tmp_individual_component_database" \
  "${RELEASE_NAME}-backend" \
  "${RELEASE_NAME}-backend-worker" \
  "${RELEASE_NAME}-audio-analyzer" \
  "${RELEASE_NAME}-audio-analyzer-clap"

echo "[CHECK] preserve external DATABASE_URL across individual workloads"
external_database_url='postgresql://external-user:literal%2Fpassword@database.example.com:5432/soundspan?sslmode=require'
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set-string postgresql.external.url="$external_database_url" \
  --set secrets.existingSecret=core-only-secret \
  --set backendWorker.enabled=true \
  --set audioAnalyzer.enabled=true \
  --set audioAnalyzerClap.enabled=true \
  >"$tmp_individual_external_database"

EXPECTED_DATABASE_URL="$external_database_url" assert_database_urls \
  external \
  "$tmp_individual_external_database" \
  "${RELEASE_NAME}-backend" \
  "${RELEASE_NAME}-backend-worker" \
  "${RELEASE_NAME}-audio-analyzer" \
  "${RELEASE_NAME}-audio-analyzer-clap"

digest_aio="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
digest_backend="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
digest_worker="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
digest_frontend="sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
digest_tidal="sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
digest_ytmusic="sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
digest_analyzer="sha256:1111111111111111111111111111111111111111111111111111111111111111"
digest_clap="sha256:2222222222222222222222222222222222222222222222222222222222222222"

echo "[CHECK] render AIO application image by digest"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set aio.image.digest="$digest_aio" \
  >"$tmp_aio_digests"
assert_deployment_image \
  "AIO Deployment" \
  "$tmp_aio_digests" \
  "$RELEASE_NAME" \
  "ghcr.io/soundspan/soundspan@${digest_aio}"

echo "[CHECK] render every individual application image by digest"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set backendWorker.enabled=true \
  --set tidalSidecar.enabled=true \
  --set ytmusicStreamer.enabled=true \
  --set audioAnalyzer.enabled=true \
  --set audioAnalyzerClap.enabled=true \
  --set backend.image.digest="$digest_backend" \
  --set backendWorker.image.digest="$digest_worker" \
  --set frontend.image.digest="$digest_frontend" \
  --set tidalSidecar.image.digest="$digest_tidal" \
  --set ytmusicStreamer.image.digest="$digest_ytmusic" \
  --set audioAnalyzer.image.digest="$digest_analyzer" \
  --set audioAnalyzerClap.image.digest="$digest_clap" \
  >"$tmp_individual_digests"

assert_deployment_image "backend Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-backend" "ghcr.io/soundspan/soundspan-backend@${digest_backend}"
assert_deployment_image "backend-worker Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-backend-worker" "ghcr.io/soundspan/soundspan-backend-worker@${digest_worker}"
assert_deployment_image "frontend Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-frontend" "ghcr.io/soundspan/soundspan-frontend@${digest_frontend}"
assert_deployment_image "TIDAL Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-tidal" "ghcr.io/soundspan/soundspan-tidal-downloader@${digest_tidal}"
assert_deployment_image "YT Music Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-ytmusic" "ghcr.io/soundspan/soundspan-ytmusic-streamer@${digest_ytmusic}"
assert_deployment_image "audio analyzer Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-audio-analyzer" "ghcr.io/soundspan/soundspan-audio-analyzer@${digest_analyzer}"
assert_deployment_image "CLAP analyzer Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-audio-analyzer-clap" "ghcr.io/soundspan/soundspan-audio-analyzer-clap@${digest_clap}"

echo "[CHECK] reject malformed application image digests"
if helm template "$RELEASE_NAME" "$CHART_PATH" --set aio.image.digest=sha256:not-a-digest >/dev/null 2>&1; then
  echo "[ERROR] malformed application image digest was accepted" >&2
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
assert_service_selectors_isolated "individual with HTTP sidecars" "$tmp_sidecars"

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
if ! perl -0777 -ne '
    for my $doc (split /^---/m, $_) {
        next unless $doc =~ /kind:\s*Deployment/;
        next unless $doc =~ /^  name: '"$RELEASE_NAME"'$/m;
        exit 0 if $doc =~ /name:\s+POSTGRES_PASSWORD\s+valueFrom:\s+secretKeyRef:\s+name:\s+external-secret\s+key:\s+POSTGRES_PASSWORD\s+optional:\s+true/s;
    }
    exit 1' "$tmp_secret_existing"; then
  echo "[ERROR] AIO existingSecret POSTGRES_PASSWORD reference must remain optional" >&2
  exit 1
fi

echo "[CHECK] render individual-mode frontend inherits global UID 1000 pod security context"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  >"$tmp_frontend_uid"
if ! perl -0777 -ne '
    for my $doc (split /^---/m, $_) {
        next unless $doc =~ /kind:\s*Deployment/;
        next unless $doc =~ /^  name: '"$RELEASE_NAME"'-frontend$/m;
        exit 0 if $doc =~ /runAsUser:\s+1000\b/s && $doc !~ /runAsUser:\s+1001\b/s;
    }
    exit 1' "$tmp_frontend_uid"; then
  echo "[ERROR] individual-mode frontend pod securityContext must render runAsUser: 1000 (inherit global; stale 1001 frontend override must be removed)" >&2
  exit 1
fi

echo "[OK] Helm render checks passed"

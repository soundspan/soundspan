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

assert_deployment_env_value() {
  local deployment_name="$1"
  local env_name="$2"
  local env_value="$3"
  local manifest_file="$4"

  if ! DEPLOYMENT_NAME="$deployment_name" ENV_NAME="$env_name" ENV_VALUE="$env_value" perl -0777 -ne '
      for my $doc (split /^---/m, $_) {
          next unless $doc =~ /kind:\s*Deployment/;
          next unless $doc =~ /^  name: \Q$ENV{DEPLOYMENT_NAME}\E$/m;
          my @keys = $doc =~ /name:\s+\Q$ENV{ENV_NAME}\E\b/sg;
          exit 0 if scalar @keys == 1
              && $doc =~ /name:\s+\Q$ENV{ENV_NAME}\E\s+value:\s+"\Q$ENV{ENV_VALUE}\E"/s;
      }
      exit 1' "$manifest_file"; then
    echo "[ERROR] ${deployment_name} missing unique ${env_name}=${env_value}" >&2
    exit 1
  fi
}

assert_deployment_env_absent() {
  local deployment_name="$1"
  local env_name="$2"
  local manifest_file="$3"

  if ! DEPLOYMENT_NAME="$deployment_name" ENV_NAME="$env_name" perl -0777 -ne '
      for my $doc (split /^---/m, $_) {
          next unless $doc =~ /kind:\s*Deployment/;
          next unless $doc =~ /^  name: \Q$ENV{DEPLOYMENT_NAME}\E$/m;
          exit 0 if $doc !~ /name:\s+\Q$ENV{ENV_NAME}\E\b/;
      }
      exit 1' "$manifest_file"; then
    echo "[ERROR] ${deployment_name} unexpectedly renders ${env_name}" >&2
    exit 1
  fi
}

assert_deployment_termination_grace() {
  local deployment_name="$1"
  local expected_seconds="$2"
  local manifest_file="$3"

  if ! DEPLOYMENT_NAME="$deployment_name" EXPECTED_SECONDS="$expected_seconds" perl -0777 -ne '
      for my $doc (split /^---/m, $_) {
          next unless $doc =~ /kind:\s*Deployment/;
          next unless $doc =~ /^  name: \Q$ENV{DEPLOYMENT_NAME}\E$/m;
          exit 0 if $doc =~ /^      terminationGracePeriodSeconds: \Q$ENV{EXPECTED_SECONDS}\E$/m;
      }
      exit 1' "$manifest_file"; then
    echo "[ERROR] ${deployment_name} missing terminationGracePeriodSeconds=${expected_seconds}" >&2
    exit 1
  fi
}

assert_template_rejected() {
  local description="$1"
  local expected_message="$2"
  shift 2
  local output

  if output="$(helm template "$RELEASE_NAME" "$CHART_PATH" "$@" 2>&1)"; then
    echo "[ERROR] ${description} was accepted" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_message"* ]]; then
    echo "[ERROR] ${description} failed without the expected message: ${expected_message}" >&2
    echo "$output" >&2
    exit 1
  fi
}

assert_oidc_env() {
  local deployment_name="$1"
  local manifest_file="$2"

  for expected in \
    'LOCAL_LOGIN_ENABLED=false' \
    'OIDC_ENABLED=true' \
    'OIDC_ISSUER_URL=https://idp.example/realms/soundspan' \
    'OIDC_CLIENT_ID=soundspan' \
    'OIDC_REDIRECT_URI=https://soundspan.example/api/auth/oidc/callback' \
    'OIDC_WEB_BASE_URL=https://music.example' \
    'OIDC_SCOPES=openid profile email groups' \
    'OIDC_AUTO_PROVISION=true' \
    'OIDC_MANAGE_ROLES=true' \
    'OIDC_GROUPS_CLAIM=groups' \
    'OIDC_ADMIN_GROUP=soundspan-admin' \
    'OIDC_EMAIL_CLAIM=email' \
    'OIDC_NAME_CLAIM=name' \
    'OIDC_PROVIDER_NAME=Company SSO'; do
    env_name="${expected%%=*}"
    env_value="${expected#*=}"
    if ! DEPLOYMENT_NAME="$deployment_name" ENV_NAME="$env_name" ENV_VALUE="$env_value" perl -0777 -ne '
        for my $doc (split /^---/m, $_) {
            next unless $doc =~ /kind:\s*Deployment/;
            next unless $doc =~ /^  name: \Q$ENV{DEPLOYMENT_NAME}\E$/m;
            exit 0 if $doc =~ /name:\s+\Q$ENV{ENV_NAME}\E\s+value:\s+"\Q$ENV{ENV_VALUE}\E"/s;
        }
        exit 1' "$manifest_file"; then
      echo "[ERROR] ${deployment_name} missing ${env_name}=${env_value}" >&2
      exit 1
    fi
  done

  if ! DEPLOYMENT_NAME="$deployment_name" SECRET_NAME="$RELEASE_NAME" perl -0777 -ne '
      for my $doc (split /^---/m, $_) {
          next unless $doc =~ /kind:\s*Deployment/;
          next unless $doc =~ /^  name: \Q$ENV{DEPLOYMENT_NAME}\E$/m;
          exit 0 if $doc =~ /name:\s+OIDC_CLIENT_SECRET\s+valueFrom:\s+secretKeyRef:\s+name:\s+\Q$ENV{SECRET_NAME}\E\s+key:\s+OIDC_CLIENT_SECRET/s;
      }
      exit 1' "$manifest_file"; then
    echo "[ERROR] ${deployment_name} missing OIDC_CLIENT_SECRET secretKeyRef" >&2
    exit 1
  fi
}

tmp_aio="$(mktemp)"
tmp_aio_sidecars="$(mktemp)"
tmp_aio_rotated_secrets="$(mktemp)"
tmp_aio_secret_overrides="$(mktemp)"
tmp_aio_oidc="$(mktemp)"
tmp_aio_digests="$(mktemp)"
tmp_aio_reserved_labels="$(mktemp)"
tmp_individual_ha="$(mktemp)"
tmp_individual_component_database="$(mktemp)"
tmp_individual_external_database="$(mktemp)"
tmp_individual_digests="$(mktemp)"
tmp_individual_reserved_labels="$(mktemp)"
tmp_individual_oidc="$(mktemp)"
tmp_individual_notes="$(mktemp)"
tmp_global_env="$(mktemp)"
tmp_sidecars="$(mktemp)"
tmp_dclap_default="$(mktemp)"
tmp_dclap_aio="$(mktemp)"
tmp_dclap_enabled="$(mktemp)"
tmp_dclap_override="$(mktemp)"
tmp_dclap_scaled="$(mktemp)"
tmp_secret="$(mktemp)"
tmp_secret_explicit="$(mktemp)"
tmp_secret_existing="$(mktemp)"
tmp_frontend_uid="$(mktemp)"
tmp_metrics="$(mktemp)"
trap 'rm -f "$tmp_aio" "$tmp_aio_sidecars" "$tmp_aio_rotated_secrets" "$tmp_aio_secret_overrides" "$tmp_aio_oidc" "$tmp_aio_digests" "$tmp_aio_reserved_labels" "$tmp_individual_ha" "$tmp_individual_component_database" "$tmp_individual_external_database" "$tmp_individual_digests" "$tmp_individual_reserved_labels" "$tmp_individual_oidc" "$tmp_individual_notes" "$tmp_global_env" "$tmp_sidecars" "$tmp_dclap_default" "$tmp_dclap_aio" "$tmp_dclap_enabled" "$tmp_dclap_override" "$tmp_dclap_scaled" "$tmp_secret" "$tmp_secret_explicit" "$tmp_secret_existing" "$tmp_frontend_uid" "$tmp_metrics"' EXIT

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
assert_deployment_env_absent "$RELEASE_NAME" "CLAP_REDIS_SOCKET_TIMEOUT" "$tmp_aio"
if line_match '^kind: ServiceMonitor$' "$tmp_aio"; then
  echo "[ERROR] ServiceMonitor must be disabled by default" >&2
  exit 1
fi

echo "[CHECK] render AIO metrics ServiceMonitor with bearer credentials"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set metrics.serviceMonitor.enabled=true \
  >"$tmp_metrics"
if [ "$(rg -c '^kind: ServiceMonitor$' "$tmp_metrics")" -ne 1 ]; then
  echo "[ERROR] AIO metrics render must include one ServiceMonitor" >&2
  exit 1
fi
if ! line_match '^    - port: metrics$' "$tmp_metrics"; then
  echo "[ERROR] AIO metrics render missing the named Service port" >&2
  exit 1
fi

echo "[CHECK] render individual metrics ServiceMonitors with bearer credentials"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set backendWorker.enabled=true \
  --set metrics.serviceMonitor.enabled=true \
  >"$tmp_metrics"
if [ "$(rg -c '^kind: ServiceMonitor$' "$tmp_metrics")" -ne 2 ]; then
  echo "[ERROR] metrics render must include backend and worker ServiceMonitors" >&2
  exit 1
fi
if ! perl -0777 -ne 'exit((/authorization:\s+type:\s+Bearer\s+credentials:\s+name:\s+soundspan\s+key:\s+METRICS_TOKEN/s) ? 0 : 1)' "$tmp_metrics"; then
  echo "[ERROR] ServiceMonitor missing METRICS_TOKEN bearer credentials" >&2
  exit 1
fi

echo "[CHECK] render OIDC configuration in AIO and individual backend modes"
for oidc_mode in aio individual; do
  oidc_output="$tmp_aio_oidc"
  oidc_deployment="$RELEASE_NAME"
  oidc_mode_args=()
  if [ "$oidc_mode" = "individual" ]; then
    oidc_output="$tmp_individual_oidc"
    oidc_deployment="${RELEASE_NAME}-backend"
    oidc_mode_args=(--set deploymentMode=individual)
  fi
  helm template "$RELEASE_NAME" "$CHART_PATH" \
    "${oidc_mode_args[@]}" \
    --set config.localLoginEnabled=false \
    --set config.oidc.enabled=true \
    --set-string config.oidc.issuerUrl=https://idp.example/realms/soundspan \
    --set-string config.oidc.clientId=soundspan \
    --set-string config.oidc.redirectUri=https://soundspan.example/api/auth/oidc/callback \
    --set-string config.oidc.webBaseUrl=https://music.example \
    --set-string 'config.oidc.scopes=openid profile email groups' \
    --set config.oidc.autoProvision=true \
    --set config.oidc.manageRoles=true \
    --set-string config.oidc.groupsClaim=groups \
    --set-string config.oidc.adminGroup=soundspan-admin \
    --set-string config.oidc.emailClaim=email \
    --set-string config.oidc.nameClaim=name \
    --set-string 'config.oidc.providerName=Company SSO' \
    --set-string secrets.oidcClientSecret=oidc-client-secret \
    >"$oidc_output"
  assert_oidc_env "$oidc_deployment" "$oidc_output"
  if ! line_match '^  OIDC_CLIENT_SECRET: "oidc-client-secret"$' "$oidc_output"; then
    echo "[ERROR] ${oidc_mode} render missing OIDC_CLIENT_SECRET in Secret" >&2
    exit 1
  fi
done

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
  --set vibeProviderDclap.enabled=true \
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
  "${RELEASE_NAME}-audio-analyzer"

echo "[CHECK] preserve external DATABASE_URL across individual workloads"
external_database_url='postgresql://external-user:literal%2Fpassword@database.example.com:5432/soundspan?sslmode=require'
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set-string postgresql.external.url="$external_database_url" \
  --set secrets.existingSecret=core-only-secret \
  --set backendWorker.enabled=true \
  --set audioAnalyzer.enabled=true \
  >"$tmp_individual_external_database"

EXPECTED_DATABASE_URL="$external_database_url" assert_database_urls \
  external \
  "$tmp_individual_external_database" \
  "${RELEASE_NAME}-backend" \
  "${RELEASE_NAME}-backend-worker" \
  "${RELEASE_NAME}-audio-analyzer"

digest_aio="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
digest_backend="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
digest_worker="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
digest_frontend="sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
digest_tidal="sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
digest_ytmusic="sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
digest_analyzer="sha256:1111111111111111111111111111111111111111111111111111111111111111"
digest_dclap="sha256:3333333333333333333333333333333333333333333333333333333333333333"

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
  --set vibeProviderDclap.enabled=true \
  --set backend.image.digest="$digest_backend" \
  --set backendWorker.image.digest="$digest_worker" \
  --set frontend.image.digest="$digest_frontend" \
  --set tidalSidecar.image.digest="$digest_tidal" \
  --set ytmusicStreamer.image.digest="$digest_ytmusic" \
  --set audioAnalyzer.image.digest="$digest_analyzer" \
  --set vibeProviderDclap.image.digest="$digest_dclap" \
  >"$tmp_individual_digests"

assert_deployment_image "backend Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-backend" "ghcr.io/soundspan/soundspan-backend@${digest_backend}"
assert_deployment_image "backend-worker Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-backend-worker" "ghcr.io/soundspan/soundspan-backend-worker@${digest_worker}"
assert_deployment_image "frontend Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-frontend" "ghcr.io/soundspan/soundspan-frontend@${digest_frontend}"
assert_deployment_image "TIDAL Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-tidal" "ghcr.io/soundspan/soundspan-tidal-streamer@${digest_tidal}"
assert_deployment_image "YT Music Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-ytmusic" "ghcr.io/soundspan/soundspan-ytmusic-streamer@${digest_ytmusic}"
assert_deployment_image "audio analyzer Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-audio-analyzer" "ghcr.io/soundspan/soundspan-audio-analyzer@${digest_analyzer}"
assert_deployment_image "DCLAP provider Deployment" "$tmp_individual_digests" "${RELEASE_NAME}-vibe-provider-dclap" "ghcr.io/soundspan/soundspan-vibe-provider-dclap@${digest_dclap}"
legacy_clap_name='audio-analyzer''-clap'
if line_match "$legacy_clap_name" "$tmp_individual_digests"; then
  echo "[ERROR] individual render references the removed CLAP analyzer" >&2
  exit 1
fi

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
assert_deployment_termination_grace "${RELEASE_NAME}-ytmusic" "30" "$tmp_sidecars"
assert_service_selectors_isolated "individual with HTTP sidecars" "$tmp_sidecars"

echo "[CHECK] render default-off DCLAP provider in individual mode"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  >"$tmp_dclap_default"
if line_match '^  name: '"$RELEASE_NAME"'-vibe-provider-dclap$' "$tmp_dclap_default"; then
  echo "[ERROR] DCLAP provider must be disabled by default" >&2
  exit 1
fi
assert_deployment_env_absent "${RELEASE_NAME}-backend" "VIBE_PROVIDER_URL" "$tmp_dclap_default"

echo "[CHECK] render default backend-worker vibe concurrency"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set backendWorker.enabled=true \
  >"$tmp_dclap_default"
assert_deployment_env_value "${RELEASE_NAME}-backend-worker" "VIBE_EMBED_CONCURRENCY" "2" "$tmp_dclap_default"

echo "[CHECK] explain inactive vibe similarity in individual-mode notes"
helm install "$RELEASE_NAME" "$CHART_PATH" \
  --dry-run=client \
  --set deploymentMode=individual \
  >"$tmp_individual_notes"
if ! line_match 'Vibe similarity: Inactive — set vibeProviderDclap.enabled=true to deploy the embedding provider.' "$tmp_individual_notes"; then
  echo "[ERROR] individual-mode notes missing inactive vibe similarity guidance" >&2
  exit 1
fi

echo "[CHECK] accept absent and explicitly null audioAnalyzerClap values"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  >"$tmp_dclap_default"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set audioAnalyzerClap=null \
  >"$tmp_dclap_default"

echo "[CHECK] reject non-null removed audioAnalyzerClap values"
assert_template_rejected \
  "removed audioAnalyzerClap values" \
  "audioAnalyzerClap values were removed; set vibeProviderDclap.enabled instead; see the 2.3.0 entry in docs/UPGRADING.md" \
  --set audioAnalyzerClap.enabled=true

echo "[CHECK] keep the DCLAP provider individual-mode-only"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set vibeProviderDclap.enabled=true \
  >"$tmp_dclap_aio"
if line_match '^  name: '"$RELEASE_NAME"'-vibe-provider-dclap$' "$tmp_dclap_aio"; then
  echo "[ERROR] DCLAP provider must not render in AIO mode" >&2
  exit 1
fi
assert_deployment_env_absent "$RELEASE_NAME" "VIBE_PROVIDER_URL" "$tmp_dclap_aio"

echo "[CHECK] render enabled DCLAP provider with automatic backend wiring"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set backendWorker.enabled=true \
  --set vibeProviderDclap.enabled=true \
  --set vibeProviderDclap.port=8199 \
  --set vibeProviderDclap.replicas=2 \
  --set-string vibeProviderDclap.env.MODEL_IDLE_TIMEOUT=600 \
  >"$tmp_dclap_enabled"

for kind in Deployment Service; do
  if ! RESOURCE_KIND="$kind" RESOURCE_NAME="${RELEASE_NAME}-vibe-provider-dclap" perl -0777 -ne '
      for my $doc (split /^---/m, $_) {
          next unless $doc =~ /^kind: \Q$ENV{RESOURCE_KIND}\E$/m;
          exit 0 if $doc =~ /^  name: \Q$ENV{RESOURCE_NAME}\E$/m;
      }
      exit 1' "$tmp_dclap_enabled"; then
    echo "[ERROR] enabled DCLAP provider missing ${kind}" >&2
    exit 1
  fi
done

dclap_url="http://${RELEASE_NAME}-vibe-provider-dclap:8199"
assert_deployment_env_value "${RELEASE_NAME}-backend" "VIBE_PROVIDER_URL" "$dclap_url" "$tmp_dclap_enabled"
assert_deployment_env_value "${RELEASE_NAME}-backend-worker" "VIBE_PROVIDER_URL" "$dclap_url" "$tmp_dclap_enabled"
assert_deployment_env_value "${RELEASE_NAME}-backend-worker" "VIBE_EMBED_CONCURRENCY" "4" "$tmp_dclap_enabled"

echo "[CHECK] size backend-worker vibe concurrency from DCLAP replicas"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set backendWorker.enabled=true \
  --set vibeProviderDclap.enabled=true \
  --set vibeProviderDclap.replicas=4 \
  >"$tmp_dclap_scaled"
assert_deployment_env_value "${RELEASE_NAME}-backend-worker" "VIBE_EMBED_CONCURRENCY" "8" "$tmp_dclap_scaled"

echo "[CHECK] honor explicit backend-worker vibe concurrency"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set backendWorker.enabled=true \
  --set vibeProviderDclap.enabled=true \
  --set vibeProviderDclap.replicas=4 \
  --set backendWorker.vibeEmbedConcurrency=3 \
  >"$tmp_dclap_override"
assert_deployment_env_value "${RELEASE_NAME}-backend-worker" "VIBE_EMBED_CONCURRENCY" "3" "$tmp_dclap_override"
assert_template_rejected \
  "backend-worker vibe concurrency above the backend cap" \
  "backendWorker.vibeEmbedConcurrency must be an integer from 1 through 32" \
  --set deploymentMode=individual \
  --set backendWorker.enabled=true \
  --set backendWorker.vibeEmbedConcurrency=33

if ! DEPLOYMENT_NAME="${RELEASE_NAME}-vibe-provider-dclap" SECRET_NAME="$RELEASE_NAME" perl -0777 -ne '
    for my $doc (split /^---/m, $_) {
        next unless $doc =~ /^kind:\s*Deployment$/m;
        next unless $doc =~ /^  name: \Q$ENV{DEPLOYMENT_NAME}\E$/m;
        exit 1 if $doc =~ /name:\s+(?:DATABASE_URL|REDIS_URL|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)\b/;
        exit 0 if $doc =~ /^  replicas:\s+2$/m
            && $doc =~ /containerPort:\s+8199\b/
            && $doc =~ /tcpSocket:\s+port:\s+http/s
            && $doc =~ /name:\s+MUSIC_PATH\s+value:\s+\/music/s
            && $doc =~ /name:\s+DCLAP_HTTP_PORT\s+value:\s+"8199"/s
            && $doc =~ /name:\s+DCLAP_ONNX_INTRA_OP_THREADS\s+value:\s+"1"/s
            && $doc =~ /name:\s+MODEL_IDLE_TIMEOUT\s+value:\s+"600"/s
            && $doc =~ /mountPath:\s+\/music\s+readOnly:\s+true/s
            && $doc =~ /limits:\s+memory:\s+2560Mi/s
            && $doc =~ /requests:\s+memory:\s+1Gi/s
            && $doc =~ /name:\s+INTERNAL_API_SECRET\s+valueFrom:\s+secretKeyRef:\s+name:\s+\Q$ENV{SECRET_NAME}\E\s+key:\s+INTERNAL_API_SECRET/s;
    }
    exit 1' "$tmp_dclap_enabled"; then
  echo "[ERROR] DCLAP provider wiring, overrides, probes, or credential isolation are invalid" >&2
  exit 1
fi
assert_service_selectors_isolated "individual with DCLAP provider" "$tmp_dclap_enabled"

echo "[CHECK] reject DCLAP_HTTP_PORT env override"
assert_template_rejected \
  "vibeProviderDclap.env.DCLAP_HTTP_PORT" \
  "set vibeProviderDclap.port instead of env.DCLAP_HTTP_PORT" \
  --set-string vibeProviderDclap.env.DCLAP_HTTP_PORT=8199

echo "[CHECK] preserve explicit backend VIBE_PROVIDER_URL override"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set vibeProviderDclap.enabled=true \
  --set-string backend.env.VIBE_PROVIDER_URL=https://vibe-provider.example \
  >"$tmp_dclap_override"
assert_deployment_env_value "${RELEASE_NAME}-backend" "VIBE_PROVIDER_URL" "https://vibe-provider.example" "$tmp_dclap_override"

# Secret generation (F22): the stable-lookup template must still render a
# complete Secret on first install / dry-run (where `lookup` returns nil and the
# chain falls back to generation), honor explicit secrets.*, and stay skipped
# when an external existingSecret is referenced. The lookup-reuse-on-upgrade
# behavior itself requires a live cluster (server-side `lookup`) and is verified
# out-of-band per docs/UPGRADING.md; here we guard the client-renderable paths.
echo "[CHECK] render default Secret has all generated keys"
helm template "$RELEASE_NAME" "$CHART_PATH" >"$tmp_secret"
for key in SESSION_SECRET SETTINGS_ENCRYPTION_KEY INTERNAL_API_SECRET METRICS_TOKEN POSTGRES_PASSWORD; do
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

echo "[CHECK] existingSecret optional API keys include the Last.fm key pair"
helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set secrets.existingSecret=external-secret \
  --set secrets.apiKeysInExistingSecret=true \
  >"$tmp_secret_existing"
for deployment in "$RELEASE_NAME"; do
  for key in LASTFM_API_KEY LASTFM_SHARED_SECRET; do
    if ! DEPLOYMENT_NAME="$deployment" ENV_NAME="$key" perl -0777 -ne '
        for my $doc (split /^---/m, $_) {
            next unless $doc =~ /kind:\s*Deployment/;
            next unless $doc =~ /^  name: \Q$ENV{DEPLOYMENT_NAME}\E$/m;
            exit 0 if $doc =~ /name:\s+\Q$ENV{ENV_NAME}\E\s+valueFrom:\s+secretKeyRef:\s+name:\s+external-secret\s+key:\s+\Q$ENV{ENV_NAME}\E\s+optional:\s+true/s;
        }
        exit 1' "$tmp_secret_existing"; then
      echo "[ERROR] ${deployment} missing ${key} from existingSecret" >&2
      exit 1
    fi
  done
done

helm template "$RELEASE_NAME" "$CHART_PATH" \
  --set deploymentMode=individual \
  --set backendWorker.enabled=true \
  --set secrets.existingSecret=external-secret \
  --set secrets.apiKeysInExistingSecret=true \
  >"$tmp_secret_existing"
for deployment in "${RELEASE_NAME}-backend" "${RELEASE_NAME}-backend-worker"; do
  for key in LASTFM_API_KEY LASTFM_SHARED_SECRET; do
    if ! DEPLOYMENT_NAME="$deployment" ENV_NAME="$key" perl -0777 -ne '
        for my $doc (split /^---/m, $_) {
            next unless $doc =~ /kind:\s*Deployment/;
            next unless $doc =~ /^  name: \Q$ENV{DEPLOYMENT_NAME}\E$/m;
            exit 0 if $doc =~ /name:\s+\Q$ENV{ENV_NAME}\E\s+valueFrom:\s+secretKeyRef:\s+name:\s+external-secret\s+key:\s+\Q$ENV{ENV_NAME}\E\s+optional:\s+true/s;
        }
        exit 1' "$tmp_secret_existing"; then
      echo "[ERROR] ${deployment} missing ${key} from existingSecret" >&2
      exit 1
    fi
  done
done

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

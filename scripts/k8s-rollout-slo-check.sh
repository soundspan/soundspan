#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  k8s-rollout-slo-check.sh [options]

Options:
  -n, --namespace <ns>         Kubernetes namespace (default: soundspan)
  -c, --context <ctx>          kubectl context (optional)
  -w, --window <duration>      Log window for SLO checks (default: 15m)
  -t, --timeout <duration>     Rollout wait timeout (default: 10m)
  -r, --release-prefix <name>  Helm release prefix for deployment names (default: soundspan)
  -h, --help                   Show this help
USAGE
}

NAMESPACE="${NAMESPACE:-soundspan}"
KUBE_CONTEXT="${KUBE_CONTEXT:-}"
WINDOW="${WINDOW:-15m}"
TIMEOUT="${TIMEOUT:-10m}"
RELEASE_PREFIX="${RELEASE_PREFIX:-soundspan}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    -c|--context)
      KUBE_CONTEXT="$2"
      shift 2
      ;;
    -w|--window)
      WINDOW="$2"
      shift 2
      ;;
    -t|--timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    -r|--release-prefix)
      RELEASE_PREFIX="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ "$1" != -* ]]; then
        NAMESPACE="$1"
        shift
      else
        echo "[rollout-slo-check] Unknown arg: $1" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
done

KUBE_ARGS=()
if [[ -n "${KUBE_CONTEXT}" ]]; then
  KUBE_ARGS+=(--context "${KUBE_CONTEXT}")
fi

k() {
  kubectl "${KUBE_ARGS[@]}" "$@"
}

workload_exists() {
  local kind="$1"
  local name="$2"
  k -n "${NAMESPACE}" get "${kind}/${name}" >/dev/null 2>&1
}

resolve_workload() {
  local component="$1"
  local kind name

  for candidate in \
    "deploy:${RELEASE_PREFIX}-${component}" \
    "statefulset:${RELEASE_PREFIX}-${component}" \
    "statefulset:${RELEASE_PREFIX}-${component}-statefulset"
  do
    kind="${candidate%%:*}"
    name="${candidate##*:}"
    if workload_exists "${kind}" "${name}"; then
      printf '%s/%s' "${kind}" "${name}"
      return 0
    fi
  done

  return 1
}

print_component_pods() {
  local component="$1"
  local workload_name="$2"
  local pods
  pods="$(k -n "${NAMESPACE}" get pods -l "app.kubernetes.io/component=${component}" --no-headers 2>/dev/null || true)"
  if [[ -n "${pods}" ]]; then
    k -n "${NAMESPACE}" get pods -l "app.kubernetes.io/component=${component}"
    return
  fi

  # Fallback for installations without consistent component labels.
  k -n "${NAMESPACE}" get pods --no-headers | grep -E "^${workload_name}-" || true
}

workload_desired_replicas() {
  local workload="$1"
  k -n "${NAMESPACE}" get "${workload}" -o jsonpath='{.spec.replicas}'
}

workload_ready_replicas() {
  local workload="$1"
  local ready
  ready="$(k -n "${NAMESPACE}" get "${workload}" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
  if [[ -z "${ready}" ]]; then
    echo "0"
    return
  fi
  echo "${ready}"
}

find_matches() {
  local pattern="$1"
  if command -v rg >/dev/null 2>&1; then
    rg -n "${pattern}" || true
  else
    grep -En "${pattern}" || true
  fi
}

BACKEND_WORKLOAD="$(resolve_workload "backend" || true)"
FRONTEND_WORKLOAD="$(resolve_workload "frontend" || true)"
WORKER_WORKLOAD="$(resolve_workload "backend-worker" || true)"

echo "[rollout-slo-check] namespace=${NAMESPACE} context=${KUBE_CONTEXT:-current} window=${WINDOW} timeout=${TIMEOUT} releasePrefix=${RELEASE_PREFIX}"

echo "[1/4] Waiting for rollout completion..."
if [[ -z "${BACKEND_WORKLOAD}" ]]; then
  echo "[rollout-slo-check] ERROR: backend workload not found (tried deployment/statefulset prefixes under ${RELEASE_PREFIX})" >&2
  exit 1
fi
if [[ -z "${FRONTEND_WORKLOAD}" ]]; then
  echo "[rollout-slo-check] ERROR: frontend workload not found (tried deployment/statefulset prefixes under ${RELEASE_PREFIX})" >&2
  exit 1
fi

k -n "${NAMESPACE}" rollout status "${BACKEND_WORKLOAD}" --timeout="${TIMEOUT}"
k -n "${NAMESPACE}" rollout status "${FRONTEND_WORKLOAD}" --timeout="${TIMEOUT}"
if [[ -n "${WORKER_WORKLOAD}" ]]; then
  k -n "${NAMESPACE}" rollout status "${WORKER_WORKLOAD}" --timeout="${TIMEOUT}"
else
  echo "[rollout-slo-check] WARN: backend-worker workload not found; skipping worker rollout status check"
fi

echo "[2/4] Checking pod readiness..."
print_component_pods "backend" "${BACKEND_WORKLOAD##*/}"
print_component_pods "frontend" "${FRONTEND_WORKLOAD##*/}"
[[ -n "${WORKER_WORKLOAD}" ]] && print_component_pods "backend-worker" "${WORKER_WORKLOAD##*/}"

backend_desired="$(workload_desired_replicas "${BACKEND_WORKLOAD}")"
backend_ready="$(workload_ready_replicas "${BACKEND_WORKLOAD}")"
frontend_desired="$(workload_desired_replicas "${FRONTEND_WORKLOAD}")"
frontend_ready="$(workload_ready_replicas "${FRONTEND_WORKLOAD}")"

if [[ "${backend_ready}" -lt "${backend_desired}" ]]; then
  echo "[rollout-slo-check] FAIL: backend ready replicas ${backend_ready}/${backend_desired}" >&2
  exit 1
fi
if [[ "${frontend_ready}" -lt "${frontend_desired}" ]]; then
  echo "[rollout-slo-check] FAIL: frontend ready replicas ${frontend_ready}/${frontend_desired}" >&2
  exit 1
fi
if [[ -n "${WORKER_WORKLOAD}" ]]; then
  worker_desired="$(workload_desired_replicas "${WORKER_WORKLOAD}")"
  worker_ready="$(workload_ready_replicas "${WORKER_WORKLOAD}")"
  if [[ "${worker_ready}" -lt "${worker_desired}" ]]; then
    echo "[rollout-slo-check] FAIL: worker ready replicas ${worker_ready}/${worker_desired}" >&2
    exit 1
  fi
fi

echo "[3/4] Checking SLO warning channels..."
backend_logs="$(k -n "${NAMESPACE}" logs "${BACKEND_WORKLOAD}" --since="${WINDOW}" || true)"
worker_logs=""
if [[ -n "${WORKER_WORKLOAD}" ]]; then
  worker_logs="$(k -n "${NAMESPACE}" logs "${WORKER_WORKLOAD}" --since="${WINDOW}" || true)"
fi

backend_reconnect_breaches="$(printf '%s\n' "${backend_logs}" | find_matches "ListenTogether/SLO.*exceeded target")"
backend_scheduler_warnings="$(printf '%s\n' "${backend_logs}" | find_matches "SchedulerClaim/SLO.*skipped")"
worker_scheduler_warnings="$(printf '%s\n' "${worker_logs}" | find_matches "SchedulerClaim/SLO.*skipped")"

if [[ -n "${backend_reconnect_breaches}" ]]; then
  echo "[rollout-slo-check] backend reconnect SLO breaches detected:"
  printf '%s\n' "${backend_reconnect_breaches}"
fi

if [[ -n "${backend_scheduler_warnings}" ]]; then
  echo "[rollout-slo-check] backend scheduler SLO warnings detected:"
  printf '%s\n' "${backend_scheduler_warnings}"
fi

if [[ -n "${worker_scheduler_warnings}" ]]; then
  echo "[rollout-slo-check] worker scheduler SLO warnings detected:"
  printf '%s\n' "${worker_scheduler_warnings}"
fi

if [[ -n "${backend_reconnect_breaches}" || -n "${backend_scheduler_warnings}" || -n "${worker_scheduler_warnings}" ]]; then
  echo "[rollout-slo-check] FAIL: SLO warnings present in log window ${WINDOW}"
  exit 1
fi

echo "[4/4] PASS: rollout completed with no SLO warnings in window ${WINDOW}"

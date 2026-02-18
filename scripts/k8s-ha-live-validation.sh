#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  k8s-ha-live-validation.sh [options]

Purpose:
  End-to-end HA preflight + rollout SLO validation for soundspan split deployments.

Options:
  -n, --namespace <ns>         Kubernetes namespace (default: soundspan)
  -c, --context <ctx>          kubectl context (optional)
  -r, --release-prefix <name>  Helm release prefix (default: soundspan)
  -w, --window <duration>      Log window for SLO checks (default: 15m)
  -t, --timeout <duration>     Rollout/pod wait timeout (default: 10m)
      --restart-backend        Restart backend deployment and re-run SLO gate
      --restart-frontend       Restart frontend deployment and re-run SLO gate
      --restart-worker         Restart backend-worker deployment and re-run SLO gate
  -h, --help                   Show this help
USAGE
}

NAMESPACE="${NAMESPACE:-soundspan}"
KUBE_CONTEXT="${KUBE_CONTEXT:-}"
RELEASE_PREFIX="${RELEASE_PREFIX:-soundspan}"
WINDOW="${WINDOW:-15m}"
TIMEOUT="${TIMEOUT:-10m}"
RESTART_BACKEND=false
RESTART_FRONTEND=false
RESTART_WORKER=false

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
    -r|--release-prefix)
      RELEASE_PREFIX="$2"
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
    --restart-backend)
      RESTART_BACKEND=true
      shift
      ;;
    --restart-frontend)
      RESTART_FRONTEND=true
      shift
      ;;
    --restart-worker)
      RESTART_WORKER=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ha-live-validation] Unknown arg: $1" >&2
      usage >&2
      exit 1
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

get_workload_env_lines() {
  local workload="$1"
  local container_name="$2"
  k -n "${NAMESPACE}" get "${workload}" \
    -o jsonpath="{range .spec.template.spec.containers[?(@.name=='${container_name}')].env[*]}{.name}={.value}{'\n'}{end}"
}

print_component_pods() {
  local component="$1"
  local workload_name="$2"
  local pods
  pods="$(k -n "${NAMESPACE}" get pods -l "app.kubernetes.io/component=${component}" --no-headers 2>/dev/null || true)"
  if [[ -n "${pods}" ]]; then
    k -n "${NAMESPACE}" get pods -l "app.kubernetes.io/component=${component}" \
      -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,NODE:.spec.nodeName
    return
  fi

  # Fallback for installations without component labels.
  k -n "${NAMESPACE}" get pods --no-headers | grep -E "^${workload_name}-" || true
}

wait_component_ready() {
  local component="$1"
  local workload_name="$2"
  local pod_names
  pod_names="$(k -n "${NAMESPACE}" get pods -l "app.kubernetes.io/component=${component}" -o name 2>/dev/null || true)"
  if [[ -n "${pod_names}" ]]; then
    k -n "${NAMESPACE}" wait --for=condition=Ready pod -l "app.kubernetes.io/component=${component}" --timeout="${TIMEOUT}"
    return
  fi

  while IFS= read -r pod; do
    [[ -z "${pod}" ]] && continue
    k -n "${NAMESPACE}" wait --for=condition=Ready "pod/${pod}" --timeout="${TIMEOUT}"
  done < <(k -n "${NAMESPACE}" get pods --no-headers | awk '{print $1}' | grep -E "^${workload_name}-" || true)
}

component_unique_nodes() {
  local component="$1"
  local workload_name="$2"
  local nodes
  nodes="$(k -n "${NAMESPACE}" get pods -l "app.kubernetes.io/component=${component}" -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' 2>/dev/null || true)"
  if [[ -z "${nodes}" ]]; then
    nodes="$(
      while IFS= read -r pod; do
        [[ -z "${pod}" ]] && continue
        k -n "${NAMESPACE}" get "pod/${pod}" -o jsonpath='{.spec.nodeName}{"\n"}'
      done < <(k -n "${NAMESPACE}" get pods --no-headers | awk '{print $1}' | grep -E "^${workload_name}-" || true)
    )"
  fi

  printf '%s\n' "${nodes}" | sort -u | sed '/^$/d' | wc -l | tr -d ' '
}

BACKEND_WORKLOAD="$(resolve_workload "backend" || true)"
FRONTEND_WORKLOAD="$(resolve_workload "frontend" || true)"
WORKER_WORKLOAD="$(resolve_workload "backend-worker" || true)"

ROLLOUT_SCRIPT="$(dirname "$0")/k8s-rollout-slo-check.sh"
if [[ ! -x "${ROLLOUT_SCRIPT}" ]]; then
  echo "[ha-live-validation] ERROR: required executable not found: ${ROLLOUT_SCRIPT}" >&2
  exit 1
fi

echo "[ha-live-validation] namespace=${NAMESPACE} context=${KUBE_CONTEXT:-current} releasePrefix=${RELEASE_PREFIX}"

if [[ -z "${BACKEND_WORKLOAD}" ]]; then
  echo "[ha-live-validation] ERROR: backend workload not found" >&2
  exit 1
fi
if [[ -z "${FRONTEND_WORKLOAD}" ]]; then
  echo "[ha-live-validation] ERROR: frontend workload not found" >&2
  exit 1
fi

backend_replicas="$(k -n "${NAMESPACE}" get "${BACKEND_WORKLOAD}" -o jsonpath='{.spec.replicas}')"
frontend_replicas="$(k -n "${NAMESPACE}" get "${FRONTEND_WORKLOAD}" -o jsonpath='{.spec.replicas}')"
worker_replicas="0"
worker_exists=false
if [[ -n "${WORKER_WORKLOAD}" ]]; then
  worker_exists=true
  worker_replicas="$(k -n "${NAMESPACE}" get "${WORKER_WORKLOAD}" -o jsonpath='{.spec.replicas}')"
fi

echo "[ha-live-validation] replicas: backend=${backend_replicas} frontend=${frontend_replicas} worker=${worker_replicas}"
if [[ "${backend_replicas}" -lt 2 ]]; then
  echo "[ha-live-validation] WARN: backend replicas < 2; this is not a true HA API topology"
fi
if [[ "${worker_exists}" == "false" ]]; then
  echo "[ha-live-validation] WARN: backend-worker workload not found; worker-role isolation cannot be verified"
fi

echo "[ha-live-validation] validating deployment env posture..."
backend_env="$(get_workload_env_lines "${BACKEND_WORKLOAD}" "backend")"
echo "${backend_env}" | grep -q '^BACKEND_PROCESS_ROLE=api$' || {
  echo "[ha-live-validation] WARN: backend BACKEND_PROCESS_ROLE is not 'api'" >&2
}
for expected in \
  "LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED=true" \
  "LISTEN_TOGETHER_STATE_SYNC_ENABLED=true" \
  "LISTEN_TOGETHER_STATE_STORE_ENABLED=true" \
  "LISTEN_TOGETHER_MUTATION_LOCK_ENABLED=true" \
  "LISTEN_TOGETHER_ALLOW_POLLING=false" \
  "READINESS_REQUIRE_DEPENDENCIES=true"
do
  if ! echo "${backend_env}" | grep -q "^${expected}$"; then
    echo "[ha-live-validation] WARN: backend missing expected env ${expected}" >&2
  fi
done

if [[ "${worker_exists}" == "true" ]]; then
  worker_env="$(get_workload_env_lines "${WORKER_WORKLOAD}" "backend-worker")"
  echo "${worker_env}" | grep -q '^BACKEND_PROCESS_ROLE=worker$' || {
    echo "[ha-live-validation] WARN: worker BACKEND_PROCESS_ROLE is not 'worker'" >&2
  }
fi

echo "[ha-live-validation] waiting for ready pods..."
wait_component_ready "backend" "${BACKEND_WORKLOAD##*/}"
wait_component_ready "frontend" "${FRONTEND_WORKLOAD##*/}"
if [[ "${worker_exists}" == "true" ]]; then
  wait_component_ready "backend-worker" "${WORKER_WORKLOAD##*/}"
fi

echo "[ha-live-validation] backend pod/node spread:"
print_component_pods "backend" "${BACKEND_WORKLOAD##*/}"
unique_backend_nodes="$(component_unique_nodes "backend" "${BACKEND_WORKLOAD##*/}")"
if [[ "${backend_replicas}" -ge 2 && "${unique_backend_nodes}" -lt 2 ]]; then
  echo "[ha-live-validation] WARN: backend replicas are not spread across nodes (unique nodes=${unique_backend_nodes})"
fi

echo "[ha-live-validation] running baseline rollout SLO gate..."
KUBE_CONTEXT="${KUBE_CONTEXT}" WINDOW="${WINDOW}" TIMEOUT="${TIMEOUT}" RELEASE_PREFIX="${RELEASE_PREFIX}" \
  "${ROLLOUT_SCRIPT}" --namespace "${NAMESPACE}"

run_restart_gate() {
  local workload="$1"
  if [[ -z "${workload}" ]]; then
    echo "[ha-live-validation] WARN: workload not found; skipping restart gate"
    return
  fi

  echo "[ha-live-validation] restarting ${workload}..."
  k -n "${NAMESPACE}" rollout restart "${workload}"
  k -n "${NAMESPACE}" rollout status "${workload}" --timeout="${TIMEOUT}"
  KUBE_CONTEXT="${KUBE_CONTEXT}" WINDOW="${WINDOW}" TIMEOUT="${TIMEOUT}" RELEASE_PREFIX="${RELEASE_PREFIX}" \
    "${ROLLOUT_SCRIPT}" --namespace "${NAMESPACE}"
}

if [[ "${RESTART_BACKEND}" == "true" ]]; then
  run_restart_gate "${BACKEND_WORKLOAD}"
fi
if [[ "${RESTART_FRONTEND}" == "true" ]]; then
  run_restart_gate "${FRONTEND_WORKLOAD}"
fi
if [[ "${RESTART_WORKER}" == "true" ]]; then
  run_restart_gate "${WORKER_WORKLOAD}"
fi

echo "[ha-live-validation] PASS"

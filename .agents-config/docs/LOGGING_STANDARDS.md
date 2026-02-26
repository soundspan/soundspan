# Logging Standards

Canonical logging contract for frontend, backend, and Python sidecar services.

## Purpose

- Keep logging simple and reusable through shared helpers.
- Keep logs useful for incident triage with consistent scope/context fields.
- Prevent direct raw logging drift by enforcing contract checks in policy-as-code.

## Shared Principles

1. Everything in the project should be logged appropriately for operator visibility in runtime code paths.
2. Use scoped loggers, not raw global console/print calls.
3. Emit structured context objects for identifiers (`requestId`, `userId`, `jobId`, `trackId`).
4. Treat secrets as forbidden log fields (tokens, passwords, auth headers, cookies).
5. Use level semantics consistently:
- `debug`: high-volume diagnostics and timing traces.
- `info`: lifecycle transitions and important operator events.
- `warn`: degraded but recoverable state.
- `error`: failures requiring action or retry.
6. Prefer reusable wrappers/decorators over repeated inline timing/try-catch logging.

## Frontend Contract

- Required module: `frontend/lib/logger.ts`
- Required factory: `createFrontendLogger(scope)`
- Required timing helper: `withFrontendLogTiming(logger, operation, run, context?)`
- Preferred usage:
  - Instantiate one logger per component/module scope.
  - Log component boundary failures and recoveries with structured context.
  - Keep user-facing errors in UI toasts/components and operator detail in logs.

## Backend Contract

- Required module: `backend/src/utils/logger.ts`
- Required factory: `createLogger(scope?)`
- Required timing helper: `withLogTiming(logger, operation, run, context?)`
- Required error helper: `logErrorWithContext(logger, message, error, context?)`
- Preferred usage:
  - Use `logger.child("Subscope")` for nested operations.
  - Attach request/job/session identifiers as structured context.
  - Keep HTTP response payloads stable and avoid leaking internal stack details to clients.

## Python Sidecar Contract

- Required module: `services/common/logging_utils.py`
- Required setup function: `configure_service_logger(service_name, ...)`
- Required decorators: `log_exceptions(...)`, `log_timing(...)`
- Preferred usage:
  - Configure service logger once in each sidecar entrypoint.
  - Use decorators for repeated exception/timing behavior.
  - Avoid raw `print()` and per-file `logging.basicConfig(...)`.

## Enforcement

- Baseline generator: `npm run logging:compliance:generate`
- Strict verifier: `npm run logging:compliance:verify`
- Verifier script: `.agents-config/scripts/verify-logging-compliance.mjs`
- Baseline file: `.agents-config/policies/logging-compliance-baseline.json`

Compliance model:

1. Existing raw logging callsites are tracked in the baseline.
2. New raw logging callsites fail verification.
3. Removed callsites must be reflected by regenerating baseline so drift is explicit.

## Migration to 100% Coverage

1. Replace raw logging callsites with shared logger helpers by domain.
2. Regenerate baseline after each migration slice.
3. Keep reducing baseline count until it reaches zero across frontend/backend/python runtime surfaces.

# Logging Standards

Shared logging guidance for runtime code in `soundspan`.

## Purpose

- Keep operator-facing logs consistent across frontend, backend, and Python sidecars.
- Prefer shared helpers over ad hoc logging patterns.
- Avoid logging secrets or unstable raw payload dumps.

## Shared Rules

1. Log meaningful runtime state changes, failures, and recovery paths.
2. Use scoped loggers instead of raw global logging calls when shared helpers exist.
3. Include structured identifiers when available: `requestId`, `userId`, `jobId`, `trackId`, `groupId`.
4. Never log secrets, tokens, passwords, cookies, or auth headers.
5. Keep log levels consistent:
   - `debug` for high-volume diagnostics,
   - `info` for normal lifecycle events,
   - `warn` for degraded but recoverable states,
   - `error` for failures that need action, retry, or investigation.

## Frontend

- Shared logger module: `frontend/lib/logger.ts`
- Preferred entrypoint: `createFrontendLogger(scope)`
- Preferred timing helper: `withFrontendLogTiming(logger, operation, run, context?)`

## Backend

- Shared logger module: `backend/src/utils/logger.ts`
- Preferred entrypoint: `createLogger(scope?)`
- Preferred helpers: `withLogTiming(...)`, `logErrorWithContext(...)`

## Python Sidecars

- Shared logger module: `services/common/logging_utils.py`
- Preferred setup: `configure_service_logger(service_name, ...)`
- Preferred decorators: `log_exceptions(...)`, `log_timing(...)`

## Maintenance Rule

When touching runtime logging behavior, keep this doc aligned with the real shared helper surface instead of preserving legacy enforcement details that no longer exist in the repo.

# ADR: Segmented Streaming Startup Contract

## Status

Accepted (implementation in progress)

## Context

Segmented startup reliability depends on consistent semantics across:

- session creation (`POST /api/streaming/v1/sessions`)
- manifest readiness (`GET /api/streaming/v1/sessions/:sessionId/manifest.mpd`)
- segment readiness (`GET /api/streaming/v1/sessions/:sessionId/segments/:segmentName`)

Historically, callers inferred retryability from free-form error messages. This caused brittle startup recovery behavior and made rollout diagnostics noisy.

## Decision

All startup-path failures return a machine-readable `startupHint` contract with:

- `stage`: `session_create` | `manifest` | `segment`
- `state`: `waiting` | `blocked` | `failed`
- `transient`: boolean retryability signal
- `reason`: stable reason token
- `retryAfterMs`: bounded retry hint for transient startup states, otherwise `null`

Transient startup responses also emit `Retry-After` headers.

## Route-Level Taxonomy

### Session create (`POST /api/streaming/v1/sessions`)

- `503 STREAMING_DRAINING`
  - `startupHint.state=waiting`
  - `startupHint.transient=true`
  - `startupHint.reason=runtime_draining`
- `401 Unauthorized`
  - `startupHint.state=blocked`
  - `startupHint.transient=false`
  - `startupHint.reason=unauthorized`
- `4xx request/track errors`
  - `startupHint.state=failed`
  - `startupHint.transient=false`
  - reason mapped by code/reason (`track_not_found`, `invalid_request`, etc.)

### Manifest readiness (`GET /api/streaming/v1/sessions/:sessionId/manifest.mpd`)

- token errors (`STREAMING_SESSION_TOKEN_*`)
  - `startupHint.state=blocked`
  - `startupHint.transient=false`
- asset-not-ready (`STREAMING_ASSET_NOT_READY`)
  - `startupHint.state=waiting`
  - `startupHint.transient=true`
  - `startupHint.reason=asset_not_ready`
- session/manifest not found
  - `startupHint.state=failed`
  - `startupHint.transient=false`

### Segment readiness (`GET /api/streaming/v1/sessions/:sessionId/segments/:segmentName`)

- invalid segment name/path
  - `startupHint.state=failed`
  - `startupHint.transient=false`
- asset-not-ready
  - `startupHint.state=waiting`
  - `startupHint.transient=true`
- segment/session not found
  - `startupHint.state=failed`
  - `startupHint.transient=false`

## Correlation and Observability

Startup correlation fields are accepted on startup routes:

- `x-segmented-startup-load-id`
- `x-segmented-startup-correlation-id`

These fields are logged with `session.create`, `manifest.fetch`, and `segment.fetch` metrics/traces for wave-level diagnostics.

## Consequences

- Frontend startup recovery can prefer canonical backend retryability hints over message parsing.
- Operator rollouts can measure startup health using stable dimensions (stage, transientness, reason, retry budget/correlation fields).
- Compatibility is preserved: existing error `code`/`error` contracts remain available.

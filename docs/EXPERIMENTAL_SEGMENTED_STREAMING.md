# Experimental Segmented Streaming

Segmented streaming is an experimental feature.

- It is not part of the standard deployment path.
- Keep standard self-hosting setup on direct playback (`howler`) unless you are explicitly evaluating segmented mode.
- This document is the single source for segmented-streaming runtime knobs, rollout guidance, and primary-mode reversion procedures.

## Runtime Controls

| Variable | Default | Values | Purpose |
| --- | --- | --- | --- |
| `STREAMING_ENGINE_MODE` | `howler` | `howler`, `videojs` | Frontend runtime engine mode (`howler` direct primary playback, `videojs` segmented experimental playback). |
| `SEGMENTED_SESSION_PREWARM_ENABLED` | `true` | `true`, `false` | Enables next-track segmented session prewarm + validation. |
| `LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED` | `false` | `true`, `false` | Enables segmented startup/handoff/recovery while a Listen Together group is active. |
| `SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS` | `20000` | `1500-22000` | Runtime startup timeout used to trigger segmented startup retries when startup stalls. |
| `SEGMENTED_VHS_PROFILE` | `balanced` | `balanced`, `legacy` | Runtime Video.js startup/retry profile for segmented playback. |
| `SEGMENTED_LOCAL_SEG_DURATION_SEC` | `2.0` | positive number | Backend DASH segment duration for local segmented sessions. |
| `SEGMENTED_DASH_FRAGMENT_DURATION_RATIO` | `0.1` | positive number | Frontend runtime-config ratio used to derive effective fragment duration. |
| `SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC` | derived | derived | Runtime-config key derived as `SEGMENTED_LOCAL_SEG_DURATION_SEC * SEGMENTED_DASH_FRAGMENT_DURATION_RATIO`. |
| `SEGMENTED_STREAMING_CACHE_PATH` | `TRANSCODE_CACHE_PATH` | filesystem path | Base directory for segmented DASH cache artifacts. |

## Runtime Model

Primary runtime knob:

- `STREAMING_ENGINE_MODE` (container runtime env, not `NEXT_PUBLIC_*` build args)
- effective behavior:
  - unset/empty: defaults to `howler` (direct)
  - `howler`: direct playback mode
  - `videojs`: segmented playback mode (experimental)

Guardrails:

- Keep `videojs` opt-in and promote only with explicit rollout checks.
- Do not rely on build-time flags when switching between primary and experimental modes.
- Recovery policy stays local-player authoritative after disruption (local play/pause/position intent wins).

## Progressive Rollout Levels

| Stage | Scope | Promotion guardrails |
| --- | --- | --- |
| 0 | Dev/staging only | Segmented session create/manifest/segment requests succeed and no critical regressions in queue/seek/repeat/shuffle flows. |
| 1 | Local-library segmented users only | Rolling-update tests complete with no fatal interruption spikes; startup and seek latencies stay within accepted SLO budgets. |
| 2 | Limited production cohort (local + selected provider tracks) | Rebuffer/hour and handoff-failure metrics stay below rollback thresholds for at least 24h. |
| 3 | Broader production cohort including provider-heavy sessions | Error budget and session continuity metrics remain stable through at least one controlled deploy window. |
| 4 | Segmented runtime (`videojs`, experimental) | Keep direct-stream compatibility and explicit return-to-primary (`howler`) path validated. |

## Primary-Mode Reversion Trigger Matrix

| Trigger | Signal | Immediate action |
| --- | --- | --- |
| Session create failures | sustained `session.create` error/reject increase against baseline | Switch frontend to `STREAMING_ENGINE_MODE=howler` and restart frontend runtime. |
| Handoff recovery failures | sustained `session.handoff_failure`/`session.handoff_load_error` increase | Switch to `howler`; keep backend telemetry enabled for diagnosis. |
| Segment/manifest instability | repeated manifest/segment fetch errors with user-facing interruptions | Switch frontend engine back to primary `howler` immediately; investigate segmented backend path offline. |
| Deployment disruption regression | interruption rate breaches rollout SLO window during controlled deploy | Switch the active deployment wave back to primary `howler` before further rollout expansion. |

## Startup Contract and Correlation

Segmented startup failures return a machine-readable `startupHint` payload:

- `stage`: `session_create` | `manifest` | `segment`
- `state`: `waiting` | `blocked` | `failed`
- `transient`: whether retry is expected to succeed
- `reason`: stable operator-facing reason token
- `retryAfterMs`: bounded retry hint for transient startup states

Transient startup responses also include `Retry-After` headers.

Correlation headers the frontend can send:

- `x-segmented-startup-load-id`
- `x-segmented-startup-correlation-id`

## Startup Observability Queries

Use these field groups from `[SegmentedStreaming][Metric]` logs during rollout waves:

- Startup timeline (client): `event=player.startup_timeline`, `totalToAudibleMs`, `outcome`, `startupRetryCount`, `retryBudgetRemaining`, `startupCorrelationId`
- Session create (server): `event=session.create`, `status`, `latencyMs`, `startupLoadId`, `startupCorrelationId`
- Manifest fetch (server): `event=manifest.fetch`, `status`, `latencyMs`, `startupLoadId`, `startupCorrelationId`
- Segment fetch (server): `event=segment.fetch`, `status`, `latencyMs`, `startupLoadId`, `startupCorrelationId`
- Retry exhaustion (client): `event=session.startup_retry_exhausted`, `stage`, `attempts`, `windowElapsedMs`, `sessionResetsUsed`

For baseline-vs-wave summaries:

```bash
cd backend
npx tsx scripts/measure-segmented-startup-baseline.ts --input <capture.ndjson> --label <name> [--output <report.md>]
npx tsx scripts/measure-segmented-startup-baseline.ts --input <baseline.ndjson> --label baseline --compare-input <wave.ndjson> --compare-label wave [--output <report.md>]
```

## Primary Mode Procedure (`howler`)

1. Set runtime env on frontend process and restart frontend service only (no rebuild).

Split stack:

```bash
STREAMING_ENGINE_MODE=howler docker compose up -d frontend
```

AIO:

```bash
STREAMING_ENGINE_MODE=howler docker compose -f docker-compose.aio.yml up -d soundspan
```

2. Validate primary-mode reversion:
   - playback starts/continues for local, TIDAL, and YouTube queue paths;
   - no new segmented handoff retry storms;
   - player controls (seek, queue progression, repeat/shuffle, Listen Together) remain functional.

3. After stabilization, restore segmented runtime and restart frontend runtime.

Split stack:

```bash
STREAMING_ENGINE_MODE=videojs docker compose up -d frontend
```

AIO:

```bash
STREAMING_ENGINE_MODE=videojs docker compose -f docker-compose.aio.yml up -d soundspan
```

## Segmented Testing Pointers

- Contract/compat coverage: `frontend/tests/e2e/predeploy/media-contract.spec.ts`
- Startup baseline tooling: `backend/scripts/measure-segmented-startup-baseline.ts`
- Architecture docs:
  - `docs/architecture/adr-segmented-streaming.md`
  - `docs/architecture/segmented-streaming-baseline.md`

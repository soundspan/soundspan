# Segmented Streaming Startup Baseline

This page defines measurable startup reliability targets and the command workflow for baseline vs wave captures.

## Success Thresholds

Treat a rollout wave as healthy only when all thresholds pass against the same capture window and population slice used for baseline:

| Metric | Success threshold |
|---|---|
| Startup samples (`player.startup_timeline` records) | At least 200 samples per capture |
| First-audible latency p50 (`totalToAudibleMs`) | <= 1200 ms |
| First-audible latency p95 (`totalToAudibleMs`) | <= 2500 ms |
| Startup-timeout rate (`outcome == startup_timeout`) | <= 2.0% |
| Retry-exhaustion event rate (`session.startup_retry_exhausted`) | <= 1.0% |

## Measurement Script

Runner: `backend/scripts/measure-segmented-startup-baseline.ts`

Required flag:

- `--input <path>`: NDJSON capture file.

Optional flags:

- `--output <path>`: write the same markdown report to disk.
- `--label <name>`: report label, for example `baseline` or `wave-1`.
- `--compare-input <path>`: second NDJSON capture path for baseline-vs-wave comparisons.
- `--compare-label <name>`: label for the second capture (default: `comparison`).

## Runbook: Baseline and Wave

From `backend/`:

```bash
npx tsx scripts/measure-segmented-startup-baseline.ts \
  --input ../captures/segmented-startup-baseline.ndjson \
  --label baseline \
  --output ../docs/architecture/segmented-streaming-baseline-report-baseline.md

npx tsx scripts/measure-segmented-startup-baseline.ts \
  --input ../captures/segmented-startup-baseline.ndjson \
  --label baseline \
  --compare-input ../captures/segmented-startup-wave-1.ndjson \
  --compare-label wave-1 \
  --output ../docs/architecture/segmented-streaming-baseline-report-baseline-vs-wave-1.md
```

The first command is single-run mode (baseline-only snapshot).
The second command is comparison mode and includes absolute + percent deltas for p50/p95 first-audible, startup-timeout rate, and retry-exhaustion rate.

## Interpretation Notes

- Rates use `total startup timeline samples` as denominator.
- The script accepts shape variations where telemetry fields may be flat or nested under keys such as `fields`, `data`, or `payload`.
- If p95 latency or timeout/retry rates regress beyond thresholds, block rollout and investigate startup pipeline changes before the next wave.

## Residual Risk Ranking

Use this ordering when comparison reports regress and triage capacity is limited:

1. Startup timeout rate regression (`outcome == startup_timeout`): highest user-visible failure risk and strongest rollback signal.
2. Retry-exhaustion rate regression (`session.startup_retry_exhausted`): indicates recovery policy budget is insufficient for live conditions.
3. p95 first-audible latency regression (`totalToAudibleMs`): tail-latency degradation often precedes reliability incidents.
4. p50 first-audible latency regression (`totalToAudibleMs`): broad startup slowness with lower immediate interruption risk.

Recommended follow-up sequence by impact:

1. Validate startup contract hints and `Retry-After` correctness in backend responses.
2. Inspect readiness coalescing/microcache behavior and startup segment production lag.
3. Tune stage retry limits/backoff only after confirming backend startup readiness behavior is healthy.

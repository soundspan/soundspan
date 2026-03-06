# ACM Legacy Plans

This directory keeps the legacy planning history that was intentionally preserved during the move from the old agents-template workflow to ACM.

## What Is Kept

- `current/`, `deferred/`, and `archived/`: committed exports of legacy `PLAN.json` state for ACM import and historical lookup.
- `index.json` and `../ACM_LEGACY_PLAN_MAP.json`: manifest files for the export set.
- `legacy-notes/`: a small set of standalone design notes that were not represented in plan exports but may still be useful later.

## What Is Not Kept

- Old execution queue state, session brief state, and other orchestrator runtime files from `.agents/`.
- Raw execution archive shards and session logs that were treated as template-era noise rather than durable project history.

## Visibility

This directory is tracked in git, but it is not part of the end-user documentation surface. Treat it as maintainer/internal migration history.

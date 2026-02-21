# Video.js DASH Engine Spike (VHS vs `videojs-contrib-dash`)

Date: 2026-02-21
Feature: `videojs-maturity`
Status: Evaluation complete (no runtime switch implemented)

## Scope

This spike compares the current Video.js VHS-based DASH path with a potential `videojs-contrib-dash` (dash.js-backed) fallback for DASH edge cases observed during segmented playback hardening.

## Current Path (VHS) in soundspan

- We currently use Video.js with built-in VHS for segmented DASH playback.
- Existing runtime telemetry, usage-event diagnostics, and startup profile controls are implemented against VHS runtime behavior.
- Recent playback incidents were primarily tied to startup/handoff orchestration and transcode latency, not a complete inability of VHS to play our manifests.

## `videojs-contrib-dash` Capability Snapshot

- `videojs-contrib-dash` is a dedicated DASH source handler that uses dash.js and advertises stable maintenance.
- It supports passing dash.js MediaPlayer configuration through Video.js, enabling deeper buffer/ABR tuning than default VHS-only control points.
- dash.js exposes explicit buffer and ABR controls that can help on advanced DASH tuning scenarios (initial buffer, top-quality buffer targets, ABR rule selection, bitrate constraints).

## Integration Delta and Cost

Switching or dual-wiring adds meaningful complexity:

- Add and maintain extra engine dependencies (`dash.js` + `videojs-contrib-dash`) and compatibility validation across Video.js upgrades.
- Introduce a second DASH runtime behavior surface with separate diagnostics and failure modes.
- Rework/branch current VHS-focused telemetry hooks (`onResponse`, `vhs.stats`, usage events) to preserve observability parity.
- Expand regression matrix for player lifecycle, handoff, seek continuity, buffering recovery, and quality semantics across two DASH engines.

## Recommendation

No-go for immediate default migration to `videojs-contrib-dash`.

Proceed with VHS as primary/default and keep the `contrib-dash` path as a contingency option if either condition is met:

1. Reproducible DASH-specific failures remain after orchestration and backend transcode pipeline stabilization.
2. We identify a required dash.js-only control (buffer/ABR behavior) that materially improves real user outcomes and cannot be matched with VHS tuning.

If condition-triggered, run a bounded canary experiment with a runtime-selectable engine mode, parity telemetry, and explicit rollback.

## Sources

- Video.js FAQ (DASH support notes and contrib-dash mention): https://videojs.com/guides/faqs/
- Video.js HTTP Streaming (VHS): https://github.com/videojs/http-streaming
- `videojs-contrib-dash` repository: https://github.com/videojs/videojs-contrib-dash
- dash.js buffer management: https://dashif.org/dash.js/pages/usage/buffer-management.html
- dash.js ABR settings: https://dashif.org/dash.js/pages/usage/abr/settings.html

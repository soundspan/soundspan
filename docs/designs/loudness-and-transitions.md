# Loudness Normalization and Smart Transitions

Spec drafted 2026-08-16 for [issue #526](https://github.com/soundspan/soundspan/issues/526) (loudness) and [issue #527](https://github.com/soundspan/soundspan/issues/527) (transitions). Status: design phase. The two features share analyzer plumbing and are sequenced: transitions assume leveled loudness.

## Problem

Playback volume varies wildly across a mixed library (quiet 90s masters next to loudness-war rips), and every transition is a hard cut. The analyzer visits every file and already stores BPM and energy, but playback uses none of it.

## Part 1 — Loudness normalization

### Measurement

- `services/audio-analyzer` gains an EBU R128 pass emitting **integrated LUFS** and **true peak (dBTP)** per track. Implementation candidate order: ffmpeg `loudnorm` in analysis mode (already in the image, print_format json) over Essentia's `LoudnessEBUR128` — pick by benchmarking both on the analyzer's decode path; record the choice and why here when implemented.
- Album aggregation: album gain computed per EBU R128 over the concatenated program (approximated as duration-weighted energy mean of track measurements — exact concatenation is not worth a second decode pass; note the approximation).
- Schema: nullable `loudnessLufs`, `truePeakDb` on Track; `albumLoudnessLufs` on Album. Backfill through the existing re-analysis queue at low priority; coverage gauge on the metrics registry.

### Application (client-side)

- Gain = `target − measured`, target default **−18 LUFS** (ReplayGain 2 reference; commercial streamers use −14 to −16, but self-hosted libraries skew dynamic — default documented and configurable per server, `LOUDNESS_TARGET_LUFS`).
- **Positive gain clamp:** limit boost to `min(+3 dB, headroom to 0 dBTP)` using true peak — never introduce clipping to normalize a quiet track.
- Modes per user: `off | track | album | auto` (auto = album gain inside album context, track gain in shuffle/radio/mix). **Default: `auto` at ship** (maintainer decision 2026-08-16): the true-peak boost clamp is the safety mechanism, cut-only attenuation cannot clip, and `off` stays one toggle away. Release notes call out the behavior change prominently.
- Engine application: both direct engines composite a gain factor into their volume pipeline (multiplicative with user volume). No new AudioContext requirement on the default path — element volume compositing suffices; where a context already exists (iOS-standalone bridge), a GainNode is acceptable but not required. Missing measurement ⇒ gain 0 for that track; **no mid-queue jump handling beyond that** (a measured→unmeasured boundary plays both at their natural relationship, same as today).
- Transcoding/offline: measurement reflects the source file; client-side gain is codec-independent, so transcoded streams inherit correct leveling. Offline downloads play through the same player pipeline and use the same stored values.

### Subsonic surface

- Implement the OpenSubsonic **ReplayGain extension**: `replayGain` object (trackGain, albumGain, trackPeak, albumPeak) on song child elements; advertise in `getOpenSubsonicExtensions`. Update `docs/OPENSUBSONIC_COMPATIBILITY.md`. This alone upgrades Symfonium-class clients.

## Part 2 — Smart transitions

### Phase T1 — silence handling

- Analyzer emits `leadingSilenceMs`, `trailingSilenceMs` (threshold −60 dBFS relative, minimum 200 ms to count). Player trims in **non-album contexts only** (radio, mixes, shuffle, playlists with the setting on); album playback stays untouched (gapless art is deliberate).
- Trim = seek offset on start + early-advance near end via the existing track-end watchdog path; no engine API change.

### Phase T2 — adaptive crossfade

- New pure policy module beside `nextTrackPreloadPolicy`: inputs `(current: {bpm, energy, trailingSilence}, next: {bpm, energy, leadingSilence}, context)` → `{ type: cut | fade, fadeMs, nextStartOffsetMs }`. Deterministic table, unit-fixtured:
  - album context → `cut` (never fade inside albums)
  - energy step down > threshold → longer fade (up to 6 s)
  - matched high energy → short fade (1–2 s)
  - either track shorter than 30 s, or classical/spoken genre tags → `cut`
- User modes: `off | fixed(n) | smart`. Smart requires loudness shipped (fades between unleveled tracks pump).
- **Engine capability contract:** crossfade needs two simultaneous voices. The engine interface gains optional `supportsDualVoice`; howler slot: yes (parallel Howl instances — the preload instance becomes the second voice); native element engine: second `<audio>` element behind the same gesture/session rules — must not regress the iOS interruption-survival behavior, so background transitions degrade to `cut` when the page is hidden; declared per engine and reflected in settings UI (mode greyed with reason when unsupported).
- Fade curves: equal-power. Gain compositing must stack correctly with loudness gain and user volume (single multiplicative chain, tested).

### Phase T3 (stretch, separate decision) — beat alignment

Requires beat-grid phase data the analyzer does not store; explicitly out of scope until T1/T2 ship and a beat-tracking pass is costed.

## Rollout and testing

1. Loudness measurement + backfill (no playback change) → 2. player gain + modes + Subsonic extension → 3. T1 silence → 4. T2 crossfade.
- Policy modules: pure unit fixtures (the campaign pattern). Engines: component-harness cases for gain compositing and dual-voice fallback. Measurement: golden-file tests with generated tones (known LUFS) through the analyzer pass.
- Metrics: histogram of applied gain (bounded buckets) to observe real-library spread; counter of clamped boosts.

## Non-goals

- Server-side loudness rewriting or tag writing (library files are never modified).
- DSP beyond gain (EQ, dynamics) — separate future discussion.
- Crossfade in Subsonic clients (client-side concern; they get ReplayGain data only).

## Open questions

- Genre-exclusion list for smart fades (classical/spoken/live) — tag-based heuristic vs user-managed list.

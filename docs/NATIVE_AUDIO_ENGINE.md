# Native Audio Element Engine

The native engine is the **default** direct-playback backend as of 1.8.0: it drives a single browser-owned `<audio>` element instead of Howler.js, implements the same `AudioEngine` contract as the other backends, and plugs into the hybrid runtime router — no orchestrator changes. Howler remains the gated fallback: set `STREAMING_ENGINE_MODE=howler` to revert a deployment, and the Android WebView platform pin selects Howler automatically.

Tracked in GH issue #42.

## Why It Exists

Howler's abstractions carry a workaround tax for this app's direct-stream playback:

- Its `onend` is timer-polled and dies under background timer throttling (we bind a parallel native `ended` listener as a fallback).
- Its internal HTML5 audio pool can exhaust.
- Its unlock/autoplay dance needs retry scheduling and loop caps.
- Every track switch creates/destroys `Howl` instances; the gap between "old Howl not yet cleaned up" and "new Howl playing" is where double-play lives.

Owning one element makes double-play structurally impossible within the engine: assigning `audio.src` synchronously stops the old stream before the new one exists. The browser natively handles buffering, seeking, format detection, and autoplay policy.

**Hi-res audio is a design constraint.** The bare media-element pipeline is the best hi-res path a browser can offer for 24-bit/192 kHz FLAC. The engine never routes through an `AudioContext` except the one narrowly gated iOS bridge below.

## Selecting an Engine

The native engine is the default — no configuration needed. To revert a deployment to the legacy Howler engine:

```bash
# docker compose (frontend runtime env, not a build arg)
STREAMING_ENGINE_MODE=howler docker compose up -d frontend

# AIO
STREAMING_ENGINE_MODE=howler docker compose -f docker-compose.aio.yml up -d soundspan
```

Helm: set `STREAMING_ENGINE_MODE: howler` under the frontend deployment's runtime env (see `charts/soundspan/values.yaml`).

The flag doubles as a live diagnostic: a user reporting double-play or background playback death can be flipped between engines to isolate the layer.

## Selection Precedence

Selection is explicit and unit-tested (`frontend/lib/audio-engine/engineSelectionPolicy.ts`), highest priority first:

1. **Platform pins.** Android WebView is pinned to Howler even when the flag is `native` — Howler's Web Audio mode is the established fix for crackling/popping on track changes there.
2. **The engine-mode flag.** `native` (the default when unset) selects the native element engine; `howler` selects the legacy engine.
3. **Default.** Native (`DEFAULT_STREAMING_ENGINE_MODE` in `frontend/lib/audio-engine/types.ts`).

## Architecture

| Piece                | File                                                    | Role                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy state machine | `frontend/lib/audio-engine/nativeAudioElementPolicy.ts` | Pure transition function owning every playback decision: lifecycle states, single load path with autoplay captured at load time, queued seeks before readiness, seek-mark suppression of stale `timeupdate` positions, bounded retry exhaustion, autoplay gesture retry, media-error classification. |
| Controller           | `frontend/lib/audio-engine/nativeAudioElementEngine.ts` | Applies transitions and executes effects against the single engine-owned element. No decision logic of its own.                                                                                                                                                                                      |
| iOS bridge           | `frontend/lib/audio-engine/iosStandalonePwaBridge.ts`   | The one sanctioned `AudioContext` path (below).                                                                                                                                                                                                                                                      |
| Selection policy     | `frontend/lib/audio-engine/engineSelectionPolicy.ts`    | Direct-slot selection precedence and Android WebView detection.                                                                                                                                                                                                                                      |

Key behaviors:

- **Native is a direct mode.** Direct stream URLs are used exactly as in howler mode. (The Video.js segmented/DASH engine was removed in issue #534; direct playback is the only path.)
- **End detection** is the native `ended` event only — it is media-pipeline driven and fires under background timer throttling. No heartbeat/polling monitors; position updates come from `timeupdate` plus a 1 s ticker.
- **Seeks** are direct `currentTime` assignments. A seek requested while loading is stored and applied on `loadedmetadata` (load-bearing for podcast/audiobook resume-at-position). A ~300 ms seek mark suppresses stale positions instead of lock flags and timers.
- **Autoplay policy**: the native `play()` promise is used. `NotAllowedError` surfaces a user-gesture requirement and arms exactly one gesture retry — never a loop. Automatic retries are bounded and exhaust into an explicit error instead of showing "playing" while nothing plays.
- **Auth rotation**: stream URLs carry rotating tokens. A media error after a long pause (≥ 60 s) is classified as a stale source and recovered by reloading from the orchestrator-provided source at the current position, distinct from genuine network failure.
- **Background/network errors** (`MEDIA_ERR_NETWORK` while the page is hidden — the canonical iOS session-reclaim signature) preserve the current media so the existing foreground-recovery path can retry on return, and error payloads carry the `MEDIA_ERR_*` name plus the numeric code as a string for the orchestrator's classification.
- **Preload** uses a single muted, never-playing buffer element (capped at one) to warm the browser cache for the next track; the main element still performs the only audible load. The existing `nextTrackPreloadPolicy` behavior is preserved.
- **BFCache**: `pageshow` with `persisted=true` revalidates engine state against the element so a restored page cannot desync from React state.
- **No silent-audio keepalive loops and no Web Locks** — a persistent silent element steals audio focus from Bluetooth/CarPlay, and `navigator.locks` is insufficient on iOS.

## The iOS Standalone PWA AudioContext Bridge

In standalone (installed) PWAs, iOS suspends background audio behavior of a bare `HTMLAudioElement` — the next track fails to auto-play at track end and MediaSession controls go dead while the UI still claims "playing" ([WebKit bug 261858](https://bugs.webkit.org/show_bug.cgi?id=261858); Safari-tab playback is unaffected). Routing the element through an `AudioContext` (`createMediaElementSource` → `destination`) holds the audio session durably.

The bridge is gated to **iOS user agent AND `display-mode: standalone`** only, set up lazily on the first user-gesture play. Desktop, Android, and iOS Safari tabs keep the bare-element hi-res path. iOS hardware output is 48 kHz regardless, so the bridge costs nothing there.

## Telemetry & Soak

All playback client metrics (`[Playback][ClientMetric]` log lines and the backend beacon) carry two engine tags:

- `engineMode` — the deployment flag (`STREAMING_ENGINE_MODE` as resolved). Identifies the rollout cohort.
- `activeEngine` — the engine actually driving playback at the moment of the event (`howler` or `native`). Platform pins (Android WebView → howler) make this legitimately diverge from `engineMode`, so use `activeEngine` for performance/error comparison and `engineMode` for cohort segmentation. A divergence outside those known cases (e.g. `engineMode: native` with `activeEngine: howler` on a non-WebView client) indicates a selection-policy bug.

For 2.0.0 log queries, `player.howler_startup` became
`player.engine_startup`, and client-signal ingestion moved from
`route.client.signal` / `[SegmentedStreaming.Trace]` to
`playback.client.signal` / `[Playback.Trace]`. The always-on client-signal
metric log identity likewise moved from `[SegmentedStreaming][Metric]` to
`[Playback.Metric]`, and client-ingestion errors moved from the
`[SegmentedStreaming]` scope to `[Playback]`. (The segmented manifest,
segment, and session traces themselves were removed with the segmented
engine in issue #534.)

This makes howler and native directly comparable over a soak window: playback error events by `MEDIA_ERR` code, playback-start latency, and recovery attempts. The engine additionally emits `[NativeAudioEngine][Telemetry]` events (`playback_start_latency`, `recovery_attempt`, `playback_error`, `load_retry_applied`) tagged `engineMode: native`.

Those were the exit criteria for flipping the default (met during the 1.7.0 soak: no metric regression against the howler baseline, zero new double-play/background-death reports). They remain the criteria for evaluating any deployment that reverts to `howler` and considers switching back.

## Manual Test Matrix (exercised during the 1.7.0 soak; re-run when the engine changes materially)

- Desktop Chrome/Firefox/Safari playback, seek, track advance
- 24/192 FLAC plays via the bare element pipeline (no AudioContext in the default path)
- iOS Safari tab; iOS installed PWA (backgrounded ≥ 5 min, lock screen controls, AirPods/CarPlay)
- Android Chrome (screen off ≥ 5 min, Bluetooth); Android WebView stays pinned to Howler
- Phone-call interruption resume on iOS and Android
- Listen Together session with the native engine on at least one participant
- Podcast/audiobook resume-at-position (queued-seek path)
- MediaSession state after engine error, queue clear, and background track advance

## Rollout

Opt-in flag (1.7.0) → soaked on the operator deployment → default flipped to `native` in 1.8.0. Howler remains the gated fallback (not removed). Out of scope at rollout time: removing Howler/Video.js/Tauri adapters, crossfade, and true bit-perfect hi-res output (impossible from web APIs). Since then the Tauri adapter (issue #607) and the Video.js segmented engine (issue #534) have both been removed; the engine matrix is native (default) plus Howler (fallback).

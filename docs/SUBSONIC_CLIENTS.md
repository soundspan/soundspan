# Subsonic Clients on Mobile


## The mobile story

soundspan's mobile story is deliberate: there is no native soundspan app, and none is planned.

- **PWA** for the full soundspan experience: install the web app from your mobile browser for discovery, Vibe, podcasts, audiobooks, admin, and the native player.
- **Subsonic clients** for native ergonomics: offline caching, Android Auto / CarPlay, platform audio integration, and battery-friendly playback through soundspan's OpenSubsonic-compatible `/rest` API.

Both are first-class. Use the PWA when you want everything soundspan does; use a Subsonic client when you want a native music player.

The authoritative protocol contract is [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md). This page is the client-facing view of that contract.

## Connecting a client

1. Create an app password: **Settings → Sign-in & Security → App Passwords**. The generated secret starts with `ssap_`, is shown once, works only on `/rest`, and can be revoked independently.
2. Server URL: your normal soundspan URL (the frontend proxies `/rest` to the backend). Backend-direct deployments can target the backend port instead.
3. Username: your soundspan username. Password: the app password.
4. Prefer token authentication when the client offers it; every client below supports it.

Supported auth modes: token (`u`+`t`+`s`), password (`u`+`p`, including `enc:` hex), and `apiKey` query auth (OpenSubsonic extension). Form-encoded POST is accepted across the surface.

## Compatibility matrix

Clients and versions assessed:

| Client | Version | Platform | Source |
| --- | --- | --- | --- |
| Symfonium | 15.0.1 (2026) | Android (paid) | [symfonium.app](https://symfonium.app/) |
| Tempo | 3.9.0 | Android (FOSS) | [github.com/CappielloAntonio/tempo](https://github.com/CappielloAntonio/tempo) |
| DSub2000 | 5.7.4 (2026-05-17) | Android (FOSS) | [github.com/paroj/DSub2000](https://github.com/paroj/DSub2000) |
| Ultrasonic | 4.9.0 | Android (FOSS) | [gitlab.com/ultrasonic/ultrasonic](https://gitlab.com/ultrasonic/ultrasonic) |
| play:Sub | 2026.1.22 | iOS (paid) | [App Store](https://apps.apple.com/us/app/play-sub-music-streamer/id955329386) |

Verdict legend:

- **Verified** — exercised against soundspan by the request-profile matrix or smoke harness recorded in [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md).
- **Expected** — the server implements it and the client documents support; not yet exercised on a real device against soundspan.
- **Client N/A** — the client does not use this capability, so nothing is lost server-side.
- **Server gap** — the client could use it but soundspan does not provide it (linked issue where one exists).

| Feature | Server support | Symfonium | Tempo | DSub2000 | Ultrasonic | play:Sub |
| --- | --- | --- | --- | --- | --- | --- |
| Token auth (`t`/`s`) | Yes (app passwords) | Expected | Expected | Expected | Expected | Expected |
| Password auth (`p`) | Yes | Expected | Expected | Expected | Expected | Expected |
| API-key auth | Yes (extension) | Expected | Client N/A | Client N/A | Client N/A | Client N/A |
| Browse (ID3: artists/albums/songs) | Yes | Verified¹ | Expected | Expected | Expected | Expected |
| Browse (folder: `getMusicDirectory`) | Yes | Expected | Expected | Expected | Expected | Expected |
| Search (`search2`/`search3`, empty-query full sync) | Yes | Verified¹ | Expected | Verified¹ | Expected | Expected |
| Stream with Range/seek | Yes | Expected | Expected | Expected | Expected | Expected |
| Transcoding (`maxBitRate`) | Yes (192/320 tiers) | Expected | Expected | Expected | Expected | Expected |
| Seek in transcoded stream (`timeOffset`) | Yes (transcode tiers; raw ignores offset) | Expected | Client N/A | Client N/A | Client N/A | Client N/A |
| Playlists (full CRUD) | Yes | Verified¹ | Expected | Expected | Expected | Expected |
| Star / unstar / rating | Yes² (star state, 1-5 ratings, and play counts appear on every song payload) | Verified¹ | Expected | Expected | Expected | Expected |
| Play-queue sync | Yes³ | Expected | Expected | Expected | Expected | Expected |
| Indexed play queue (`…ByIndex`) | Yes (advertised, `currentIndex` contract) | Expected | Client N/A | Client N/A | Client N/A | Client N/A |
| Bookmarks | Yes | Expected | Client N/A | Expected | Expected | Expected |
| Lyrics (plain, `getLyrics`) | Yes | Client N/A⁵ | Expected | Expected | Expected | Client N/A |
| Synced lyrics (`getLyricsBySongId`) | Yes (extension) | Expected | Expected | Client N/A | Client N/A | Client N/A |
| ReplayGain over the API | Yes (extension, song objects) | Expected | Expected | Client N/A⁶ | Client N/A | Client N/A⁶ |
| Last-played dates (`songPlayedDate`/`albumPlayedDate`) | Yes (per-user `played` on songs and albums) | Expected | Client N/A | Client N/A | Client N/A | Client N/A |
| Offline cache / downloads (`download`) | Yes | Expected | Expected | Expected | Expected | Expected |
| Scrobble / now playing | Yes | Verified¹ | Expected | Expected | Expected | Expected |
| Jukebox control | No (out of scope) | Client N/A | Client N/A | Server gap | Server gap | Server gap |
| Podcasts over `/rest` | Empty stubs only⁷ | Client N/A | Server gap⁷ | Server gap⁷ | Server gap⁷ | Server gap⁷ |
| Shares | No (product decision pending) | Client N/A | Client N/A | Server gap | Client N/A | Client N/A |

Notes:

1. "Verified" cells rest on feature-specific request-profile evidence recorded in [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md): a cell is Verified only when that client's profile exercised that feature (for example `symfonium` search3 full sync and playlist CRUD, `dsub` search2, `ultrasonic` getIndexes/scan, `substreamer` indexed queues). Everything else stays Expected until the profile or a real device exercises it; full GUI-client certification remains open.
2. Album/artist star is projected onto matching tracks; there are no separate album/artist favorite tables.
3. Queue state uses the legacy playback-state device bucket. `getPlayQueue` exchanges `current` as a song ID per the classic contract, and the ByIndex extension endpoints use `currentIndex`.
4. Symfonium discovers capabilities via `getOpenSubsonicExtensions`; `indexBasedQueue` is advertised, so capability-driven clients can use the indexed queue endpoints.
5. Symfonium prefers the structured `getLyricsBySongId` extension when advertised.
6. DSub2000 and play:Sub apply gain from file tags on cached audio rather than the OpenSubsonic `replayGain` API fields.
7. soundspan's native podcast domain is not exposed over `/rest`; `getPodcasts`/`getNewestPodcasts` return empty successes so probing clients do not fail. Use the PWA for podcasts.

Client capability columns are compiled from each client's documentation, changelogs, and release notes at the versions listed; re-check them when a client ships a major release.

## Extension roadmap

Advertised today at v1: `apiKeyAuthentication`, `formPost`, `replayGain`, `songLyrics`, `transcodeOffset`, `songPlayedDate`, `albumPlayedDate`, `indexBasedQueue`.

| Extension | State | Next step |
| --- | --- | --- |
| `replayGain` | Shipped | None — gains computed against `LOUDNESS_TARGET_LUFS`; unmeasured tracks fill in as the background measurement reaches them |
| `formPost` | Shipped (validated with Music Assistant) | None |
| `apiKeyAuthentication` | Shipped | None |
| `songLyrics` | Shipped | None |
| `transcodeOffset` | Shipped | None — ffmpeg input seeking on transcode tiers; raw streams ignore the offset |
| `songPlayedDate` / `albumPlayedDate` | Shipped | None — per-user `played` timestamps on songs and albums |
| `indexBasedQueue` | Shipped | None — advertised with the `currentIndex` wire contract |
| Transcoding decision (`getTranscodeDecision`/`getTranscodeStream`) | Not implemented | Deferred — revisit if a target client fails a core workflow without it |
| HLS | Not implemented | Deferred — soundspan streams via the native/Howler engines; segmented streaming is out of scope |

The exhaustive missing-endpoint catalog, non-goals, and revisit triggers live in [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md).

## Keeping this matrix honest

Re-test per release:

1. `cd backend && npm run test:smoke` with `SMOKE_SUBSONIC_USER`/`SMOKE_SUBSONIC_PASSWORD` runs the health and Subsonic profile checks; `SMOKE_MODE=full` plus `SMOKE_REQUIRE_TRACKS=true` covers the track-dependent surface.
2. Device passes (upgrade Expected → Verified): connect the real client with an app password and walk browse → search → stream/seek → playlist edit → star → queue restore → lyrics → offline cache. Record client version and date here.
3. `SUBSONIC_TRACE_LOGS=true` prints per-request `/rest` trace lines (endpoint, client `c`, protocol status) without logging secrets — the fastest way to see what a misbehaving client actually sends.

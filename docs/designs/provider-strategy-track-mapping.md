# Provider Strategy & Track Mapping Redesign

Brainstormed 2026-02-28. Status: design phase, no implementation yet.

---

## Provider Strategy

### Deezer: Remove from user-facing features
- Browse page today is a Deezer storefront, but 30-second preview cap without account makes it frustrating
- Not worth investing in gap-fill
- Keep backend Deezer service for cover art/metadata fallback only

### Spotify: Remove from user-facing streaming
- API 5-user development cap; app verification has strict commercial requirements
- Keep anonymous playlist URL parsing (no user OAuth) for playlist imports
- Strip indexer/download logic from import flow
- No "connect Spotify," no Spotify streaming, no Spotify gap-fill

### YouTube Music: Elevate to primary free-tier provider
- Full-length playback works for free, no app verification issues, no meaningful API limits
- Becomes default Browse experience and first-class gap-fill provider
- No concerns about OAuth limits per user's confirmation
- **Universal fallback:** YT Music serves as automatic free-tier resolution for ALL playlist imports, even for users with no connected services
- Search already works unauthenticated (uses `YTMusic()` with no credentials, avoids polluting user's YT history)
- Streaming currently gated behind OAuth in sidecar code, but underlying yt-dlp extraction is unauthenticated — small sidecar modification needed to allow unauthenticated streaming path
- Sidecar details: `_get_ytmusic(user_id)` check at top of `/stream` and `/proxy` endpoints (lines ~1586, ~1613 in app.py) is the only gate; yt-dlp (`_get_stream_url_sync`) doesn't use OAuth
- `ytmusicapi` = search/matching (unauthenticated), `yt-dlp` = stream URL extraction (unauthenticated)

### Tidal: Keep as premium gap-fill
- Works well today via device-code OAuth
- Remains highest-priority streaming source for connected users

---

## Browse Page Overhaul

- Replace Deezer Browse with YouTube Music Browse (full-length free playback for everyone)
- YT Music Browse always visible and playable (baseline for all users)
- Tidal Browse appears as additional tab/section when user has Tidal connected
- Optional: non-connected users see "connect Tidal to unlock" state on Tidal tab
- **Browse -> Play flow:** Clicking play on a Browse playlist creates an inline temporary queue — full track playback, no import required
- Users can optionally "Import this playlist" to save it as their own playlist in the platform
- Do NOT auto-create playlists or transient playlists — avoid compounding into unmanageable state
- Deprecate existing Deezer Browse UX, add new YT Music Browse alongside

---

## Playlist Restructuring

### Core change: playlists accept remote sources
- Today: playlist = list of local files
- Future: playlist = list of track references that resolve per-user based on available sources

### Import flow (Spotify, YT Music, Tidal URL imports)
1. Pull track list metadata from source URL
2. Match against local library first (ISRC, then artist+title+album+duration)
3. Check existing TrackMapping/TrackTidal/TrackYtMusic entries
4. **Tracks with no local match and no existing mapping:** auto-search YT Music unauthenticated, create TrackYtMusic + TrackMapping — ensures playlist is playable even with zero connected services
5. **Also resolve all available providers at import time** (e.g., if user has Tidal, match Tidal AND YT Music) so fallback is automatic if a service is later disconnected
6. No download queue, no indexer matching — resolution only
7. Result: most playlists are fully playable on import via YT Music free tier as universal fallback

### PlaylistItem changes
- Adds `trackTidalId?` and `trackYtMusicId?` (new nullable FKs)
- Existing `trackId` stays untouched — all current playlists work as before

### Unplayable tracks in shared playlists
- Tracks user can't resolve: red/greyed out with tooltip ("Connect Tidal to play this track")
- Skip-on-play behavior (don't halt queue)
- Summary at top: "12 of 15 tracks playable"

### Service disconnection handling
- Per-user per-track resolution (local > tidal > youtube) handles this naturally
- Since all providers are resolved at import time, disconnecting Tidal falls back to YT Music automatically
- No special re-resolution needed — the mappings already exist

### Existing PlaylistPendingTrack
- Keep existing functionality in place (additive/backwards compatible, no breaking changes)
- Deprecate in favor of new import flow
- Clean up cruft later once new system is stable

---

## New Data Model

### New Tables

**TrackTidal** — Tidal's representation of a track:
- `id`, `tidalId` (numeric, **unique constraint**), `title`, `artist`, `album`, `duration`, `isrc`, `quality`, `explicit`, `createdAt`

**TrackYtMusic** — YouTube Music's representation of a track:
- `id`, `videoId` (**unique constraint**), `title`, `artist`, `album`, `duration`, `thumbnailUrl`, `createdAt`
- Note: `videoId` is a permanent YouTube identifier. Stream URLs are extracted at playback time via yt-dlp and expire after a few hours — only `videoId` is stored, never the stream URL.

**TrackMapping** — assertion/glue layer ("we believe these are the same track"):
- `id`
- `trackId?` -> Track (nullable)
- `trackTidalId?` -> TrackTidal (nullable)
- `trackYtMusicId?` -> TrackYtMusic (nullable)
- `confidence` — match certainty
- `source` — enum: `gap-fill`, `isrc`, `import-match`, `manual`
- `createdAt`

### Provider table deduplication
- Unique constraints on `TrackTidal.tidalId` and `TrackYtMusic.videoId`
- Import logic does upsert: find existing by provider ID, create only if new
- Prevents duplicate rows from multiple imports of the same track

### Existing Tables (unchanged)
- **Track** — completely untouched. Local files, album relationships, analysis data.
- **PlaylistItem** — adds two new nullable FKs, existing `trackId` FK unchanged.

### Key Design Principles

1. **TrackMapping is advisory, not authoritative.** Doesn't own data. Connects independent records. Wrong mapping? Delete it, nothing else affected. If TrackMapping table disappeared, local playback and direct provider streaming still work.

2. **No uniqueness constraints on TrackMapping FKs.** A Track/TrackTidal/TrackYtMusic can appear in multiple mapping rows. Handles same song on multiple albums correctly.

3. **Local tracks are authoritative but not merged.** New local track does NOT attach to existing TrackMapping/remote entries. Stays in its album. Forward gap-fill runs instead (find Tidal/YT equivalents for this specific album context). Background worker separately reconciles remote-only entries.

4. **Everything is additive/non-breaking.** Track table untouched. Existing playlists untouched. Old functionality identical until ready to remove cruft.

---

## Flow Details

### Album Page Gap-Fill (evolution of existing)
1. Album loads, local Tracks displayed (unchanged)
2. **Check TrackMapping first** — if mappings exist for these tracks, skip API calls
3. For tracks without mappings: gap-fill runs against Tidal/YT Music APIs (existing behavior)
4. **New:** Results persisted — TrackTidal/TrackYtMusic rows created, TrackMapping rows linking to local Track
5. Next user: TrackMapping exists, instant resolution
6. Frontend hooks (`useYtMusicGapFill`, `useTidalGapFill`) become "check cache, then fill gaps in cache"

### Playlist Import (new)
1. User pastes Spotify/Tidal/YT Music playlist URL
2. Track metadata pulled from source
3. Each track: match against local library first (ISRC, then artist+title+album+duration)
4. Each track: check existing TrackMapping/TrackTidal/TrackYtMusic entries
5. **Tracks with no local match and no existing mapping:** auto-search YT Music unauthenticated, create TrackYtMusic + TrackMapping
6. **Also match against user's other connected providers** (resolve Tidal AND YT at import time for fallback resilience)
7. Create PlaylistItem pointing to best reference found (trackId for local, trackTidalId/trackYtMusicId for remote)

### Playback Resolution (per-user, per-track)
Priority: Local file > Tidal (if connected) > YT Music (if connected or free) > Unplayable (red, skipped)

For items with only trackTidalId, resolution checks TrackMapping for local Track or TrackYtMusic equivalents.

### New Local Track Scan (forward gap-fill on ingest)
1. Library scan finds new file -> Track row created (unchanged)
2. **New:** Forward gap-fill runs for this track, scoped to its album context
3. TrackTidal/TrackYtMusic and TrackMapping rows created
4. Album context (artist+title+album+duration) prevents conflating studio/live/remaster versions
5. Does NOT attempt to attach to existing remote-only TrackMapping entries — keeps album-track integrity

### Background Reconciliation Worker (new)
- Runs on schedule, purely additive, never modifies existing records
- Finds TrackTidal/TrackYtMusic without TrackMapping to local Track
- Attempts matching against local library (ISRC first, then metadata)
- Creates TrackMapping rows for high-confidence matches only
- Effect: remote-only playlist tracks can resolve to local playback over time

### Backfilling Existing Libraries
- **Lazy, not bulk.** No mass gap-fill on deployment.
- TrackMapping populated on first album page view (same cold-start cost as today)
- Existing local playback is unaffected — albums work identically until gap-fill runs

---

## Dead Mapping Handling

- YouTube videos get taken down, Tidal tracks get delisted
- If a stream request fails (404/410/unavailable), keep the TrackTidal/TrackYtMusic row but mark it as stale
- Playlist UI: gray out the track as "No longer available" rather than deleting
- Attempt fallback to next provider in priority chain
- Do NOT delete TrackMapping rows — the mapping was correct, the content just disappeared

---

## YT Music as Universal Fallback

- Any playlist import (Spotify, Tidal, YT Music URL) automatically resolves unmatched tracks through YT Music free tier
- Users with zero connected services still get fully playable playlists
- Creates a natural tiered experience:

| Tier | Experience |
|---|---|
| No accounts | Full playback via free YT Music (lower quality) |
| YT Music connected | Better quality, ad-free YT streams |
| Tidal connected | Premium/lossless quality on matched tracks |
| Local files | Best quality, no external dependency |

- Import resolution waterfall: local match -> existing TrackMapping -> auto YT Music search -> unplayable (rare)
- Sidecar needs minor modification: add unauthenticated code path in `/proxy` endpoint (skip OAuth check, yt-dlp extraction is already unauthenticated)

---

## Region Handling

- Edge case given self-hosted nature (target: ~15-20 users max, friends/family)
- Hardcoded US default for provider region
- Configurable via exposed runtime variable for non-US deployments
- When user connects YT Music/Tidal OAuth, could auto-detect region from their account and update provider config
- Failed streams due to region restrictions: fall to next provider reactively

---

## Search Across Providers (Future Consideration)

- Currently out of immediate scope but high-value
- Search results could include remote-only tracks (from TrackYtMusic/TrackTidal) alongside local results
- "We don't have this locally, but you can stream it" — makes search much more powerful
- Would leverage existing TrackMapping/provider tables

---

## Risks / Open Items

- **yt-dlp 403/429 rate limiting:** Unauthenticated yt-dlp requests to YouTube are susceptible to 403 Forbidden and 429 rate limit responses. Need to verify current User-Agent and header configuration — may need to pass a browser-like User-Agent, use yt-dlp's `--extractor-args` for PO tokens, or implement request throttling/backoff. This risk increases significantly with unauthenticated streaming at scale since there's no OAuth session to lean on. Investigate what yt-dlp headers/config the sidecar currently sends.
- **Player/queue mixed sources:** Queue could have local/Tidal/YT interleaved. Works fine today on album pages; investigate further when approaching playlist implementation.
- **Stream URL expiry:** Not a storage concern — `videoId` is permanent, stream URLs extracted at playback time via yt-dlp. But need graceful handling if extraction fails (retry, fallback).

---

## Outcome Summary
- **Self-improving:** Every gap-fill, import, and scan enriches the mapping layer
- **Non-breaking:** All new tables/FKs are additive; existing functionality untouched
- **Per-user resolution:** Same playlist renders differently based on each user's providers/library
- **Provider-agnostic playlists:** Imported from Spotify, resolvable through Tidal/YT/local
- **Zero-friction onboarding:** New users can import and play playlists immediately via YT Music free tier
- **Deprecate-in-place:** Old Deezer Browse and PlaylistPendingTrack stay functional, new features built alongside, cruft cleaned later

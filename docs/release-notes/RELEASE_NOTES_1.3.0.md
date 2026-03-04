# soundspan 1.3.0 Release Notes - 2026-03-04

## Release Summary

soundspan 1.3.0 is a major feature release that adds full TIDAL and YouTube Music integration across the platform. Users can now browse, stream, like, and import tracks from both providers — with intelligent cross-provider fallback so a track available on one service can play through the other when needed. The UI has been consolidated around a new Explore page, playlist import supports all four providers in a single flow, and Listen Together sessions now work seamlessly across mixed-provider libraries. This release also includes a security hardening pass and significant iOS playback reliability improvements.

## Fixed

- TIDAL lossless streams could show a ~4 second duration instead of the full track length when using HI_RES_LOSSLESS quality.
- Playlist and Subsonic API responses could fail when referencing remote-only tracks without a local library entry.
- Track mapping validation accepted payloads with no provider linkage, which could create orphaned mappings.
- Mapping selection could return inconsistent results when multiple mappings existed for the same track.
- Listen Together could repeatedly pause and resume playback even when the current track hadn't actually changed.
- Listen Together could lose track of the active group or try to play a track index beyond the end of the queue.
- TIDAL sidecar DASH streaming could fail due to missing initialization segments or incorrect codec detection from the manifest.
- Remote playback could fail when format overrides conflicted with provider stream negotiation, and empty TIDAL browse shelves could cause rendering errors.
- Tracks with zero duration from remote providers were incorrectly rejected during metadata validation.
- The Swagger UI at `/api/docs` could enter a redirect loop due to inconsistent trailing-slash handling.
- Liked tracks pagination could skip entries, and unusual playlist URLs could fail to parse during import.
- Spotify playlist import could fail entirely when the anonymous token endpoint was unavailable, instead of falling back to alternative parsing.
- Liking or playing a remote track could overwrite its real metadata (title, artist, album) with placeholder values if the track was re-encountered before enrichment completed.
- Background reconciliation could fail with a database conflict when linking an orphaned mapping to a local track that already had an active mapping for the same provider row.
- Large playlist imports could time out on the preview step before provider resolution finished.
- YouTube Music metadata refresh required a user's personal OAuth session, preventing background enrichment of tracks that no user had browsed yet.
- TIDAL playlist imports required visiting a TIDAL page first to warm up the sidecar session; imports now restore saved credentials automatically.
- Cover mosaic could overflow its container when displaying a single cover image.

## Added

- **Cross-provider track mapping**: a new mapping layer links local library tracks to their TIDAL and YouTube Music equivalents with confidence scores, staleness tracking, and database-enforced uniqueness. Mappings are created automatically when you like or play a remote track, and a background reconciler continuously matches remote-only tracks back to your local library using audio fingerprints and metadata similarity.
- **TIDAL and YouTube Music browsing**: full discovery surfaces for both providers — TIDAL home shelves, explore picks, genres, moods, and mixes; YouTube Music home shelves, charts, and mood/genre categories. All accessible from the new Explore page.
- **Explore page**: Home, Browse, Radio, and Discovery have been merged into a single `/explore` landing with For You content, library radio stations, and tabbed provider browsing for YouTube Music and TIDAL.
- **Unified playlist import**: paste a Spotify, Deezer, YouTube Music, or TIDAL playlist URL into the import page. A preview shows per-track resolution status (local match, TIDAL, YouTube, or unresolved) with confidence scores before creating the playlist. TIDAL and YouTube Music imports work even without a personal account by falling back to public browse.
- **Remote tracks in playlists**: playlist items can reference TIDAL or YouTube Music tracks directly. The detail page shows provider badges and playability indicators, and each item resolves to the best available source for the current user.
- **Remote track likes and play history**: like and unlike TIDAL and YouTube Music tracks just like local ones. Liked remote tracks appear on the My Liked page with provider badges, and plays are recorded with full metadata.
- **Public YouTube Music playback**: YouTube Music streaming, browsing (albums, artists, songs, playlists), and search work without per-user OAuth. The admin toggle alone unlocks all core YouTube Music functionality.
- **Listen Together with remote tracks**: Listen Together queues now accept TIDAL and YouTube Music tracks. Each listener's playback resolves to the best provider they have connected, with cross-provider fallback through track mappings (e.g., a TIDAL track can play via YouTube Music for listeners without TIDAL).
- **Provider-upgrade reconciliation**: the background reconciler periodically retries YouTube-only track mappings against TIDAL and upgrades successful matches, so TIDAL can be preferred for higher-quality playback.
- **Multi-seed radio**: radio generation from multiple seed tracks computes a combined feature profile and scores candidates against it, improving variety for artist and album radio.
- **Inline playlist rename**: playlist owners can click the title on the detail page to rename it directly. Keyboard-accessible — Enter saves, Escape cancels.
- **Collection-level like button**: playlists and albums now have a heart button that likes or unlikes all tracks in one action.
- **iOS playback improvements**: automatic recovery when returning to the app after iOS reclaims the audio session, next-track preloading to eliminate inter-track silence, and a circuit breaker that stops auto-advancing after 3 consecutive failures.
- **Cover mosaic component**: playlist headers, radio station cards, and the My Liked hero now display 2x2 or 3x2 cover art grids assembled from track artwork.
- **Browse image caching**: TIDAL and YouTube Music thumbnails are cached to disk, reducing repeated external image fetches.
- **Track preview via YouTube Music**: artist page track previews now use YouTube Music video IDs instead of Deezer preview URLs.

## Changed

- The sidebar has been simplified from 8 navigation items to 5: Home, Explore, Library, Listen Together, and Audiobooks/Podcasts. My Liked is pinned as its own sidebar link when you have liked tracks.
- The Home page now focuses on your library — liked summary, Discover Weekly, and community playlists. External browse content has moved to Explore.
- Spotify import no longer triggers the downloader; it resolves tracks against your existing library and connected providers only.
- Playlist detail pages now resolve each item to the viewer's best available source (local > TIDAL > YouTube) and clearly mark items that can't be played. When a mapping exists but the user lacks that specific provider, cross-provider fallback kicks in automatically.
- Artist lists now support filtering by `remote` (artists with only remote tracks) and `all` (library + discovery + remote).
- YouTube Music album, artist, song, and playlist browse pages no longer require per-user OAuth — they fall back to public browse automatically.
- YouTube Music and TIDAL playlist imports work without a personal account by trying public browse when authenticated access isn't available.
- Listen Together enforces a 500-track queue limit with a clear error message.
- Queue and track lists use virtualized rendering for smoother scrolling with large collections.
- Network polling intervals are staggered with random jitter to avoid request spikes.
- Per-user provider visibility toggles (`showYtMusicExplore`, `showTidalExplore`) control which provider tabs appear on the Explore page.

## Admin/Operations

- **Security hardening**: timing-safe comparisons for Subsonic tokens, webhook secrets, and 2FA recovery codes; dummy bcrypt rounds on failed auth to prevent username enumeration; cryptographic device link codes; internal error details stripped from all API responses; SSRF protection on podcast cover downloads.
- **Docker image optimization**: `.dockerignore` reduces build context by ~1.9 GB, production dependency pruning and `.next/cache` cleanup produce smaller images and faster rebuilds.
- **Improved diagnostics**: silent exception paths replaced with scoped debug logging across auth middleware, track-mapping reconciliation, and metadata refresh workers.
- **YouTube Music admin settings**: the OAuth credentials section is now collapsed by default when unconfigured, reducing visual clutter on the settings page.
- **Background workers**: orphan reconciliation finds provider rows with no active mapping and creates gap-fill entries; metadata refresh re-fetches placeholder titles/artists from provider APIs; provider-upgrade reconciliation retries YouTube-only mappings against TIDAL.
- **TIDAL quality cache**: invalidated immediately when the streaming quality setting changes, instead of waiting for expiry.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 1.3.0
```

## Breaking Changes

None. All changes are additive. Existing playlists, likes, and playback history are preserved.

## Known Issues

None at this time.

## Compatibility and Migration

- Database migrations run automatically on startup. New tables (`TrackTidal`, `TrackYtMusic`, `TrackMapping`) and schema changes (nullable `trackId` on playlist items and plays) are applied non-destructively.
- The background reconciler and metadata refresh worker begin processing automatically after upgrade — no manual action required.
- Existing TIDAL and YouTube Music OAuth credentials are preserved and will be used by the new cross-provider features immediately.
- The Explore page replaces the separate Browse, Radio, and Discovery pages. Bookmarks to old routes will need to be updated.

## Full Changelog

- Compare changes: https://github.com/soundspan/soundspan/compare/v1.2.1...v1.3.0
- Full changelog: https://github.com/soundspan/soundspan/blob/main/CHANGELOG.md

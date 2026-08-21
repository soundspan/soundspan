# [2.4.0] Release Notes - 2026-08-21

## Release Summary

The headline: YouTube Music playback works again. YouTube changed how it
delivers audio ("SABR" enforcement) and broke the old streaming path for
everyone; soundspan now downloads each track in the background and plays it
from a small local cache, so playback is reliable again and seeking is
instant. Listen Together also received its deepest reliability work to date:
hosts with a fast system clock no longer skip ahead every few seconds,
member lists stay correct through host transfers and reconnects, and group
state stays consistent even when soundspan runs as several backend replicas.
Around the player, Explore and the /radio page now open station tiles as
browsable playlists instead of silently replacing your queue, search can
find artists and songs you do not own yet, and albums you liked on TIDAL or
YouTube Music now show up properly with artwork. Admins get two new
dashboards — Library Insights (metadata gaps, duplicates, storage, audio
quality) and per-peer Federation Health — plus automatic cleanup of stale
streaming-service leftovers. Upgrading from 2.3.x is a rolling update with
automatic migrations for almost everyone; the one exception is federation
peers on private networks (see "Before you upgrade"), and owners of very
large libraries should expect the first startup to take a little longer
than usual.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.4.0. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- Straightforward rolling upgrade from any 2.3.x — all database migrations
  run automatically. The one exception is federation deployments touching
  private networks or egress proxies; see the bolded bullet below.
- Two of the migrations briefly lock large tables (track-mapping
  housekeeping and an album-ownership integrity guard). On libraries with
  hundreds of thousands of tracks, the first startup after upgrading can
  take extra time while they complete. Pick a quiet moment if that matters
  to you; nothing needs babysitting.
- A daily cleanup job is new in this release: TIDAL and YouTube Music
  catalog rows that are stale, unliked, and unplayable are removed after 30
  days by default. Anything you liked, added to a playlist, played
  recently, or that maps to a real file is always kept. Set
  `PROVIDER_TRACK_RETENTION_DAYS` to tune or effectively disable this.
- **If any federation peer lives on a private network, set
  `FEDERATION_ALLOW_PRIVATE_PEERS=true` before upgrading.** 2.3.3 started
  rejecting peers configured by literal private addresses. 2.4.0 goes
  further: it now resolves peer hostnames and also rejects peers whose DNS
  answer is a private, loopback, or link-local address. A peer reached
  through a hostname that resolves to a LAN or VPN address — common with
  internal DNS or VPN setups — stops syncing after this upgrade until you
  opt in. Peers on public addresses reached directly are unaffected, but
  federation connections no longer honor `HTTP(S)_PROXY` egress proxies:
  the anti-rebinding design connects to the validated address directly.
  The docker-compose files now forward this variable properly.

## Fixed

- **YouTube Music playback works again.** YouTube's SABR delivery
  enforcement broke the old "proxy the stream URL" approach for range
  requests. The sidecar now downloads the complete track through yt-dlp
  and serves playback from a bounded local cache (256 MiB by default,
  oldest tracks evicted first). Concurrent listeners of the same track at
  the same quality share one download.
- **Listen Together hosts no longer skip ahead.** A host whose system
  clock ran faster than the server's would creep forward a few seconds at
  a time until songs ended early. Broadcast echoes no longer position-
  correct the host, follower latency compensation now accounts for
  client-server clock offset, and stale position reports are discarded.
- **Listen Together group state is now correct across restarts, host
  transfers, and multiple backend replicas.** Members with live
  connections are no longer dropped when another replica publishes a
  snapshot, a dropped host who reconnects gets their host role back,
  departures remove exactly the departed member on every server and every
  tab, and joins, leaves, host transfers, and group endings are protected
  by fenced leases so two servers can never commit conflicting changes.
  Group playback also pauses cleanly when a server shuts down mid-song.
- **Deleting a user account now cleans up Listen Together everywhere.**
  Deleting an account from the Admin page previously left the deleted
  user's sessions half-alive. Deletion now reserves the account, evicts
  the user's sockets on every replica, hands off or ends their groups, and
  only then removes the account. The last admin account can never be
  deleted.
- Provider outages no longer make the player rapid-skip through the whole
  queue; consecutive failures trip a breaker that waits for real recovery
  or a manual action.
- Explore no longer logs you out. Temporary backend or network hiccups
  during Explore's burst of requests were misread as rejected credentials;
  they now retry with backoff and keep your session.
- Explore sections backed by YouTube Music or TIDAL show a small inline
  note when they fail to load instead of raising the page-wide "Some
  sections failed to load" banner, and retained content stays visible.
- Volume leveling no longer steps audibly when you change modes or targets
  mid-track, and a slow settings load at startup can no longer silently
  disable it.
- Subsonic apps: seeking within transcoded audio (`timeOffset`) works, play
  queues survive round-trips with the correct current song, songs report
  your latest played time, star timestamps, 1-5 ratings, play counts, and
  bitrates, and the classic (non-ID3) artist/album info endpoints return
  their proper envelopes.
- Artist, audiobook-series, and cover-art pages handle names containing
  percent signs and other encoded-looking characters.
- Liked albums that exist only on TIDAL or YouTube Music now load with
  deduplicated track lists and their real artwork, and stop offering
  actions (like album downloads) that cannot work for them.
- Likes on provider tracks no longer switch identity after metadata
  enrichment, and library cleanup can no longer sweep away remote-backed
  albums and artists.
- The Library Insights drill-downs no longer crash the Admin page, quality
  analytics recognize more audio formats (AIFF fallbacks, APE, WavPack,
  Matroska), and removed-track purges report live progress correctly.
- Loudness measurement is more resilient: the analyzer reconnects to the
  database promptly, transient failures retry on a schedule with bounded
  budgets instead of flooding logs, and replaced audio files get fresh
  measurements with album gain recomputed.
- Backend database connections enable TCP keepalive, which clears up
  "Connection terminated unexpectedly" errors on deployments where traffic
  crosses NAT or firewall hops.
- Vibe: embedding work now saturates all DCLAP replicas instead of
  starving behind long analyzer runs, very long tracks are capped safely,
  and the vibe map build backs off after failures instead of restarting on
  every poll.

## Added

- **Library Insights** on the Admin page: metadata gaps, analysis
  coverage with retry actions, duplicate-cluster reports, storage
  breakdown, and low-bitrate album detection.
- **Federation health**: per-peer Prometheus metrics, an administrator
  health panel with sync/stream/error diagnostics, Grafana panels, and an
  example alert pack.
- **Search finds music you do not own yet**: matching artists from
  Last.fm appear in an Artists section, external track matches appear
  under "Songs to Discover", and an exact name match beats a fuzzy
  library match (searching "Drake" no longer tops out at Nick Drake).
- **Station playlists**: Quick Start, genre, and decade tiles on Explore
  and the /radio page open a generated playlist you can look over before
  playing. Reopening a tile returns the same station; Shuffle All still
  plays instantly.
- External tracks resolve to their albums via MusicBrainz (with Last.fm
  and Deezer fallbacks), so finding one song can lead you to its album.
- A Subsonic client guide (`docs/SUBSONIC_CLIENTS.md`) with a per-feature
  compatibility matrix for Symfonium, Tempo, DSub2000, Ultrasonic, and
  play:Sub, plus instructions for re-verifying it each release.
- Track ratings (1-5 stars) are stored per user and served to Subsonic
  clients.

## Security

- Federation requests now resolve and validate every peer address before
  connecting, reject private and special-purpose ranges (from DNS answers
  too, not just literal addresses), and pin each connection to the
  validated address. This closes DNS-rebinding tricks that could have
  redirected a peer's bearer token. See "Before you upgrade" if your
  peers legitimately live on a private network.
- OpenSubsonic trace logs strip control characters, bound client-supplied
  fields, and keep form-posted credentials out of structured metadata.

## Changed

- Provider-backed vibe embedding accepts 1-32 concurrent workers; the Helm
  chart defaults to two jobs per DCLAP replica. Compose and AIO keep the
  single-job default.
- Stream Info now names the peer library a federated track comes from.

## Deprecated

- `DISCOVERY_MODE=legacy` is deprecated and will be removed in a future
  release; unset `DISCOVERY_MODE` to use the current discovery pipeline.

## Removed

- The Tauri desktop integration. The discontinued desktop app never lived
  in this repository, and the integration was dead code in every shipping
  deployment; playback continues on the standard web engines.
- Segmented/DASH streaming: the Video.js engine, the segmented
  session/manifest/segment endpoints under `/api/streaming/v1` (the
  `client-metrics` endpoint remains), and the `SEGMENTED_*` and
  `LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED` settings. Leftover settings
  are ignored, and `STREAMING_ENGINE_MODE=videojs` falls back to the
  default native engine.
- The `soundspan_transcode_cache_requests_total` metric (only the removed
  segmented service emitted it).

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- The new provider-row cleanup runs daily and after manual purges; it
  drains up to 5,000 rows per provider per run. `PROVIDER_TRACK_RETENTION_DAYS`
  (default 30) controls retention.
- Library and audiobook endpoints now have their own rate-limit budgets,
  applied before authentication.
- The YouTube Music sidecar keeps its playback cache in container-local
  temporary storage (`/tmp`), capped at roughly 256 MiB
  (`YTMUSIC_SPOOL_MAX_BYTES` to tune). It is a disposable cache — it does
  not live on the OAuth data volume and rebuilds itself as tracks play.
  The sidecar also gets a 30-second shutdown grace period in compose and
  Helm so in-flight provider requests drain cleanly.
- docker-compose no longer pins Listen Together lock-timing values, so a
  custom `LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS` now derives safe companion
  values automatically. Defaults are unchanged.
- Federation peer-health metrics are capped at 500 peers per scrape and
  survive PostgreSQL or Redis outages with last-good samples.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.4.0
```

## Breaking Changes

- None for standard deployments. If you had opted into the experimental
  segmented streaming mode (`STREAMING_ENGINE_MODE=videojs`), that mode
  and its segmented session endpoints are gone; playback falls back to the
  standard native engine automatically and the leftover settings are
  ignored rather than rejected. The removed Tauri desktop integration was
  dead code in every shipping deployment.
- Federation peers reached through hostnames that resolve to private
  addresses require the `FEDERATION_ALLOW_PRIVATE_PEERS=true` opt-in, and
  federation traffic no longer routes through `HTTP(S)_PROXY` egress
  proxies (see "Before you upgrade").

## Known Issues

- YouTube Music "library playlists" can intermittently return errors from
  YouTube's side (an upstream API change). Affected Explore sections show
  an inline note, and the failure is cached briefly so it does not hammer
  the API; the section loads again the next time you open or refresh
  Explore.

## Compatibility and Migration

- All schema migrations run automatically at startup. Two of them do
  heavier work on large tables (see "Before you upgrade"); the rest are
  quick catalog changes.
- Rolling multi-replica upgrades are safe. During the mixed-version
  window, Listen Together coordination and admin user deletion keep their
  pre-upgrade behavior until every pod runs 2.4.0.
- Older web clients on the standard playback engines keep working against
  2.4.0 backends; they adopt the new Listen Together ordering guarantees
  after a refresh. A client still pinned to the removed `videojs` mode
  falls back to the native engine.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.4.0. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.3.3...2.4.0](https://github.com/soundspan/soundspan/compare/2.3.3...2.4.0)
- Full changelog: https://github.com/soundspan/soundspan/blob/2.4.0/CHANGELOG.md

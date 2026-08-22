# Usage Guide

This guide covers day-to-day usage of soundspan: setup, navigation, playback behavior, and administration.

For deployment and installation, see [`DEPLOYMENT.md`](DEPLOYMENT.md).
For configuration and security, see [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md).

## First-Time Setup

1. Create the first account (this user becomes admin)
2. Optionally configure integrations (see [`INTEGRATIONS.md`](INTEGRATIONS.md))
3. Wait for initial library scan and enrichment

## Home and Search

- Home surfaces continue listening, recently added artists, Made For You mixes, recommendations, popular artists, community playlists, podcasts, and audiobooks
- Search includes tabs for library, peers, discovery, Soulseek, and podcasts; peer and Soulseek tabs appear when their integrations are enabled
- Search results also surface external artists and songs to discover from Last.fm matches, linking into artist pages for preview and download
- Discovery search supports preview/download/subscription actions
- Explore and `/radio` station tiles (Quick Start, genres, decades) open a generated station playlist you can inspect before playing; Shuffle All still starts playback immediately
- The Vibe Map in the main navigation plots your analyzed library as an explorable similarity map

## Artist Playback Order

Artist-level Play queues owned albums newest-to-oldest, with track ordering by disc and track number.

## Podcast Behavior

Playing an older podcast episode creates a forward-only queue of newer episodes; starting the latest episode plays just that episode. If a queue is already active, the episode (and its not-yet-queued newer episodes) is inserted after the current item instead of replacing the queue, so anything you queued stays queued.

Podcast episodes and music tracks share one mixed-media play queue: while an episode plays you can queue tracks behind it (and vice versa) with "Add to queue" / "Play next", and skip controls and auto-advance move through the combined queue. Listen Together sessions remain music-only.

## Playback Settings

Configure stream/transcode quality and cache behavior in Settings.

Player quality badges show active source details (codec/bitrate or bit depth/sample rate).

### Volume Leveling

Volume leveling evens out loudness differences between songs so you do not reach for the volume knob between a quiet 90s master and a modern loud one. It is on by default in `Automatic` mode: albums played front-to-back keep their intended dynamics, while shuffle, radio, and mixed queues are leveled per song. Set it to `By track`, `By album`, or `Off` under `Settings -> Playback -> Volume leveling`. Leveling only turns loud songs down and gives quiet songs a small, clip-safe boost; songs the analyzer has not measured yet play unchanged until the background measurement catches up.

## Social and History

- Activity panel `Social` tab lists users who are online and sharing presence.
- If a user shares listening activity, their current track appears inline in the Social roster.
- Non-admin accounts only see `Notifications` and `Social` in the activity panel (`Active`, `History`, and `Imports` remain admin-only).
- Open `My History` from `Settings -> History & Personalization` (`Open My History`) for queue-like controls: click-to-play, add to queue, and add to playlist.

## Keyboard Shortcuts

| Key         | Action                   |
| ----------- | ------------------------ |
| Space       | Play / Pause             |
| N           | Next track               |
| P           | Previous track           |
| S           | Toggle shuffle           |
| M           | Toggle mute              |
| Arrow Up    | Volume up                |
| Arrow Down  | Volume down              |
| Arrow Right | Seek forward 10 seconds  |
| Arrow Left  | Seek backward 10 seconds |

## Administration

Admins can manage users, integrations, downloads, enrichment automation, queue dashboards, and API keys.

### Common admin areas

- User Management
- `Connected Now` live card under User Management for currently connected accounts
- Integration and storage settings
- Download source/fallback settings
- Enrichment controls
- Activity panel events and active jobs
- Library Insights panels: metadata gaps, analysis coverage, duplicate clusters, storage breakdown, and low-bitrate albums
- Federation health panel with per-peer sync, stream, and error diagnostics
- API keys and Swagger docs
- Bull Board dashboard (`/api/admin/queues`)

Technical admin configuration and security notes are in [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md).

### Sharing libraries between servers (Federation)

Federation lets two soundspan servers share their music libraries. Sharing is read-only: a connected server can browse and stream your library, but it can never change it.

Every connection has two separate roles:

- **Share my library** — you give another server access to your library.
- **Connect to a library** — you get access to another server's library.

Each direction is set up on its own. There is no single "two-way" switch. This is deliberate: each step tells you clearly whether it worked, so a connection can never half-succeed without you knowing.

Both controls live on the `Admin` page under `Federation`. Federation must be enabled on both servers. The server that shares its library must be reachable from the other server over HTTPS; for two-way sharing that means both servers need an HTTPS address the other can reach.

#### Share your library with a friend

1. Open `Admin -> Federation -> Share my library`.
2. Click `Generate pairing code`.
3. Send the 8-character code to the other admin. The code works once and expires after 30 minutes.
4. The other admin enters your server's URL and the code on their side. Your server then shows them under `Sharing to them`.

If a code expires before it is used, generate a new one. You can have up to five unused codes at a time; creating more than five removes the oldest ones.

If you prefer a long-lived credential instead of a code, use `Host credential`. The credential is shown once — copy it before closing the dialog.

#### Connect to a friend's library

1. Ask the other admin for a pairing code (or a host credential).
2. Open `Admin -> Federation -> Connect to a library`.
3. Enter a name for their server, their server URL, and the code or token.
4. Click `Connect`. Their library appears in your search and browse surfaces after the first sync.

If the connection fails, the error tells you why: the code expired, the code was already used, the server was unreachable, or its certificate failed validation. Each of these has a different fix, so read the message before retrying.

#### Two-way sharing

Two-way sharing means both servers do both steps:

1. You share your library (generate a code) and connect to theirs (redeem their code).
2. The other admin does the same: they share their library and connect to yours.

That is four steps across the two servers. Each peer's card shows the two directions separately — `Sharing to them` and `Consuming from them` — so you can always see exactly which halves are active, offline, or revoked.

#### Instance display name

By default your server introduces itself to peers using its hostname, which in container deployments can look like `soundspan-backend-84975bdf86-h27qt`. Set a friendly name in `Admin -> Federation -> Instance display name` before pairing so the other side sees something readable.

#### Health and diagnostics

The federation health panel shows per-peer sync freshness, stream usage, and the class of the last failure (unreachable, TLS, authentication, or invalid response). It also shows whether vibe embeddings are federating with each peer; if the peers run different embedding spaces, the panel says so and the fix is upgrading the out-of-date server.

---

## See also

- [Deployment Guide](DEPLOYMENT.md) — Docker and compose deployment options
- [Configuration and Security](CONFIGURATION_AND_SECURITY.md) — Environment variables and security hardening
- [Integrations Guide](INTEGRATIONS.md) — Lidarr, Audiobookshelf, Soulseek, YouTube Music, TIDAL, podcasts, and OpenSubsonic
- [Environment Variables](ENVIRONMENT_VARIABLES.md) — Complete env var reference by container

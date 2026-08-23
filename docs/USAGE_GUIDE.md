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
2. Enter a name for the server you are sharing with. Tick the embeddings box if you also want to share the data behind vibe features.
3. Click `Issue credential`. The token is shown once — copy it before closing the dialog.
4. Send the token to the other admin, along with your server's URL. Once they connect, your server shows them under `Sharing to them`.

Online-status sharing is built into every connection, but it is private by default. A user only appears in the other server's Social tab if they turn on both `Share online presence` and `Share presence with trusted peers` in their own Social settings. Remote users always show under a `From <server name>` heading, so it is clear they are on another instance.

If a token is lost or leaked, use `Rotate` on that peer's card to issue a fresh one, or `Revoke` to cut off access.

#### Connect to a friend's library

1. Ask the other admin to issue a credential for you and send you the token, plus their server URL.
2. Open `Admin -> Federation -> Connect to a library`.
3. Enter a name for their server, their server URL, and the token.
4. Click `Connect with token`. Their library appears in your search and browse surfaces after the first sync.

If the connection fails, the error tells you why: the token was rejected, the server was unreachable, or its certificate failed validation. Each of these has a different fix, so read the message before retrying.

#### Two-way sharing

Two-way sharing means both servers do both steps:

1. You issue a credential for them, and connect to their server with the token they issued for you.
2. The other admin does the same on their side.

That is four steps across the two servers. Each peer's card shows the two directions separately — `Sharing to them` and `Consuming from them` — so you can always see exactly which halves are active, offline, or revoked. A peer card without a URL shows `No remote URL — they connect to this server`: that is a server you share to, so the connection always comes from their side.

#### Instance display name

By default your server introduces itself to peers using its hostname, which in container deployments can look like `soundspan-backend-84975bdf86-h27qt`. Set a friendly name in `Admin -> Federation -> Instance display name` before pairing so the other side sees something readable.

#### Health and diagnostics

The federation health panel shows per-peer sync freshness, stream usage, and the class of the last failure (unreachable, TLS, authentication, or invalid response). It also shows whether vibe embeddings are federating with each peer; if the peers run different embedding spaces, the panel says so and the fix is upgrading the out-of-date server.

### Social sharing between servers (Federation)

If your server is federated with others, two social surfaces can cross between them. Both are off by default, and both need two switches: the person sharing must opt in, and nothing is shown unless the receiving side wants it.

**Seeing friends on other servers.** When your admin turns on `Show user status from peers` (under `Admin -> Federation`), the Social tab gains sections like "From Family server" listing people on that server who chose to share. Peer status updates every few minutes — the tab shows how fresh each section is. To appear on other servers yourself, turn on both `Share online presence` and `Share presence with trusted peers` in `Settings -> Social`. Your current track travels only if `Share listening status` is also on.

**Playlists from other servers.** People on federated servers can share their public playlists. Turn on `Share public playlists with trusted peers` in `Settings -> Social` to share yours; private playlists never leave your server. Shared playlists from peers appear in a "From your peers" section on Home. Open one to play it, `Follow` it (it stays live and updates when the owner changes it), or `Save a copy` (a snapshot that becomes a normal playlist of yours). Tracks you also have locally play from your library; the rest stream from the peer, and anything the peer can no longer provide is shown dimmed.

When you opt in, the other server sees your username or display name — that is how friends recognize you. What never crosses servers: your listening history, your private playlists, your email, and your login details. Servers only exchange what the people involved explicitly chose to share.

---

## See also

- [Deployment Guide](DEPLOYMENT.md) — Docker and compose deployment options
- [Configuration and Security](CONFIGURATION_AND_SECURITY.md) — Environment variables and security hardening
- [Integrations Guide](INTEGRATIONS.md) — Lidarr, Audiobookshelf, Soulseek, YouTube Music, TIDAL, podcasts, and OpenSubsonic
- [Environment Variables](ENVIRONMENT_VARIABLES.md) — Complete env var reference by container

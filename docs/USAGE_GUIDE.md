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
- Search shows one **Songs** section: songs you own and songs you don't sit together in a single ranked list. External matches carry a provider badge (TIDAL or YouTube) and never duplicate something already in your library.
- External songs with a streaming match play right from the results, and every row — owned or not — has the full menu with like/dislike, Go to artist, and Go to album
- Search understands artist and album names, tolerates typos, and ranks near-misses by similarity instead of alphabetically
- Discovery search supports preview/download/subscription actions
- Explore and `/radio` station tiles (Quick Start, genres, decades) open a generated station playlist you can inspect before playing; Shuffle All still starts playback immediately
- The Vibe Map in the main navigation plots your analyzed library as an explorable similarity map
- Artists and albums you browse are remembered locally. Repeat visits load instantly, and the pages keep working during MusicBrainz outages. Entries untouched for 180 days are cleaned up automatically.

### Sharing a song

Every track's menu has `Copy link to song`. The link opens the album page with that song highlighted and starts playing it. On a brand-new device the browser may ask for one tap before audio starts.

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

## Scrobbling

Scrobbling sends the music you play in soundspan to your listening-history service. Each user connects their own accounts under `Settings -> Scrobbling`. Two services are supported:

- **ListenBrainz.** Copy your user token from `listenbrainz.org/settings` and paste it into the Connect form. No server setup is needed.
- **Last.fm.** Click `Connect Last.fm`. A Last.fm page opens asking you to approve the connection. Approve it, come back, and click `I've approved — finish connecting`. Last.fm requires the server operator to set `LASTFM_API_KEY` and `LASTFM_SHARED_SECRET` first; the settings page tells you if they are missing.

Once connected, each service has its own on/off toggle, so you can pause forwarding without disconnecting. `Disconnect` removes the stored credential.

What gets sent: finished tracks (scrobbles) and now-playing updates, for music you play in the app or through a connected Subsonic client. Scrobbling never delays or blocks playback — if a service is down, deliveries retry in the background and are dropped after repeated failures. If a service rejects your stored credential, the connection is switched off and you are asked to reconnect.

## Social and History

- Activity panel `Social` tab lists users who are online and sharing presence.
- If a user shares listening activity, their current track appears inline in the Social roster.
- Non-admin accounts only see `Notifications` and `Social` in the activity panel (`Active`, `History`, and `Imports` remain admin-only).
- Open `My History` from `Settings -> History & Personalization` (`Open My History`) for queue-like controls: click-to-play, add to queue, and add to playlist.

## Requesting Music

Non-admin users cannot download music directly. Instead, they can ask for it:

- Open an album that is not in the library. A `Request` button appears where admins see `Download`.
- Click `Request`. The button changes to `Requested` and an admin is notified.
- Admins review requests on the `Requests` page (avatar menu -> `Requests`): approve to send the album into the download queue, or decline.
- You get a notification when your request is approved, declined, or when the album lands in the library.
- Visit `/requests` to see your own requests and cancel pending ones.

Limits: you cannot request an album that is already in the library, already requested, or already downloading, and there is a daily per-user cap (default 10, operators can change `REQUESTS_PER_USER_PER_DAY`). Operators can turn the whole feature off with `FEATURE_REQUESTS=false`.

Discover Weekly no longer downloads albums for non-admin users. On the default recommendation mode, playlists still generate for everyone from music the server already has. The legacy download-based mode is admin-only.

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

### Album downloads

Album downloads run through a queue. One album downloads at a time across the whole server, and the queue survives restarts — queued albums resume where they left off.

- `Download all missing albums` on an artist page queues each missing album and shows progress as the list is worked through. Promo releases, bootlegs, remix/live/demo/compilation groups, and albums where the artist is only featured are skipped.
- A download that delivers only part of an album is reported as `Partial download: N/M tracks` instead of claiming success.
- If the requested album cannot be found on the primary source, the job moves to your configured fallback source or fails with a clear reason. It never substitutes a different release.

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

Online-status sharing is built into every connection, but it is private by default. A user only appears in the other server's Social tab if they turn on `Share online presence` in their own Social settings — one switch covers this server and its peers. Remote users always show under a `From <server name>` heading, so it is clear they are on another instance.

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

If your server is federated with others, two social surfaces can cross between them: online status and public playlists. Sharing follows the same choices you already made for this server — share your presence, or make a playlist public, and it applies to peers too. Nothing extra is shared behind your back, and presence is still off by default.

**Seeing friends on other servers.** When your server is federated, the Social tab gains sections like "From Family server" listing people on that server who chose to share. Peer status updates every few minutes — the tab shows how fresh each section is. To appear on other servers yourself, turn on `Share online presence` in `Settings -> Social` — the same switch that shows you on this server. Your current track travels only if `Share listening status` is also on.

**Playlists from other servers.** Public playlists are shared automatically between federated servers — public means public, on this server and its peers. Private playlists never leave your server; make a playlist private to stop sharing it. Peer playlists show up right alongside your own: in the sidebar playlist list and on the Playlists page, each marked with a small badge naming the server it comes from. Use the `All / Local / Peers` buttons on the Playlists page (or the sidebar's filter menu) to narrow the view, and the "From your peers" section on Home for a quick look. Open one to play it, `Follow` it (it stays live and updates when the owner changes it), or `Save a copy` (a snapshot that becomes a normal playlist of yours). Tracks you also have locally play from your library; the rest stream from the peer, and anything the peer can no longer provide is shown dimmed.

When you opt in, the other server sees your username or display name — that is how friends recognize you. What never crosses servers: your listening history, your private playlists, your email, and your login details. Servers only exchange what the people involved explicitly chose to share.

---

## See also

- [Deployment Guide](DEPLOYMENT.md) — Docker and compose deployment options
- [Configuration and Security](CONFIGURATION_AND_SECURITY.md) — Environment variables and security hardening
- [Integrations Guide](INTEGRATIONS.md) — Lidarr, Audiobookshelf, Soulseek, YouTube Music, TIDAL, podcasts, and OpenSubsonic
- [Environment Variables](ENVIRONMENT_VARIABLES.md) — Complete env var reference by container

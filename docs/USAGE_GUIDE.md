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
- Discovery search supports preview/download/subscription actions

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
- API keys and Swagger docs
- Bull Board dashboard (`/api/admin/queues`)

Technical admin configuration and security notes are in [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md).

---

## See also

- [Deployment Guide](DEPLOYMENT.md) — Docker and compose deployment options
- [Configuration and Security](CONFIGURATION_AND_SECURITY.md) — Environment variables and security hardening
- [Integrations Guide](INTEGRATIONS.md) — Lidarr, Audiobookshelf, Soulseek, YouTube Music, TIDAL, podcasts, and OpenSubsonic
- [Environment Variables](ENVIRONMENT_VARIABLES.md) — Complete env var reference by container

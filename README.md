# soundspan

[![GHCR Image](https://img.shields.io/badge/Image-ghcr.io%2Fsoundspan%2Fsoundspan-0A84FF)](https://ghcr.io/soundspan/soundspan)
[![GitHub Release](https://img.shields.io/github/v/release/soundspan/soundspan?label=Release)](https://github.com/soundspan/soundspan/releases)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

A self-hosted, on-demand audio streaming platform that spans all of your listening experiences in one place.

soundspan is built for people who want streaming convenience without giving up ownership of their library. Listen without limits.  Point it at your local music folder, then manage listening, discovery, podcasts, audiobooks, and playlist workflows from one interface.

> Gratitude: soundspan began from the foundation created by [`Chevron7Locked/kima-hub`](https://github.com/Chevron7Locked/kima-hub). Thank you for the original project and momentum!

<img src="assets/screenshots/desktop-home.png" width="750"/>

---

## Table of Contents

- [Documentation](#documentation)
- [Features](#features)
- [Quick Start](#quick-start)
- [Integrations at a Glance](#integrations-at-a-glance)
- [Mobile Support](#mobile-support)
- [Using soundspan](#using-soundspan)
- [Administration](#administration)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [Disclaimer](#disclaimer)
- [License](#license)
- [Acknowledgments](#acknowledgments)
- [Support](#support)

---

## Documentation

The README stays intentionally user-focused. Technical and operator material lives in `/docs`.

- Documentation index (all guides): [`docs/README.md`](docs/README.md)
- Deployment modes and updates: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- Configuration and security: [`docs/CONFIGURATION_AND_SECURITY.md`](docs/CONFIGURATION_AND_SECURITY.md)
- Integration setup (Lidarr, Soulseek, YouTube Music, TIDAL, OpenSubsonic): [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)
- Testing frameworks, structure, and CI visibility: [`docs/TESTING.md`](docs/TESTING.md)
- CLAP and GPU acceleration: [`docs/ADVANCED_ANALYSIS_AND_GPU.md`](docs/ADVANCED_ANALYSIS_AND_GPU.md)
- Kubernetes deployment: [`docs/KUBERNETES.md`](docs/KUBERNETES.md)
- Reverse proxy and tunnel routing: [`docs/REVERSE_PROXY_AND_TUNNELS.md`](docs/REVERSE_PROXY_AND_TUNNELS.md)
- OpenSubsonic compatibility contract and known-gap policy: [`docs/OPENSUBSONIC_COMPATIBILITY.md`](docs/OPENSUBSONIC_COMPATIBILITY.md)
- Brand usage policy: [`docs/BRAND_POLICY.md`](docs/BRAND_POLICY.md)

---

## Features

soundspan is built for people who want to listen without limits while keeping ownership, control, and reliability in a self-hosted stack.

### Core Library and Playback

- Listen without limits across local FLAC, MP3, AAC, and OGG libraries
- Automatic cataloging and enrichment with MusicBrainz/Last.fm, plus guided metadata correction
- Multi-disc album support with disc-aware ordering and artist playback-order improvements
- Overhauled desktop/mobile/overlay player flows with queue, lyrics, and related views
- Synced lyrics and source/quality badges in now-playing surfaces
- Progressive loading/hydration hardening across Home, Discover, Podcasts, and artist/album pages

![Placeholder: Library view screenshot](assets/screenshots/desktop-library.png)

![Placeholder: Player overlay with queue screenshot](assets/screenshots/desktop-player-upnext.png)

![Placeholder: Player overlay with lyrics and quality badges screenshot](assets/screenshots/desktop-player-lyrics.png)

![Placeholder: Player overlay with related info screenshot](assets/screenshots/desktop-player-related.png)

### Streaming, Downloads, and Discovery

- YouTube Music gap-fill playback with per-user OAuth
- TIDAL gap-fill playback with priority and per-user OAuth
- Per-user streaming credentials and quality settings, including TIDAL-over-YouTube source priority
- TIDAL download workflows with source/fallback controls
- Local-first recommendations with no automatic download/import side effects
- Programmatic playlist generation and artist-diversity balancing
- Library radio stations, interactive release search/selection, and artist recommendation/alias resolution
- Deezer previews plus Spotify/Deezer playlist import flows

![Placeholder: Deezer browse screenshot](assets/screenshots/desktop-browse.png)

![Placeholder: Spotify import preview screenshot](assets/screenshots/desktop-deezer-playlist.png)

### Vibe Intelligence

- CLAP-powered vibe matching for similarity-first playback
- Radar-style analysis views (energy, mood, groove, tempo)
- Mood mixer presets and custom slider-driven mixes
- Keep-the-vibe-going queue behavior

![Placeholder: Mood mixer screenshot](assets/screenshots/desktop-mood-mixer.png)

### Social, Sync, and Multi-User

- Multiple users with isolated libraries, history, and settings
- Admin role controls and optional 2FA
- Listen Together synchronized group sessions
- HA-ready API/worker split with Redis-backed cross-pod Listen Together state
- Activity `Social` tab with presence/privacy controls (`Share online presence`, `Share listening status`)
- Queue-style personal `My History` for playback-first history workflows

![Placeholder: Listen Together and Social tab screenshot](assets/screenshots/desktop-listen-together.png)

![Placeholder: Listen Together and Social tab screenshot](assets/screenshots/desktop-listen-together-inprogress.png)

![Placeholder: Mobile home screenshot](assets/screenshots/mobile-home.png)
![Placeholder: Mobile library artist screenshot](assets/screenshots/mobile-artist.png)
![Placeholder: Mobile player screenshot](assets/screenshots/mobile-player.png)
![Placeholder: Mobile queue screenshot](assets/screenshots/mobile-queue.png)
![Placeholder: Mobile lyrics screenshot](assets/screenshots/mobile-lyrics.png)

### Podcasts and Audiobooks

- Podcast search/subscribe via RSS with resume and played-state tracking
- Mobile podcast skip controls
- Audiobookshelf integration with unified browsing/playback and progress sync

![Placeholder: Podcast experience screenshot](assets/screenshots/desktop-podcasts.png)

![Placeholder: Podcast experience screenshot](assets/screenshots/desktop-podcasts-inprogress.png)

![Placeholder: Audiobooks experience screenshot](assets/screenshots/desktop-audiobooks.png)

### Compatibility, Safety, and Operations

- OpenSubsonic-compatible `/rest` API surface with an explicit compatibility contract
- Admin-controlled library deletion safety model
- Contributor workflow hardening with policy-as-code queue lifecycle checks and strict repository indexing drift/freshness verification

For feature and release notes, see [`CHANGELOG.md`](CHANGELOG.md).

---

## Quick Start

### One-command install

```bash
docker run -d \
  --name soundspan \
  -p 3030:3030 \
  -v /path/to/your/music:/music \
  -v soundspan_data:/data \
  ghcr.io/soundspan/soundspan:latest
```

Open `http://localhost:3030` and create your account.

### Optional GPU mode

```bash
docker run -d \
  --name soundspan \
  --gpus all \
  -p 3030:3030 \
  -v /path/to/your/music:/music \
  -v soundspan_data:/data \
  ghcr.io/soundspan/soundspan:latest
```

For deployment variants, release channels, compose files, and updates, use [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Integrations at a Glance

soundspan supports optional integrations for discovery, downloads, and client compatibility:

- Lidarr
- Audiobookshelf
- Soulseek
- YouTube Music
- TIDAL (streaming + downloads)
- OpenSubsonic-compatible `/rest` API

Full setup guides are documented in [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

---

## Mobile Support

### Progressive Web App (PWA)

Install soundspan to Android/iOS home screen for app-like behavior, background playback, media controls, and faster repeat loads.

### Subsonic-compatible apps

Subsonic-compatible client apps are supported through soundspan's OpenSubsonic `/rest` interface (see [`docs/OPENSUBSONIC_COMPATIBILITY.md`](docs/OPENSUBSONIC_COMPATIBILITY.md)).

### Android TV

soundspan includes a TV-optimized browser interface with D-pad/remote navigation and a persistent now-playing bar.

---

## Using soundspan

### First-Time Setup

1. Create the first account (this user becomes admin)
2. Optionally configure integrations
3. Wait for initial library scan and enrichment

### Home and Search

- Home surfaces continue listening, recently added items, radio stations, mixes, and recommendations
- Search includes tabs for library, discovery, and podcasts
- Discovery search supports preview/download/subscription actions

### Artist Playback Order

Artist-level Play queues owned albums newest-to-oldest, with track ordering by disc and track number.

### Podcast Behavior

Playing an older podcast episode creates a forward-only queue of newer episodes; starting the latest episode does not create an episode queue.

### Playback Settings

Configure stream/transcode quality and cache behavior in Settings.

Player quality badges show active source details (codec/bitrate or bit depth/sample rate).

### Social and History

- Activity panel `Social` tab lists users who are online and sharing presence.
- If a user shares listening activity, their current track appears inline in the Social roster.
- Non-admin accounts only see `Notifications` and `Social` in the activity panel (`Active` and `History` remain admin-only).
- Open `My History` from `Settings -> History & Personalization` (`Open My History`) for queue-like controls: click-to-play, add to queue, and add to playlist.

![Placeholder: Desktop now-playing screenshot](assets/screenshots/placeholders/desktop-now-playing.png)
![Placeholder: Desktop settings screenshot](assets/screenshots/placeholders/desktop-settings.png)

### Keyboard Shortcuts

| Key | Action |
| --- | --- |
| Space | Play / Pause |
| N | Next track |
| P | Previous track |
| S | Toggle shuffle |
| M | Toggle mute |
| Arrow Up | Volume up |
| Arrow Down | Volume down |
| Arrow Right | Seek forward 10 seconds |
| Arrow Left | Seek backward 10 seconds |

---

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
- Bull Board dashboard (`/admin/queues`)

Technical admin configuration and security notes are in [`docs/CONFIGURATION_AND_SECURITY.md`](docs/CONFIGURATION_AND_SECURITY.md).

---

## Architecture

soundspan consists of several cooperating services:

```
                                   ┌─────────────────┐
                                   │   Your Browser  │
                                   └────────┬────────┘
                                            │
                                            ▼
                                 ┌─────────────────────┐
                                 │     Frontend        │
                                 │   (Next.js :3030)   │
                                 └──────────┬──────────┘
                                            │
                                            ▼
┌─────────────────┐              ┌─────────────────────┐              ┌─────────────────┐
│  Music Library  │◄────────────►│      Backend        │◄────────────►│  YT Music       │
│   (Your Files)  │              │  (Express.js :3006) │              │ :8586 (Opt.)    │
└─────────────────┘              └──────────┬──────────┘              └─────────────────┘
┌─────────────────┐                         │                         ┌─────────────────┐
│    Lidarr       │◄────────────────────────┤                         │  TIDAL Sidecar  │
│   (Optional)    │                         ├────────────────────────►│ :8585 (Opt.)    │
└─────────────────┘                         │                         └─────────────────┘
┌─────────────────┐                         │
│ Audiobookshelf  │◄────────────────────────┘
│   (Optional)    │                         |
└─────────────────┘                         |
                                 ┌──────────┴──────────┐
                                 │  ┌───────────────┐  │
                                 │  │  PostgreSQL   │  │
                                 │  └───────────────┘  │
                                 │  ┌───────────────┐  │
                                 │  │     Redis     │  │
                                 │  └───────────────┘  │
                                 └─────────────────────┘
```

| Component | Purpose | Default Port |
| --- | --- | --- |
| Frontend | Web interface (Next.js) | 3030 |
| Backend | API server (Express.js) | 3006 |
| PostgreSQL | Primary database (with pgvector) | 5432 |
| Redis | Cache and queue backend | 6379 |
| TIDAL Sidecar | TIDAL streaming/download proxy | 8585 |
| YT Music Streamer | YouTube Music streaming proxy | 8586 |
| Audio Analyzer | MusiCNN analyzer service | — |
| Audio Analyzer CLAP | CLAP embedding service | — |

---

## Roadmap

- Offline playback mode
- Standalone Windows-friendly distribution path

---

## Disclaimer

soundspan is a self-hosted music management tool intended for content you own or can legally access.

For optional third-party integrations (YouTube Music, TIDAL, Soulseek):

- You are responsible for compliance with applicable terms and laws
- soundspan is not affiliated with Google, YouTube, TIDAL, or Soulseek
- Streaming/downloading features require your own valid subscriptions where applicable

soundspan is provided "as is" without warranty.

---

## License

soundspan is released under the [GNU General Public License v3.0](LICENSE).

---

## Acknowledgments

- [Last.fm](https://www.last.fm/) - artist recommendations and metadata
- [MusicBrainz](https://musicbrainz.org/) - music metadata
- [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/) - podcast discovery
- [Deezer](https://developers.deezer.com/) - preview and browse sources
- [Fanart.tv](https://fanart.tv/) - artist imagery
- [Lidarr](https://lidarr.audio/) - music collection management
- [Audiobookshelf](https://www.audiobookshelf.org/) - audiobook/podcast server
- [TIDAL](https://tidal.com/) - streaming and downloads
- [tiddl](https://github.com/oskvr37/tiddl) - TIDAL API library
- [ytmusicapi](https://github.com/sigma67/ytmusicapi) - YouTube Music API wrapper
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - stream extraction

---

## Support

1. Check existing [Issues](https://github.com/soundspan/soundspan/issues)
2. Open a new issue with setup details and reproduction steps
3. Include relevant logs from `docker compose logs`

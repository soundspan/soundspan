# soundspan™

[![GHCR Image](https://img.shields.io/badge/Image-ghcr.io%2Fsoundspan%2Fsoundspan-0A84FF)](https://ghcr.io/soundspan/soundspan)
[![GitHub Release](https://img.shields.io/github/v/release/soundspan/soundspan?label=Release)](https://github.com/soundspan/soundspan/releases)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

A self-hosted, on-demand audio streaming platform that spans all of your listening experiences in one place.

soundspan is built for people who want streaming convenience without giving up ownership of their library. Point it at your local music folder, then manage listening, discovery, podcasts, audiobooks, and playlist workflows from one interface. Listen without limits.

> Gratitude: soundspan began from the foundation created by [`Chevron7Locked/kima-hub`](https://github.com/Chevron7Locked/kima-hub). Thank you for the original project and momentum!

<a href="assets/screenshots/desktop-home.png"><img src="assets/screenshots/desktop-home.png" width="750"/></a>

---

## Highlights

- Local FLAC, MP3, AAC, and OGG library with automatic MusicBrainz/Last.fm enrichment
- YouTube Music and TIDAL gap-fill streaming with per-user OAuth and quality controls
- CLAP-powered vibe matching, mood mixer presets, and radar-style analysis views
- Podcast search/subscribe via RSS with resume, played-state tracking, and mobile skip controls
- Audiobookshelf integration with unified browsing/playback and progress sync
- Programmatic playlist generation, artist-diversity balancing, and library radio stations
- Synced lyrics, source/quality badges, and overhauled desktop/mobile/overlay player flows
- Multiple users with isolated libraries, admin roles, optional 2FA, and Listen Together group sessions
- Deezer previews plus Spotify/Deezer playlist import flows and provider track mapping APIs
- OpenSubsonic-compatible `/rest` API surface for third-party client access

<a href="assets/screenshots/desktop-library.png"><img src="assets/screenshots/desktop-library.png" width="750" alt="Library view"/></a>

<a href="assets/screenshots/desktop-mood-mixer.png"><img src="assets/screenshots/desktop-mood-mixer.png" width="750" alt="Mood mixer"/></a>

<a href="assets/screenshots/desktop-player-lyrics.png"><img src="assets/screenshots/desktop-player-lyrics.png" width="750" alt="Player overlay with lyrics and quality badges"/></a>

For the full feature list and release notes, see [`CHANGELOG.md`](CHANGELOG.md).

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

For deployment variants, release channels, compose files, and updates, see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Documentation

- Documentation index (all guides): [`docs/README.md`](docs/README.md)
- Usage guide (navigation, playback, admin): [`docs/USAGE_GUIDE.md`](docs/USAGE_GUIDE.md)
- Deployment modes and updates: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- Configuration and security: [`docs/CONFIGURATION_AND_SECURITY.md`](docs/CONFIGURATION_AND_SECURITY.md)
- Environment variables reference: [`docs/ENVIRONMENT_VARIABLES.md`](docs/ENVIRONMENT_VARIABLES.md)
- Integration setup (Lidarr, Soulseek, YouTube Music, TIDAL, OpenSubsonic): [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)
- CLAP and GPU acceleration: [`docs/ADVANCED_ANALYSIS_AND_GPU.md`](docs/ADVANCED_ANALYSIS_AND_GPU.md)
- Kubernetes deployment: [`docs/KUBERNETES.md`](docs/KUBERNETES.md)
- Reverse proxy and tunnel routing: [`docs/REVERSE_PROXY_AND_TUNNELS.md`](docs/REVERSE_PROXY_AND_TUNNELS.md)
- OpenSubsonic compatibility contract: [`docs/OPENSUBSONIC_COMPATIBILITY.md`](docs/OPENSUBSONIC_COMPATIBILITY.md)
- Brand usage policy: [`docs/BRAND_POLICY.md`](docs/BRAND_POLICY.md)

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

### Integration API quick reference

All integration endpoints below require soundspan auth (session or API key where supported) and admin-enabled integrations.

| Area | Endpoints |
| --- | --- |
| YouTube Music browse (OAuth-free) | `GET /api/browse/ytmusic/charts`, `GET /api/browse/ytmusic/categories`, `GET /api/browse/ytmusic/playlist/:id` |
| YouTube Music public stream (OAuth-free) | `GET /api/ytmusic/stream-info-public/:videoId`, `GET /api/ytmusic/stream-public/:videoId` |
| YouTube Music search/match (OAuth-free sidecar clients) | `POST /api/ytmusic/search`, `POST /api/ytmusic/match`, `POST /api/ytmusic/match-batch` |
| Mapping/import APIs | `POST /api/browse/playlists/parse`, `GET /api/track-mappings/album/:albumId`, `POST /api/track-mappings/batch`, `POST /api/import/preview`, `POST /api/import/execute` |

---

## Mobile Support

### Progressive Web App (PWA)

Install soundspan as a PWA from your browser install flow for app-like behavior, background playback, media controls, and faster repeat loads.

PWA is the only current first-party mobile direction. soundspan does not currently ship a native iOS/Android app.

#### Known issues

iOS PWA users may experience playback stopping or failing to resume after the device lock screen activates. Set `HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED=true` on your frontend container to enable iOS-specific audio-session workarounds. See [`docs/ENVIRONMENT_VARIABLES.md`](docs/ENVIRONMENT_VARIABLES.md) for details.

### Subsonic-compatible apps

For mobile native clients, use Subsonic-compatible apps through soundspan's OpenSubsonic `/rest` interface (see [`docs/OPENSUBSONIC_COMPATIBILITY.md`](docs/OPENSUBSONIC_COMPATIBILITY.md)).

### Android TV

soundspan includes a TV-optimized browser interface with D-pad/remote navigation and a persistent now-playing bar.

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

Trademark disclaimer: soundspan is an open-source project. All product names, logos, and brands are property of their respective owners.

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

# Integrations Guide

soundspan works standalone, but these integrations unlock additional discovery and playback workflows.

For environment and secret setup, see [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md).

## Lidarr

Connect soundspan to Lidarr to request/download new music and trigger imports.

### What you get

- Browse artists/albums you do not own
- Request downloads from soundspan
- Discover Weekly playlist import flows
- Automatic library sync via webhook

### Setup

1. Open **Admin** → **Download Services**
2. Enable Lidarr
3. Set Lidarr URL (for example `http://localhost:8686`)
4. Set Lidarr API key (Lidarr → Settings → General)
5. Test and save

Audiobook detail metadata and section navigation are served from soundspan's
local cache. Scheduled or manual Audiobookshelf sync validates chapter coverage
and fills section data for rows created before this model was added. Multi-file
part boundaries are playable because the stream proxy exposes all files as one
byte-addressable audiobook resource.

### Networking note

Lidarr must reach the soundspan callback URL.

- AIO: default callback uses `host.docker.internal:3030`
- Split stack: usually `http://backend:3006` on compose network
- Custom Docker networking: set `SOUNDSPAN_CALLBACK_URL` to a reachable soundspan address

```yaml
environment:
    - SOUNDSPAN_CALLBACK_URL=http://YOUR_SOUNDSPAN_IP:3030
```

## Audiobookshelf

Connect your Audiobookshelf instance for audiobook playback in soundspan.

### Setup

1. Open **Admin** → **Media Servers**
2. Turn on **Enable Audiobookshelf**
3. Set **Server URL** (for example `http://localhost:13378`)
4. Set **API Key** from the Audiobookshelf user settings
5. Test and save

## Soulseek

soundspan can connect directly to Soulseek for discovery/download flows.

> Disclaimer: You are responsible for legal use in your jurisdiction.

### Setup

1. Open **Admin** → **Download Services**
2. Enter Soulseek username/password
3. Save

### Notes

- Discovery results include filename, size, bitrate, and parsed metadata
- Download progress appears in Activity Panel
- Quality/availability depends on peer uptime and speed

## YouTube Music

Stream unowned tracks via per-user YouTube Music OAuth.

> Disclaimer: Uses unofficial libraries (`ytmusicapi`, `yt-dlp`) and requires YouTube Music Premium.

### Requirements

- Running `ytmusic-streamer` sidecar
- Google OAuth client configured as "TVs and Limited Input devices"

### Admin setup

1. Create OAuth client in Google Cloud Console
2. Open **Admin** → **YouTube Music**
3. Enable and set client ID/secret
4. Save

### Per-user setup

1. Open **Settings** → **Integrations** → **YouTube Music**
2. Select **Open Google Sign-In Page**
3. Complete the provider authorization flow
4. Choose quality and save

### Quality settings

| Setting  | Approximate bitrate |
| -------- | ------------------- |
| Low      | ~64 kbps            |
| Medium   | ~128 kbps           |
| High     | ~256 kbps           |
| Lossless | Best available      |

### API access modes

All routes below still require soundspan authentication and
`ytMusicEnabled=true`. Browse, search, and public stream routes normally work
without a linked account, subject to sidecar availability and provider behavior.

| Mode                                                        | Endpoints                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normally works without a linked account (sidecar-dependent) | `GET /api/browse/ytmusic/charts`, `GET /api/browse/ytmusic/categories`, `GET /api/browse/ytmusic/playlist/:id`, `POST /api/ytmusic/search`, `POST /api/ytmusic/match`, `POST /api/ytmusic/match-batch`, `GET /api/ytmusic/stream-info-public/:videoId`, `GET /api/ytmusic/stream-public/:videoId` |
| Per-user OAuth required                                     | `GET /api/ytmusic/album/:browseId`, `GET /api/ytmusic/artist/:channelId`, `GET /api/ytmusic/song/:videoId`, `GET /api/ytmusic/stream-info/:videoId`, `GET /api/ytmusic/stream/:videoId`, `GET /api/ytmusic/library/songs`, `GET /api/ytmusic/library/albums`                                      |

## Track Mapping and Playlist Import APIs

soundspan also exposes provider mapping and playlist import routes for cross-provider workflows:

| Endpoint                                 | Purpose                                                              |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `POST /api/browse/playlists/parse`       | Parse Spotify/Deezer playlist URLs before import                     |
| `GET /api/track-mappings/album/:albumId` | Read provider mappings for an album's local tracks                   |
| `POST /api/track-mappings/batch`         | Persist multiple mapping links in one request                        |
| `POST /api/import/preview`               | Resolve playlist tracks (local/YT/TIDAL) without creating a playlist |
| `POST /api/import/execute`               | Create a playlist from a resolved import                             |
| `POST /api/import/jobs`                  | Start a provider-neutral playlist import job                         |
| `GET /api/import/jobs`                   | List the authenticated user's import jobs                            |
| `GET /api/import/jobs/:jobId`            | Read one import job and its current progress                         |
| `POST /api/import/jobs/reconnect`        | Reconnect to an active import for the same source                    |
| `POST /api/import/jobs/:jobId/cancel`    | Cancel a queued or running import job                                |
| `POST /api/import/m3u/preview`           | Parse and preview an uploaded M3U playlist before import             |

## TIDAL Streaming

Stream unowned tracks via per-user TIDAL OAuth.

> Disclaimer: Requires TIDAL subscription and uses `tiddl` library.

### Requirements

- Running `tidal-downloader` sidecar
- TIDAL enabled in admin settings

### Per-user setup

1. Open **Settings** → **Integrations** → **TIDAL**
2. Select **Open TIDAL Authorization Page**
3. Complete the provider authorization flow
4. Choose quality and save

Streaming auth is separate from admin download auth.

### Quality settings

| Setting      | Format                 |
| ------------ | ---------------------- |
| Low          | AAC 96 kbps            |
| High         | AAC 320 kbps           |
| Lossless     | FLAC 16-bit / 44.1 kHz |
| Max / Hi-Res | FLAC 24-bit / 192 kHz  |

## TIDAL Downloads

Use TIDAL as a download source for tracks/albums.

> Disclaimer: Intended for personal use with your own subscription.

### Setup

1. Ensure `tidal-downloader` service is running
2. Open **Admin** → **Download Services**
3. Authenticate via device-code flow
4. Choose download quality and naming template
5. Save

### File naming template examples

```text
# Default
{album.artist}/{album.title}/{item.number:02d}. {item.title}

# Disc-track format
{album.artist}/{album.title}/{item.volume}-{item.number:02d} {item.title}

# With year
{album.artist}/{album.title} ({album.date:%Y})/{item.number:02d}. {item.title}
```

Default template:

```text
{album.artist}/{album.title}/{item.number:02d}. {item.title}
```

### TIDAL sidecar environment values

| Variable            | Default        | Description                   |
| ------------------- | -------------- | ----------------------------- |
| `TIDAL_TRACK_DELAY` | `3`            | Delay between track downloads |
| `MUSIC_PATH`        | `/music`       | Path for downloaded music     |
| `TIDDL_PATH`        | `/data/.tiddl` | Sidecar cache/config path     |
| `DEBUG`             | _(unset)_      | Enable debug logging          |

Main-channel image:

```bash
docker pull ghcr.io/soundspan/soundspan-tidal-downloader:main
```

## YouTube Music Downloads

Use YouTube Music as a download source for albums, the same way TIDAL works.

> Disclaimer: Uses unofficial libraries (`ytmusicapi`, `yt-dlp`). Intended for personal use.

### Setup

1. Ensure the `ytmusic-streamer` sidecar is running
2. Open **Admin** → **YouTube Music** and enable YouTube Music
3. Open **Admin** → **Download Preferences**
4. Choose **YouTube Music (Albums)** as the primary source, or pick **Try YouTube Music** as the fallback for another source
5. Save

No account link is needed for downloads — the sidecar uses public album pages.

### How it works

When a download job runs, soundspan searches YouTube Music for the album, then the sidecar downloads each track and files it under your music folder as `Artist/Album/01. Title.mp3`. The library scanner picks the album up automatically when the job finishes.

If the album is not found on YouTube Music, the job follows your **When Primary Source Fails** setting — it can hand off to Soulseek, Lidarr, or TIDAL, or skip.

### Sidecar environment values

| Variable                        | Default  | Description                              |
| ------------------------------- | -------- | ---------------------------------------- |
| `MUSIC_PATH`                    | `/music` | Path for downloaded music                |
| `YT_ALBUM_DOWNLOAD_CONCURRENCY` | `1`      | Album download jobs processed at once    |

## Podcasts

Podcast discovery and subscriptions require no credentials. Search uses the
iTunes discovery catalog. Subscriptions use each podcast's RSS feed for episode
metadata and playback.

1. Open **Podcasts**
2. Search the iTunes catalog or add an RSS feed
3. Subscribe to keep the feed in your library

## OpenSubsonic API Compatibility

soundspan exposes a Subsonic/OpenSubsonic-compatible `/rest` surface.

- Full contract and known-gap policy: [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md)
- Split deployment client URL guidance: use frontend base URL
- Backend-direct deployments can target backend URL directly

Local smoke check:

```bash
cd backend
npm run test:smoke:subsonic-proxy
```

---

## See also

- [Configuration and Security](CONFIGURATION_AND_SECURITY.md) — Secret handling and external access settings
- [Environment Variables](ENVIRONMENT_VARIABLES.md) — Complete env var reference by container
- [Deployment Guide](DEPLOYMENT.md) — Docker and compose deployment options
- [Usage Guide](USAGE_GUIDE.md) — Navigation, playback behavior, and administration

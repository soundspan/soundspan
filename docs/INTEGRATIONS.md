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

1. Open Settings in soundspan
2. Go to the Lidarr section
3. Set Lidarr URL (for example `http://localhost:8686`)
4. Set Lidarr API key (Lidarr -> Settings -> General)
5. Test and save

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

1. Open Settings -> Audiobookshelf
2. Set URL (for example `http://localhost:13378`)
3. Set API token (Audiobookshelf user settings)
4. Test and save

## Soulseek

soundspan can connect directly to Soulseek for discovery/download flows.

> Disclaimer: You are responsible for legal use in your jurisdiction.

### Setup

1. Open Settings -> Soulseek
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
2. Open soundspan Settings -> YouTube Music
3. Enable and set client ID/secret
4. Save

### Per-user setup

1. Open Settings -> YouTube Music
2. Click **Link YouTube Music Account**
3. Enter device code at Google authorization page
4. Choose quality and save

### Quality settings

| Setting | Approximate bitrate |
| --- | --- |
| Low | ~64 kbps |
| Medium | ~128 kbps |
| High | ~256 kbps |
| Lossless | Best available |

## TIDAL Streaming

Stream unowned tracks via per-user TIDAL OAuth.

> Disclaimer: Requires TIDAL subscription and uses `tiddl` library.

### Requirements

- Running `tidal-downloader` sidecar
- TIDAL enabled in admin settings

### Per-user setup

1. Open Settings -> TIDAL Streaming
2. Click **Link TIDAL Account**
3. Enter device code at TIDAL authorization page
4. Choose quality and save

Streaming auth is separate from admin download auth.

### Quality settings

| Setting | Format |
| --- | --- |
| Low | AAC 96 kbps |
| High | AAC 320 kbps |
| Lossless | FLAC 16-bit / 44.1 kHz |
| Max / Hi-Res | FLAC 24-bit / 192 kHz |

## TIDAL Downloads

Use TIDAL as a download source for tracks/albums.

> Disclaimer: Intended for personal use with your own subscription.

### Setup

1. Ensure `tidal-downloader` service is running
2. Open Settings -> TIDAL
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

| Variable | Default | Description |
| --- | --- | --- |
| `TIDAL_TRACK_DELAY` | `3` | Delay between track downloads |
| `MUSIC_PATH` | `/music` | Path for downloaded music |
| `TIDDL_PATH` | `/data/.tiddl` | Sidecar cache/config path |
| `DEBUG` | _(unset)_ | Enable debug logging |

Main-channel image:

```bash
docker pull ghcr.io/soundspan/soundspan-tidal-downloader:main
```

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

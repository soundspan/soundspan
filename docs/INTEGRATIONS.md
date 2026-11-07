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

Audiobook detail metadata and section navigation are served from soundspan's
local cache. A scheduled sync keeps that cache in step with Audiobookshelf: it
adds new books within a few minutes and removes books that were deleted in
Audiobookshelf, together with their cached covers and listening progress.
Removals are deliberately cautious: a book is only removed after it has been
absent from two complete, verified library listings taken several minutes
apart, and an unreachable server or an incomplete listing never triggers
removals. Books without a recorded source library are never removed
automatically. Scheduled or manual sync also validates chapter coverage and
backfills section data for rows that do not have it yet. Multi-file
part boundaries are playable because the stream proxy exposes all files as one
byte-addressable audiobook resource.

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
3. Optional: select **Test Connection** to check the login. The test opens its own short Soulseek session and closes it when it finishes.
4. Save

### Notes

- Use the Soulseek account only for soundspan. The Soulseek server allows one session per account: when another client (or the **Test Connection** check) logs in with the same account, it ends soundspan's session. soundspan logs in again on its next search or download, which ends the other client's session in turn.
- A Soulseek download that runs past its time limit is cancelled. It does not keep going in the background.
- Discovery results include filename, size, bitrate, and parsed metadata
- Download progress appears in Activity Panel
- Quality/availability depends on peer uptime and speed
- Album downloads prefer one uploader's complete album folder: a folder is only chosen when it covers at least 90% of the requested tracks and its contents clearly belong to the same album. When no folder qualifies, tracks are assembled one by one from the best individual matches.

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

Songs you like from YouTube Music appear in your Library with a YouTube badge. This works without signing in. See [Your Library](USAGE_GUIDE.md#your-library).

### Quality settings

| Setting  | Approximate bitrate |
| -------- | ------------------- |
| Low      | ~64 kbps            |
| Medium   | ~128 kbps           |
| High     | ~256 kbps           |
| Lossless | Best available      |

### Memory and the playback fallback

The sidecar looks up each song with YouTube clients that do not need YouTube's JavaScript player. One lookup uses about 60 MB. If YouTube stops serving a song to those clients, that song does not play.

The sidecar can retry such songs with yt-dlp's full client set. That retry runs YouTube's JavaScript player in a Deno process of about 300 MB. The sidecar runs one retry at a time.

> Warning: Give the sidecar at least 512 MB of memory before you turn the fallback on. With less memory, a retry can run the sidecar out of memory and stop every song that is playing.

To turn the fallback on, set `YTMUSIC_JS_CLIENT_FALLBACK=true` on the `ytmusic-streamer` container. With Helm, set `ytmusicStreamer.env.YTMUSIC_JS_CLIENT_FALLBACK: "true"`. The sidecar logs at startup whether the fallback is on, and logs each retry. Regular YouTube URL playback and downloads do not use the fallback.

### API access modes

All routes below still require soundspan authentication and
`ytMusicEnabled=true`. Browse, search, and public stream routes normally work
without a linked account, subject to sidecar availability and provider behavior.

| Mode                                                        | Endpoints                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normally works without a linked account (sidecar-dependent) | `GET /api/browse/ytmusic/charts`, `GET /api/browse/ytmusic/categories`, `GET /api/browse/ytmusic/playlist/:id`, `POST /api/ytmusic/search`, `POST /api/ytmusic/match`, `POST /api/ytmusic/match-batch`, `GET /api/ytmusic/stream-info-public/:videoId`, `GET /api/ytmusic/stream-public/:videoId` |
| Per-user OAuth required                                     | `GET /api/ytmusic/album/:browseId`, `GET /api/ytmusic/artist/:channelId`, `GET /api/ytmusic/song/:videoId`, `GET /api/ytmusic/stream-info/:videoId`, `GET /api/ytmusic/stream/:videoId`, `GET /api/ytmusic/library/songs`, `GET /api/ytmusic/library/albums`                                      |

## Search Providers

Search lists artists and songs that are not in the library from catalog
providers that an admin orders and enables under `Admin → Search Providers`:

| Provider      | Results          | Needs                                                   |
| ------------- | ---------------- | ------------------------------------------------------- |
| Last.fm       | Artists, songs   | The server's Last.fm key; also corrects artist spelling |
| Deezer        | Artists, songs   | Nothing: Deezer's public API                            |
| TIDAL         | Artists, songs   | A TIDAL session for the user, or the shared account     |
| YouTube Music | Songs            | The YouTube Music integration enabled and reachable     |

Last.fm and Deezer are enabled by default. Enabled providers are searched in
parallel, and their results are merged in the admin's order: an artist, or an
artist and song, that a higher provider already returned is dropped. A provider
the user cannot use, or one that fails, is skipped. TIDAL and YouTube Music
songs play straight from that service; other songs play when they match an
enabled streaming service and otherwise link to the artist page. Results are
cached for 15 minutes per query and provider list.

## Track Mapping and Playlist Import APIs

soundspan also exposes provider mapping and playlist import routes for cross-provider workflows:

| Endpoint                                 | Purpose                                                              |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `POST /api/browse/playlists/parse`       | Parse Spotify, Deezer, YouTube Music, and TIDAL playlist URLs before import                     |
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

- Running `tidal-streamer` sidecar
- TIDAL enabled in admin settings

### Per-user setup

1. Open **Settings** → **Integrations** → **TIDAL**
2. Select **Open TIDAL Authorization Page**
3. Complete the provider authorization flow
4. Choose quality and save

Streaming auth is separate from admin download auth, unless an admin shares the download account (see below).

Songs you like from TIDAL appear in your Library with a TIDAL badge while you are signed in. See [Your Library](USAGE_GUIDE.md#your-library).

### Sharing one account with every user

An admin can let every user stream TIDAL through the admin download account instead of linking their own:

1. Connect TIDAL under **Admin** → **Download Services** (see [TIDAL Downloads](#tidal-downloads))
2. Turn on **Share this account with all users** in the same card
3. Save

While it is on, every user's TIDAL search, browse, matching, and streaming use that one account, the TIDAL card disappears from users' **Settings** → **Integrations**, and linking a personal account is turned off. Each user's **Playback** → **Streaming Quality** picks the TIDAL quality, up to what the shared subscription allows:

| Streaming Quality   | TIDAL quality         |
| ------------------- | --------------------- |
| Original (Lossless) | Max / Hi-Res          |
| High (320 kbps)     | High (AAC 320 kbps)   |
| Medium (192 kbps)   | High (AAC 320 kbps)   |
| Low (128 kbps)      | Low (AAC 96 kbps)     |

TIDAL has no 192 kbps tier, so Medium uses High. The TIDAL card's own quality and **Show on Explore Page** settings are kept but hidden; TIDAL shelves stay on Explore for anyone who had not turned them off. Personal accounts users linked before are kept but not used; turning the setting off goes back to them. Relinking the admin account takes effect on the next request.

TIDAL may allow only one stream at a time per account, so two users playing TIDAL at the same moment can interrupt each other. Sharing an account may also be against TIDAL's terms for your plan.

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

1. Ensure `tidal-streamer` service is running
2. Open **Admin** → **Download Services**
3. Authenticate via device-code flow
4. Choose download quality and naming template
5. Save

### Download songs as they play

Turn on **Download songs as they play** in the TIDAL card under **Admin** → **Download Services** to keep a copy of everything people play:

- Every TIDAL song plays from its download. The first time anyone plays a song, soundspan downloads it once into the music library with the admin TIDAL account at the highest quality TIDAL offers for it, and the listener hears those same bytes as they arrive, so playback starts straight away. Nothing plays without ending up in the library.
- The download finishes even if the listener skips the song, and other people playing the same song meanwhile share it. As soon as it finishes, soundspan adds that file to the library on its own; no library scan is needed.
- While a song is still downloading, it plays at the download's quality and can only be skipped to parts that have already arrived; jumping further ahead waits for the download to finish. Later plays use the downloaded file at the listener's **Playback** → **Streaming Quality**, the same as any library song.
- If a download cannot start or fails, the song does not play; try again.
- Songs are never removed automatically yet. soundspan records when each downloaded song was last played so a cleanup can remove unplayed songs later.

### Single songs

When a liked TIDAL song's album has no MusicBrainz match, a download job cannot fetch the album. Admins can still download that one song with `Add song to library` in the song's menu in the Library or in Search. The same option replaces `Add album to library` when the library already has the song's matched album but not the song, for example a streaming-only bonus track. The song uses the same quality and naming template as album downloads.

- soundspan downloads these songs one at a time. Up to 25 more can wait in line; when the line is full, try again later. If you run more than one backend instance, each one has its own line.
- soundspan adds each downloaded song to the library as soon as it arrives, without a full library scan.
- If a download fails, the song stays a streaming song. The backend log records the failure and its HTTP status, and the TIDAL sidecar log has the cause. A download that timed out can still finish and arrive after the next library scan; if it does not, choose `Add song to library` again.
- Songs still waiting when the backend restarts are dropped. A song that was downloading at that moment can still arrive, but it shows up only after the next library scan. Choose `Add song to library` again, or run a library scan.

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
docker pull ghcr.io/soundspan/soundspan-tidal-streamer:main
```

`ghcr.io/soundspan/soundspan-tidal-downloader` is published as an alias of `soundspan-tidal-streamer`, and the `tidal-downloader` Compose hostname resolves to `tidal-streamer`.

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

## Last.fm and ListenBrainz Scrobbling

Each user can send their soundspan listening history to Last.fm and/or ListenBrainz. Connections are per user, under **Settings** -> **Scrobbling**. Plays from the web app and from connected Subsonic clients both forward.

### ListenBrainz setup

No server configuration is needed.

1. Copy your user token from `listenbrainz.org/settings`
2. Open **Settings** -> **Scrobbling**, paste the token, and click **Connect**

### Last.fm setup

The server operator must first create a free Last.fm API account (https://www.last.fm/api/account/create) and set two environment values:

```bash
LASTFM_API_KEY=your_api_key
LASTFM_SHARED_SECRET=your_shared_secret
```

`LASTFM_API_KEY` may already be set for metadata enrichment; scrobbling additionally requires the shared secret. Helm users storing keys in an existing Secret must add `LASTFM_SHARED_SECRET` to it.

These two values identify your soundspan server as an application to Last.fm — like an OAuth app credential. They are not a listener account and never receive scrobbles. Each user still connects their own Last.fm account, and each user's plays go to their own Last.fm profile.

The shared secret is intentionally never displayed in any admin screen. The Scrobbling settings page reports which of the two values is missing when Last.fm is unavailable.

Then each user connects their own account:

1. Open **Settings** -> **Scrobbling** and click **Connect Last.fm**
2. Approve the connection on the Last.fm page that opens
3. Return and click **I've approved — finish connecting**

### Notes

- Each service has its own enable toggle; **Disconnect** removes the stored credential
- Scrobbles and now-playing updates are delivered in the background and retried on failure; playback is never delayed
- If a service rejects a stored credential, that connection is disabled and the user is asked to reconnect

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

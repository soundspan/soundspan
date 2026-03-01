# Backend Routes

Start-here guide for API route handlers in `backend/src/routes`.

## Start Here

1. Mount points and middleware chain: `backend/src/index.ts`.
2. Canonical endpoint map: `.agents-config/docs/ROUTE_MAP.md`.
3. Targeted verification commands: `.agents-config/docs/TEST_MATRIX.md`.

## Mounted Route Modules

| Route File | Mounted Prefixes |
| --- | --- |
| `backend/src/routes/analysis.ts` | `/api/analysis` |
| `backend/src/routes/apiKeys.ts` | `/api/api-keys` |
| `backend/src/routes/artists.ts` | `/api/artists` |
| `backend/src/routes/audiobooks.ts` | `/api/audiobooks` |
| `backend/src/routes/auth.ts` | `/api/auth` |
| `backend/src/routes/browse.ts` | `/api/browse` |
| `backend/src/routes/deviceLink.ts` | `/api/device-link` |
| `backend/src/routes/discover.ts` | `/api/discover` |
| `backend/src/routes/downloads.ts` | `/api/downloads` |
| `backend/src/routes/enrichment.ts` | `/api/enrichment` |
| `backend/src/routes/homepage.ts` | `/api/homepage` |
| `backend/src/routes/library.ts` | `/api/library` |
| `backend/src/routes/listeningState.ts` | `/api/listening-state` |
| `backend/src/routes/listenTogether.ts` | `/api/listen-together` |
| `backend/src/routes/lyrics.ts` | `/api/lyrics` |
| `backend/src/routes/mixes.ts` | `/api/mixes` |
| `backend/src/routes/notifications.ts` | `/api/notifications` |
| `backend/src/routes/offline.ts` | `/api/offline` |
| `backend/src/routes/onboarding.ts` | `/api/onboarding` |
| `backend/src/routes/playbackState.ts` | `/api/playback-state` |
| `backend/src/routes/playlistImport.ts` | `/api/import` |
| `backend/src/routes/playlists.ts` | `/api/playlists` |
| `backend/src/routes/plays.ts` | `/api/plays` |
| `backend/src/routes/podcasts.ts` | `/api/podcasts` |
| `backend/src/routes/recommendations.ts` | `/api/recommendations` |
| `backend/src/routes/releases.ts` | `/api/releases` |
| `backend/src/routes/routeErrorResponse.ts` | (not found in `backend/src/index.ts` mounts) |
| `backend/src/routes/search.ts` | `/api/search` |
| `backend/src/routes/settings.ts` | `/api/settings` |
| `backend/src/routes/social.ts` | `/api/social` |
| `backend/src/routes/soulseek.ts` | `/api/soulseek` |
| `backend/src/routes/spotify.ts` | `/api/spotify` |
| `backend/src/routes/streaming.ts` | `/api/streaming` |
| `backend/src/routes/subsonic.ts` | `/rest` |
| `backend/src/routes/system.ts` | `/api/system` |
| `backend/src/routes/systemSettings.ts` | `/api/system-settings` |
| `backend/src/routes/tidalStreaming.ts` | `/api/tidal-streaming` |
| `backend/src/routes/trackMappings.ts` | `/api/track-mappings` |
| `backend/src/routes/vibe.ts` | `/api/vibe` |
| `backend/src/routes/webhooks.ts` | `/api/webhooks` |
| `backend/src/routes/youtubeMusic.ts` | `/api/ytmusic` |

## Update Rule

- When adding, removing, or changing endpoints in this directory, regenerate `.agents-config/docs/ROUTE_MAP.md` and verify impacted targeted commands in `.agents-config/docs/TEST_MATRIX.md`.

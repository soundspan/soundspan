# Backend Services

Start-here guide for business logic modules in `backend/src/services`.

## Start Here

1. API call entrypoints: `backend/src/routes/*.ts`.
2. Endpoint-to-handler map: `docs/ROUTE_MAP.md`.
3. Feature-targeted verification commands: `docs/TEST_MATRIX.md`.

## Service Modules

| Service File | Area |
| --- | --- |
| `backend/src/services/acquisitionService.ts` | Core |
| `backend/src/services/artistCountsService.ts` | Core |
| `backend/src/services/audioAnalysisCleanup.ts` | Core |
| `backend/src/services/audiobookCache.ts` | Core |
| `backend/src/services/audiobookshelf.ts` | Core |
| `backend/src/services/audioStreaming.ts` | Core |
| `backend/src/services/coverArt.ts` | Core |
| `backend/src/services/coverArtExtractor.ts` | Core |
| `backend/src/services/dataCache.ts` | Core |
| `backend/src/services/deezer.ts` | Core |
| `backend/src/services/discoverWeekly.ts` | Core |
| `backend/src/services/discovery/discoveryAlbumLifecycle.ts` | Discovery |
| `backend/src/services/discovery/discoveryBatchLogger.ts` | Discovery |
| `backend/src/services/discovery/discoveryRecommendations.ts` | Discovery |
| `backend/src/services/discovery/discoverySeeding.ts` | Discovery |
| `backend/src/services/discovery/index.ts` | Discovery |
| `backend/src/services/discoveryLogger.ts` | Core |
| `backend/src/services/downloadQueue.ts` | Core |
| `backend/src/services/enrichment.ts` | Core |
| `backend/src/services/enrichmentFailureService.ts` | Core |
| `backend/src/services/enrichmentState.ts` | Core |
| `backend/src/services/fanart.ts` | Core |
| `backend/src/services/featureDetection.ts` | Core |
| `backend/src/services/fileValidator.ts` | Core |
| `backend/src/services/hybridSimilarity.ts` | Core |
| `backend/src/services/imageBackfill.ts` | Core |
| `backend/src/services/imageProvider.ts` | Core |
| `backend/src/services/imageProxy.ts` | Core |
| `backend/src/services/imageStorage.ts` | Core |
| `backend/src/services/itunes.ts` | Core |
| `backend/src/services/lastfm.ts` | Core |
| `backend/src/services/lidarr.ts` | Core |
| `backend/src/services/listenTogether.ts` | Core |
| `backend/src/services/listenTogetherClusterSync.ts` | Core |
| `backend/src/services/listenTogetherManager.ts` | Core |
| `backend/src/services/listenTogetherSocket.ts` | Core |
| `backend/src/services/listenTogetherStateStore.ts` | Core |
| `backend/src/services/lyrics.ts` | Core |
| `backend/src/services/moodBucketService.ts` | Core |
| `backend/src/services/musicbrainz.ts` | Core |
| `backend/src/services/musicScanner.ts` | Core |
| `backend/src/services/notificationPolicyService.ts` | Core |
| `backend/src/services/notificationService.ts` | Core |
| `backend/src/services/openai.ts` | Core |
| `backend/src/services/podcastCache.ts` | Core |
| `backend/src/services/podcastDownload.ts` | Core |
| `backend/src/services/podcastindex.ts` | Core |
| `backend/src/services/programmaticPlaylistArtistCap.ts` | Core |
| `backend/src/services/programmaticPlaylists.ts` | Core |
| `backend/src/services/rateLimiter.ts` | Core |
| `backend/src/services/releaseContracts.ts` | Core |
| `backend/src/services/rss-parser.ts` | Core |
| `backend/src/services/search.ts` | Core |
| `backend/src/services/simpleDownloadManager.ts` | Core |
| `backend/src/services/soulseek.ts` | Core |
| `backend/src/services/spotify.ts` | Core |
| `backend/src/services/spotifyImport.ts` | Core |
| `backend/src/services/staleJobCleanup.ts` | Core |
| `backend/src/services/tidal.ts` | Core |
| `backend/src/services/tidalStreaming.ts` | Core |
| `backend/src/services/trackPreference.ts` | Core |
| `backend/src/services/vibeAnalysisCleanup.ts` | Core |
| `backend/src/services/vibeVocabulary.ts` | Core |
| `backend/src/services/wikidata.ts` | Core |
| `backend/src/services/youtubeMusic.ts` | Core |

## Update Rule

- Keep services reusable and route handlers thin. If service entrypoints or contracts change, update impacted docs/tests in the same change set.

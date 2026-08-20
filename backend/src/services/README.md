# Backend Services

Start-here guide for business logic modules in `backend/src/services`.

## Start Here

1. API call entrypoints: `backend/src/routes/*.ts`.
2. Service-focused tests: `backend/src/services/__tests__/` and nested `__tests__/` directories under service domains.
3. Shared runtime helpers: `backend/src/utils/`, `backend/src/lib/`, and adjacent service modules.

## Service Modules

| Service File | Area |
| --- | --- |
| `backend/src/services/acquisitionService.ts` | Core |
| `backend/src/services/albumResolutionService.ts` | Core |
| `backend/src/services/albumTitleGuards.ts` | Shared remote-album placeholder-title classification |
| `backend/src/services/albumLoudness.ts` | Transactional active-track loudness rollups and per-album serialization |
| `backend/src/services/artistCountsService.ts` | Core |
| `backend/src/services/artistResolutionService.ts` | Core |
| `backend/src/services/artistSlotAllocation.ts` | Core |
| `backend/src/services/audioAnalysisCleanup.ts` | Core |
| `backend/src/services/audioFormatLabel.ts` | Scanner audio-format label derivation |
| `backend/src/services/audiobookCache.ts` | Core |
| `backend/src/services/audiobookshelf.ts` | Core |
| `backend/src/services/audioStreaming.ts` | Core |
| `backend/src/services/browseImageCache.ts` | Core |
| `backend/src/services/cacheHelpers.ts` | Core |
| `backend/src/services/coverArt.ts` | Core |
| `backend/src/services/coverArtExtractor.ts` | Core |
| `backend/src/services/coverArtResize.ts` | Core |
| `backend/src/services/curatedVibeMixDefinitions.ts` | Data-driven curated vibe mix catalog |
| `backend/src/services/dataCache.ts` | Core |
| `backend/src/services/deezer.ts` | Core |
| `backend/src/services/discoverWeekly.ts` | Discover Weekly compatibility facade |
| `backend/src/services/discoverWeekly/batchLifecycle.ts` | Discover Weekly batch transitions |
| `backend/src/services/discoverWeekly/candidateSelection.ts` | Discover Weekly candidate eligibility |
| `backend/src/services/discoverWeekly/generationService.ts` | Discover Weekly generation orchestration |
| `backend/src/services/discoverWeekly/helpers.ts` | Discover Weekly pure helpers |
| `backend/src/services/discoverWeekly/index.ts` | Discover Weekly public service composition |
| `backend/src/services/discoverWeekly/lidarrCleanup.ts` | Discover Weekly Lidarr cleanup |
| `backend/src/services/discoverWeekly/playlistPersistence.ts` | Discover Weekly playlist persistence |
| `backend/src/services/discoverWeekly/recommendationStrategies.ts` | Discover Weekly recommendation strategies |
| `backend/src/services/discoverWeekly/state.ts` | Discover Weekly Prisma retry state |
| `backend/src/services/discoverWeekly/types.ts` | Discover Weekly shared types |
| `backend/src/services/discovery/discoveryAlbumLifecycle.ts` | Discovery |
| `backend/src/services/discovery/discoveryBatchLogger.ts` | Discovery |
| `backend/src/services/discovery/discoveryRecommendations.ts` | Discovery |
| `backend/src/services/discovery/discoverySeeding.ts` | Discovery |
| `backend/src/services/discovery/index.ts` | Discovery |
| `backend/src/services/discoveryLogger.ts` | Core |
| `backend/src/services/downloadQueue.ts` | Core |
| `backend/src/services/embeddingSpaceLifecycle.ts` | Blue/green embedding-space cutover and retirement cleanup |
| `backend/src/services/embeddingSpaces.ts` | Provider-space registry resolution, active cache, and worker target |
| `backend/src/services/enrichment.ts` | Core |
| `backend/src/services/enrichmentFailureService.ts` | Core |
| `backend/src/services/enrichmentState.ts` | Core |
| `backend/src/services/fanart.ts` | Core |
| `backend/src/services/featureDetection.ts` | Core |
| `backend/src/services/fileValidator.ts` | Core |
| `backend/src/services/federationCatalog.ts` | Host federation manifest, filtered catalog envelopes, and deltas |
| `backend/src/services/federationClient.ts` | Bounded, validated consumer HTTP client for peer calls |
| `backend/src/services/federationCredentialCipher.ts` | Federation outbound-token encryption and rolling-startup read compatibility |
| `backend/src/services/federationCredentials.ts` | Bounded, idempotent federation outbound-token startup backfill |
| `backend/src/services/federationCoverProxy.ts` | Backpressured consumer proxy for peer album covers |
| `backend/src/services/federationEmbeddingSpace.ts` | Federation embedding-space identity and compatibility decisions |
| `backend/src/services/federationEmbeddingSpaceHeader.ts` | Federation embedding-space response-header encoding and tolerant parsing |
| `backend/src/services/federationPeers.ts` | Encrypted peer credentials, identity, linking, and pairing lifecycle |
| `backend/src/services/federationStreamProxy.ts` | Backpressured consumer proxy for peer audio streams |
| `backend/src/services/genericImportJobRunner.ts` | Core |
| `backend/src/services/hybridSimilarity.ts` | Core |
| `backend/src/services/imageBackfill.ts` | Core |
| `backend/src/services/imageProvider.ts` | Core |
| `backend/src/services/imageProxy.ts` | Core |
| `backend/src/services/imageStorage.ts` | Core |
| `backend/src/services/importJobStore.ts` | Core |
| `backend/src/services/itunes.ts` | Core |
| `backend/src/services/lastfm.ts` | Core |
| `backend/src/services/libraryRadioBuilder.ts` | Core |
| `backend/src/services/libraryRadioStationSelection.ts` | Shared Quick Start, genre, and decade radio selection |
| `backend/src/services/libraryRadioTrackResponse.ts` | Library-radio playback response mapping |
| `backend/src/services/libraryOrphanCleanup.ts` | Deletes catalog parents after their final track row is purged |
| `backend/src/services/libraryHealthDashboard/index.ts` | Library Health read-model composition and cached panel surface |
| `backend/src/services/libraryHealthDashboard/analysisCoverage.ts` | Local analysis, vibe, loudness, and failure coverage |
| `backend/src/services/libraryHealthDashboard/cache.ts` | Redis caching, invalidation, and request coalescing |
| `backend/src/services/libraryHealthDashboard/duplicateClusters.ts` | Report-only durable-identity duplicate clusters |
| `backend/src/services/libraryHealthDashboard/metadataGaps.ts` | Local metadata-gap counts and drill-down pages |
| `backend/src/services/libraryHealthDashboard/pagination.ts` | Bounded service-level offset pagination |
| `backend/src/services/libraryHealthDashboard/predicates.ts` | Shared visible-local track predicate |
| `backend/src/services/libraryHealthDashboard/qualityOutliers.ts` | Lossy album bitrate outlier analytics |
| `backend/src/services/libraryHealthDashboard/storageAnalytics.ts` | MIME, storage, bitrate, and artist analytics |
| `backend/src/services/libraryTrackPreferences.ts` | Core |
| `backend/src/services/lidarr.ts` | Core |
| `backend/src/services/listenTogether.ts` | Core |
| `backend/src/services/listenTogetherCallbacks.ts` | Socket-facing manager callback contracts |
| `backend/src/services/listenTogetherClusterSync.ts` | Core |
| `backend/src/services/listenTogetherManager.ts` | Core |
| `backend/src/services/listenTogetherResolution.ts` | Core |
| `backend/src/services/listenTogetherSnapshot.ts` | Snapshot membership and playback adoption helpers |
| `backend/src/services/listenTogetherSocket.ts` | Core |
| `backend/src/services/listenTogetherStateStore.ts` | Core |
| `backend/src/services/lyrics.ts` | Core |
| `backend/src/services/m3uParser.ts` | Core |
| `backend/src/services/moodBucketService.ts` | Core |
| `backend/src/services/musicbrainz.ts` | Core |
| `backend/src/services/musicScanner.ts` | Core |
| `backend/src/services/nativeCoverHealing.ts` | Core |
| `backend/src/services/notificationPolicyService.ts` | Core |
| `backend/src/services/notificationService.ts` | Core |
| `backend/src/services/outboundAddressPolicy.ts` | Shared outbound IP address classification policy |
| `backend/src/services/outboundUrlSafety.ts` | Core |
| `backend/src/services/playlistImportService.ts` | Core |
| `backend/src/services/playlistMutationLock.ts` | Shared Playlist-first lock and ordinary item-mutation transactions |
| `backend/src/services/playlistTrackResolution.ts` | Core |
| `backend/src/services/playbackTrace.ts` | Playback telemetry |
| `backend/src/services/podcastCache.ts` | Core |
| `backend/src/services/podcastDownload.ts` | Core |
| `backend/src/services/programmaticPlaylistArtistCap.ts` | Core |
| `backend/src/services/programmaticPlaylists.ts` | Programmatic playlist compatibility façade |
| `backend/src/services/programmaticPlaylists/activityMixes.ts` | Party, chill, workout, and focus mixes |
| `backend/src/services/programmaticPlaylists/audioAnalysisMixes.ts` | Audio-analysis energy, mood, dance, and acoustic mixes |
| `backend/src/services/programmaticPlaylists/contextualMixes.ts` | Tag, road-trip, and day-of-week mixes |
| `backend/src/services/programmaticPlaylists/curatedMixes.ts` | Data-driven daily curated-vibe mixes |
| `backend/src/services/programmaticPlaylists/index.ts` | Programmatic playlist public module surface |
| `backend/src/services/programmaticPlaylists/libraryMixes.ts` | Library-history, genre, era, artist-similarity, and discovery mixes |
| `backend/src/services/programmaticPlaylists/service.ts` | Mix rotation orchestration and shared service instance |
| `backend/src/services/programmaticPlaylists/shared.ts` | Shared types, selection helpers, constants, and service state |
| `backend/src/services/programmaticPlaylists/weeklyAndMoodMixes.ts` | Weekly curated and on-demand mood mixes |
| `backend/src/services/providerFidelity.ts` | Pure provider-fidelity cosine, recall-overlap, and gate evaluation metrics |
| `backend/src/services/providerFidelityValidation.ts` | Testable provider-fidelity sampling, orchestration, reporting, and CLI parsing |
| `backend/src/services/radioPlaylistIdentity.ts` | Generated-radio playlist discriminator and standard-list exclusion filter |
| `backend/src/services/radioPlaylistService.ts` | User-scoped generated-radio playlist persistence and mutation |
| `backend/src/services/radioVibeEngine.ts` | Core |
| `backend/src/services/rateLimiter.ts` | Core |
| `backend/src/services/releaseContracts.ts` | Core |
| `backend/src/services/remoteTrackBackfillService.ts` | Core |
| `backend/src/services/remoteTrackMetadataRefresh.ts` | Core |
| `backend/src/services/scannedTrackPersistence.ts` | Scanner track persistence, audio-change invalidation, and album loudness refresh |
| `backend/src/services/remoteTrackMetadataResolver.ts` | Core |
| `backend/src/services/rssParser.ts` | Core |
| `backend/src/services/search.ts` | Core |
| `backend/src/services/simpleDownloadManager.ts` | Core |
| `backend/src/services/socialPresenceEvents.ts` | Core |
| `backend/src/services/soulseek.ts` | Core |
| `backend/src/services/spotify.ts` | Core |
| `backend/src/services/spotifyImport.ts` | Spotify import compatibility façade |
| `backend/src/services/spotifyImport/index.ts` | Spotify import public module surface and shared service instance |
| `backend/src/services/spotifyImport/jobManagement.ts` | Spotify import job reads, refresh, and cancellation |
| `backend/src/services/spotifyImport/lifecycle.ts` | Spotify import job start, acquisition, completion, and scan lifecycle |
| `backend/src/services/spotifyImport/matching.ts` | Spotify import library and MusicBrainz matching |
| `backend/src/services/spotifyImport/pendingTracks.ts` | Spotify import pending-track reconciliation and reads |
| `backend/src/services/spotifyImport/playlistBuilder.ts` | Spotify import playlist creation and post-scan matching |
| `backend/src/services/spotifyImport/preview.ts` | Spotify and Deezer import preview generation |
| `backend/src/services/spotifyImport/state.ts` | Shared Spotify import persistence, retry, cache, and logger state |
| `backend/src/services/spotifyImport/types.ts` | Shared Spotify import contracts |
| `backend/src/services/staleJobCleanup.ts` | Core |
| `backend/src/services/textEmbedding.ts` | Provider-backed text embedding and registered search-space routing |
| `backend/src/services/tidal.ts` | Core |
| `backend/src/services/tidalStreaming.ts` | Core |
| `backend/src/services/trackMappingService.ts` | Core |
| `backend/src/services/trackAlbumResolution.ts` | Bounded external-track to MusicBrainz release-group resolution |
| `backend/src/services/trackDeletion.ts` | Transactional track deletion and former-album loudness refresh |
| `backend/src/services/trackEmbeddings.ts` | Transactional vibe pgvector reads, writes, generation finalization, ANN queries, and embedding counts |
| `backend/src/services/trackIdentityMatcher.ts` | Durable track move identity matching |
| `backend/src/services/trackPreference.ts` | Core |
| `backend/src/services/trackReconciliation.ts` | Core |
| `backend/src/services/trackRebinding.ts` | Moved-track identity persistence and audio-change decisions |
| `backend/src/services/trackReplacement.ts` | Replacement analysis, transcode invalidation, and loudness refresh |
| `backend/src/services/umapProjection.ts` | Core |
| `backend/src/services/unifiedTrackResponse.ts` | Core |
| `backend/src/services/vibeAnalysisCleanup.ts` | Core |
| `backend/src/services/vibeCalibration.ts` | Vibe distance calibration |
| `backend/src/services/vibeEmbedJobs.ts` | Provider-backed audio embedding job lifecycle |
| `backend/src/services/vibeEmbeddingCoverage.ts` | Worker target-space audio embedding coverage metrics |
| `backend/src/services/vibeEmbeddingEligibility.ts` | Shared local-track eligibility for vibe production and coverage |
| `backend/src/services/vibeInvalidation.ts` | Atomic vibe-state reset and generation invalidation fence |
| `backend/src/services/vibeProvider.ts` | Validated, bounded vibe-provider HTTP client and registry-space trust boundaries |
| `backend/src/services/vibeVocabulary.ts` | Core |
| `backend/src/services/vibeVocabularyGenerator.ts` | Testable provider-backed vocabulary artifact generation |
| `backend/src/services/wikidata.ts` | Core |
| `backend/src/services/workerEventLoopMonitor.ts` | Core |
| `backend/src/services/youtubeDownload.ts` | Core |
| `backend/src/services/youtubeMusic.ts` | Core |

## Update Rule

- Keep services reusable and route handlers thin. If service entrypoints or contracts change, update impacted docs/tests in the same change set.

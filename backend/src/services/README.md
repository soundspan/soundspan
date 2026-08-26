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
| `backend/src/services/albumMatchPolicy.ts` | Shared fail-closed provider album artist/title matching policy |
| `backend/src/services/albumDownloadJobs.ts` | Shared locked album download-job creation and active-job deduplication |
| `backend/src/services/albumDownloadQueueOwnership.ts` | Persisted album-download queue ownership marker and metadata predicate |
| `backend/src/services/albumDownloadQueueService.ts` | Durable album download queue admission and observed background enqueue failures |
| `backend/src/services/albumDownloadCompleteness.ts` | Pure downloaded-versus-expected album track-count classification |
| `backend/src/services/artistDownloadExpansionJobs.ts` | Locked creation and active-job deduplication for durable artist discography expansion |
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
| `backend/src/services/coalescedLibraryScan.ts` | Deployment-wide full-library scan coalescing and follow-up admission |
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
| `backend/src/services/downloadDispatcher.ts` | Configured-source album download dispatch (policy resolution and provider routing) |
| `backend/src/services/downloadArtistMbid.ts` | Artist-MBID reuse and MusicBrainz fallback for manager-backed album downloads |
| `backend/src/services/downloadJobStatus.ts` | Shared download-job status transitions and guarded metadata patch writes |
| `backend/src/services/download/albumRetryStrategy.ts` | Same-artist fallback decisions and retry orchestration |
| `backend/src/services/download/downloadJobEvents.ts` | Closed typed download-job notification event vocabulary |
| `backend/src/services/download/downloadJobNotificationSubscriber.ts` | Notification-policy subscriber and delivery side effects |
| `backend/src/services/download/lidarrQueueReconciler.ts` | Snapshot-based Lidarr library and queue reconciliation |
| `backend/src/services/download/staleDownloadSweeper.ts` | Time-window-based stale download cleanup |
| `backend/src/services/embeddingSpaceLifecycle.ts` | Blue/green embedding-space cutover and retirement cleanup |
| `backend/src/services/embeddingSpaces.ts` | Provider-space registry resolution, active cache, and worker target |
| `backend/src/services/enrichment.ts` | Enrichment settings and compatibility facade over shared metadata field rules |
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
| `backend/src/services/federationPeers.ts` | Encrypted peer credentials, identity, and linking lifecycle |
| `backend/src/services/federationPlaylistExport.ts` | Privacy-filtered host export of public, owner-opted-in playlists |
| `backend/src/services/federationPeerPlaylists.ts` | Bounded on-demand peer playlist browse, resolution, follow, and copy orchestration |
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
| `backend/src/services/libraryDownloadProcessor.ts` | Shared provider-backed library album download orchestration and fallback handoff |
| `backend/src/services/libraryRadioBuilder.ts` | Core |
| `backend/src/services/libraryRadioStationSelection.ts` | Shared Quick Start, genre, and decade radio selection |
| `backend/src/services/libraryRadioTrackResponse.ts` | Library-radio playback response mapping |
| `backend/src/services/libraryOrphanCleanup.ts` | Deletes non-CATALOG library parents after their final track row is purged |
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
| `backend/src/services/lidarr/lidarrAlbumSelection.ts` | Pure Lidarr album catalog matching and edition fallback selection |
| `backend/src/services/lidarr/lidarrArtistCatalog.ts` | Artist presence and bounded album-catalog polling |
| `backend/src/services/lidarr/lidarrHttpClient.ts` | Bounded Lidarr HTTP transport |
| `backend/src/services/lidarr/lidarrQueue.ts` | Lidarr queue inspection and cleanup |
| `backend/src/services/lidarr/lidarrReconciliation.ts` | Queue and downloaded-album reconciliation snapshots |
| `backend/src/services/lidarr/lidarrReleaseGrab.ts` | Lidarr album monitoring, search, and edition fallback acquisition |
| `backend/src/services/lidarr/lidarrTagService.ts` | Lidarr discovery-tag lifecycle and artist tagging |
| `backend/src/services/listenTogether.ts` | Core |
| `backend/src/services/listenTogetherAvailability.ts` | Queue identity checks for late availability resolution |
| `backend/src/services/listenTogetherAvailabilityPublication.ts` | Resolve, revalidate, and publish per-user queue availability |
| `backend/src/services/listenTogetherCallbacks.ts` | Per-stage fenced snapshot, membership, and socket publication queue |
| `backend/src/services/listenTogetherClusterSync.ts` | Post-authority-check deferred cluster effects, replay watermarks, direct local identity revocation, and reconnect reconciliation ownership |
| `backend/src/services/listenTogetherDeadline.ts` | Bounded Listen Together Redis, publication, and shared-deadline operations |
| `backend/src/services/listenTogetherExternalSnapshot.ts` | Bounded adoption of externally produced group snapshots |
| `backend/src/services/listenTogetherGroupDeparture.ts` | Abort-aware fenced PostgreSQL departure, group ending, and host-transfer orchestration |
| `backend/src/services/listenTogetherGroupEnding.ts` | Idempotent fenced PostgreSQL group ending for normal and retry cleanup paths |
| `backend/src/services/listenTogetherGroupError.ts` | Stable Listen Together domain error |
| `backend/src/services/listenTogetherLeaseFencing.ts` | Mutation fencing contracts |
| `backend/src/services/listenTogetherInternalCompletion.ts` | Bounded ready-gate completion retry policy |
| `backend/src/services/listenTogetherManager.ts` | In-memory group state and shared normal/shutdown playback transitions |
| `backend/src/services/listenTogetherMembershipFence.ts` | Pre-write and pre-commit lease validation around PostgreSQL membership fencing |
| `backend/src/services/listenTogetherMembershipPublication.ts` | Committed membership overlay and publication |
| `backend/src/services/listenTogetherMutationAdmission.ts` | Command-owned HTTP/socket admission, shutdown-owned work, and fixed-deadline drain |
| `backend/src/services/listenTogetherMutationLock.ts` | Renewable per-group mutation leases and fencing tokens |
| `backend/src/services/listenTogetherPlaybackPosition.ts` | Playback position calculations |
| `backend/src/services/listenTogetherPersistenceState.ts` | Publication eligibility for periodic persistence |
| `backend/src/services/listenTogetherReadyGate.ts` | Ready-gate state transitions |
| `backend/src/services/listenTogetherResolution.ts` | Core |
| `backend/src/services/listenTogetherSnapshot.ts` | Version-aware snapshot membership and playback adoption helpers |
| `backend/src/services/listenTogetherShutdownDrain.ts` | Shared shutdown drain deadline and outcome |
| `backend/src/services/listenTogetherSocket.ts` | Socket command admission, fenced mutation orchestration, and ordered fanout |
| `backend/src/services/listenTogetherSocketMutationAuthority.ts` | Locked Redis-authority hydration and stale local socket-group eviction |
| `backend/src/services/listenTogetherSocketMutationEligibility.ts` | In-lock pending-deletion check and local socket revocation for acting users |
| `backend/src/services/listenTogetherSocketPlayback.ts` | Socket playback command validation and manager dispatch |
| `backend/src/services/listenTogetherSocketRevocation.ts` | Retry-safe group and all-user socket eviction by socket and user identity |
| `backend/src/services/listenTogetherSocketReconciliation.ts` | Single-flight reconnect audit of exact attached socket-membership pairs; the current Prisma read is non-cancelable, so one 100-pair batch remains active until settlement before a coalesced trailing audit may start |
| `backend/src/services/listenTogetherStateStore.ts` | Core |
| `backend/src/services/listenTogetherUserCleanup.ts` | Abortable fail-closed administrative user cleanup with historical and final cluster revocation sweeps |
| `backend/src/services/listenTogetherUserEligibility.ts` | Transactional create/join and reconnect fences for pending user deletion |
| `backend/src/services/listenTogetherUserQuiescence.ts` | Bounded per-group local mutation-tail barrier before administrative user cleanup |
| `backend/src/services/lyrics.ts` | Core |
| `backend/src/services/m3uParser.ts` | Core |
| `backend/src/services/metadata/albumCoverResolver.ts` | Canonical bounded album-cover provider ladder, cache, and in-flight deduplication |
| `backend/src/services/metadata/albumEnrichmentFields.ts` | Shared MusicBrainz, Last.fm, cover, and album-column enrichment rules |
| `backend/src/services/metadata/artistEnrichmentFields.ts` | Shared Wikidata-first bio, Last.fm genre, image, and artist-column enrichment rules |
| `backend/src/services/metadata/artistImageResolver.ts` | Canonical bounded artist-image provider ladder, cache, and in-flight deduplication |
| `backend/src/services/metadata/catalogPersistence.ts` | Kill-switchable write-through and fresh read-first access for MusicBrainz album and track skeletons |
| `backend/src/services/metadata/discographyFiltering.ts` | Library artist discography secondary-type filtering policy |
| `backend/src/services/moodBucketService.ts` | Core |
| `backend/src/services/musicbrainz.ts` | Core |
| `backend/src/services/musicScanner.ts` | Core |
| `backend/src/services/musicScannerIdentity.ts` | Scanner artist and album identity resolution |
| `backend/src/services/musicRequestService.ts` | Album request deduplication, quota, review, and notification lifecycle |
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
| `backend/src/services/remoteProviders/adapters.ts` | Shared remote playback, playlist-import, and playlist-row provider routing |
| `backend/src/services/remoteProviders/types.ts` | Canonical remote-provider identities and mapping/streaming translators |
| `backend/src/services/rssParser.ts` | Core |
| `backend/src/services/scannerAlbumDedup.ts` | Bounded normalized scanner-album duplicate merging before orphan cleanup |
| `backend/src/services/scannerAlbumIdentityPolicy.ts` | Shared deterministic scanner-album keeper preference |
| `backend/src/services/search.ts` | Core |
| `backend/src/services/simpleDownloadManager.ts` | Core |
| `backend/src/services/soulseek/albumCoherence.ts` | Pure Soulseek album-folder grouping, coherence eligibility, and peer-signal ranking |
| `backend/src/services/soulseek/albumFolderDownload.ts` | Soulseek coherent-folder batch orchestration with per-track retry fallback |
| `backend/src/services/soulseekLibraryDownload.ts` | Soulseek album track-list resolution, batch download, and download-job persistence |
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
| `backend/src/services/userDeletion.ts` | Transactional deletion reservation, last-admin guards, and marker cancellation |
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

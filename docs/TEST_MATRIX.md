# Test Matrix

Canonical domain-to-test mapping for fast, targeted verification.

## Constraints

- Prefer targeted impacted commands from this matrix before broad suite runs.

## Fast Commands

### Backend (Jest)

```bash
# Single test file
npx --prefix backend jest --no-coverage <testFile>

# Pattern match
npx --prefix backend jest --no-coverage --testPathPatterns "<pattern>"

# With coverage (slower)
npm --prefix backend run test:coverage
```

### Frontend

```bash
# Unit tests (Node test runner, requires Node 24+)
npm --prefix frontend run test:unit

# Component tests
npm --prefix frontend run test:component

# Lint
npm --prefix frontend run lint

# Build check
npm --prefix frontend run build

# Coverage
npm --prefix frontend run test:coverage
npm --prefix frontend run test:component:coverage
```

### Governance

```bash
# Receipt-scoped, targeted verify
awm verify --project soundspan --phase review --file-changed <path>

# Promoted full backend build + coverage gate before done
awm review --run --project soundspan --receipt-id <receipt-id>

awm health --project soundspan --include-details
```

## Domain-to-Test Map

### Backend Route Tests (`backend/src/routes/__tests__/`)

| Domain            | Test Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Route Module                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Admin             | `admin.test.ts`, `adminRuntime.test.ts`, `adminSecretsStatusRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                     | `admin.ts`                         |
| Analysis          | `analysisRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `analysis.ts`                      |
| API Keys          | `apiKeysRuntime.test.ts`, `apiKeysInteractiveAuthRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                | `apiKeys.ts`                       |
| Artists           | `artistsRuntime.test.ts`, `artistsPreviewYtMusic.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                        | `artists.ts`                       |
| Audiobooks        | `audiobooksRuntime.test.ts`, `audiobooksAdvancedRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                 | `audiobooks.ts`                    |
| Auth              | `authRuntime.test.ts`, `authOidcRuntime.test.ts`, `authAdminSsoRuntime.test.ts`, `authInteractiveAuthRuntime.test.ts`, `authModuleBoundariesRuntime.test.ts`, `totpBehavior.test.ts`                                                                                                                                                                                                                                                                                              | `auth.ts` / `auth/*.ts`            |
| Browse            | `browseRuntime.test.ts`, `browseTidal.test.ts`, `browseUrlParse.test.ts`, `browseYtMusicRoutes.integration.test.ts`, `browseBranchCoverage.test.ts`                                                                                                                                                                                                                                                                                                                              | `browse.ts`                        |
| Device Link       | `deviceLinkRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `deviceLink.ts`                    |
| Discover          | `discoverRuntime.test.ts`, `discoverLegacyRuntime.test.ts`, `discoverRecommendationCompat.test.ts`, `discoverCleanupLidarrLeak.test.ts`, `discoverErrorLeak.test.ts`                                                                                                                                                                                                                                                                                                             | `discover.ts`                      |
| Downloads         | `downloadsRuntime.test.ts`, `downloadsInteractiveCompat.test.ts`, `downloadsReleasesCompat.test.ts`                                                                                                                                                                                                                                                                                                                                                                              | `downloads.ts`                     |
| Enrichment        | `enrichmentRuntime.test.ts`, `enrichmentFullOptionsCompat.test.ts`, `enrichmentMetadataCompat.test.ts`, `enrichmentMusicBrainzLookupCompat.test.ts`, `enrichmentErrorLeak.test.ts`, `enrichmentFailuresBoundedQuery.test.ts`, `enrichmentRepairCovers.test.ts`                                                                                                                                                                                                                   | `enrichment.ts`                    |
| Federation        | `federationRoutes.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `federation.ts`                    |
| Federation Admin  | `federationAdminRoutes.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `federationAdmin.ts`               |
| Homepage          | `homepageRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `homepage.ts`                      |
| Library           | `libraryRuntime.test.ts`, `libraryArtistLookupCompat.test.ts`, `libraryCoverArtCompat.test.ts`, `libraryRadioVibeReliabilityCompat.test.ts`, `libraryRemotePreference.test.ts`, `libraryBranchCoverage.test.ts`, `libraryErrorLeak.test.ts`, `libraryRouteTable.test.ts`                                                                                                                                                                                                         | `library.ts` / `library/*.ts`      |
| Listen Together   | `listenTogetherRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `listenTogether.ts`                |
| Listening State   | `listeningStateRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `listeningState.ts`                |
| Lyrics            | `lyricsRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `lyrics.ts`                        |
| Mixes             | `mixesRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `mixes.ts`                         |
| Notifications     | `notificationsRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `notifications.ts`                 |
| Offline           | `offlineRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `offline.ts`                       |
| Onboarding        | `onboardingRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `onboarding.ts`                    |
| Playback State    | `playbackStateRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `playbackState.ts`                 |
| Playlist Import   | `importRoutes.integration.test.ts`, `playlistImportCore.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                 | `playlistImport.ts`                |
| Playlists         | `playlistsRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `playlists.ts`                     |
| Plays             | `playsHistoryCompat.test.ts`, `playsCore.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                | `plays.ts`                         |
| Podcasts          | `podcastsCoreRuntime.test.ts`, `podcastsDiscoveryRuntime.test.ts`, `podcastsStreamingRuntime.test.ts`, `podcastsDiscoverTopCompat.test.ts`, `podcastsRefreshPrismaRetryCompat.test.ts`                                                                                                                                                                                                                                                                                           | `podcasts.ts`                      |
| Recommendations   | `recommendationsRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `recommendations.ts`               |
| Releases          | `releasesRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `releases.ts`                      |
| Search            | `searchRuntime.test.ts`, `searchDiscoverCompat.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                          | `search.ts`                        |
| Settings          | `settingsDisplayNameCompat.test.ts`, `settingsCore.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                      | `settings.ts`                      |
| Share Links       | `shareLinksCore.test.ts`, `shareLinksRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                            | `shareLinks.ts`                    |
| Social            | `socialCompat.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `social.ts`                        |
| Soulseek          | `soulseekRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `soulseek.ts`                      |
| Streaming         | `streamingRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `streaming.ts`                     |
| Subsonic          | `subsonicCoreCompat.test.ts`, `subsonicBrowseCompat.test.ts`, `subsonicCollectionsCompat.test.ts`, `subsonicEntityCompat.test.ts`, `subsonicLegacyCompat.test.ts`, `subsonicMediaCompat.test.ts`, `subsonicMetadataCompat.test.ts`, `subsonicProfileCompat.test.ts`, `subsonicRuntimeFocused.test.ts`, `subsonicStateCompat.test.ts`, `subsonicStreamCoverArtHandlers.test.ts`, `subsonicTierB.test.ts`, `subsonicBranchCoverage.test.ts`, `subsonicCoverArtResizeDedup.test.ts`, `subsonicModuleBoundariesRuntime.test.ts` | `subsonic.ts` / `subsonic/*.ts`   |
| System            | `systemRuntime.test.ts`, `systemCore.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                    | `system.ts`                        |
| System Settings   | `systemSettingsRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `systemSettings.ts`                |
| TIDAL Streaming   | `tidalStreamingRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `tidalStreaming.ts`                |
| Track Mappings    | `trackMappingsRuntime.test.ts`, `trackMappingsRoutes.integration.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                        | `trackMappings.ts`                 |
| Vibe              | `vibeSearchCompat.test.ts`, `vibeCalibrationRuntime.test.ts`, `vibeErrorShapeCanon.test.ts`, `vibeJourneyRequest.test.ts`, `vibeJourneyRuntime.test.ts`                                                                                                                                                                                                                                                                                                                          | `vibe.ts`, `vibeJourneyRequest.ts` |
| Webhooks          | `webhooksRuntime.test.ts`, `webhooksGrabConcurrency.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                     | `webhooks.ts`                      |
| YouTube           | `youtubeRuntime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `youtube.ts`                       |
| YouTube Music     | `youtubeMusicRuntime.test.ts`, `youtubeMusicPublicRoutes.integration.test.ts`, `youtubeMusicPublicStream.test.ts`, `youtubeMusicBranchCoverage.test.ts`                                                                                                                                                                                                                                                                                                                          | `youtubeMusic.ts`                  |

### Backend Contract/Cross-Domain Tests (`backend/src/__tests__/`)

Audiobook service behavior is covered by
`src/services/__tests__/audiobookSections.test.ts`,
`src/services/__tests__/audiobookCacheService.test.ts`, and
`src/services/__tests__/audiobookshelfService.test.ts`. The validated section
component contract is covered by
`frontend/tests/component/chapterList.component.test.ts`.

Programmatic playlist service behavior is covered by
`src/services/__tests__/programmaticPlaylistsBehavior.test.ts`,
`src/services/__tests__/programmaticPlaylistsCuratedMixes.test.ts`,
`src/services/__tests__/programmaticPlaylistsDataDriven.test.ts`,
`src/services/__tests__/programmaticPlaylistsPriorityMixes.test.ts`, and
`src/services/__tests__/programmaticPlaylistsModuleBoundariesRuntime.test.ts`.

| Domain                   | Test Files                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Entrypoint           | `apiEntrypointRuntime.test.ts`, `apiEntrypointDbResilienceContract.test.ts`                                                                                                                                                  |
| Embedding Migration      | `embeddingSpaceMigration.test.ts`, `src/services/__tests__/embeddingSpaceLifecycle.test.ts`, `src/services/__tests__/embeddingSpaces.test.ts`, `src/services/__tests__/vibeEmbeddingCoverage.test.ts`, `src/services/__tests__/vibeEmbedMigrationFlow.test.ts` |
| Federation Export Guard  | `src/services/__tests__/federationCatalog.test.ts`                                                                                                                                                                          |
| Provider Audio Jobs      | `src/services/__tests__/vibeEmbedJobs.test.ts`, `src/services/__tests__/vibeProvider.test.ts`, `src/workers/__tests__/vibeEmbedWorker.test.ts`, `src/workers/__tests__/legacyVibeRedisCleanup.test.ts`                         |
| Authorization / Security | `artistsRouteAuthz.test.ts`, `audiobooksCoverAuthz.test.ts`, `configBoundary.guard.test.ts`, `enrichmentRouteAuthz.test.ts`, `listenTogetherEndGroupAuthz.test.ts`                                                          |
| Config                   | `config.test.ts`                                                                                                                                                                                                             |
| Data Integrity           | `dataIntegrityPrismaRetryContract.test.ts`                                                                                                                                                                                   |
| Dependencies             | `dependencyReadinessContract.test.ts`                                                                                                                                                                                        |
| Discovery                | `discoverProcessorIdempotencyContract.test.ts`, `discoverQueueHandlerContract.test.ts`                                                                                                                                       |
| Enrichment               | `enrichmentCycleClaimContract.test.ts`, `enrichmentStateRedisRetryContract.test.ts`, `artistEnrichmentMbidConflict.test.ts`                                                                                                  |
| Health                   | `healthEndpointContract.test.ts`                                                                                                                                                                                             |
| Listen Together          | `listenTogether*.test.ts` (9 files)                                                                                                                                                                                          |
| Mood                     | `moodBucket*.test.ts` (2 files)                                                                                                                                                                                              |
| Playlists                | `programmaticPlaylistArtistCap.test.ts`                                                                                                                                                                                      |
| Prisma                   | `prismaBinaryTargetContract.test.ts`, `prismaConnectionResilienceContract.test.ts`                                                                                                                                           |
| Queue                    | `queueCleanerPrismaRetryContract.test.ts`                                                                                                                                                                                    |
| Workers                  | `worker*.test.ts` (7 files)                                                                                                                                                                                                  |

### Python Provider Tests

| Provider | Test Path | Targeted Command |
| --- | --- | --- |
| DCLAP ONNX | `services/vibe-provider-dclap/tests/` | `pytest services/vibe-provider-dclap/tests -q` |

### Frontend Tests

| Path                                     | Scope                 | Command                                    |
| ---------------------------------------- | --------------------- | ------------------------------------------ |
| `frontend/tests/unit/*.test.ts`          | Unit/logic tests      | `npm --prefix frontend run test:unit`      |
| `frontend/tests/component/*.test.ts`     | Component regressions | `npm --prefix frontend run test:component` |
| `frontend/tests/e2e/*.spec.ts`           | E2E smoke/flows       | `npm --prefix frontend run test:e2e`       |
| `frontend/tests/e2e/predeploy/*.spec.ts` | Release-readiness     | `npm --prefix frontend run test:predeploy` |

## Update Triggers

Update this matrix when:

- A test file is added, renamed, or removed
- A route module is added, renamed, or removed
- A reliable targeted command changes

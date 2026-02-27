# Test Matrix

Canonical feature-to-test map for fast, targeted verification.

## Usage Rule

- Treat this file as the canonical targeted-test command map.
- Whenever a feature is introduced, changed significantly, or removed, update or explicitly verify the related feature entry in `.agents-config/docs/FEATURE_INDEX.json` and this matrix in the same change set.
- Prefer running targeted impacted commands from this matrix before broad/full-suite runs.
- Run `npm run feature-index:verify` as a quick drift check for frontend feature coverage in `.agents-config/docs/FEATURE_INDEX.json`.

## Fast Commands

### Backend

```bash
npm --prefix backend test -- --runInBand src/routes/__tests__/libraryRuntime.test.ts
npm --prefix backend test -- --runInBand src/routes/__tests__/discoverRuntime.test.ts src/routes/__tests__/mixesRuntime.test.ts
npm --prefix backend test -- --runInBand src/routes/__tests__/subsonicRuntimeFocused.test.ts src/routes/__tests__/subsonicCoreCompat.test.ts
npm --prefix backend test -- --runInBand src/routes/__tests__/listenTogetherRuntime.test.ts src/routes/__tests__/socialCompat.test.ts
npm --prefix backend test -- --runInBand src/services/__tests__/hybridSimilarity.test.ts src/services/discovery/__tests__/discoveryRecommendationsService.test.ts
```

### Frontend

```bash
npm --prefix frontend run lint
npm --prefix frontend run test:unit
npm --prefix frontend run test:component
npm --prefix frontend run test:component:coverage:changed
npm --prefix frontend run test:coverage:social
npm --prefix frontend run test:predeploy
```

### Governance

```bash
npm run feature-index:verify
npm run logging:compliance:verify
node .agents-config/scripts/enforce-agent-policies.mjs
```

## Feature-to-Test Map

| Feature ID (`.agents-config/docs/FEATURE_INDEX.json`) | Targeted commands | Primary specs |
| --- | --- | --- |
| `library-and-home` | `npm --prefix backend test -- --runInBand src/routes/__tests__/libraryRuntime.test.ts src/routes/__tests__/homepageRuntime.test.ts`<br>`npm --prefix frontend run test:component` | `backend/src/routes/__tests__/libraryRuntime.test.ts`<br>`backend/src/routes/__tests__/homepageRuntime.test.ts`<br>`frontend/tests/component/trackPreferenceButtons.component.test.ts` |
| `album-and-artist` | `npm --prefix backend test -- --runInBand src/routes/__tests__/artistsRuntime.test.ts`<br>`npm --prefix frontend run test:component` | `backend/src/routes/__tests__/artistsRuntime.test.ts`<br>`frontend/tests/component/remainingViewsOverflowMenu.component.test.ts` |
| `discover-and-mixes` | `npm --prefix backend test -- --runInBand src/routes/__tests__/discoverRuntime.test.ts src/routes/__tests__/mixesRuntime.test.ts`<br>`npm --prefix backend test -- --runInBand src/services/__tests__/hybridSimilarity.test.ts src/services/discovery/__tests__/discoveryRecommendationsService.test.ts`<br>`npm --prefix frontend run test:unit` | `backend/src/routes/__tests__/discoverRuntime.test.ts`<br>`backend/src/routes/__tests__/mixesRuntime.test.ts`<br>`backend/src/services/__tests__/hybridSimilarity.test.ts`<br>`backend/src/services/discovery/__tests__/discoveryRecommendationsService.test.ts`<br>`frontend/features/discover/hooks/useDiscoverProviderGapFill.test.ts` |
| `podcasts` | `npm --prefix backend test -- --runInBand src/routes/__tests__/podcastsCoreRuntime.test.ts src/routes/__tests__/podcastsDiscoveryRuntime.test.ts`<br>`npm --prefix backend test -- --runInBand src/services/__tests__/podcastDownloadRuntime.test.ts` | `backend/src/routes/__tests__/podcastsCoreRuntime.test.ts`<br>`backend/src/routes/__tests__/podcastsDiscoveryRuntime.test.ts`<br>`backend/src/services/__tests__/podcastDownloadRuntime.test.ts` |
| `audiobooks` | `npm --prefix backend test -- --runInBand src/routes/__tests__/audiobooksRuntime.test.ts src/routes/__tests__/audiobooksAdvancedRuntime.test.ts`<br>`npm --prefix backend test -- --runInBand src/services/__tests__/audiobookshelfService.test.ts` | `backend/src/routes/__tests__/audiobooksRuntime.test.ts`<br>`backend/src/routes/__tests__/audiobooksAdvancedRuntime.test.ts`<br>`backend/src/services/__tests__/audiobookshelfService.test.ts` |
| `search-and-browse` | `npm --prefix backend test -- --runInBand src/routes/__tests__/searchRuntime.test.ts src/routes/__tests__/browseRuntime.test.ts`<br>`npm --prefix backend test -- --runInBand src/services/__tests__/searchService.test.ts src/services/__tests__/deezerService.test.ts` | `backend/src/routes/__tests__/searchRuntime.test.ts`<br>`backend/src/routes/__tests__/browseRuntime.test.ts`<br>`backend/src/services/__tests__/searchService.test.ts`<br>`backend/src/services/__tests__/deezerService.test.ts` |
| `settings-and-device` | `npm --prefix backend test -- --runInBand src/routes/__tests__/settingsDisplayNameCompat.test.ts src/routes/__tests__/systemSettingsRuntime.test.ts src/routes/__tests__/deviceLinkRuntime.test.ts`<br>`npm --prefix frontend run lint` | `backend/src/routes/__tests__/systemSettingsRuntime.test.ts`<br>`backend/src/routes/__tests__/deviceLinkRuntime.test.ts` |
| `playlists-queue-and-player` | `npm --prefix frontend run test:component`<br>`npm --prefix frontend run test:unit`<br>`npm --prefix backend test -- --runInBand src/routes/__tests__/playlistsRuntime.test.ts` | `frontend/tests/component/trackOverflowMenu.component.test.ts`<br>`frontend/tests/component/queuePageOverflowMenu.component.test.ts`<br>`frontend/tests/component/miniPlayerEnhancements.component.test.ts`<br>`frontend/tests/component/audioPlaybackTimeGuard.component.test.ts`<br>`frontend/tests/unit/playNextQueueControl.test.ts`<br>`frontend/tests/unit/audioPlaybackPersistence.test.ts`<br>`frontend/tests/unit/prewarmValidationTimeout.test.ts`<br>`frontend/tests/unit/segmentedRepresentationPolicy.test.ts`<br>`frontend/tests/unit/segmentedPlaybackRegressionPolicy.test.ts`<br>`backend/src/routes/__tests__/playlistsRuntime.test.ts` |
| `social-and-listen-together` | `npm --prefix backend test -- --runInBand src/routes/__tests__/listenTogetherRuntime.test.ts src/routes/__tests__/socialCompat.test.ts`<br>`npm --prefix frontend run test:coverage:social` | `backend/src/routes/__tests__/listenTogetherRuntime.test.ts`<br>`backend/src/routes/__tests__/socialCompat.test.ts`<br>`frontend/tests/component/activityPanel.component.test.ts`<br>`frontend/tests/component/listenTogetherSocketRetry.component.test.ts` |
| `streaming-integrations-and-subsonic` | `npm --prefix backend test -- --runInBand src/routes/__tests__/tidalStreamingRuntime.test.ts src/routes/__tests__/youtubeMusicRuntime.test.ts src/routes/__tests__/subsonicRuntimeFocused.test.ts`<br>`npm --prefix backend test -- --runInBand src/routes/__tests__/subsonicCoreCompat.test.ts src/routes/__tests__/subsonicBrowseCompat.test.ts` | `backend/src/routes/__tests__/tidalStreamingRuntime.test.ts`<br>`backend/src/routes/__tests__/youtubeMusicRuntime.test.ts`<br>`backend/src/routes/__tests__/subsonicRuntimeFocused.test.ts`<br>`backend/src/routes/__tests__/subsonicCoreCompat.test.ts` |
| `logging-and-observability-governance` | `npm --prefix backend test -- --runInBand src/utils/__tests__/logger.test.ts`<br>`npm --prefix frontend run test:unit -- tests/unit/logger.test.ts`<br>`python3 -m py_compile services/common/logging_utils.py services/ytmusic-streamer/app.py services/tidal-downloader/app.py`<br>`npm run logging:compliance:verify`<br>`node .agents-config/scripts/enforce-agent-policies.mjs` | `backend/src/utils/__tests__/logger.test.ts`<br>`frontend/tests/unit/logger.test.ts`<br>`.agents-config/scripts/verify-logging-compliance.mjs` |

## Update Triggers

Update this matrix when any of the following occurs:

- A feature is introduced, changed significantly, or removed.
- A reliable targeted command changes (script rename, path move, or framework invocation change).
- A high-value regression spec is added and should be part of the default targeted workflow.

## Verification Workflow

1. Locate impacted feature IDs in `.agents-config/docs/FEATURE_INDEX.json`.
2. Run the mapped targeted commands from this matrix.
3. If a command is stale, fix this matrix in the same change set.
4. If feature behavior changed materially, update or verify both `.agents-config/docs/FEATURE_INDEX.json` and `.agents-config/docs/TEST_MATRIX.md` before closeout.

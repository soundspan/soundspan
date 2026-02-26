# Discover Feature Domain

Start-here guide for `frontend/features/discover`.

## Start Here

1. Route entrypoints: `frontend/app/discover/page.tsx`, `frontend/app/mix/page.tsx`
2. Domain ownership and contracts: `.agents-config/docs/FEATURE_INDEX.json`.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/discoverRuntime.test.ts src/routes/__tests__/mixesRuntime.test.ts`
- `npm --prefix backend test -- --runInBand src/services/__tests__/hybridSimilarity.test.ts src/services/discovery/__tests__/discoveryRecommendationsService.test.ts`
- `npm --prefix frontend run test:unit`

## Feature Index Mapping

- Feature IDs: `discover-and-mixes`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/DiscoverActionBar.tsx` | components |
| `components/DiscoverHero.tsx` | components |
| `components/DiscoverSettings.tsx` | components |
| `components/HowItWorks.tsx` | components |
| `components/TrackList.tsx` | components |
| `components/UnavailableAlbums.tsx` | components |
| `hooks/useDiscoverActions.test.ts` | hooks |
| `hooks/useDiscoverActions.ts` | hooks |
| `hooks/useDiscoverData.ts` | hooks |
| `hooks/useDiscoverProviderGapFill.test.ts` | hooks |
| `hooks/useDiscoverProviderGapFill.ts` | hooks |
| `hooks/usePreviewPlayer.ts` | hooks |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `.agents-config/docs/FEATURE_INDEX.json` and `.agents-config/docs/TEST_MATRIX.md`.

# Explore Feature Domain

Start-here guide for `frontend/features/explore`.

## Start Here

1. Route entrypoints: `frontend/app/explore/page.tsx`, `frontend/app/library/page.tsx`, `frontend/app/page.tsx`, `frontend/app/radio/page.tsx`
2. Domain ownership and contracts: `.agents-config/docs/FEATURE_INDEX.json`.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/libraryRuntime.test.ts src/routes/__tests__/homepageRuntime.test.ts`
- `npm --prefix frontend run test:component`
- `npm --prefix frontend run test:unit`

## Feature Index Mapping

- Feature IDs: `library-and-home`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/FeaturedShelvesSection.tsx` | components |
| `components/MadeForYouSection.tsx` | components |
| `components/MoodPills.tsx` | components |
| `components/MoodsGenresSection.tsx` | components |
| `components/ProviderTabSection.tsx` | components |
| `components/TidalFeaturedShelvesSection.tsx` | components |
| `components/TidalMixesSection.tsx` | components |
| `components/TidalMoodsGenresSection.tsx` | components |
| `components/YtMusicMixesSection.tsx` | components |
| `genreClassification.ts` | root |
| `hooks/useExploreData.ts` | hooks |
| `hooks/useTidalExploreEnabled.ts` | hooks |
| `hooks/useUserSettingsExplorePrefs.ts` | hooks |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `.agents-config/docs/FEATURE_INDEX.json` and `.agents-config/docs/TEST_MATRIX.md`.

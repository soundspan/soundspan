# Home Feature Domain

Start-here guide for `frontend/features/home`.

## Start Here

1. Route entrypoints: `frontend/app/library/page.tsx`, `frontend/app/page.tsx`, `frontend/app/radio/page.tsx`
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
| `components/ArtistsGrid.tsx` | components |
| `components/AudiobooksGrid.tsx` | components |
| `components/ContinueListening.tsx` | components |
| `components/FeaturedPlaylistsGrid.tsx` | components |
| `components/HomeHero.tsx` | components |
| `components/LibraryRadioStations.tsx` | components |
| `components/MixesGrid.tsx` | components |
| `components/PodcastsGrid.tsx` | components |
| `components/PopularArtistsGrid.tsx` | components |
| `components/SectionHeader.tsx` | components |
| `hooks/useHomeData.ts` | hooks |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `.agents-config/docs/FEATURE_INDEX.json` and `.agents-config/docs/TEST_MATRIX.md`.

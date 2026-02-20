# Library Feature Domain

Start-here guide for `frontend/features/library`.

## Start Here

1. Route entrypoints: `frontend/app/library/page.tsx`, `frontend/app/page.tsx`, `frontend/app/radio/page.tsx`
2. Domain ownership and contracts: `docs/FEATURE_INDEX.json`.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/libraryRuntime.test.ts src/routes/__tests__/homepageRuntime.test.ts`
- `npm --prefix frontend run test:component`
- `npm --prefix frontend run test:unit`

## Feature Index Mapping

- Feature IDs: `library-and-home`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/AlbumsGrid.tsx` | components |
| `components/ArtistsGrid.tsx` | components |
| `components/LibraryHeader.tsx` | components |
| `components/LibraryTabs.tsx` | components |
| `components/TracksList.tsx` | components |
| `hooks/useLibraryActions.ts` | hooks |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `docs/FEATURE_INDEX.json` and `docs/TEST_MATRIX.md`.

# Search Feature Domain

Start-here guide for `frontend/features/search`.

## Start Here

1. Route entrypoints: `frontend/app/browse/playlists/page.tsx`, `frontend/app/search/page.tsx`
2. Domain ownership and contracts: `docs/FEATURE_INDEX.json`.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/searchRuntime.test.ts src/routes/__tests__/browseRuntime.test.ts`
- `npm --prefix backend test -- --runInBand src/services/__tests__/searchService.test.ts`

## Feature Index Mapping

- Feature IDs: `search-and-browse`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/AliasResolutionBanner.tsx` | components |
| `components/DiscoverPodcastsGrid.tsx` | components |
| `components/EmptyState.tsx` | components |
| `components/LibraryAlbumsGrid.tsx` | components |
| `components/LibraryAudiobooksGrid.tsx` | components |
| `components/LibraryPodcastsGrid.tsx` | components |
| `components/LibraryTracksList.tsx` | components |
| `components/SearchFilters.tsx` | components |
| `components/SimilarArtistsGrid.tsx` | components |
| `components/SoulseekSongsList.tsx` | components |
| `components/TopResult.tsx` | components |
| `components/TVSearchInput.tsx` | components |
| `hooks/useSearchData.ts` | hooks |
| `hooks/useSoulseekSearch.ts` | hooks |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `docs/FEATURE_INDEX.json` and `docs/TEST_MATRIX.md`.

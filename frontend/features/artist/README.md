# Artist Feature Domain

Start-here guide for `frontend/features/artist`.

## Start Here

1. Route entrypoints: `frontend/app/album/[id]/page.tsx`, `frontend/app/artist/[id]/page.tsx`
2. Domain ownership and contracts: `docs/FEATURE_INDEX.json`.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/artistsRuntime.test.ts`
- `npm --prefix frontend run test:component`

## Feature Index Mapping

- Feature IDs: `album-and-artist`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/ArtistActionBar.tsx` | components |
| `components/ArtistBio.tsx` | components |
| `components/ArtistHero.tsx` | components |
| `components/AvailableAlbums.tsx` | components |
| `components/Discography.tsx` | components |
| `components/index.ts` | components |
| `components/PopularTracks.tsx` | components |
| `components/SimilarArtists.tsx` | components |
| `hooks/index.ts` | hooks |
| `hooks/useArtistActions.ts` | hooks |
| `hooks/useArtistData.ts` | hooks |
| `hooks/useDownloadActions.ts` | hooks |
| `hooks/useTidalTopTracks.ts` | hooks |
| `hooks/useYtMusicTopTracks.ts` | hooks |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `docs/FEATURE_INDEX.json` and `docs/TEST_MATRIX.md`.

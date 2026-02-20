# Album Feature Domain

Start-here guide for `frontend/features/album`.

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
| `components/AlbumActionBar.tsx` | components |
| `components/AlbumHero.tsx` | components |
| `components/SimilarAlbums.tsx` | components |
| `components/TrackList.tsx` | components |
| `hooks/useAlbumActions.ts` | hooks |
| `hooks/useAlbumData.ts` | hooks |
| `hooks/useTidalGapFill.ts` | hooks |
| `hooks/useYtMusicGapFill.ts` | hooks |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `docs/FEATURE_INDEX.json` and `docs/TEST_MATRIX.md`.

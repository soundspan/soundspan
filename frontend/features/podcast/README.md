# Podcast Feature Domain

Start-here guide for `frontend/features/podcast`.

## Start Here

1. Route entrypoints: `frontend/app/podcasts/page.tsx`
2. Domain ownership and contracts: `docs/FEATURE_INDEX.json`.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/podcastsCoreRuntime.test.ts src/routes/__tests__/podcastsDiscoveryRuntime.test.ts`
- `npm --prefix backend test -- --runInBand src/services/__tests__/podcastDownloadRuntime.test.ts`

## Feature Index Mapping

- Feature IDs: `podcasts`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/ContinueListening.tsx` | components |
| `components/EpisodeList.tsx` | components |
| `components/index.ts` | components |
| `components/PodcastActionBar.tsx` | components |
| `components/PodcastHero.tsx` | components |
| `components/PreviewEpisodes.tsx` | components |
| `components/SimilarPodcasts.tsx` | components |
| `hooks/index.ts` | hooks |
| `hooks/usePodcastActions.ts` | hooks |
| `hooks/usePodcastData.ts` | hooks |
| `index.ts` | root |
| `types.ts` | root |
| `utils.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `docs/FEATURE_INDEX.json` and `docs/TEST_MATRIX.md`.

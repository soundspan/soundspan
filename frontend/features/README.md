# Frontend Features

Start-here index for domain modules under `frontend/features`.

## Start Here

1. Route entrypoints: `frontend/app/**/page.tsx` and `docs/ROUTE_MAP.md`.
2. Feature ownership map: `docs/FEATURE_INDEX.json`.
3. Targeted regression commands: `docs/TEST_MATRIX.md`.

## Feature Domains

| Directory | Domain README | Primary App Routes |
| --- | --- | --- |
| `album` | `frontend/features/album/README.md` | `frontend/app/album/[id]/page.tsx`<br>`frontend/app/artist/[id]/page.tsx` |
| `artist` | `frontend/features/artist/README.md` | `frontend/app/album/[id]/page.tsx`<br>`frontend/app/artist/[id]/page.tsx` |
| `audiobook` | `frontend/features/audiobook/README.md` | `frontend/app/audiobooks/series/[name]/page.tsx` |
| `discover` | `frontend/features/discover/README.md` | `frontend/app/discover/page.tsx`<br>`frontend/app/mix/page.tsx` |
| `home` | `frontend/features/home/README.md` | `frontend/app/library/page.tsx`<br>`frontend/app/page.tsx`<br>`frontend/app/radio/page.tsx` |
| `library` | `frontend/features/library/README.md` | `frontend/app/library/page.tsx`<br>`frontend/app/page.tsx`<br>`frontend/app/radio/page.tsx` |
| `podcast` | `frontend/features/podcast/README.md` | `frontend/app/podcasts/page.tsx` |
| `search` | `frontend/features/search/README.md` | `frontend/app/browse/playlists/page.tsx`<br>`frontend/app/search/page.tsx` |
| `settings` | `frontend/features/settings/README.md` | `frontend/app/device/page.tsx`<br>`frontend/app/settings/page.tsx` |

## Update Rule

- Whenever feature behavior changes materially, update or verify this index and the affected `frontend/features/*/README.md` file in the same change set.

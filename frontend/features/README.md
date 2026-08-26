# Frontend Features

Start-here index for domain modules under `frontend/features`.

## Start Here

1. Route entrypoints: `frontend/app/**/page.tsx`.
2. Domain-specific guides: `frontend/features/*/README.md`.
3. Regression coverage: `frontend/tests/component/` and `frontend/tests/unit/`.

## Feature Domains

| Directory   | Domain README                           | Primary App Routes                                                                                                             |
| ----------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `album`     | `frontend/features/album/README.md`     | `frontend/app/album/[id]/page.tsx`<br>`frontend/app/artist/[id]/page.tsx`                                                      |
| `artist`    | `frontend/features/artist/README.md`    | `frontend/app/album/[id]/page.tsx`<br>`frontend/app/artist/[id]/page.tsx`                                                      |
| `auth`      | `frontend/features/auth/README.md`      | `frontend/app/login/page.tsx`                                                                                                  |
| `audiobook` | `frontend/features/audiobook/README.md` | `frontend/app/audiobooks/series/[name]/page.tsx`                                                                               |
| `discover`  | `frontend/features/discover/README.md`  | `frontend/app/discover/page.tsx`<br>`frontend/app/mix/[id]/page.tsx`                                                           |
| `explore`   | `frontend/features/explore/README.md`   | `frontend/app/explore/page.tsx`<br>`frontend/app/library/page.tsx`<br>`frontend/app/page.tsx`<br>`frontend/app/radio/page.tsx` |
| `home`      | `frontend/features/home/README.md`      | `frontend/app/explore/page.tsx`<br>`frontend/app/library/page.tsx`<br>`frontend/app/page.tsx`<br>`frontend/app/radio/page.tsx` |
| `library`   | `frontend/features/library/README.md`   | `frontend/app/explore/page.tsx`<br>`frontend/app/library/page.tsx`<br>`frontend/app/page.tsx`<br>`frontend/app/radio/page.tsx` |
| `library-health` | `frontend/features/library-health/README.md` | `frontend/app/admin/page.tsx`                                                                                             |
| `podcast`   | `frontend/features/podcast/README.md`   | `frontend/app/podcasts/page.tsx`                                                                                               |
| `search`    | `frontend/features/search/README.md`    | `frontend/app/playlists/page.tsx`<br>`frontend/app/search/page.tsx`                                                            |
| `social`    | `frontend/features/social/README.md`    | `frontend/app/page.tsx`<br>`frontend/app/peer-playlists/[peerId]/[remoteId]/page.tsx`                                          |
| `settings`  | `frontend/features/settings/README.md`  | `frontend/app/device/page.tsx`<br>`frontend/app/settings/page.tsx`                                                             |

## Recognized Exception: Vibe Map

The Vibe Map — the interactive vibe navigator — does **not** live under `frontend/features/`. Its components, hooks, and model live in `frontend/components/vibe/` (entrypoint `VibeMapTab.tsx` / `VibeMapView.tsx`), its route is `frontend/app/vibe/page.tsx`, and its unit coverage is `frontend/tests/unit/` (`mapSearch`, `vibeMapModel`, `vibeModeMachine`, `travelCompass`, and siblings). It is indexed here so the surface is discoverable and its placement is a documented, recognized location rather than undocumented drift.

Relocating it to `frontend/features/vibe/` to match the domain-module convention is an owner decision (large import churn across `frontend/components/vibe/**` and the tests above) and has not been made; until then, extend the Vibe Map in place under `frontend/components/vibe/`.

## Update Rule

- Whenever feature behavior changes materially, update or verify this index and the affected `frontend/features/*/README.md` file in the same change set.

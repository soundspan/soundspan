# Audiobook Feature Domain

Start-here guide for `frontend/features/audiobook`.

## Start Here

1. Route entrypoints: `frontend/app/audiobooks/series/[name]/page.tsx`
2. Domain ownership and contracts: `.agents-config/docs/FEATURE_INDEX.json`.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/audiobooksRuntime.test.ts src/routes/__tests__/audiobooksAdvancedRuntime.test.ts`
- `npm --prefix backend test -- --runInBand src/services/__tests__/audiobookshelfService.test.ts`

## Feature Index Mapping

- Feature IDs: `audiobooks`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/AboutSection.tsx` | components |
| `components/AudiobookActionBar.tsx` | components |
| `components/AudiobookHero.tsx` | components |
| `components/ChapterList.tsx` | components |
| `components/index.ts` | components |
| `components/PlayControls.tsx` | components |
| `hooks/index.ts` | hooks |
| `hooks/useAudiobookActions.ts` | hooks |
| `hooks/useAudiobookData.ts` | hooks |
| `index.ts` | root |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `.agents-config/docs/FEATURE_INDEX.json` and `.agents-config/docs/TEST_MATRIX.md`.

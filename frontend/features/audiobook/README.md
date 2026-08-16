# Audiobook Feature Domain

Start-here guide for `frontend/features/audiobook`.

## Start Here

1. Route entrypoints: `frontend/app/audiobooks/[id]/page.tsx` and `frontend/app/audiobooks/series/[name]/page.tsx`
2. Primary tests and route entrypoints for this domain are listed below.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/audiobooksRuntime.test.ts src/routes/__tests__/audiobooksAdvancedRuntime.test.ts`
- `npm --prefix backend test -- --runInBand src/services/__tests__/audiobookshelfService.test.ts`
- `npm --prefix backend test -- --runInBand src/services/__tests__/audiobookSections.test.ts src/services/__tests__/audiobookCacheService.test.ts`
- `npm --prefix frontend exec -- node --test --experimental-test-module-mocks --import tsx tests/component/chapterList.component.test.ts`

## Section Navigation

The detail page renders only validated cached sections. Sparse or malformed
Audiobookshelf chapters are replaced by derived multi-file parts when possible.
Navigation remains hidden for honest-empty results and for multi-file books
until the stream proxy can serve more than the first file.

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

- When adding/removing significant files or changing behavior in this domain, update or verify this README and keep the targeted commands below accurate in the same change set.

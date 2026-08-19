# library-health

Library Insights dashboard (issue #532): admin-facing read-model panels for
metadata gaps, analysis coverage, duplicate clusters, and storage/quality
analytics. Rendered on the Admin page as the `library-insights` section; data
comes from the admin-gated `/api/library-health` API via
`frontend/lib/api/libraryHealth.ts`.

## Directory Contents

| Path                                    | Role                                                            |
| --------------------------------------- | --------------------------------------------------------------- |
| `format.ts`                             | Pure display formatters (bytes, kbps, coverage percent) and gap-row line mapping (`gapItemLine`) |
| `hooks/useLibraryInsights.ts`           | Summary load + cache-busting refresh with a refresh token for expanded panels |
| `hooks/usePanelLoader.ts`               | Lazy drill-down loader with stale-response protection           |
| `hooks/useInsightPanelLoader.ts`        | Expansion-driven loader: fetches on first expand, tab/filter change, and section refresh |
| `components/LibraryInsightsSection.tsx` | Section container composing the five panels                     |
| `components/InsightPanel.tsx`           | Shared collapsible panel card (lazy fetch on first expand, error state with Retry) |
| `components/MetadataGapsPanel.tsx`      | Art/MBID/genre/lyrics gap counts and tabbed drill-down          |
| `components/AnalysisCoveragePanel.tsx`  | Analysis/vibe/loudness coverage plus retry remediation actions  |
| `components/DuplicatesPanel.tsx`        | Report-only duplicate/version clusters (durable identity tiers) |
| `components/StoragePanel.tsx`           | Per-format storage and largest artists                          |
| `components/QualityPanel.tsx`           | Lossy albums below a selectable bitrate floor                   |

## Targeted verification commands

```bash
cd frontend
node --test --import tsx tests/unit/libraryHealthFormat.test.ts
node --test --experimental-test-module-mocks --import tsx tests/component/libraryInsightsSection.component.test.ts
node --test --experimental-test-module-mocks --import tsx tests/component/libraryInsightsDrilldown.component.test.ts
npx tsc --noEmit
```

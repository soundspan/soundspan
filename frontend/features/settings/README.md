# Settings Feature Domain

Start-here guide for `frontend/features/settings`.

## Start Here

1. Route entrypoints: `frontend/app/device/page.tsx`, `frontend/app/settings/page.tsx`
2. Domain ownership and contracts: `.agents-config/docs/FEATURE_INDEX.json`.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/settingsDisplayNameCompat.test.ts src/routes/__tests__/systemSettingsRuntime.test.ts src/routes/__tests__/deviceLinkRuntime.test.ts`
- `npm --prefix frontend run lint`
- `npm --prefix frontend run test:component`

## Feature Index Mapping

- Feature IDs: `settings-and-device`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/sections/AccountSection.tsx` | components |
| `components/sections/AIServicesSection.tsx` | components |
| `components/sections/APIKeysSection.tsx` | components |
| `components/sections/AudiobookshelfSection.tsx` | components |
| `components/sections/CacheSection.tsx` | components |
| `components/sections/DownloadPreferencesSection.tsx` | components |
| `components/sections/DownloadServicesSection.tsx` | components |
| `components/sections/IntegrationsSection.tsx` | components |
| `components/sections/LibrarySafetySection.tsx` | components |
| `components/sections/LidarrSection.tsx` | components |
| `components/sections/LinkDeviceSection.tsx` | components |
| `components/sections/playbackHistoryConfig.ts` | components |
| `components/sections/PlaybackHistorySection.tsx` | components |
| `components/sections/PlaybackSection.tsx` | components |
| `components/sections/SocialSection.tsx` | components |
| `components/sections/SoulseekSection.tsx` | components |
| `components/sections/StoragePathsSection.tsx` | components |
| `components/sections/SubsonicSection.tsx` | components |
| `components/sections/TidalSection.tsx` | components |
| `components/sections/TidalStreamingSection.tsx` | components |
| `components/sections/UserManagementSection.tsx` | components |
| `components/sections/YouTubeMusicSection.tsx` | components |
| `components/ui/ConnectionCard.tsx` | components |
| `components/ui/index.ts` | components |
| `components/ui/InfoTooltip.tsx` | components |
| `components/ui/IntegrationCard.tsx` | components |
| `components/ui/SettingsInput.tsx` | components |
| `components/ui/SettingsLayout.tsx` | components |
| `components/ui/SettingsRow.tsx` | components |
| `components/ui/SettingsSection.tsx` | components |
| `components/ui/SettingsSelect.tsx` | components |
| `components/ui/SettingsSidebar.tsx` | components |
| `components/ui/SettingsToggle.tsx` | components |
| `hooks/settingsHydration.ts` | hooks |
| `hooks/useAPIKeys.ts` | hooks |
| `hooks/useSettingsData.ts` | hooks |
| `hooks/useSystemSettings.ts` | hooks |
| `hooks/useTwoFactor.ts` | hooks |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README along with `.agents-config/docs/FEATURE_INDEX.json` and `.agents-config/docs/TEST_MATRIX.md`.

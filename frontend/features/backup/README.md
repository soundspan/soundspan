# backup

Restoring a full-database backup on a fresh install. The first-run screen
(`frontend/app/onboarding/page.tsx`) offers **Restore from a backup** while no
account exists, and the login page (`frontend/app/login/page.tsx`) hands a
visitor back to it while a restore runs or waits for its restart. The backup
itself is downloaded from the Admin page's Backup section
(`frontend/features/settings/components/sections/BackupSection.tsx`).
Both talk to the backend through `frontend/lib/api/backup.ts`: the admin-only
`/api/backup` download session and the anonymous `/api/restore` upload,
start, and status endpoints.

## Directory Contents

| Path                                   | Role                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `backupRestoreModel.ts`                | Pure rules shared by backup and restore: passphrase limits, chunk byte ranges, phase labels, error-code messages, retryable-error policy |
| `restoreFlowModel.ts`                  | Pure mapping from server status snapshots and start errors to the restore page's flow steps          |
| `restoreUploader.ts`                   | Sends a file in the chunks the upload session planned, in order, with bounded retries               |
| `hooks/useRestoreFlow.ts`              | Upload, start, and status-polling state machine for the restore page; cancels its upload when the page unloads |
| `hooks/useRestoreHoldRedirect.ts`      | Sends a visitor whose sign-in request failed to the first-run screen while a restore runs or waits for its restart |
| `components/RestoreFromBackup.tsx`     | First-run restore form and flow container                                                             |
| `components/RestoreProgressViews.tsx`  | Upload progress, restore progress, restart prompt with summary, and failure views                    |

## Targeted verification commands

```bash
cd frontend
node --test --import tsx tests/unit/backupRestoreModel.test.ts tests/unit/restoreUploader.test.ts
node --test --experimental-test-module-mocks --import tsx --import ./tests/componentTestEnv.ts tests/component/restoreFromBackup.component.test.ts tests/component/backupSection.component.test.ts
npx tsc --noEmit
```

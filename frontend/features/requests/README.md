# requests

The `/requests` page for music requests. Admins see every request and review
it; other users see their own requests. Data comes from `/api/requests` via
`frontend/lib/api/requests.ts`. Shared request hooks live in
`frontend/hooks/useMusicRequests.ts`, and helpers shared with the album,
artist, and release surfaces live in `frontend/lib/musicRequests.ts`.

## Directory Contents

| Path                                  | Role                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `requestViewModel.ts`                 | Pure status labels, cooldown and failure hints, page math, deep links, and bulk-action summary text     |
| `hooks/useRequestActions.ts`          | Toast-wrapped approve/retry, decline, cancel, approve-all, and decline-stale actions                   |
| `components/RequestsView.tsx`         | Page body: status filter, paged list, pending badge, and the action dialogs                            |
| `components/RequestRow.tsx`           | One request: artist/album links, requester and date, status chip, follow-up hint, `Open album` link    |
| `components/RequestRowActions.tsx`    | Approve or Retry, Decline, `Approve all from <user>`, or Cancel, as the viewer's role allows           |
| `components/RequestPagination.tsx`    | First/Prev/Next/Last pager matching the Library page                                                    |
| `components/DeclineRequestDialog.tsx` | Confirms a single decline with an optional reason                                                       |
| `components/DeclineStaleDialog.tsx`   | Declines pending requests older than a chosen age, with an optional reason                              |
| `components/DeclineReasonField.tsx`   | Shared optional reason text area (500 characters)                                                       |

The navigation entries (`Requests` with a pending-count badge for admins,
`My Requests` for other users) live in `frontend/components/layout/UserAvatarMenu.tsx`
and `frontend/components/layout/MobileSidebar.tsx`, driven by
`useRequestsNavEntry` in `frontend/hooks/useMusicRequests.ts`.

## Targeted verification commands

```bash
cd frontend
node --test --import tsx tests/unit/requestViewModel.test.ts tests/unit/musicRequests.test.ts tests/unit/notificationLinks.test.ts
node --test --experimental-test-module-mocks --import tsx --import ./tests/componentTestEnv.ts tests/component/requestsPage.component.test.ts tests/component/requestDialogs.component.test.ts tests/component/musicRequestHooks.component.test.ts tests/component/mobileSidebar.component.test.ts
npx tsc --noEmit
```

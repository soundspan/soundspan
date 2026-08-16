# Authentication

Frontend authentication flows for the login route.

## Modules

- `oidc.ts` owns client-side `returnTo` validation, OIDC start URL construction, and safe callback-error messages.
- `components/` owns the local-login, OIDC account-link, and invite-code forms rendered by `frontend/app/login/page.tsx`.

All network calls remain on the typed `frontend/lib/api.ts` facade.

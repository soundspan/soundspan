# OIDC and SSO

soundspan supports one OpenID Connect provider per deployment. The provider authenticates the user. The soundspan account continues to own roles, settings, history, playlists, and credentials.

## Quick start

Use this configuration for the common HTTPS deployment. One public hostname sends `/api/*` to the backend and all other paths to the frontend.

```env
LOCAL_LOGIN_ENABLED=true
OIDC_ENABLED=true
OIDC_ISSUER_URL=https://idp.example/issuer
OIDC_CLIENT_ID=soundspan
OIDC_CLIENT_SECRET=<client-secret>
OIDC_REDIRECT_URI=https://music.example.com/api/auth/oidc/callback
OIDC_WEB_BASE_URL=
OIDC_SCOPES="openid profile email"
OIDC_AUTO_PROVISION=false
OIDC_MANAGE_ROLES=false
OIDC_PROVIDER_NAME=SSO
SECURE_COOKIES=true
```

Register this exact redirect URI at the identity provider:

```text
https://music.example.com/api/auth/oidc/callback
```

Then complete these steps:

1. Restart soundspan.
2. Open `https://music.example.com/login`.
3. Select **Sign in with SSO**.
4. Authenticate at the identity provider.

On the first login, soundspan uses the OIDC email claim only as an account hint:

- If the email matches a local account, soundspan asks for that account's password. It then asks for local TOTP when enabled. It creates the identity link only after successful confirmation.
- If no account matches, soundspan asks for an invite code because `OIDC_AUTO_PROVISION=false`.
- If `OIDC_AUTO_PROVISION=true`, soundspan creates the user without an invite.
- Later logins use the stored `(provider, sub)` link and do not repeat these prompts.

Keep local login enabled until you test SSO in a private browser session.

## Deployment topology

`OIDC_REDIRECT_URI` identifies the public backend callback. `OIDC_WEB_BASE_URL` identifies the canonical web origin that serves `/login` and `/settings`. The web base must be an HTTP(S) origin only. A trailing slash is allowed and is removed at startup. A path, query, fragment, or non-HTTP(S) scheme stops startup.

| Deployment shape                                                                | Support                        | `OIDC_REDIRECT_URI`                                | `OIDC_WEB_BASE_URL`                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Single hostname through a reverse proxy, frontend proxy mode, or AIO            | Supported; default             | `https://music.example.com/api/auth/oidc/callback` | Leave empty.                                                                                                  |
| Same host with different web and API ports in direct mode                       | Supported                      | `http://soundspan.lan:3006/api/auth/oidc/callback` | Set the web origin, such as `http://soundspan.lan:3030`.                                                      |
| Same-site sibling subdomains, such as `music.example.com` and `api.example.com` | Supported; requires a web base | `https://api.example.com/api/auth/oidc/callback`   | Set `https://music.example.com`.                                                                              |
| Different registrable domains                                                   | Not supported                  | Not applicable.                                    | Not applicable. The `SameSite=Lax` flow-binding cookie does not support the required cross-site API hand-off. |

For direct browser calls to a separate API origin, also configure the frontend direct mode and allow the web origin through `ALLOWED_ORIGINS`. See [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md) and [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md).

Do not try to enable cross-site support with `SameSite=None`. soundspan does not support that flow shape.

### Multiple web hostnames

Use one canonical SSO hostname per deployment. soundspan has one `OIDC_REDIRECT_URI`, and browser token storage is isolated per web origin. Redirect secondary hostnames to the canonical hostname before users start SSO.

## Secure cookies

Set `SECURE_COOKIES=true` whenever the browser opens soundspan over HTTPS. This includes a reverse proxy or tunnel, such as Cloudflare Tunnel, that terminates TLS before forwarding plain HTTP to the container. The OIDC flow cookie then uses the hardened `__Host-soundspan_oidc_flow` name.

**Warning:** A browser will not send a Secure cookie over plain HTTP.

Set `SECURE_COOKIES=false` for a plain-HTTP LAN deployment. soundspan then uses the unprefixed `soundspan_oidc_flow` cookie. This keeps login working, but it gives up the `__Host-` prefix protections. Prefer HTTPS when possible.

## Provider client requirements

Create a confidential server-side client. soundspan uses these protocol settings:

- Authorization Code flow.
- S256 PKCE.
- `state` and `nonce` validation.
- `client_secret_post` token endpoint authentication.
- Exact callback URI matching.
- `openid profile email` scopes by default.

Configure a groups claim only when `OIDC_MANAGE_ROLES=true`. The claim must be an array of strings. Set `OIDC_GROUPS_CLAIM` to its claim name. Add a provider-specific groups scope only when the provider requires one.

### Authentik

1. Open the Authentik admin interface.
2. Go to **Applications > Applications**.
3. Select **New Provider**.
4. Select **OAuth2/OIDC**.
5. Create the application and provider pair.
6. Add `https://<callback-host>/api/auth/oidc/callback` as a strict redirect URI.
7. Copy the client ID and client secret.
8. Set `OIDC_ISSUER_URL` to `https://<authentik-host>/application/o/<application-slug>/` for the default per-provider issuer mode.
9. Keep `OIDC_SCOPES="openid profile email"` when soundspan owns roles.
10. If OIDC manages roles, confirm that Authentik's scope mappings emit the configured groups claim as an array.

Authentik documents the combined application/provider flow in [Create an OAuth2 provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/create-oauth2-provider/). Its [OAuth 2.0 provider reference](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/) documents PKCE, issuer modes, redirect URIs, and scope mappings.

### Keycloak

1. Select the target realm in the Keycloak Admin Console.
2. Go to **Clients**.
3. Select **Create client**.
4. Set **Client type** to **OpenID Connect**.
5. Enable **Client authentication**.
6. Enable **Standard flow**.
7. Set the PKCE method to **S256**.
8. Add `https://<callback-host>/api/auth/oidc/callback` to **Valid redirect URIs**.
9. Save the client.
10. Copy the client secret from **Credentials**.
11. Set `OIDC_ISSUER_URL` to `https://<keycloak-host>/realms/<realm>`.
12. If OIDC manages roles, add a Group Membership mapper to the ID token. Set its token claim name to `OIDC_GROUPS_CLAIM`.

Keycloak documents confidential clients, Standard Flow, PKCE, and exact redirect settings in the [Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html).

### Authelia

Configure a confidential client under `identity_providers.oidc.clients`. Use the following protocol values in addition to the client ID, secret, and policy:

```yaml
public: false
redirect_uris:
    - https://<callback-host>/api/auth/oidc/callback
scopes:
    - openid
    - profile
    - email
grant_types:
    - authorization_code
response_types:
    - code
token_endpoint_auth_method: client_secret_post
require_pkce: true
pkce_challenge_method: S256
```

Add `groups` to the allowed scopes only when OIDC manages roles. Set the groups claim name to match `OIDC_GROUPS_CLAIM`.

Put the hashed client secret in Authelia. Put the corresponding plaintext secret in `OIDC_CLIENT_SECRET`.

Authelia defines these fields in its [OIDC client configuration reference](https://www.authelia.com/configuration/identity-providers/openid-connect/clients/). Its [OIDC FAQ](https://www.authelia.com/integration/openid-connect/frequently-asked-questions/) explains provider-side hashed secrets and relying-party plaintext secrets.

### Pocket ID

1. Sign in to Pocket ID as an administrator.
2. Open **OIDC Clients**.
3. Select **Add OIDC Client**.
4. Set the name to `soundspan`.
5. Set the callback URL to `https://<callback-host>/api/auth/oidc/callback`.
6. Enable PKCE.
7. Save the client.
8. Copy its client ID and client secret.
9. Set `OIDC_ISSUER_URL` to the public Pocket ID base URL. Do not append `/.well-known/openid-configuration`.
10. If OIDC manages roles, configure the client to emit the selected groups claim and confirm that it is an array.

Pocket ID shows the client creation flow in its [Gotify example](https://pocket-id.org/docs/client-examples/gotify). It describes confidential client secrets in [OIDC Client Authentication](https://pocket-id.org/docs/guides/oidc-client-authentication).

## Account model

### Identity and email matching

soundspan identifies an external login by `(provider, sub)`. The provider value derives from `OIDC_ISSUER_URL`. The `sub` claim is the provider subject. Email and display-name claims are cached metadata. They are not identity keys.

An existing identity link signs in to its local user. An email match only suggests a possible local user. soundspan requires the local password and local TOTP, when enabled, before it creates the link. It never links accounts from email alone.

Users can also link SSO from **Settings > Sign-in & Security**. This manual link uses the same protected OIDC flow.

### Provisioning and invites

`OIDC_AUTO_PROVISION=false` is the default. An unknown OIDC identity must redeem a valid soundspan invite code. soundspan claims the invite and records its use when it creates the local user.

`OIDC_AUTO_PROVISION=true` creates a local user without an invite. Use this only with a private IdP that restricts assignment to the soundspan client.

> **Warning:** Do not enable automatic provisioning for an unrestricted public IdP. Any provider account that can authenticate to the client could create a soundspan user.

Provisioned accounts start with the `user` role and no local password. A verified, unused email claim can populate the local email field. The identity link still uses only `(provider, sub)`.

### Role ownership

Keep `OIDC_MANAGE_ROLES=false` when soundspan owns roles. OIDC then never promotes or demotes users. Administrators assign the `admin` and `user` roles in soundspan. Provisioned users start as `user`.

Set `OIDC_MANAGE_ROLES=true` when the IdP must own roles for linked users. Also set:

```env
OIDC_GROUPS_CLAIM=groups
OIDC_ADMIN_GROUP=soundspan-admins
```

Configure the provider to put an array of group names in that claim. Add a provider-specific groups scope to `OIDC_SCOPES` only when needed.

Membership in `OIDC_ADMIN_GROUP` maps to `admin`. Absence maps to `user`. The sync runs at login for linked users and includes demotion. It never changes unlinked users. It never demotes the last remaining administrator.

**Warning:** A manual role edit for a linked user is overwritten at the user's next SSO login when role management is enabled.

### Unlinking and credential safety

Unlinking deletes the external identity row. soundspan blocks unlinking when the account has no local password and no other external identity. This guard prevents an OIDC-only user from removing the last sign-in method.

### OpenSubsonic app passwords

Browser OIDC cannot run inside most OpenSubsonic clients. Create one app password per client under **Settings > Sign-in & Security**.

The secret starts with `ssap_`. soundspan shows it once. Store the soundspan username and app password in the client.

- Password mode sends the app password as `p`, either plain or `enc:` hex encoded.
- Token mode sends `t = md5(appPassword + salt)` and sends the same salt as `s`.
- App passwords work only on `/rest`.
- Revocation stops password and token authentication for that app password.
- `lastUsedAt` shows whether a credential is still active.

App-password secrets use authenticated encryption under `SETTINGS_ENCRYPTION_KEY`. Token authentication requires soundspan to recompute the MD5 value. Keep the encryption key stable.

Use an app password for a standard OpenSubsonic client. Use the `apiKey` extension only when the client supports soundspan API-key authentication. Device linking is a separate pairing flow that issues an API key.

See [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md) for the complete `/rest` contract.

### MFA ownership

The IdP owns MFA for SSO logins. soundspan does not request local TOTP after an already-linked OIDC login.

soundspan owns MFA for local password login. Local TOTP also applies to the local-credential confirmation step before an email-hinted account link is created.

## Troubleshooting

| Symptom                                                                       | Likely cause                                                                                                                                                                     | Fix                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_state` on every attempt                                              | The flow cookie does not reach the API. Common causes are the wrong topology, a missing `OIDC_WEB_BASE_URL`, a cross-site app/API split, or `SECURE_COOKIES=true` on plain HTTP. | Use a supported row in the topology matrix. Set the canonical web origin when required. Use the same scheme across the flow. Set `SECURE_COOKIES=false` only for plain HTTP.          |
| The callback lands on the API host at `/login` or `/settings`                 | The callback and web app use different origins, but `OIDC_WEB_BASE_URL` is empty.                                                                                                | Set `OIDC_WEB_BASE_URL` to the web origin. Do not include a path.                                                                                                                     |
| The IdP reports a redirect-URI mismatch                                       | The registered URI differs by scheme, host, port, path, case, or trailing slash.                                                                                                 | Copy `OIDC_REDIRECT_URI` exactly into the provider's allowed callback list.                                                                                                           |
| `account_already_linked`                                                      | The email-matched soundspan account already has a different subject linked for this provider.                                                                                    | Sign in with the existing method. Unlink the old identity in settings before linking the new identity.                                                                                |
| `oidc_failed`                                                                 | Discovery, token exchange, claim parsing, nonce validation, or provider communication failed. Clock skew can also invalidate tokens.                                             | Check backend logs. Verify the issuer discovery URL from the backend network. Verify the client secret, `client_secret_post` support, callback URI, required claims, and system time. |
| “No soundspan account is linked to this identity” or the user needs an invite | No `(provider, sub)` link or local email match exists, and automatic provisioning is off.                                                                                        | Ask an administrator for an invite code. Enter it in the prompt. Use automatic provisioning only for a restricted private IdP.                                                        |
| The SSO button is missing                                                     | OIDC is disabled, or the browser cannot load `GET /api/auth/config`.                                                                                                             | Set `OIDC_ENABLED=true`, restart, and inspect the auth-config request and backend startup logs.                                                                                       |
| Login loops when using plain HTTP                                             | `SECURE_COOKIES=true` prevents the browser from returning the flow cookie.                                                                                                       | Set `SECURE_COOKIES=false`, restart, and accept the reduced cookie hardening.                                                                                                         |
| All login methods are unavailable                                             | Local login was disabled before SSO was verified, or the IdP is unavailable.                                                                                                     | Use the break-glass procedure below.                                                                                                                                                  |

## Break-glass recovery

Keep at least one administrator with a tested local password.

1. Set `LOCAL_LOGIN_ENABLED=true`.
2. If OIDC configuration prevents startup, set `OIDC_ENABLED=false`.
3. If you disabled OIDC, also set `OIDC_MANAGE_ROLES=false`.
4. If you disabled OIDC, clear `OIDC_WEB_BASE_URL`.
5. Restart soundspan.
6. Sign in with the local administrator account.
7. Repair the IdP client or OIDC environment values.
8. Re-enable OIDC.
9. Restart soundspan.
10. Test SSO in a private browser session.
11. Disable local login only after the test succeeds.

Startup rejects `LOCAL_LOGIN_ENABLED=false` with `OIDC_ENABLED=false`. Startup also rejects `OIDC_MANAGE_ROLES=true` or a non-empty `OIDC_WEB_BASE_URL` while OIDC is disabled.

## Related configuration

- [`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md) lists every OIDC variable and default.
- [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md) summarizes the security controls.
- [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md) shows callback routing through supported proxy layouts.

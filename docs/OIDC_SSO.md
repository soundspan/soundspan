# OIDC and SSO

soundspan supports one OpenID Connect provider. The provider authenticates a person. The existing soundspan user remains the account that owns roles, settings, history, playlists, and credentials.

Use this callback URI for every provider:

```text
https://<host>/api/auth/oidc/callback
```

The value must be public and must match `OIDC_REDIRECT_URI` exactly. See [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md) before you enable OIDC behind a proxy or tunnel.

## Basic soundspan configuration

Start with local login enabled:

```env
LOCAL_LOGIN_ENABLED=true
OIDC_ENABLED=true
OIDC_ISSUER_URL=https://idp.example/issuer
OIDC_CLIENT_ID=soundspan
OIDC_CLIENT_SECRET=<client-secret>
OIDC_REDIRECT_URI=https://soundspan.example/api/auth/oidc/callback
OIDC_SCOPES="openid profile email"
OIDC_AUTO_PROVISION=false
OIDC_MANAGE_ROLES=false
OIDC_PROVIDER_NAME=SSO
```

Restart soundspan after you change these values. Startup fails if an enabled OIDC client is missing its issuer URL, client ID, client secret, or redirect URI. Startup also rejects `LOCAL_LOGIN_ENABLED=false` with `OIDC_ENABLED=false`.

## Provider setup

Use a confidential web client. Enable the Authorization Code flow, `client_secret_post` authentication, and S256 PKCE. Register only the exact callback URI. Copy the provider's issuer URL, client ID, and plaintext client secret into soundspan.

### Authentik

1. Open the Authentik admin interface.
2. Go to **Applications > Applications**.
3. Select **New Provider**.
4. Select **OAuth2/OIDC**.
5. Create a confidential provider and application.
6. Add `https://<host>/api/auth/oidc/callback` as a strict redirect URI.
7. Copy the client ID and client secret.
8. Set `OIDC_ISSUER_URL` to `https://<authentik-host>/application/o/<application-slug>/` for the default per-provider issuer mode.

Authentik documents the combined provider flow in [Create an OAuth2 provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/create-oauth2-provider). Its [OAuth 2.0 provider reference](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/) defines redirect and issuer behavior.

### Keycloak

1. Select the target realm in the Keycloak Admin Console.
2. Go to **Clients**.
3. Select **Create client**.
4. Set **Client type** to **OpenID Connect**.
5. Enable **Client authentication** and **Standard flow**.
6. Set **Valid redirect URIs** to `https://<host>/api/auth/oidc/callback`.
7. Save the client and copy its secret from **Credentials**.
8. Set `OIDC_ISSUER_URL` to `https://<keycloak-host>/realms/<realm>`.

Keycloak documents client creation in its [getting-started guide](https://www.keycloak.org/getting-started/getting-started-openshift) and realm OIDC endpoints in the [Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html).

### Authelia

1. Configure the Authelia OpenID Connect provider.
2. Add a confidential client under `identity_providers.oidc.clients`.
3. Give the client a unique ID and secret.
4. Add `https://<host>/api/auth/oidc/callback` to `redirect_uris`.
5. Allow the `authorization_code` grant and `code` response type.
6. Set the token endpoint authentication method to `client_secret_post`.
7. Require S256 PKCE.
8. Allow the `openid`, `profile`, and `email` scopes.
9. Put the hashed client secret in Authelia.
10. Put the corresponding plaintext secret in `OIDC_CLIENT_SECRET`.
11. Set `OIDC_ISSUER_URL` to the public Authelia URL.

Authelia defines the client fields in its [OIDC client configuration reference](https://www.authelia.com/configuration/identity-providers/openid-connect/clients/). Its [OIDC FAQ](https://www.authelia.com/integration/openid-connect/frequently-asked-questions/) explains hashed provider-side secrets and plaintext relying-party secrets.

### Pocket ID

1. Sign in to Pocket ID as an administrator.
2. Open **OIDC Clients**.
3. Select **Add OIDC Client**.
4. Set the name to `soundspan`.
5. Set the callback URL to `https://<host>/api/auth/oidc/callback`.
6. Enable PKCE.
7. Save the client and copy its client ID and client secret.
8. Set `OIDC_ISSUER_URL` to the Pocket ID public base URL without `/.well-known/openid-configuration`.

Pocket ID shows this client flow in its [client examples](https://pocket-id.org/docs/client-examples/gotify) and describes client credentials in [OIDC Client Authentication](https://pocket-id.org/docs/guides/oidc-client-authentication).

## Account model and linking

soundspan identifies an external login by `(provider, sub)`. The provider value derives from `OIDC_ISSUER_URL`. The `sub` claim is the provider's subject identifier. Email and display-name claims are cached metadata. They are not identity keys.

An existing identity link signs in to its local user. An email match only suggests a possible local user. soundspan then requires the local password and local TOTP, when enabled, before it creates the link. It never links accounts from email alone.

Users can also link SSO from **Settings > Sign-in & Security**. Unlinking deletes the identity link. soundspan blocks unlinking when an OIDC-only account has no other identity and no local password.

## Provisioning

`OIDC_AUTO_PROVISION=false` is the safe default. An unknown OIDC identity must redeem a valid soundspan invite code. soundspan claims the invite and records its use when it creates the local user.

`OIDC_AUTO_PROVISION=true` creates local users without an invite. Use this mode only with a private IdP that restricts assignment to the soundspan application.

> **Warning:** Do not enable automatic provisioning for a public IdP unless the IdP restricts who can access this client. Otherwise, any provider account that can complete authentication can create a soundspan user.

Provisioned accounts start with the `user` role and no local password. A verified, unused email claim may populate the local email field. The identity link still uses only `(provider, sub)`.

## Role management

Keep `OIDC_MANAGE_ROLES=false` when soundspan administrators own roles. OIDC login then leaves every role unchanged. Administrators assign `admin` and `user` in soundspan.

Set `OIDC_MANAGE_ROLES=true` when the IdP must own roles for linked users. Also set:

```env
OIDC_SCOPES="openid profile email groups"
OIDC_GROUPS_CLAIM=groups
OIDC_ADMIN_GROUP=soundspan-admins
```

The configured groups claim must be an array of strings. Configure a provider mapper when the provider does not emit this claim by default. Membership in `OIDC_ADMIN_GROUP` maps to `admin`. Absence maps to `user`. The sync runs on each login for an already linked user and includes demotion. It never changes unlinked users and never demotes the last remaining administrator.

## OpenSubsonic app passwords

Browser-based OIDC cannot run inside most OpenSubsonic clients. Create a separate app password for each client under **Settings > Sign-in & Security**.

The secret starts with `ssap_`. soundspan shows it once. Store it in the client as the password and keep the soundspan username.

- Password mode sends the app password as `p`, either plain or `enc:` hex encoded.
- Token mode sends `t = md5(appPassword + salt)` with the same salt in `s`.
- App passwords work only on `/rest`.
- Revocation stops both password and token authentication for that app password.
- `lastUsedAt` helps identify credentials that are still active.

App-password secrets use authenticated encryption under `SETTINGS_ENCRYPTION_KEY` because token authentication requires the server to recompute the MD5 value. Keep that encryption key stable.

Use an app password for a standard OpenSubsonic client. Use the `apiKey` extension only when the client supports soundspan API-key authentication. Device linking is a separate pairing flow that issues an API key. It does not replace an app password in clients that only support standard `p` or `t` authentication.

See [`OPENSUBSONIC_COMPATIBILITY.md`](OPENSUBSONIC_COMPATIBILITY.md) for the complete `/rest` contract.

## MFA

The IdP owns MFA for SSO logins. soundspan does not request local TOTP after a successful OIDC login.

Local TOTP still applies to local password login. It also applies when an email-hinted account link requires local credential confirmation.

## Break-glass recovery

Keep at least one administrator with a tested local password.

1. Set `LOCAL_LOGIN_ENABLED=true`.
2. Set `OIDC_ENABLED=false` if invalid OIDC settings prevent startup.
3. Restart soundspan.
4. Sign in with the local administrator account.
5. Repair the IdP client or OIDC environment values.
6. Re-enable OIDC and test it in a private browser session.
7. Disable local login only after the test succeeds.

The backend entrypoint validates core runtime secrets first. The backend configuration parser then reports OIDC validation errors during startup.

## Related configuration

- [`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md) lists every OIDC variable and default.
- [`CONFIGURATION_AND_SECURITY.md`](CONFIGURATION_AND_SECURITY.md) summarizes the security controls.
- [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md) shows callback routing through supported proxy layouts.

# Configuration and Security

This guide centralizes environment configuration and security expectations.

For deployment mode selection, see [`DEPLOYMENT.md`](DEPLOYMENT.md).
For integration-specific setup values, see [`INTEGRATIONS.md`](INTEGRATIONS.md).

## Environment Variables

For the complete environment variable reference (all containers, defaults, and status labels), see [`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md).

The sections below provide guidance on configuration patterns, security hardening, and operational concerns that go beyond simple variable listings.

## Role Split Guidance (Compose/Kubernetes)

For horizontally scaled split deployments, prefer:

- API pods/containers: `BACKEND_PROCESS_ROLE=api`
- Worker pods/containers: `BACKEND_PROCESS_ROLE=worker`

For single-process deployments, keep `BACKEND_PROCESS_ROLE=all`.

## External Access Settings

If users access soundspan from outside your local network, configure CORS and API routing intentionally.

### Frontend Build-Time vs Runtime

`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_API_PATH_MODE`, and `NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING` are frontend build-time variables.

- They work as expected in source-build flows (`npm run dev`, `npm run build` with env/build args).
- In pre-published frontend images, changing these vars at container runtime does not change browser behavior.

### Source-Build Direct Mode (optional)

If you build the frontend yourself and want direct browser calls to backend:

```env
NEXT_PUBLIC_API_URL=https://soundspan-api.yourdomain.com
NEXT_PUBLIC_API_PATH_MODE=direct
ALLOWED_ORIGINS=http://localhost:3030,https://soundspan.yourdomain.com
```

### Pre-Published Image Recommendation (no rebuild)

For users consuming published images:

- Leave `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_API_PATH_MODE` unset unless you are publishing your own rebuilt frontend image.
- `NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING` is also build-time; runtime container env changes on pre-published images do not switch browser transport behavior.
- Route `/api/*` to backend in your reverse proxy, and route app traffic to frontend.
- Set backend `ALLOWED_ORIGINS` to include your frontend origin.

`NEXT_PUBLIC_API_PATH_MODE` controls how the browser reaches backend APIs:

- `auto` (default): use `NEXT_PUBLIC_API_URL` when set; otherwise use same-origin proxy mode (`/api/*`).
- `proxy`: always use same-origin `/api/*` calls through `frontend/app/api/[...path]/route.ts`.
- `direct`: always call backend directly (uses `NEXT_PUBLIC_API_URL` when provided, else derives `protocol://<host>:3006`).

Set this in frontend build/dev environment (same place you set `NEXT_PUBLIC_API_URL`).
For pre-published images, see reverse-proxy path routing guidance in [`REVERSE_PROXY_AND_TUNNELS.md`](REVERSE_PROXY_AND_TUNNELS.md).

For Listen Together, the frontend proxies `/socket.io/listen-together` to backend by default in split deployments.
If you bypass frontend proxying intentionally, your edge proxy/tunnel must route `/socket.io/listen-together` to backend `:3006`.
`LISTEN_TOGETHER_ALLOW_POLLING=false` is recommended for HA deployments; only enable polling fallback when sticky sessions are guaranteed end-to-end.
For pre-published frontend images, browser polling fallback also requires rebuilding with `NEXT_PUBLIC_LISTEN_TOGETHER_ALLOW_POLLING=true`.

For multi-replica backend/frontend deployments, configure Redis as a highly available endpoint.
A single Redis pod is a runtime SPOF for sessions, queues, and realtime coordination.
Redis HA is an operator-managed prerequisite (external managed Redis/Dragonfly, Sentinel, or equivalent); soundspan consumes the configured endpoint and does not manage Redis HA topology itself.

## Sensitive Variables

Never commit `.env` files or credentials.

| Variable                  | Purpose                                                                         | Required                                           |
| ------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| `SESSION_SECRET`          | Session encryption (32+ chars)                                                  | Yes                                                |
| `SETTINGS_ENCRYPTION_KEY` | Encryption of stored credentials (32+ chars, must not be the published default) | Yes                                                |
| `INTERNAL_API_SECRET`     | Service-to-service authentication (32+ chars)                                   | Yes                                                |
| `POSTGRES_PASSWORD`       | PostgreSQL authentication                                                       | Yes, production                                    |
| `API_KEY_PEPPER`          | HMAC pepper for API keys; keep stable or existing hashed keys become invalid    | Optional; falls back to encryption/session secrets |
| `OIDC_CLIENT_SECRET`      | OIDC confidential client authentication                                         | If using OIDC                                      |
| `LIDARR_API_KEY`          | Lidarr integration                                                              | If using Lidarr                                    |
| `OPENAI_API_KEY`          | AI features                                                                     | Optional                                           |
| `LASTFM_API_KEY`          | Artist recommendations                                                          | Optional                                           |
| `FANART_API_KEY`          | Artist images                                                                   | Optional                                           |
| `YTMUSIC_STREAMER_URL`    | YouTube Music sidecar URL                                                       | If using YouTube Music                             |
| `TIDAL_SIDECAR_URL`       | TIDAL sidecar URL                                                               | If using TIDAL                                     |

Soulseek credentials are configured via System Settings and stored encrypted in the database.
Last.fm no longer ships with a bundled fallback application key. Provide `LASTFM_API_KEY` in the environment or store a key in System Settings when you want Last.fm-backed recommendations and metadata; otherwise those lookups remain unavailable.

## Authentication and Session Security

- JWT access tokens expire after 24 hours; refresh tokens after 30 days
- Token refresh uses `/api/auth/refresh`
- Password changes invalidate existing sessions
- Session cookies use `httpOnly` and `sameSite=lax`. Secure cookies default on when `NODE_ENV=production` and can be overridden with `SECURE_COOKIES`. The OIDC flow cookie drops its `__Host-` prefix when secure cookies are off.
- Encryption key validity is checked at startup

## OIDC and App-Password Security

soundspan uses the OIDC Authorization Code flow with `state`, `nonce`, and S256 PKCE. Login and account-link attempts keep their pending state on the server. The callback sends the browser a short-lived, single-use exchange code. It never puts access or refresh tokens in a redirect URL.

OIDC requires the web app and API to be same-site. A single public hostname needs no extra redirect setting. A same-site callback on a sibling API subdomain or different port must set `OIDC_WEB_BASE_URL` to the canonical web origin. Cross-site deployments on different registrable domains are not supported because the flow-binding cookie is `SameSite=Lax`.

OpenSubsonic app passwords are restricted to `/rest`. Their `ssap_` secrets are encrypted at rest with authenticated encryption under `SETTINGS_ENCRYPTION_KEY`. Users can revoke each app password independently.

See the [`OIDC_SSO.md` topology matrix](OIDC_SSO.md#deployment-topology) for supported layouts. The same guide covers provider setup, account linking, provisioning, role ownership, app passwords, MFA, and break-glass recovery.

## Streaming Credential Security

- YouTube Music and TIDAL OAuth tokens are AES-encrypted before database storage
- Credentials are isolated per user account
- Credentials are only decrypted for active sidecar operations
- TIDAL tokens are refreshed automatically and re-encrypted when needed

## Federation Credential Security

- Instance links use dedicated `Authorization: Bearer` credentials. They do not reuse user JWTs or API keys and never establish a user identity on the host.
- Host-issued credentials are random 32-byte tokens. The raw value is returned only when issued or rotated; the database stores an HMAC hash for constant-time verification.
- Each credential grants an explicit subset of `library:read`, `stream:read`, and `embeddings:read`. Embedding access also requires library access.
- `library:read` includes the instance's complete subscribed podcast-feed catalog. Treat linked peers as trusted recipients of feed URLs and podcast metadata.
- Revocation clears credential material and changes the peer to `REVOKED`. Deleting a peer also cascades its consumer-side mirrored catalog rows.
- Consumer outbound tokens are encrypted and decrypted through the settings cipher backed by `SETTINGS_ENCRYPTION_KEY`. API and admin responses exclude both outbound tokens and credential hashes.
- Peer base URLs must use HTTPS. The consumer backend attaches the decrypted token to bounded peer requests; browser clients never receive it.

Federation intentionally permits HTTPS peer URLs on private, LAN, and VPN
networks. Private addressing is a primary self-hosted deployment model, and
peer configuration is restricted to administrators. Outbound federation calls
disable redirects and use bounded timeouts and response sizes, but they do not
apply the public-address-only SSRF policy used for untrusted user-supplied
URLs. Administrators must therefore treat a linked peer as trusted and limit
admin access accordingly.

## Webhook and Admin Security

- Lidarr webhook signatures are supported and should be configured
- Bull Board (`/api/admin/queues`) requires authenticated admin access
- Swagger docs: the UI at `/api/docs` is always accessible; the raw spec at `/api/docs.json` requires auth in production unless `DOCS_PUBLIC=true`

## Optional VPN Notes

If using Mullvad VPN for Soulseek:

- Put WireGuard config in `backend/mullvad/` (gitignored)
- Never commit private keys
- `*.conf` and `key.txt` are already ignored

## Generating Secrets

```bash
# Session secret
openssl rand -base64 32

# Settings encryption key
openssl rand -base64 32
```

## Network Safety Guidance

- soundspan is intended for self-hosted usage
- For internet exposure, place it behind HTTPS reverse proxy/tunnel
- Keep `ALLOWED_ORIGINS` strict and explicit

---

## See also

- [Environment Variables](ENVIRONMENT_VARIABLES.md) — Complete env var reference by container
- [OIDC and SSO](OIDC_SSO.md) — Provider setup, account linking, roles, and recovery
- [Deployment Guide](DEPLOYMENT.md) — Docker and compose deployment options
- [Reverse Proxy and Tunnels](REVERSE_PROXY_AND_TUNNELS.md) — Edge routing for split deployments
- [Integrations Guide](INTEGRATIONS.md) — Integration-specific setup values
- [Kubernetes Guide](KUBERNETES.md) — Helm deployment and HA rollout

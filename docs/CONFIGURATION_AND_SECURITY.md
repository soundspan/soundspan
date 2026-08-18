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
Redis HA is an operator-managed prerequisite (external managed Redis/Dragonfly, Sentinel, or equivalent); soundspan consumes the configured endpoint for queues, claims, and realtime coordination and does not manage Redis HA topology itself.

## Browser Content Security Policy

The frontend sends a nonce-based Content Security Policy on every Next-served document, including unauthenticated `/share/*` pages and PWA navigations. API response CSP headers are separate and do not protect documents rendered by the browser.

The production policy is:

```text
default-src 'self'; script-src 'self' 'nonce-{PER_REQUEST_NONCE}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

The frontend generates a new unpredictable nonce for each request. Next applies it to framework, page, and inline runtime scripts. This avoids `script-src 'unsafe-inline'`. Development mode adds `script-src 'unsafe-eval'` because the Next development runtime requires it. `style-src 'unsafe-inline'` remains necessary for framework and application inline styles.

Nonce propagation requires dynamic rendering, so Next static optimization, ISR, and default CDN document caching are disabled. Static assets remain cacheable. The policy contains no deployment hostname. Browser API, cover-art, provider-thumbnail, playback, and Listen Together requests use same-origin frontend proxy paths by default. Enforcing CSP does not support a separately originated `NEXT_PUBLIC_API_URL`; use `NEXT_PUBLIC_API_PATH_MODE=proxy` or the default unset configuration before enforcement.

The policy defaults to `Content-Security-Policy-Report-Only`. Use this rollout sequence:

1. Leave `CSP_ENFORCE` unset or set it to `false`.
2. Review browser console violations during normal playback, Listen Together, offline/PWA use, unauthenticated share pages, and administrator workflows.
3. Fix or explicitly account for every required source.
4. Set `CSP_ENFORCE=true` and restart the frontend or AIO container.
5. Repeat the same workflow checks against the enforcing header.

Set `CSP_REPORT_URI` to a root-relative path handled by your reverse proxy or to an HTTPS collector URL to receive reports. soundspan does not include a report collector. When configured, the frontend emits both the legacy `report-uri` directive and the `report-to` directive with a matching `Reporting-Endpoints` header. Treat reports as potentially sensitive because browsers can include document and blocked-resource URLs. Values containing header delimiters, credentials, fragments, unsupported schemes, or protocol-relative URLs are ignored.

### SVG image optimization exception

`images.dangerouslyAllowSVG` remains enabled for cover-art compatibility. The Next image optimizer is explicitly configured to return optimized images with `Content-Disposition: attachment` and this image-specific CSP:

```text
default-src 'self'; script-src 'none'; frame-src 'none'; sandbox;
```

This sandbox applies to optimized image responses independently of the document policy. External MusicBrainz, Last.fm, Deezer, podcast RSS, TIDAL, YouTube Music, and other provider images are fetched through the backend cover/browse proxy or the same-origin Next image optimizer. The browser document policy therefore does not allow provider image hosts directly.

## Sensitive Variables

Never commit `.env` files or credentials.

| Variable                  | Purpose                                                                         | Required                                           |
| ------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| `SESSION_SECRET`          | Required JWT signing fallback (32+ chars)                                       | Yes                                                |
| `SETTINGS_ENCRYPTION_KEY` | Encryption of stored credentials (32+ chars, must not be the published default) | Yes                                                |
| `INTERNAL_API_SECRET`     | Service-to-service authentication (32+ chars)                                   | Yes                                                |
| `METRICS_TOKEN`           | Bearer authentication for backend and worker Prometheus scrapes                 | Required to scrape unless metrics are explicitly public |
| `POSTGRES_PASSWORD`       | PostgreSQL authentication                                                       | Yes, production                                    |
| `API_KEY_PEPPER`          | HMAC pepper for API keys; keep stable or existing hashed keys become invalid    | Optional; falls back to encryption/JWT secrets     |
| `OIDC_CLIENT_SECRET`      | OIDC confidential client authentication                                         | If using OIDC                                      |
| `LIDARR_API_KEY`          | Lidarr integration                                                              | If using Lidarr                                    |
| `OPENAI_API_KEY`          | AI features                                                                     | Optional                                           |
| `LASTFM_API_KEY`          | Artist recommendations                                                          | Optional                                           |
| `FANART_API_KEY`          | Artist images                                                                   | Optional                                           |
| `YTMUSIC_STREAMER_URL`    | YouTube Music sidecar URL                                                       | If using YouTube Music                             |
| `TIDAL_SIDECAR_URL`       | TIDAL sidecar URL                                                               | If using TIDAL                                     |

Soulseek credentials are configured via System Settings and stored encrypted in the database.
Last.fm no longer ships with a bundled fallback application key. Provide `LASTFM_API_KEY` in the environment or store a key in System Settings when you want Last.fm-backed recommendations and metadata; otherwise those lookups remain unavailable.

### Metrics exposure

`GET /metrics` is private by default. It accepts only a bearer token matching
`METRICS_TOKEN` and fails closed when that value is absent. Keep the endpoint on
an internal network, store the token as a runtime secret, and configure the
scraper to send it in the `Authorization` header.

`METRICS_PUBLIC=true` removes this gate. Treat that setting as unsafe outside an
isolated private network. The exposition includes process health, route classes,
queue names and state, cache behavior, and federation sync outcomes. It never
uses user IDs, media IDs, raw URLs, cache keys, peer IDs, or error text as
labels.

## Authentication and Credential Security

Cookie-session authentication has been removed. Each authenticated request now uses an explicit credential transport, so an ambient cookie cannot silently take precedence over a bearer token or API key and the API has no ambient-cookie CSRF credential surface. The HTTP-only OIDC flow-binding cookie remains; it binds a login transaction to its initiating browser and does not authenticate API requests.

| Surface | Credential transport | Lifetime | Revocation path |
| ------- | -------------------- | -------- | --------------- |
| Web UI and first-party API | `Authorization: Bearer` JWT access token plus refresh token in the refresh request body | Access: 24 hours. Refresh: 30 days. | A self-service password change or administrator-set password increments `tokenVersion`, invalidating outstanding access and refresh JWTs. Ordinary logout removes the current browser's tokens only; there is no separate logout-all-devices endpoint. |
| OpenSubsonic `/rest` | Per-request token plus salt, password transport, or an `ssap_` app password; API keys use the separate `apiKey` parameter | The token is a per-request digest with no independent server-side lifetime. App-password credentials remain valid until revoked. The legacy dedicated Subsonic password is deprecated: it can no longer be set from Settings, but existing values are still honored until removed in a future release. | Revoke an app password individually. Account password changes and administrator-set passwords clear any legacy dedicated Subsonic password. |
| External API clients | `X-API-Key` header | 90 days from creation | Delete the API key. |
| Federation peer API | Dedicated opaque `Authorization: Bearer` peer credential | No automatic expiry. | Rotate the credential, revoke the peer, or delete the peer. |
| Internal sidecar requests | `x-internal-secret` header | No automatic expiry. | Rotate `INTERNAL_API_SECRET` across the backend and sidecars, then restart them. |

- Token refresh uses `/api/auth/refresh`.
- `SESSION_SECRET` remains required as the JWT signing fallback when `JWT_SECRET` is unset.
- Encryption key validity is checked at startup.
- Secure OIDC flow cookies default on when `NODE_ENV=production` and can be overridden with `SECURE_COOKIES`. The OIDC flow cookie drops its `__Host-` prefix when secure cookies are off.

## Reverse Proxy Trust and Rate Limits

soundspan is designed to run behind a reverse proxy. The backend uses its
configured Express `trust proxy` policy, so the trusted `X-Forwarded-For` chain
determines the client IP used by per-IP rate limits. Some authentication,
registration, OIDC, OpenSubsonic, share-link, webhook, and federation endpoints
can be unauthenticated and exposed to the internet. Set `TRUST_PROXY_HOPS` to
the actual number of trusted proxy hops. Do not leave a permissive proxy chain
in a deployment where clients can connect to the backend directly and supply
their own forwarding headers.

Security-relevant counters use the existing `REDIS_URL` connection. This makes
authentication and account-management, admin and invite-management, OIDC,
OpenSubsonic authentication, share-link, webhook, and federation limits common
to every backend replica and preserves them across backend restarts. Redis keys
are separated by limiter name. A Redis command has a 250 ms deadline. If Redis
is disconnected or a command fails or times out, credential-guarding limits
fall back to an in-process sliding window of up to 10,000 keys and one million
retained hit timestamps per limiter, while other
Redis-backed limits remain availability-first and allow the request. The
fallback is per backend process during an outage, so replicas enforce separate
budgets until Redis recovers; each fallback decision emits a rate-limited
warning.

The general high-ceiling API limiter and high-volume playback, image, download,
lyrics, and provider-request limiters remain per-process and in memory. They are
hot-path safeguards against client bugs, accidental loops, bandwidth bursts,
and upstream-provider overload. They are not the distributed abuse-control
boundary, and avoiding Redis on those paths keeps their latency and Redis load
bounded.

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
# Required JWT signing fallback
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

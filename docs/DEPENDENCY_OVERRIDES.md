# npm Dependency Override Lifecycle

npm overrides are temporary transitive-dependency floors. The package manifests
remain the source of truth. This register explains why each surviving override
exists and what must happen before it can be removed.

The dependency chains below come from the
[`backend`](../backend/package-lock.json) and
[`frontend`](../frontend/package-lock.json) lock graphs. The media metadata
contract package currently has no overrides.

## Active overrides

| Package | Override selector | Pinned version | Advisory | Blocking direct dependency chain | Removal condition |
| --- | --- | --- | --- | --- | --- |
| [`backend`](../backend/package.json) | `uuid@>=8.0.0 <11.1.1` | `11.1.1` | [`GHSA-w5hq-g745-h8pq`](https://github.com/advisories/GHSA-w5hq-g745-h8pq) / `CVE-2026-41907` | `bull@4.16.5 -> uuid@^8.3.2` | Remove when Bull's declared `uuid` range resolves to `11.1.1` or newer without the override and the backend production audit remains clean. |
| [`backend`](../backend/package.json) | `ws@>=8.0.0 <8.21.0` | `8.21.3` | [`GHSA-96hv-2xvq-fx4p`](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) / `CVE-2026-48779` | `@socket.io/redis-adapter@8.3.0 -> socket.io-adapter@2.5.6 -> ws@~8.18.3` | Remove when Socket.IO Adapter declares a range that resolves to `8.21.0` or newer without the override and the backend production audit remains clean. |
| [`frontend`](../frontend/package.json) | `ws@>=8.0.0 <8.21.0` | `8.21.3` | [`GHSA-96hv-2xvq-fx4p`](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) / `CVE-2026-48779` | `socket.io-client@4.8.3 -> engine.io-client@6.6.4 -> ws@~8.18.3` | Remove when Engine.IO Client declares a range that resolves to `8.21.0` or newer without the override and the frontend production audit remains clean. |

## Adding an override

1. Upgrade the direct dependency that owns the transitive chain first.
2. Add an override only when the direct dependency's compatible releases still
   admit a vulnerable transitive version.
3. Use the narrowest affected selector and a fixed safe floor.
4. Add one row above with the advisory, blocking chain, and measurable removal
   condition. Use `Transitive floor; advisory unknown` when audit data does not
   identify an exact advisory.
5. Regenerate only the affected package lockfile.
6. Run the affected package's production audit and targeted compatibility
   checks.

Do not use `npm audit fix --force` to bypass an incompatible direct dependency.

## Monthly shed pass

Run the shed pass with the first dependency-review cycle of each month.

1. Run the override staleness guard.
2. Remove one candidate override in an isolated copy of the package tree.
3. Regenerate the copied lockfile without changing direct dependency versions.
4. Confirm the natural resolution meets the documented safe floor.
5. Run `npm audit --omit=dev` in the copy.
6. Remove the override and its register row only when the audit reports zero
   vulnerabilities.

`scripts/ci/check-override-staleness.mjs` fails when an override's package name
has no resolved entry in the corresponding lock graph. It also emits a
non-fatal warning when the lock contains a newer release on the pinned major
line. That warning identifies a shed candidate; it does not prove how npm will
resolve after the override is removed.

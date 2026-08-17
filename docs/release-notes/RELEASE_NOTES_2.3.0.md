# [2.3.0] Release Notes - 2026-08-17

## Release Summary

This release includes 30 fixes, 14 additions, and 16 changes.

## Before you upgrade

**Warning:** If you run a version earlier than 2.0.0, do not upgrade directly
to 2.3.0. Complete the 2.0.0 breaking changes first. See
[Upgrading from an earlier version](#upgrading-from-an-earlier-version).

- The torch CLAP analyzer is removed everywhere; existing libraries re-embed automatically through the blue/green DCLAP migration - read the 2.3.0 section of docs/UPGRADING.md BEFORE upgrading, including the mandatory full stop of backend and worker processes around the schema migration.
- Image-only rollback to 2.2.0 is not supported once the migration begins; take a database backup before upgrading.
- Helm: audioAnalyzerClap.* values now fail validation - use --reset-then-reuse-values or a clean values file, and set vibeProviderDclap.enabled=true to keep vibe features.

## Fixed

- Provider heartbeats now re-probe reachability each cycle, migration progress
  is visible in settings, coverage sampling is statement-time bounded, and Helm
  upgrade guidance waits for old backend and worker pods to be deleted.
- The legacy global ANN index is now dropped, so space-scoped vector queries
  cannot lose results through cross-space approximation.
- ANN indexes now build only after a space crosses a size floor, and the active
  lifecycle creates a missing index after backfill to heal fresh-install recall.
- Vibe vocabulary blending is now checked against the searched embedding-space
  identity; incompatible or legacy artifacts are skipped with bounded telemetry.
- Metrics endpoints now remain available when Redis-backed vibe queue-depth
  collection fails, while retaining the last successful sample.
- Legacy vibe Redis cleanup is deadline-bounded, restart-durable, safe across
  replica races, retries expired leases, atomically removes only non-expiring
  reservations, and records completion only after every bounded operation.
- Vibe invalidation now increments one generation CAS across manual rebuilds,
  full enrichment, replacement, and stale-claim recovery. Vector storage and
  claim completion share the same transaction, so stale workers cannot commit.
- Workers reject retired or cleaning embedding targets transactionally, then
  re-resolve and requeue once instead of failing the track.
- Active-space ANN indexes now use size bands and rebuild at most once per
  lifecycle tick when a space crosses a band boundary.
- Retired-space cleanup now uses a durable claim across batched vector deletion
  and concurrent ANN index removal, preventing cleanup from deleting vectors
  after a space is reactivated.
- Federation exports now resolve one embedding space per response and fetch
  vectors strictly from that space, preventing cutover-skewed headers and
  vectors.
- Historic vibe retry counts are reset on the first claim for a new target
  space, so migrated tracks receive the full provider retry budget.
- Provider 5xx availability failures now return 503 from vibe search, provider
  contract and space mismatches return 502, and timeouts remain 504.
- Helm accepts absent or null removed analyzer values while rejecting non-null
  legacy configuration.
- DCLAP tokenizer artifacts are byte-verified in both the standalone and AIO
  images.
- The Vibe UI now distinguishes provider-unavailable errors from transient
  provider timeouts.
- Force rebuilding vibe embeddings now preserves active-space vectors, and a
  durable space marker prevents wiped spaces from triggering fresh-install
  cutover behavior.
- Transient vibe-provider failures now receive bounded automatic retries, and
  malformed queue entries cannot demote completed or already-stored tracks.
- Stale vibe claims are now recovered independently of MusicCNN queue state.
- Helm now rejects removed `audioAnalyzerClap.*` values and the conflicting
  `vibeProviderDclap.env.DCLAP_HTTP_PORT` override instead of rendering a broken
  component. Chart releases now wait for the DCLAP provider image.
- Settings no longer shows the retired vibe embedding worker control, which
  targeted an endpoint removed with the torch CLAP analyzer.
- Updated the Vibe and onboarding guidance for the DCLAP provider and current
  analysis memory requirements.
- Provider-unavailable vibe text searches now return 503 while provider
  timeouts continue to return 504.
- Fresh installs with only a provider-backed vibe space now cut over
  immediately instead of stalling behind an active space with no vectors.
- The clap sidecar's embedding upsert now targets the composite
  `(track_id, space_id)` key; against the migrated schema its previous
  single-column conflict target failed every store.
- Fixed the local-profile Docker builds for both audio analyzer sidecars:
  their compose entries now build from the repository root, matching the
  root-relative paths their Dockerfiles have always used.
- Removed the torch CLAP analyzer Compose service and its configuration
  variables, so default installs no longer pull its multi-GB image. Existing
  libraries migrate automatically to the DCLAP embedding space.
- Fixed the local-profile Docker build for the MusicCNN audio analyzer by using
  the repository root, matching the root-relative paths its Dockerfile uses.
- The interface font (Montserrat) is now bundled with the app instead of
  being fetched from Google Fonts at build time, removing a network
  dependency from builds; rendering is unchanged.
- Hardened blue/green vibe migrations so completed post-cutover tails
  self-heal into the target space, text search stays in the active space,
  failed concurrent ANN indexes recover, terminal worker startup retries are
  rate-limited, and rollback stops retired-vector cleanup at the next batch
  boundary.

## Added

- The Helm chart now ships the DCLAP vibe provider component, disabled by
  default for opt-in embedding migrations.
- Added a DCLAP provider target to the default and analysis Docker Bake groups.
- Operators can now start a blue/green vibe embedding migration by pointing
  `VIBE_PROVIDER_URL` at a distinct provider space; Soundspan registers and
  backfills it, cuts over at configured coverage, retains the prior space's
  vectors during the grace period, and then cleans them. Before cutover, unset
  the provider to abandon the migration while the prior space remains active.
  Downgrading 2.3 database state to 2.2 images requires a pre-upgrade database
  backup and restore.
- Added read-only provider-fidelity validation tooling for real-library paired
  cosine, teacher-indexed neighbor overlap, text-query overlap, and inclusive
  same-space gate reports.
- Added a validated vibe-provider HTTP client for text search and
  vocabulary generation, with active-space vector checks and bounded metrics.
- Added backend-driven provider audio embedding behind `VIBE_PROVIDER_URL`,
  with bounded concurrency, graceful draining, status ownership, and
  active-space coverage metrics.
- Added a DCLAP student ONNX provider image with the provider v1
  HTTP contract, offline-vendored model/tokenizer artifacts, lazy idle unloading,
  upstream-matched audio preprocessing, and combined artifact identity.
- Added one-shot vibe-worker cleanup for the retired text-embedding stream,
  consumer group, heartbeat, and non-expiring legacy queue reservations.
- Added a scrape-time gauge for raw provider job depth in
  `audio:clap:queue`.
- Added a real-PostgreSQL integration suite for vibe registry migrations, ANN
  index lifecycle, statement timeouts, and retired-vector cleanup.
- Added starter Grafana panels for provider failures, migration coverage and
  failures, provider queue depth, and suppressed federation exports.
- Added Prometheus alert rules for absent or stale vibe-provider heartbeats,
  provider failures, stalled migrations, failed tracks, queue saturation,
  metrics collection errors, and suppressed federation exports.
- Added TTL-backed per-worker vibe migration and provider state to the system
  status API, with a minimal provider indicator in admin settings.
- Manual re-embed calls now leave automatic backfill headroom in the shared
  provider queue.

## Changed

- Federation embedding-space headers now require the additive canonical
  preprocessing hash whenever an identity tuple is present. The legacy window
  applies only to a fully absent tuple in the seeded teacher space. This
  tightens the unreleased 2.3 exchange contract; no 2.3 release used the prior
  hashless-tuple behavior.
- Vibe cutover now holds failure tails above the configured coverage
  tolerance unless operators explicitly acknowledge them with
  `VIBE_SPACE_CUTOVER_ALLOW_FAILED=true`.
- Embedding-space lifecycle selection now follows the currently configured
  provider and retires abandoned migrations after the configured grace period.
- Upgrade guidance now requires backend and worker Deployments to reach zero
  ready replicas before Helm migration, then restores their saved replica
  counts. It also covers reused values and Compose transition verification.
- Vibe migration coverage telemetry now exposes failed tracks at sampling and
  cutover, while retaining the actionable coverage denominator.
- Migrating-space vibe text scans and lifecycle coverage reads are now bounded
  by a statement timeout, candidate cap, existence query, and two-query sampler.
- Vibe provider registration now rejects preprocessing mismatches for an
  existing model tuple and records the configuration error.
- Federation embedding export now requires the peer to advertise
  embedding-space support once the active space is no longer the original
  teacher space, protecting pre-2.3 peers from storing incompatible vectors.
- During a vibe embedding-space migration, text search now embeds and queries
  in the provider's registered space, returning partial results that grow with
  the backfill instead of using the removed legacy analyzer stream.
- The AIO image now embeds the DCLAP ONNX provider as its vibe embedding
  engine, wired to the backend through `VIBE_PROVIDER_URL`.
- Enabling the Helm DCLAP provider now wires the backend to it automatically
  through `VIBE_PROVIDER_URL`. It replaces the removed torch analyzer while
  keeping the same opt-in default.
- DCLAP is now the default vibe embedding provider in Compose, and the backend
  and worker are wired to it through `VIBE_PROVIDER_URL`.
- Federation embedding sync now verifies the JSON-encoded
  `X-Soundspan-Embedding-Space` response header before storing peer vectors,
  while preserving strict catalog response bodies for released consumers.
- Vibe embeddings are now tracked against a versioned embedding-space registry.
- Confined vibe and analysis vector SQL to the track embedding service layer.
- Release-note generation now always includes the standing 2.0.0 upgrade path
  and accepts repeatable per-release `--upgrade-note` bullets.

## Removed

- Removed the orphaned `clapWorkers` system-settings column.
- Removed the backend's CLAP Redis-stream text-embedding integration and its
  analyzer-only callbacks, worker-control configuration, and detection signals.
- Removed the torch CLAP stack and 2.35 GB checkpoint download from the AIO
  image, substantially reducing its size; existing libraries migrate
  automatically through the backend's blue/green embedding-space migration.
- Deleted the standalone torch CLAP sidecar sources and removed its build,
  scan, test, type-check, dependency-update, and release-image CI coverage.
- Removed the `audioAnalyzerClap` Helm component, so the multi-GB torch image is
  no longer deployed. Libraries with the DCLAP provider enabled migrate
  automatically.

## Accessibility

- No accessibility improvements documented in this release.

## Admin/Operations

- No admin/operations updates documented in this release.

## Deployment and Distribution

- Docker image: `ghcr.io/soundspan/soundspan`
- Helm chart repository: `https://soundspan.github.io/soundspan`
- Helm chart name: `soundspan`
- Helm chart reference: `soundspan/soundspan`

```bash
helm repo add soundspan https://soundspan.github.io/soundspan
helm repo update
helm upgrade --install soundspan soundspan/soundspan --version 2.3.0
```

## Breaking Changes

- None documented in this release.

## Known Issues

- None documented in this release.

## Compatibility and Migration

- No manual migration steps required for standard Docker and Helm deployments.

## Upgrading from an earlier version

If you are upgrading from a version earlier than 2.0.0, you must complete the
2.0.0 upgrade before you install 2.3.0. The 2.0.0 release contains breaking
changes that later releases depend on. Read the
[2.0.0 release notes](https://github.com/soundspan/soundspan/blob/2.0.0/docs/release-notes/RELEASE_NOTES_2.0.0.md)
and complete the
[2.0.0 upgrade guide](https://github.com/soundspan/soundspan/blob/2.0.0/docs/UPGRADING_TO_2.0.0.md).

## Full Changelog

- Compare changes: [2.2.0...HEAD](https://github.com/soundspan/soundspan/compare/2.2.0...HEAD)
- Full changelog: https://github.com/soundspan/soundspan/blob/HEAD/CHANGELOG.md

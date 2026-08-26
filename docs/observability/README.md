# Soundspan Prometheus observability

Import [`grafana-soundspan-prometheus.json`](grafana-soundspan-prometheus.json)
for the starter Grafana dashboard. Load
[`prometheus-alerts-soundspan.yml`](prometheus-alerts-soundspan.yml) as a
Prometheus rule file for the matching vibe provider, migration, queue,
collection-error, and federation alerts.

Use the dedicated [federation alert pack](federation-alerts.md) for per-peer
sync freshness, proxy failures, and authentication bursts.

Prometheus must scrape every backend and worker replica because each process
owns its registry. The queue-capacity series is published by workers, and the
alert expressions aggregate process-local series before evaluating thresholds.

## Metric reference

Every metric family the backend and worker export, grouped by domain. Source
modules live under `backend/src/metrics/`. In addition to the families below,
Node process defaults (memory, CPU, event loop, GC) are exported under the
`soundspan_` prefix via `collectDefaultMetrics` in `backend/src/metrics/index.ts`
(for example `soundspan_process_resident_memory_bytes`).

### HTTP and queues

| Metric                                    | Type      | Labels                                | Meaning                                          |
| ----------------------------------------- | --------- | ------------------------------------- | ------------------------------------------------ |
| `soundspan_http_request_duration_seconds` | Histogram | `method`, `route_class`, `status_class` | Backend HTTP request duration.                   |
| `soundspan_queue_jobs`                    | Gauge     | `queue`, `state`                      | Current Bull jobs by queue and bounded state.    |

### Scheduler

| Metric                                                   | Type      | Labels      | Meaning                                                    |
| -------------------------------------------------------- | --------- | ----------- | ---------------------------------------------------------- |
| `soundspan_scheduler_timeouts_total`                     | Counter   | `operation` | Scheduler-owned operation timeouts by bounded name.        |
| `soundspan_scheduler_job_duration_seconds`               | Histogram | `job`       | Scheduler execution duration by persisted job name.        |
| `soundspan_scheduler_job_last_success_timestamp_seconds` | Gauge     | `job`       | Unix timestamp of the last successful scheduler execution. |

### Downloads and requests

| Metric                                            | Type      | Labels               | Meaning                                                                                |
| ------------------------------------------------- | --------- | -------------------- | -------------------------------------------------------------------------------------- |
| `soundspan_album_downloads_total`                 | Counter   | `outcome`            | Album-download queue attempts by outcome.                                              |
| `soundspan_music_requests_total`                  | Counter   | `action`             | Music request state changes and rejected submissions.                                  |
| `soundspan_soulseek_album_folder_decisions_total` | Counter   | `outcome`            | `folder_selected` or `per_track_fallback` decisions.                                   |
| `soundspan_soulseek_album_coherence_score`        | Histogram | —                    | Best selected Soulseek album-folder coherence score, 0 to 1.                           |
| `soundspan_scrobble_forwarding_total`             | Counter   | `service`, `outcome` | `lastfm`/`listenbrainz` results: `submitted`, `retried`, `dropped`, or `invalid_auth`. |

### Library, catalog, and providers

| Metric                                                       | Type      | Labels            | Meaning                                                        |
| ------------------------------------------------------------ | --------- | ----------------- | -------------------------------------------------------------- |
| `soundspan_library_health_cache_total`                       | Counter   | `panel`, `result` | Library Health dashboard cache operations.                     |
| `soundspan_browse_image_cache_requests_total`                | Counter   | `result`          | Browse image cache lookups by result.                          |
| `soundspan_catalog_albums`                                   | Gauge     | —                 | Current number of persisted metadata-catalog albums.           |
| `soundspan_catalog_writes_total`                             | Counter   | `kind`            | Successful catalog writes: `release_group` or `tracklist`.     |
| `soundspan_catalog_reaped_total`                             | Counter   | —                 | Catalog albums removed by retention sweeps.                    |
| `soundspan_provider_track_gc_deleted_total`                  | Counter   | `provider`        | Provider track rows deleted by garbage collection.             |
| `soundspan_provider_track_gc_pass_seconds`                   | Histogram | `outcome`         | Provider-track GC pass duration by outcome.                    |
| `soundspan_provider_track_gc_backlog`                        | Gauge     | `provider`        | Collectable provider track rows remaining after a pass.        |
| `soundspan_provider_track_gc_oldest_collectable_age_seconds` | Gauge     | `provider`        | Age of the oldest collectable provider track row.              |

### Loudness

| Metric                                      | Type    | Labels      | Meaning                                                  |
| ------------------------------------------- | ------- | ----------- | -------------------------------------------------------- |
| `soundspan_loudness_coverage`               | Gauge   | `state`     | Completed active local tracks by EBU R128 measurement state. |
| `soundspan_loudness_backfill_outcomes_total` | Counter | `outcome`   | Loudness-only analyzer jobs by bounded final outcome.    |
| `soundspan_loudness_collection_errors_total` | Counter | `collector` | Loudness scrape dependency failures by bounded collector. |

### Vibe embeddings and provider

| Metric                                          | Type      | Labels                | Meaning                                                          |
| ----------------------------------------------- | --------- | --------------------- | ---------------------------------------------------------------- |
| `soundspan_vibe_provider_requests_total`        | Counter   | `endpoint`, `outcome` | Vibe provider HTTP requests by endpoint and final outcome.       |
| `soundspan_vibe_provider_request_seconds`       | Histogram | `endpoint`            | Vibe provider HTTP request duration.                             |
| `soundspan_vibe_embed_jobs_total`               | Counter   | `outcome`             | Backend-driven vibe embedding jobs by final outcome.             |
| `soundspan_vibe_embedding_coverage`             | Gauge     | `state`               | Local-track embedding coverage for the worker target space.      |
| `soundspan_vibe_space_transitions_total`        | Counter   | `transition`          | Embedding-space lifecycle transitions by bounded type.           |
| `soundspan_vibe_provider_config_errors_total`   | Counter   | `reason`              | Vibe provider configuration errors by bounded reason.            |
| `soundspan_vibe_vocabulary_space_mismatches_total` | Counter | `reason`              | Skipped vibe vocabulary blends by bounded compatibility reason.  |
| `soundspan_vibe_provider_queue_depth`           | Gauge     | —                     | Raw Redis job depth for the backend vibe provider queue.         |
| `soundspan_vibe_provider_queue_capacity`        | Gauge     | —                     | Configured admission capacity for the vibe provider queue.       |
| `soundspan_vibe_provider_status_fresh`          | Gauge     | —                     | Whether Redis holds at least one unexpired vibe worker heartbeat. |
| `soundspan_vibe_migration_active`               | Gauge     | —                     | Whether this worker is targeting a migrating vibe space.         |
| `soundspan_metrics_collection_errors_total`     | Counter   | `collector`           | Prometheus collection errors by bounded collector name.          |

### Federation

Alert semantics and thresholds for these families live in the
[federation alert pack](federation-alerts.md). Peer labels are bounded (first
500 applicable peers by ID, or 100 values plus `other`, per family).

| Metric                                                          | Type      | Labels            | Meaning                                                     |
| --------------------------------------------------------------- | --------- | ----------------- | ----------------------------------------------------------- |
| `soundspan_federation_syncs_total`                              | Counter   | `outcome`         | Peer sync processor runs by outcome.                        |
| `soundspan_federation_sync_skips_total`                         | Counter   | `reason`          | Sync fields or items not ingested as received.              |
| `soundspan_federation_peer_sync_lag_seconds`                    | Gauge     | `peer`            | Seconds since each consumer peer's last successful sync.    |
| `soundspan_federation_peer_last_sync_success_timestamp_seconds` | Gauge     | `peer`            | Unix timestamp of each peer's last successful sync.         |
| `soundspan_federation_peer_sync_duration_seconds`               | Histogram | `peer`, `outcome` | Sync duration by peer and final outcome.                    |
| `soundspan_federation_peer_catalog_items`                       | Gauge     | `peer`, `type`    | Federated catalog items by peer and media type.             |
| `soundspan_federation_embedding_pages_total`                    | Counter   | `outcome`         | Embedding pages by storage decision.                        |
| `soundspan_federation_embedding_exports_total`                  | Counter   | `outcome`         | Embedding export requests by compatibility decision.        |
| `soundspan_federation_presence_fetch_total`                     | Counter   | `peer`, `outcome` | Consumer peer presence fetches by closed outcome.           |
| `soundspan_federation_presence_users_exported_total`            | Counter   | `peer`            | Privacy-filtered presence users exported to peers.          |
| `soundspan_federation_stream_proxy_requests_total`              | Counter   | `peer`, `outcome` | Consumer stream proxy requests by final outcome.            |
| `soundspan_federation_stream_proxy_duration_seconds`            | Histogram | `peer`, `outcome` | Consumer stream proxy duration by final outcome.            |
| `soundspan_federation_stream_proxy_cache_total`                 | Counter   | `peer`, `result`  | Consumer stream proxy cache lookups by result.              |
| `soundspan_federation_host_stream_requests_total`               | Counter   | `peer`, `outcome` | Host-side federation stream requests by final outcome.      |
| `soundspan_federation_stream_leases`                            | Gauge     | `peer`            | Active host-side stream leases at scrape time.              |
| `soundspan_federation_quota_rejections_total`                   | Counter   | `peer`, `kind`    | Host-side stream quota rejections by kind.                  |
| `soundspan_federation_auth_failures_total`                      | Counter   | `peer`, `reason`  | Authentication and scope failures by bounded reason.        |
| `soundspan_federation_playlist_fetch_total`                     | Counter   | `peer`, `outcome` | Consumer peer playlist fetches by closed outcome.           |
| `soundspan_federation_playlist_follow_total`                    | Counter   | `peer`, `outcome` | Local peer playlist follow changes by closed outcome.       |
| `soundspan_federation_playlist_copy_total`                      | Counter   | `peer`, `outcome` | Local peer playlist copies by closed outcome.               |
| `soundspan_federation_collector_failures_total`                 | Counter   | `collector`       | Federation scrape-time collector failures by bounded name.  |

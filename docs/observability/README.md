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

## Metrics added since 2.5.0

| Metric                                                     | Type      | Labels               | Meaning                                                       |
| ---------------------------------------------------------- | --------- | -------------------- | ------------------------------------------------------------- |
| `soundspan_album_downloads_total`                          | Counter   | `outcome`            | Album-download attempts: `completed`, `failed`, or `retried`.  |
| `soundspan_catalog_albums`                                 | Gauge     | —                    | Current number of persisted metadata-catalog albums.           |
| `soundspan_catalog_writes_total`                           | Counter   | `kind`               | Successful writes: `release_group` or `tracklist`.             |
| `soundspan_catalog_reaped_total`                           | Counter   | —                    | Catalog albums removed by retention sweeps.                    |
| `soundspan_scheduler_timeouts_total`                       | Counter   | `operation`          | Scheduler-owned timeouts by bounded operation name.            |
| `soundspan_scheduler_job_duration_seconds`                 | Histogram | `job`                | Scheduler execution duration by persisted job name.            |
| `soundspan_scheduler_job_last_success_timestamp_seconds`   | Gauge     | `job`                | Unix timestamp of the last successful scheduler execution.     |
| `soundspan_scrobble_forwarding_total`                      | Counter   | `service`, `outcome` | `lastfm`/`listenbrainz` results: `submitted`, `retried`, `dropped`, or `invalid_auth`. |
| `soundspan_soulseek_album_folder_decisions_total`          | Counter   | `outcome`            | `folder_selected` or `per_track_fallback` decisions.           |
| `soundspan_soulseek_album_coherence_score`                 | Histogram | —                    | Best selected Soulseek album-folder coherence score, 0 to 1.   |

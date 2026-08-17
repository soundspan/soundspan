# Soundspan Prometheus observability

Import [`grafana-soundspan-prometheus.json`](grafana-soundspan-prometheus.json)
for the starter Grafana dashboard. Load
[`prometheus-alerts-soundspan.yml`](prometheus-alerts-soundspan.yml) as a
Prometheus rule file for the matching vibe provider, migration, queue,
collection-error, and federation alerts.

Prometheus must scrape every backend and worker replica because each process
owns its registry. The queue-capacity series is published by workers, and the
alert expressions aggregate process-local series before evaluating thresholds.

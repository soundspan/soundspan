# Federation Prometheus alerts

Federation telemetry is process-local. Prometheus must scrape both the API and
worker targets. The dedicated worker exports peer sync lag, last-success time,
sync duration, catalog counts, and the existing sync outcome counter. The API
exports consumer proxy, host stream, authentication, stream lease, cache, and
quota metrics. An all-in-one backend exports both sets from one registry.

Every `peer` label is the stable federation peer ID. Scrape-time gauges collect
the first 500 direction-applicable peers in stable ID order: consumer and
two-way peers for sync/catalog gauges, and host and two-way peers for lease
gauges. Within that collection cap, each metric family retains at most 100 peer
IDs and aggregates additional IDs under `peer="other"`. Applicable peers after
the first 500 are omitted, and the owning process logs one warning when it
reaches that cap.

The last-success gauge emits `0` for a consumer peer that has never completed a
sync. Its sync-lag gauge consequently reports the elapsed time since the Unix
epoch. Both freshness alerts below therefore fire for never-synced peers instead
of treating the missing success as an absent series.

The following Prometheus Operator rule pack is an example. It assumes the
default 15-minute `FEDERATION_SYNC_INTERVAL_MINUTES`. Replace the 1,800-second
warning threshold when the configured interval differs. Replace the six-hour
unreachable window and traffic minimums with values that match the deployment's
service objectives.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: soundspan-federation
spec:
  groups:
    - name: soundspan-federation-health
      rules:
        - alert: SoundspanFederationPeerUnreachable
          expr: |
            max by (peer) (
              soundspan_federation_peer_last_sync_success_timestamp_seconds{peer!="other"}
            ) == 0
            or
            (
              time()
                - max by (peer) (
                    soundspan_federation_peer_last_sync_success_timestamp_seconds{peer!="other"}
                  )
                > 6 * 60 * 60
            )
          for: 15m
          labels:
            severity: critical
          annotations:
            summary: Federation peer {{ $labels.peer }} has not synced
            description: The peer has never completed a catalog sync or its last success is more than six hours old.

        - alert: SoundspanFederationPeerSyncLagHigh
          expr: |
            max by (peer) (
              soundspan_federation_peer_sync_lag_seconds{peer!="other"}
            ) >= 1800
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: Federation peer {{ $labels.peer }} sync lag is high
            description: Sync lag is at least twice the configured 15-minute interval; never-synced peers report time since the Unix epoch.

        - alert: SoundspanFederationStreamProxyErrorsBurst
          expr: |
            (
              sum by (peer) (
                rate(soundspan_federation_stream_proxy_requests_total{outcome!="ok",peer!="other"}[10m])
              )
              /
              clamp_min(
                sum by (peer) (
                  rate(soundspan_federation_stream_proxy_requests_total{peer!="other"}[10m])
                ),
                0.001
              )
            ) > 0.20
            and
            sum by (peer) (
              increase(soundspan_federation_stream_proxy_requests_total{peer!="other"}[10m])
            ) >= 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: Federation peer {{ $labels.peer }} stream proxy errors are elevated
            description: More than 20% of at least 10 proxy requests failed during the last 10 minutes.

        - alert: SoundspanFederationAuthFailuresBurst
          expr: |
            sum by (peer, reason) (
              increase(soundspan_federation_auth_failures_total[5m])
            ) >= 20
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: Federation authentication failures are elevated
            description: Peer {{ $labels.peer }} produced at least 20 {{ $labels.reason }} failures in five minutes.
```

The `peer="unknown"` authentication series intentionally covers requests that
cannot be tied to a peer, including missing and guessed credentials. It never
contains a token-derived value.

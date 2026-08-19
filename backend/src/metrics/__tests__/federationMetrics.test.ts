import { Registry } from "prom-client";
import { createFederationMetrics } from "../federationMetrics";

describe("federation metrics", () => {
    it("collects worker peer freshness and catalog gauges lazily", async () => {
        const collectWorkerSnapshot = jest.fn().mockResolvedValue([
            {
                peerId: "peer-1",
                lastSyncSuccessAt: new Date("2026-08-19T11:59:00.000Z"),
                catalog: {
                    artist: 2,
                    album: 3,
                    track: 4,
                    audiobook: 5,
                    podcast: 6,
                },
            },
        ]);
        const registry = new Registry();
        createFederationMetrics(registry, {
            role: "worker",
            collectWorkerSnapshot,
            now: () => new Date("2026-08-19T12:00:00.000Z"),
        });

        expect(collectWorkerSnapshot).not.toHaveBeenCalled();
        const exposition = await registry.metrics();

        expect(collectWorkerSnapshot).toHaveBeenCalledTimes(1);
        expect(exposition).toContain(
            'soundspan_federation_peer_sync_lag_seconds{peer="peer-1"} 60',
        );
        expect(exposition).toContain(
            'soundspan_federation_peer_last_sync_success_timestamp_seconds{peer="peer-1"} 1787140740',
        );
        expect(exposition).toContain(
            'soundspan_federation_peer_catalog_items{peer="peer-1",type="track"} 4',
        );
    });

    it("records bounded worker and API outcomes", async () => {
        const registry = new Registry();
        const metrics = createFederationMetrics(registry, {
            role: "all",
            collectWorkerSnapshot: async () => [],
            collectLeaseSnapshot: async () => [],
        });

        metrics.recordPeerSync("peer-1", "success", 1.25);
        metrics.recordStreamProxy("peer-1", "http_5xx", 0.5);
        metrics.recordStreamProxyCache("peer-1", "hit");
        metrics.recordHostStream("peer-1", "ok");
        metrics.recordAuthFailure("unknown", "no_token");
        metrics.recordQuotaRejection("peer-1", "concurrency");

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_federation_peer_sync_duration_seconds_sum{peer="peer-1",outcome="success"} 1.25',
        );
        expect(exposition).toContain(
            'soundspan_federation_stream_proxy_requests_total{peer="peer-1",outcome="http_5xx"} 1',
        );
        expect(exposition).toContain(
            'soundspan_federation_stream_proxy_cache_total{peer="peer-1",result="hit"} 1',
        );
        expect(exposition).toContain(
            'soundspan_federation_host_stream_requests_total{peer="peer-1",outcome="ok"} 1',
        );
        expect(exposition).toContain(
            'soundspan_federation_auth_failures_total{peer="unknown",reason="no_token"} 1',
        );
        expect(exposition).toContain(
            'soundspan_federation_quota_rejections_total{peer="peer-1",kind="concurrency"} 1',
        );
    });

    it("collapses peer labels beyond the per-metric cap", async () => {
        const registry = new Registry();
        const metrics = createFederationMetrics(registry, {
            role: "api",
            maxPeerLabels: 100,
            collectLeaseSnapshot: async () =>
                Array.from({ length: 101 }, (_, index) => ({
                    peerId: `peer-${String(index).padStart(3, "0")}`,
                    activeLeases: 1,
                })),
        });
        for (let index = 0; index < 101; index += 1) {
            metrics.recordStreamProxy(`peer-${index}`, "ok", 0.1);
        }

        const exposition = await registry.metrics();
        expect(exposition).toContain(
            'soundspan_federation_stream_proxy_requests_total{peer="other",outcome="ok"} 1',
        );
        expect(exposition).toContain(
            'soundspan_federation_stream_leases{peer="other"} 1',
        );
        expect(
            exposition.match(
                /soundspan_federation_stream_leases\{peer="[^"]+"\}/g,
            ),
        ).toHaveLength(101);
    });
});

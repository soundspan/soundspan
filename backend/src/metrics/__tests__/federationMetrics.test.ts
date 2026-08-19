import { Registry } from "prom-client";
import type {
    FederationLeaseMetricSnapshot,
    FederationWorkerMetricSnapshot,
} from "../../services/federationPeerHealth";

const logWarn = jest.fn();
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: logWarn }) },
}));

import { createFederationMetrics } from "../federationMetrics";

describe("federation metrics", () => {
    beforeEach(() => {
        logWarn.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

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

    it("emits epoch freshness for a consumer peer that has never synced", async () => {
        const registry = new Registry();
        createFederationMetrics(registry, {
            role: "worker",
            collectWorkerSnapshot: async () => [
                {
                    peerId: "never-synced",
                    lastSyncSuccessAt: null,
                    catalog: {
                        artist: 0,
                        album: 0,
                        track: 0,
                        audiobook: 0,
                        podcast: 0,
                    },
                },
            ],
            now: () => new Date("2026-08-19T12:00:00.000Z"),
        });

        const exposition = await registry.metrics();

        expect(exposition).toContain(
            'soundspan_federation_peer_last_sync_success_timestamp_seconds{peer="never-synced"} 0',
        );
        expect(exposition).toContain(
            'soundspan_federation_peer_sync_lag_seconds{peer="never-synced"} 1787140800',
        );
    });

    it("advances worker lag from the last-good snapshot when collection fails", async () => {
        let now = new Date("2026-08-19T12:00:00.000Z");
        const collectWorkerSnapshot = jest
            .fn()
            .mockResolvedValueOnce([
                {
                    peerId: "peer-1",
                    lastSyncSuccessAt: new Date("2026-08-19T11:59:00.000Z"),
                    catalog: {
                        artist: 1,
                        album: 2,
                        track: 3,
                        audiobook: 4,
                        podcast: 5,
                    },
                },
            ])
            .mockRejectedValueOnce(new Error("postgres unavailable"));
        const registry = new Registry();
        createFederationMetrics(registry, {
            role: "worker",
            collectWorkerSnapshot,
            now: () => now,
        });

        await registry.metrics();
        now = new Date("2026-08-19T12:05:00.000Z");
        const exposition = await registry.metrics();
        const failureExposition = await registry.getSingleMetricAsString(
            "soundspan_federation_collector_failures_total",
        );

        expect(collectWorkerSnapshot).toHaveBeenCalledTimes(2);
        expect(exposition).toContain(
            'soundspan_federation_peer_catalog_items{peer="peer-1",type="track"} 3',
        );
        expect(exposition).toContain(
            'soundspan_federation_peer_sync_lag_seconds{peer="peer-1"} 360',
        );
        expect(failureExposition).toContain(
            'soundspan_federation_collector_failures_total{collector="worker_snapshot"} 1',
        );
        expect(logWarn).toHaveBeenCalledTimes(1);
        expect(logWarn).toHaveBeenCalledWith(
            "Federation metric collector failed; retaining last-good samples",
            expect.objectContaining({ collector: "worker_snapshot" }),
        );
    });

    it("keeps a timed-out worker collection single-flight until it settles", async () => {
        jest.useFakeTimers();
        let resolveCollection:
            | ((snapshots: FederationWorkerMetricSnapshot[]) => void)
            | undefined;
        const collection = new Promise<FederationWorkerMetricSnapshot[]>(
            (resolve) => {
                resolveCollection = resolve;
            },
        );
        const collectWorkerSnapshot = jest
            .fn()
            .mockReturnValueOnce(collection)
            .mockResolvedValueOnce([
                {
                    peerId: "peer-recovered",
                    lastSyncSuccessAt: new Date("2026-08-19T11:59:00.000Z"),
                    catalog: {
                        artist: 1,
                        album: 1,
                        track: 1,
                        audiobook: 1,
                        podcast: 1,
                    },
                },
            ]);
        const registry = new Registry();
        createFederationMetrics(registry, {
            role: "worker",
            collectWorkerSnapshot,
            now: () => new Date("2026-08-19T12:00:00.000Z"),
        });

        const timedOutScrape = registry.metrics();
        await jest.advanceTimersByTimeAsync(5_000);
        await timedOutScrape;
        const failureExposition = await registry.getSingleMetricAsString(
            "soundspan_federation_collector_failures_total",
        );
        const coalescedScrape = registry.metrics();
        await Promise.resolve();

        expect(collectWorkerSnapshot).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(5_000);
        await coalescedScrape;
        resolveCollection?.([]);
        await jest.advanceTimersByTimeAsync(0);
        const recoveredExposition = await registry.metrics();

        expect(failureExposition).toContain(
            'soundspan_federation_collector_failures_total{collector="worker_snapshot"} 1',
        );
        expect(recoveredExposition).toContain(
            'soundspan_federation_peer_catalog_items{peer="peer-recovered",type="track"} 1',
        );
        expect(collectWorkerSnapshot).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(0);
    });

    it("coalesces concurrent lease collection and keeps last-good samples", async () => {
        let releaseCollection: (() => void) | undefined;
        const collectionGate = new Promise<void>((resolve) => {
            releaseCollection = resolve;
        });
        const collectLeaseSnapshot = jest
            .fn()
            .mockImplementationOnce(async () => {
                await collectionGate;
                return [{ peerId: "peer-1", activeLeases: 2 }];
            })
            .mockRejectedValueOnce(new Error("redis unavailable"));
        const registry = new Registry();
        createFederationMetrics(registry, {
            role: "api",
            collectLeaseSnapshot,
        });

        const first = registry.metrics();
        const concurrent = registry.metrics();
        await Promise.resolve();
        expect(collectLeaseSnapshot).toHaveBeenCalledTimes(1);
        releaseCollection?.();
        const [firstExposition, concurrentExposition] = await Promise.all([
            first,
            concurrent,
        ]);
        const afterFailure = await registry.metrics();
        const failureExposition = await registry.getSingleMetricAsString(
            "soundspan_federation_collector_failures_total",
        );

        expect(firstExposition).toContain(
            'soundspan_federation_stream_leases{peer="peer-1"} 2',
        );
        expect(concurrentExposition).toContain(
            'soundspan_federation_stream_leases{peer="peer-1"} 2',
        );
        expect(afterFailure).toContain(
            'soundspan_federation_stream_leases{peer="peer-1"} 2',
        );
        expect(collectLeaseSnapshot).toHaveBeenCalledTimes(2);
        expect(failureExposition).toContain(
            'soundspan_federation_collector_failures_total{collector="lease_snapshot"} 1',
        );
    });

    it("keeps a timed-out lease collection single-flight until it settles", async () => {
        jest.useFakeTimers();
        let resolveCollection:
            | ((snapshots: FederationLeaseMetricSnapshot[]) => void)
            | undefined;
        const collection = new Promise<FederationLeaseMetricSnapshot[]>(
            (resolve) => {
                resolveCollection = resolve;
            },
        );
        const collectLeaseSnapshot = jest
            .fn()
            .mockReturnValueOnce(collection)
            .mockResolvedValueOnce([
                { peerId: "peer-recovered", activeLeases: 2 },
            ]);
        const registry = new Registry();
        createFederationMetrics(registry, {
            role: "api",
            collectLeaseSnapshot,
        });

        const timedOutScrape = registry.metrics();
        await jest.advanceTimersByTimeAsync(5_000);
        await timedOutScrape;
        const failureExposition = await registry.getSingleMetricAsString(
            "soundspan_federation_collector_failures_total",
        );
        const coalescedScrape = registry.metrics();
        await Promise.resolve();

        expect(collectLeaseSnapshot).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(5_000);
        await coalescedScrape;
        resolveCollection?.([]);
        await jest.advanceTimersByTimeAsync(0);
        const recoveredExposition = await registry.metrics();

        expect(failureExposition).toContain(
            'soundspan_federation_collector_failures_total{collector="lease_snapshot"} 1',
        );
        expect(recoveredExposition).toContain(
            'soundspan_federation_stream_leases{peer="peer-recovered"} 2',
        );
        expect(collectLeaseSnapshot).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(0);
    });

    it("serves a late lease result from cache on the next scrape", async () => {
        jest.useFakeTimers();
        let resolveCollection:
            | ((snapshots: FederationLeaseMetricSnapshot[]) => void)
            | undefined;
        const collection = new Promise<FederationLeaseMetricSnapshot[]>(
            (resolve) => {
                resolveCollection = resolve;
            },
        );
        const collectLeaseSnapshot = jest
            .fn()
            .mockReturnValueOnce(collection)
            .mockReturnValueOnce(new Promise(() => undefined));
        const registry = new Registry();
        createFederationMetrics(registry, {
            role: "api",
            collectLeaseSnapshot,
        });

        const timedOutScrape = registry.metrics();
        await jest.advanceTimersByTimeAsync(5_000);
        await timedOutScrape;
        resolveCollection?.([{ peerId: "peer-late", activeLeases: 7 }]);
        await jest.advanceTimersByTimeAsync(0);

        const nextScrape = registry.metrics();
        await jest.advanceTimersByTimeAsync(5_000);
        const nextExposition = await nextScrape;

        expect(nextExposition).toContain(
            'soundspan_federation_stream_leases{peer="peer-late"} 7',
        );
        expect(collectLeaseSnapshot).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(0);
    });

    it("does not reference the collector deadline timer", async () => {
        const nativeSetTimeout = global.setTimeout;
        const deadlineTimers: NodeJS.Timeout[] = [];
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((callback: () => void, delay?: number) => {
                const timer = nativeSetTimeout(callback, delay);
                deadlineTimers.push(timer);
                return timer;
            }) as typeof setTimeout);
        let releaseCollection: (() => void) | undefined;
        const collection = new Promise<void>((resolve) => {
            releaseCollection = resolve;
        });
        const registry = new Registry();
        createFederationMetrics(registry, {
            role: "api",
            collectLeaseSnapshot: async () => {
                await collection;
                return [];
            },
        });

        let scrape: Promise<string> | undefined;
        try {
            scrape = registry.metrics();
            await Promise.resolve();

            expect(deadlineTimers).toHaveLength(1);
            expect(deadlineTimers[0]?.hasRef()).toBe(false);
        } finally {
            releaseCollection?.();
            if (scrape) await scrape;
            setTimeoutSpy.mockRestore();
        }
    });

    it("rate-limits repeated collector failure warnings", async () => {
        const registry = new Registry();
        createFederationMetrics(registry, {
            role: "api",
            collectLeaseSnapshot: jest
                .fn()
                .mockRejectedValue(new Error("redis unavailable")),
            now: () => new Date("2026-08-19T12:00:00.000Z"),
        });

        await registry.metrics();
        await registry.metrics();
        const exposition = await registry.getSingleMetricAsString(
            "soundspan_federation_collector_failures_total",
        );

        expect(exposition).toContain(
            'soundspan_federation_collector_failures_total{collector="lease_snapshot"} 2',
        );
        expect(logWarn).toHaveBeenCalledTimes(1);
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

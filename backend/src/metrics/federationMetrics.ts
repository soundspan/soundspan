import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import type {
    FederationCatalogCounts,
    FederationLeaseMetricSnapshot,
    FederationWorkerMetricSnapshot,
} from "../services/federationPeerHealth";
import { logger } from "../utils/logger";

const DEFAULT_MAX_PEER_LABELS = 100;
const MAX_COLLECTED_PEERS = 500;
const COLLECTOR_TIMEOUT_MS = 5_000;
const COLLECTOR_WARNING_INTERVAL_MS = 5 * 60 * 1_000;
const CATALOG_TYPES = [
    "artist",
    "album",
    "track",
    "audiobook",
    "podcast",
] as const;
const DURATION_BUCKETS = [
    0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900,
    1_800, 3_600,
];
const log = logger.child("FederationMetrics");

async function defaultWorkerSnapshot(): Promise<
    FederationWorkerMetricSnapshot[]
> {
    const { collectFederationWorkerMetricSnapshot } =
        await import("../services/federationPeerHealth");
    return collectFederationWorkerMetricSnapshot();
}

async function defaultLeaseSnapshot(): Promise<
    FederationLeaseMetricSnapshot[]
> {
    const { collectFederationLeaseMetricSnapshot } =
        await import("../services/federationPeerHealth");
    return collectFederationLeaseMetricSnapshot();
}

export type FederationMetricsRole = "api" | "worker" | "all";
export type FederationSyncOutcome = "success" | "failure";
export type FederationStreamOutcome =
    | "ok"
    | "http_4xx"
    | "http_5xx"
    | "timeout"
    | "aborted"
    | "error";
export type FederationAuthFailureReason =
    | "scope"
    | "no_token"
    | "unknown_credential"
    | "wrong_direction"
    | "inactive";
export type FederationQuotaKind = "concurrency" | "bandwidth";
export type FederationCacheResult = "hit" | "miss";
type FederationCollector = "worker_snapshot" | "lease_snapshot";
type RecordCollectorFailure = (
    collector: FederationCollector,
    cause: unknown,
) => void;

/** Role and dependency seams for process-local federation instrumentation. */
export interface FederationMetricsOptions {
    role?: FederationMetricsRole;
    maxPeerLabels?: number;
    now?: () => Date;
    collectWorkerSnapshot?: () => Promise<FederationWorkerMetricSnapshot[]>;
    collectLeaseSnapshot?: () => Promise<FederationLeaseMetricSnapshot[]>;
}

interface WorkerInstruments {
    syncLag: Gauge<"peer">;
    lastSyncSuccess: Gauge<"peer">;
    catalogItems: Gauge<"peer" | "type">;
    syncDuration: Histogram<"peer" | "outcome">;
}

interface ApiInstruments {
    proxyRequests: Counter<"peer" | "outcome">;
    proxyDuration: Histogram<"peer" | "outcome">;
    proxyCache: Counter<"peer" | "result">;
    hostRequests: Counter<"peer" | "outcome">;
    authFailures: Counter<"peer" | "reason">;
    streamLeases: Gauge<"peer">;
    quotaRejections: Counter<"peer" | "kind">;
}

async function collectWithTimeout<T>(
    collector: FederationCollector,
    collect: () => Promise<T>,
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(
                new Error(
                    `Federation ${collector} collector timed out after ${COLLECTOR_TIMEOUT_MS} ms`,
                ),
            );
        }, COLLECTOR_TIMEOUT_MS);
        timer?.unref?.();
    });
    try {
        return await Promise.race([collect(), timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function singleFlightCollector<T>(
    collect: () => Promise<T>,
    retain: (value: T) => void,
): () => Promise<void> {
    let pending: Promise<void> | null = null;
    return () => {
        if (pending) return pending;
        const collection = collect().then(retain);
        pending = collection.finally(() => {
            pending = null;
        });
        return pending;
    };
}

function registerCollectorFailureReporter(
    registry: Registry,
    now: () => Date,
): RecordCollectorFailure {
    const failures = new Counter({
        name: "soundspan_federation_collector_failures_total",
        help: "Federation scrape-time collector failures by bounded collector name.",
        labelNames: ["collector"] as const,
        registers: [registry],
    });
    const lastWarningAt: Record<FederationCollector, number | null> = {
        worker_snapshot: null,
        lease_snapshot: null,
    };
    return (collector, cause): void => {
        failures.inc({ collector });
        const nowMs = now().getTime();
        const lastWarning = lastWarningAt[collector];
        if (
            lastWarning !== null &&
            nowMs - lastWarning < COLLECTOR_WARNING_INTERVAL_MS
        ) {
            return;
        }
        lastWarningAt[collector] = nowMs;
        log.warn(
            "Federation metric collector failed; retaining last-good samples",
            { collector, cause },
        );
    };
}

/** Process-local federation metrics and thin recording operations. */
export interface FederationMetrics {
    recordPeerSync(
        peerId: string,
        outcome: FederationSyncOutcome,
        durationSeconds: number,
    ): void;
    recordStreamProxy(
        peerId: string,
        outcome: FederationStreamOutcome,
        durationSeconds: number,
    ): void;
    recordStreamProxyCache(peerId: string, result: FederationCacheResult): void;
    recordHostStream(peerId: string, outcome: FederationStreamOutcome): void;
    recordAuthFailure(
        peerId: string,
        reason: FederationAuthFailureReason,
    ): void;
    recordQuotaRejection(peerId: string, kind: FederationQuotaKind): void;
}

function peerLabelGuard(maxPeerLabels: number) {
    const knownPeers = new Set<string>();
    return (candidate: string): string => {
        if (
            candidate === "unknown" ||
            candidate === "other" ||
            knownPeers.has(candidate)
        ) {
            return candidate;
        }
        if (knownPeers.size >= maxPeerLabels) return "other";
        knownPeers.add(candidate);
        return candidate;
    };
}

function boundedPeerLimit(candidate: number | undefined): number {
    if (candidate === undefined || !Number.isFinite(candidate)) {
        return DEFAULT_MAX_PEER_LABELS;
    }
    return Math.min(
        DEFAULT_MAX_PEER_LABELS,
        Math.max(1, Math.floor(candidate)),
    );
}

function emptyCatalog(): FederationCatalogCounts {
    return { artist: 0, album: 0, track: 0, audiobook: 0, podcast: 0 };
}

function addCatalog(
    target: FederationCatalogCounts,
    source: FederationCatalogCounts,
): void {
    for (let index = 0; index < CATALOG_TYPES.length; index += 1) {
        const type = CATALOG_TYPES[index];
        target[type] += source[type];
    }
}

function setWorkerSnapshot(
    instruments: WorkerInstruments,
    snapshots: readonly FederationWorkerMetricSnapshot[],
    boundPeer: (peerId: string) => string,
    nowMs: number,
): void {
    const catalogs = new Map<string, FederationCatalogCounts>();
    const lastSuccess = new Map<string, number>();
    const worstLag = new Map<string, number>();
    for (let index = 0; index < MAX_COLLECTED_PEERS; index += 1) {
        const snapshot = snapshots[index];
        if (!snapshot) break;
        const peer = boundPeer(snapshot.peerId);
        const catalog = catalogs.get(peer) ?? emptyCatalog();
        addCatalog(catalog, snapshot.catalog);
        catalogs.set(peer, catalog);
        const lastSuccessMs = snapshot.lastSyncSuccessAt?.getTime() ?? 0;
        const timestamp = lastSuccessMs / 1_000;
        const lag = Math.max(0, (nowMs - lastSuccessMs) / 1_000);
        const previousTimestamp = lastSuccess.get(peer);
        lastSuccess.set(
            peer,
            previousTimestamp === undefined
                ? timestamp
                : Math.min(previousTimestamp, timestamp),
        );
        worstLag.set(peer, Math.max(worstLag.get(peer) ?? 0, lag));
    }
    const catalogEntries = [...catalogs.entries()];
    for (let index = 0; index <= DEFAULT_MAX_PEER_LABELS; index += 1) {
        const entry = catalogEntries[index];
        if (!entry) break;
        const [peer, catalog] = entry;
        for (
            let typeIndex = 0;
            typeIndex < CATALOG_TYPES.length;
            typeIndex += 1
        ) {
            const type = CATALOG_TYPES[typeIndex];
            instruments.catalogItems.set({ peer, type }, catalog[type]);
        }
    }
    const successEntries = [...lastSuccess.entries()];
    for (let index = 0; index <= DEFAULT_MAX_PEER_LABELS; index += 1) {
        const entry = successEntries[index];
        if (!entry) break;
        const [peer, timestamp] = entry;
        instruments.lastSyncSuccess.set({ peer }, timestamp);
        instruments.syncLag.set({ peer }, worstLag.get(peer) ?? 0);
    }
}

function workerCollector(
    instruments: WorkerInstruments,
    collectSnapshot: () => Promise<FederationWorkerMetricSnapshot[]>,
    boundPeer: (peerId: string) => string,
    now: () => Date,
    recordFailure: RecordCollectorFailure,
): () => Promise<void> {
    let lastGood: readonly FederationWorkerMetricSnapshot[] | null = null;
    let pendingScrape: Promise<void> | null = null;
    const collectSingleFlight = singleFlightCollector(
        collectSnapshot,
        (snapshots) => {
            lastGood = snapshots.slice(0, MAX_COLLECTED_PEERS);
        },
    );
    const scrape = async (): Promise<void> => {
        try {
            await collectWithTimeout("worker_snapshot", collectSingleFlight);
        } catch (cause) {
            recordFailure("worker_snapshot", cause);
        }
        if (lastGood === null) return;
        instruments.syncLag.reset();
        instruments.lastSyncSuccess.reset();
        instruments.catalogItems.reset();
        setWorkerSnapshot(instruments, lastGood, boundPeer, now().getTime());
    };
    return () => {
        if (pendingScrape) return pendingScrape;
        pendingScrape = scrape().finally(() => {
            pendingScrape = null;
        });
        return pendingScrape;
    };
}

function registerWorkerMetrics(
    registry: Registry,
    collectSnapshot: () => Promise<FederationWorkerMetricSnapshot[]>,
    boundPeer: (peerId: string) => string,
    now: () => Date,
    recordFailure: RecordCollectorFailure,
): WorkerInstruments {
    let collectAll: () => Promise<void> = async () => undefined;
    const syncLag = new Gauge({
        name: "soundspan_federation_peer_sync_lag_seconds",
        help: "Seconds since each consumer peer's last successful sync, or since the Unix epoch when never synced; peer labels are bounded to 100 values plus other among the first 500 applicable peers by ID.",
        labelNames: ["peer"] as const,
        registers: [registry],
        async collect() {
            await collectAll();
        },
    });
    const lastSyncSuccess = new Gauge({
        name: "soundspan_federation_peer_last_sync_success_timestamp_seconds",
        help: "Unix timestamp of each consumer peer's last successful sync, or 0 when never synced; peer labels are bounded to 100 values plus other among the first 500 applicable peers by ID.",
        labelNames: ["peer"] as const,
        registers: [registry],
        async collect() {
            await collectAll();
        },
    });
    const catalogItems = new Gauge({
        name: "soundspan_federation_peer_catalog_items",
        help: "Federated catalog items by bounded consumer peer and media type for the first 500 applicable peers by ID; peer labels are bounded to 100 values plus other.",
        labelNames: ["peer", "type"] as const,
        registers: [registry],
        async collect() {
            await collectAll();
        },
    });
    const syncDuration = new Histogram({
        name: "soundspan_federation_peer_sync_duration_seconds",
        help: "Federation sync duration by bounded peer and final outcome; peer labels are bounded to 100 values plus other.",
        labelNames: ["peer", "outcome"] as const,
        buckets: DURATION_BUCKETS,
        registers: [registry],
    });
    const instruments = {
        syncLag,
        lastSyncSuccess,
        catalogItems,
        syncDuration,
    };
    collectAll = workerCollector(
        instruments,
        collectSnapshot,
        boundPeer,
        now,
        recordFailure,
    );
    return instruments;
}

function setLeaseSnapshot(
    gauge: Gauge<"peer">,
    snapshots: readonly FederationLeaseMetricSnapshot[],
    boundPeer: (peerId: string) => string,
): void {
    const totals = new Map<string, number>();
    for (let index = 0; index < MAX_COLLECTED_PEERS; index += 1) {
        const snapshot = snapshots[index];
        if (!snapshot) break;
        const peer = boundPeer(snapshot.peerId);
        totals.set(peer, (totals.get(peer) ?? 0) + snapshot.activeLeases);
    }
    const entries = [...totals.entries()];
    for (let index = 0; index <= DEFAULT_MAX_PEER_LABELS; index += 1) {
        const entry = entries[index];
        if (!entry) break;
        gauge.set({ peer: entry[0] }, entry[1]);
    }
}

function leaseCollector(
    gauge: Gauge<"peer">,
    collectLeases: () => Promise<FederationLeaseMetricSnapshot[]>,
    leasePeer: (peerId: string) => string,
    recordFailure: RecordCollectorFailure,
): () => Promise<void> {
    let lastGood: readonly FederationLeaseMetricSnapshot[] | null = null;
    const collectSingleFlight = singleFlightCollector(
        collectLeases,
        (snapshots) => {
            lastGood = snapshots.slice(0, MAX_COLLECTED_PEERS);
        },
    );
    return async () => {
        try {
            await collectWithTimeout("lease_snapshot", collectSingleFlight);
        } catch (cause) {
            recordFailure("lease_snapshot", cause);
        }
        if (lastGood === null) return;
        gauge.reset();
        setLeaseSnapshot(gauge, lastGood, leasePeer);
    };
}

function registerProxyMetrics(
    registry: Registry,
): Pick<ApiInstruments, "proxyRequests" | "proxyDuration" | "proxyCache"> {
    const boundedHelp = "peer labels are bounded to 100 values plus other.";
    const proxyRequests = new Counter({
        name: "soundspan_federation_stream_proxy_requests_total",
        help: `Consumer stream proxy requests by final outcome; ${boundedHelp}`,
        labelNames: ["peer", "outcome"] as const,
        registers: [registry],
    });
    const proxyDuration = new Histogram({
        name: "soundspan_federation_stream_proxy_duration_seconds",
        help: `Consumer stream proxy duration by final outcome; ${boundedHelp}`,
        labelNames: ["peer", "outcome"] as const,
        buckets: DURATION_BUCKETS,
        registers: [registry],
    });
    const proxyCache = new Counter({
        name: "soundspan_federation_stream_proxy_cache_total",
        help: `Consumer stream proxy cache lookups by result; ${boundedHelp}`,
        labelNames: ["peer", "result"] as const,
        registers: [registry],
    });
    return { proxyRequests, proxyDuration, proxyCache };
}

function registerHostMetrics(
    registry: Registry,
    collectLeases: () => Promise<FederationLeaseMetricSnapshot[]>,
    leasePeer: (peerId: string) => string,
    recordFailure: RecordCollectorFailure,
): Pick<
    ApiInstruments,
    "hostRequests" | "authFailures" | "streamLeases" | "quotaRejections"
> {
    const boundedHelp = "peer labels are bounded to 100 values plus other.";
    const hostRequests = new Counter({
        name: "soundspan_federation_host_stream_requests_total",
        help: `Host-side federation stream requests by final outcome; ${boundedHelp}`,
        labelNames: ["peer", "outcome"] as const,
        registers: [registry],
    });
    const authFailures = new Counter({
        name: "soundspan_federation_auth_failures_total",
        help: `Federation authentication and scope failures by bounded reason; ${boundedHelp}`,
        labelNames: ["peer", "reason"] as const,
        registers: [registry],
    });
    let collectStreamLeases: () => Promise<void> = async () => undefined;
    const streamLeases = new Gauge({
        name: "soundspan_federation_stream_leases",
        help: `Active host-side stream leases at scrape time for the first 500 applicable peers by ID; ${boundedHelp}`,
        labelNames: ["peer"] as const,
        registers: [registry],
        async collect() {
            await collectStreamLeases();
        },
    });
    collectStreamLeases = leaseCollector(
        streamLeases,
        collectLeases,
        leasePeer,
        recordFailure,
    );
    const quotaRejections = new Counter({
        name: "soundspan_federation_quota_rejections_total",
        help: `Host-side federation stream quota rejections by kind; ${boundedHelp}`,
        labelNames: ["peer", "kind"] as const,
        registers: [registry],
    });
    return { hostRequests, authFailures, streamLeases, quotaRejections };
}

function registerApiMetrics(
    registry: Registry,
    collectLeases: () => Promise<FederationLeaseMetricSnapshot[]>,
    leasePeer: (peerId: string) => string,
    recordFailure: RecordCollectorFailure,
): ApiInstruments {
    return {
        ...registerProxyMetrics(registry),
        ...registerHostMetrics(
            registry,
            collectLeases,
            leasePeer,
            recordFailure,
        ),
    };
}

/** Registers role-owned, bounded per-peer federation metrics. */
export function createFederationMetrics(
    registry: Registry,
    options: FederationMetricsOptions = {},
): FederationMetrics {
    const role = options.role ?? "all";
    const maxPeers = boundedPeerLimit(options.maxPeerLabels);
    const now = options.now ?? (() => new Date());
    const recordFailure = registerCollectorFailureReporter(registry, now);
    const workerPeer = peerLabelGuard(maxPeers);
    const syncPeer = peerLabelGuard(maxPeers);
    const worker =
        role === "worker" || role === "all"
            ? registerWorkerMetrics(
                  registry,
                  options.collectWorkerSnapshot ?? defaultWorkerSnapshot,
                  workerPeer,
                  now,
                  recordFailure,
              )
            : null;
    const api =
        role === "api" || role === "all"
            ? registerApiMetrics(
                  registry,
                  options.collectLeaseSnapshot ?? defaultLeaseSnapshot,
                  peerLabelGuard(maxPeers),
                  recordFailure,
              )
            : null;
    const proxyPeer = peerLabelGuard(maxPeers);
    const cachePeer = peerLabelGuard(maxPeers);
    const hostPeer = peerLabelGuard(maxPeers);
    const authPeer = peerLabelGuard(maxPeers);
    const quotaPeer = peerLabelGuard(maxPeers);
    return {
        recordPeerSync(peerId, outcome, durationSeconds): void {
            worker?.syncDuration.observe(
                { peer: syncPeer(peerId), outcome },
                durationSeconds,
            );
        },
        recordStreamProxy(peerId, outcome, durationSeconds): void {
            const peer = proxyPeer(peerId);
            api?.proxyRequests.inc({ peer, outcome });
            api?.proxyDuration.observe({ peer, outcome }, durationSeconds);
        },
        recordStreamProxyCache(peerId, result): void {
            api?.proxyCache.inc({ peer: cachePeer(peerId), result });
        },
        recordHostStream(peerId, outcome): void {
            api?.hostRequests.inc({ peer: hostPeer(peerId), outcome });
        },
        recordAuthFailure(peerId, reason): void {
            api?.authFailures.inc({ peer: authPeer(peerId), reason });
        },
        recordQuotaRejection(peerId, kind): void {
            api?.quotaRejections.inc({ peer: quotaPeer(peerId), kind });
        },
    };
}

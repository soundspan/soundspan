import type { PeerDirection, PeerStatus } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import type { FederationHealthErrorClass } from "./federationErrorClassifier";
import type {
    FederationCatalogCounts,
    FederationLeaseMetricSnapshot,
    FederationWorkerMetricSnapshot,
} from "./federationMetricsTypes";

const MAX_HEALTH_PEERS = 500;
const LEASE_QUERY_BATCH_SIZE = 25;
const RECENT_ERROR_MS = 24 * 60 * 60 * 1_000;
const MAX_ERROR_LENGTH = 500;
const STREAM_LEASE_KEY_PREFIX = "federation:stream-leases:v2";
const CATALOG_TYPES = [
    "artist",
    "album",
    "track",
    "audiobook",
    "podcast",
] as const;
const log = logger.child("FederationPeerHealth");
const warnedCappedCollectors = new Set<CappedCollector>();

type CappedCollector = "admin_health" | "worker_metrics" | "lease_metrics";

export type FederationCatalogType = keyof FederationCatalogCounts;
export type FederationHealthState = "green" | "amber" | "red" | "revoked";

/** Inputs used by the pure federation health-state decision. */
export interface FederationHealthStateInput {
    direction: PeerDirection;
    inboundStatus: PeerStatus | null;
    outboundStatus: PeerStatus | null;
    syncLagSeconds: number | null;
    lastErrorAt: Date | null;
}

interface CountRow {
    peerId: string | null;
    _count: { _all: number };
}

interface LeaseCountRedis {
    zCount(key: string, min: string, max: string): Promise<number>;
}

/** Admin health response for one federation peer. */
export interface FederationPeerHealth {
    id: string;
    name: string;
    direction: PeerDirection;
    inboundStatus: PeerStatus | null;
    outboundStatus: PeerStatus | null;
    lastSeenAt: Date | null;
    lastSyncSuccessAt: Date | null;
    lastSyncDurationMs: number | null;
    syncLagSeconds: number | null;
    catalog: FederationCatalogCounts;
    activeStreamLeases: number;
    maxConcurrentStreams: number | null;
    lastError: string | null;
    lastErrorAt: Date | null;
    lastErrorClass: FederationHealthErrorClass | null;
    lastEmbeddingOutcome: "active" | "skipped_mismatch" | null;
    health: FederationHealthState;
}

function emptyCatalogCounts(): FederationCatalogCounts {
    return { artist: 0, album: 0, track: 0, audiobook: 0, podcast: 0 };
}

function activeForDirection(input: FederationHealthStateInput): boolean {
    const inboundActive =
        input.direction === "CONSUMER" || input.inboundStatus === "ACTIVE";
    const outboundActive =
        input.direction === "HOST" || input.outboundStatus === "ACTIVE";
    return inboundActive && outboundActive;
}

function revokedForDirection(input: FederationHealthStateInput): boolean {
    const inboundRevoked =
        input.direction !== "CONSUMER" && input.inboundStatus === "REVOKED";
    const outboundRevoked =
        input.direction !== "HOST" && input.outboundStatus === "REVOKED";
    return inboundRevoked || outboundRevoked;
}

/** Derives the bounded admin health state from peer status and freshness. */
export function deriveFederationHealthState(
    input: FederationHealthStateInput,
    syncIntervalMinutes: number,
    now = new Date(),
): FederationHealthState {
    if (revokedForDirection(input)) return "revoked";
    const intervalMinutes = Number.isFinite(syncIntervalMinutes)
        ? Math.max(1, syncIntervalMinutes)
        : 1;
    const intervalSeconds = intervalMinutes * 60;
    const expectsSync = input.direction !== "HOST";
    const lagIsRed =
        expectsSync &&
        (input.syncLagSeconds === null ||
            input.syncLagSeconds >= intervalSeconds * 6);
    if (!activeForDirection(input) || lagIsRed) return "red";
    const lagIsAmber =
        expectsSync &&
        input.syncLagSeconds !== null &&
        input.syncLagSeconds >= intervalSeconds * 2;
    const recentError =
        input.lastErrorAt !== null &&
        now.getTime() - input.lastErrorAt.getTime() < RECENT_ERROR_MS;
    return lagIsAmber || recentError ? "amber" : "green";
}

/** Produces a bounded credential-safe federation error for persistence. */
export function safeFederationErrorMessage(cause: unknown): string {
    const raw = toErrorMessage(cause).slice(0, MAX_ERROR_LENGTH * 4);
    const redacted = raw
        .replace(/https?:\/\/\S+/gi, "[url redacted]")
        .replace(
            /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;]+/gi,
            "Authorization: [redacted]",
        )
        .replace(/\bx-api-key\s*:\s*[^\s,;]+/gi, "x-api-key: [redacted]")
        .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
        .replace(
            /\b(api[_-]?key|access[_-]?token|client[_-]?secret|x-api-key|token|password|credential|secret)\b\s*[=:]\s*[^\s&,;]+/gi,
            "$1=[redacted]",
        )
        .replace(/\b([a-z][\w.-]{1,30})=([^\s&,;]{20,})/gi, "$1=[redacted]")
        .replace(/\b[0-9a-f]{64}\b/gi, "[credential redacted]")
        .replace(/[\r\n\t]+/g, " ")
        .trim();
    return (redacted || "Federation operation failed").slice(
        0,
        MAX_ERROR_LENGTH,
    );
}

/** Stores one bounded peer failure without persisting credential material. */
export async function recordFederationPeerError(
    peerId: string,
    cause: unknown,
): Promise<void> {
    await prisma.federationPeer.updateMany({
        where: { id: peerId },
        data: {
            lastError: safeFederationErrorMessage(cause),
            lastErrorAt: new Date(),
        },
    });
}

function warnIfPeerQueryCapped(
    peerCount: number,
    collector: CappedCollector,
): void {
    if (peerCount < MAX_HEALTH_PEERS || warnedCappedCollectors.has(collector)) {
        return;
    }
    warnedCappedCollectors.add(collector);
    log.warn("Federation peer query reached its collection cap", {
        collector,
        maxPeers: MAX_HEALTH_PEERS,
    });
}

function applyCountRows(
    catalogs: Map<string, FederationCatalogCounts>,
    type: FederationCatalogType,
    rows: readonly CountRow[],
): void {
    for (let index = 0; index < MAX_HEALTH_PEERS; index += 1) {
        const row = rows[index];
        if (!row) break;
        if (!row.peerId) continue;
        const catalog = catalogs.get(row.peerId);
        if (catalog) catalog[type] = row._count._all;
    }
}

async function loadCatalogCounts(
    peerIds: readonly string[],
): Promise<Map<string, FederationCatalogCounts>> {
    if (peerIds.length > MAX_HEALTH_PEERS) {
        throw new RangeError(
            "Federation catalog peer query exceeded its bound",
        );
    }
    const catalogs = new Map(
        peerIds.map((peerId) => [peerId, emptyCatalogCounts()]),
    );
    if (peerIds.length === 0) return catalogs;
    const where = { peerId: { in: [...peerIds] } };
    const [artists, albums, tracks, audiobooks, podcasts] = await Promise.all([
        prisma.artist.groupBy({
            by: ["peerId"],
            where,
            _count: { _all: true },
        }),
        prisma.album.groupBy({ by: ["peerId"], where, _count: { _all: true } }),
        prisma.track.groupBy({ by: ["peerId"], where, _count: { _all: true } }),
        prisma.audiobook.groupBy({
            by: ["peerId"],
            where,
            _count: { _all: true },
        }),
        prisma.federationPodcastListing.groupBy({
            by: ["peerId"],
            where,
            _count: { _all: true },
        }),
    ]);
    applyCountRows(catalogs, "artist", artists);
    applyCountRows(catalogs, "album", albums);
    applyCountRows(catalogs, "track", tracks);
    applyCountRows(catalogs, "audiobook", audiobooks);
    applyCountRows(catalogs, "podcast", podcasts);
    return catalogs;
}

function streamLeaseKey(peerId: string): string {
    return `${STREAM_LEASE_KEY_PREFIX}:${peerId}`;
}

async function loadLeaseBatch(
    peerIds: readonly string[],
    redis: LeaseCountRedis,
    nowMs: number,
): Promise<FederationLeaseMetricSnapshot[]> {
    if (peerIds.length > LEASE_QUERY_BATCH_SIZE) {
        throw new RangeError("Federation lease query batch exceeded its bound");
    }
    return Promise.all(
        peerIds.map(async (peerId) => ({
            peerId,
            activeLeases: await redis.zCount(
                streamLeaseKey(peerId),
                `(${nowMs}`,
                "+inf",
            ),
        })),
    );
}

async function loadLeaseCounts(
    peerIds: readonly string[],
    redis: LeaseCountRedis = redisClient,
    nowMs = Date.now(),
): Promise<FederationLeaseMetricSnapshot[]> {
    const snapshots: FederationLeaseMetricSnapshot[] = [];
    for (
        let offset = 0;
        offset < MAX_HEALTH_PEERS;
        offset += LEASE_QUERY_BATCH_SIZE
    ) {
        if (offset >= peerIds.length) break;
        const batch = peerIds.slice(offset, offset + LEASE_QUERY_BATCH_SIZE);
        snapshots.push(...(await loadLeaseBatch(batch, redis, nowMs)));
    }
    return snapshots;
}

async function listHealthPeerRows() {
    return prisma.federationPeer.findMany({
        orderBy: { id: "asc" },
        take: MAX_HEALTH_PEERS,
        select: {
            id: true,
            name: true,
            direction: true,
            inboundStatus: true,
            outboundStatus: true,
            lastSeenAt: true,
            lastSyncSuccessAt: true,
            lastSyncDurationMs: true,
            maxConcurrentStreams: true,
            lastError: true,
            lastErrorAt: true,
            lastErrorClass: true,
            lastEmbeddingOutcome: true,
        },
    });
}

function syncLagSeconds(lastSync: Date | null, nowMs: number): number | null {
    if (!lastSync) return null;
    return Math.max(0, Math.floor((nowMs - lastSync.getTime()) / 1_000));
}

function healthErrorClass(
    value: string | null,
): FederationHealthErrorClass | null {
    if (
        value === "unreachable" ||
        value === "tls" ||
        value === "unauthorized" ||
        value === "peer_invalid"
    ) {
        return value;
    }
    return null;
}

function embeddingOutcome(
    value: string | null,
): FederationPeerHealth["lastEmbeddingOutcome"] {
    return value === "active" || value === "skipped_mismatch" ? value : null;
}

/** Loads the bounded administrator federation-health read model. */
export async function listFederationPeerHealth(): Promise<
    FederationPeerHealth[]
> {
    const peers = await listHealthPeerRows();
    warnIfPeerQueryCapped(peers.length, "admin_health");
    const peerIds = peers.map(({ id }) => id);
    const [catalogs, leases] = await Promise.all([
        loadCatalogCounts(peerIds),
        loadLeaseCounts(peerIds),
    ]);
    const leaseByPeer = new Map(
        leases.map((row) => [row.peerId, row.activeLeases]),
    );
    const now = new Date();
    return peers.map((peer) => {
        const lag = syncLagSeconds(peer.lastSyncSuccessAt, now.getTime());
        return {
            ...peer,
            lastErrorClass: healthErrorClass(peer.lastErrorClass),
            lastEmbeddingOutcome: embeddingOutcome(peer.lastEmbeddingOutcome),
            syncLagSeconds: lag,
            catalog: catalogs.get(peer.id) ?? emptyCatalogCounts(),
            activeStreamLeases: leaseByPeer.get(peer.id) ?? 0,
            health: deriveFederationHealthState(
                { ...peer, syncLagSeconds: lag },
                config.workers.federationSyncIntervalMinutes,
                now,
            ),
        };
    });
}

/** Collects worker-owned peer freshness and catalog data at scrape time. */
export async function collectFederationWorkerMetricSnapshot(): Promise<
    FederationWorkerMetricSnapshot[]
> {
    const peers = await prisma.federationPeer.findMany({
        where: {
            direction: { in: ["CONSUMER", "BOTH"] },
            outboundStatus: { not: "REVOKED" },
        },
        orderBy: { id: "asc" },
        take: MAX_HEALTH_PEERS,
        select: { id: true, lastSyncSuccessAt: true },
    });
    warnIfPeerQueryCapped(peers.length, "worker_metrics");
    const catalogs = await loadCatalogCounts(peers.map(({ id }) => id));
    return peers.map((peer) => ({
        peerId: peer.id,
        lastSyncSuccessAt: peer.lastSyncSuccessAt,
        catalog: catalogs.get(peer.id) ?? emptyCatalogCounts(),
    }));
}

/** Collects API-owned active stream lease counts at scrape time. */
export async function collectFederationLeaseMetricSnapshot(): Promise<
    FederationLeaseMetricSnapshot[]
> {
    const peers = await prisma.federationPeer.findMany({
        where: {
            direction: { in: ["HOST", "BOTH"] },
            inboundStatus: { not: "REVOKED" },
        },
        orderBy: { id: "asc" },
        take: MAX_HEALTH_PEERS,
        select: { id: true },
    });
    warnIfPeerQueryCapped(peers.length, "lease_metrics");
    return loadLeaseCounts(peers.map(({ id }) => id));
}
import { toErrorMessage } from "../utils/errors";

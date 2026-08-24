import { collectDefaultMetrics, Registry } from "prom-client";
import {
    createDomainMetrics,
    type FederationSyncSkipReason,
} from "./domainMetrics";
import { createHttpRequestMetrics } from "./httpMetrics";
import {
    createFederationMetrics,
    type FederationAuthFailureReason,
    type FederationCacheResult,
    type FederationMetrics,
    type FederationMetricsRole,
    type FederationPresenceFetchOutcome,
    type FederationPlaylistCopyOutcome,
    type FederationPlaylistFetchOutcome,
    type FederationPlaylistFollowOutcome,
    type FederationQuotaKind,
    type FederationStreamOutcome,
    type FederationSyncOutcome,
} from "./federationMetrics";
import {
    createLoudnessMetrics,
    LOUDNESS_BACKFILL_OUTCOMES,
    loudnessBackfillOutcomeKey,
    parseLoudnessOutcomeCount,
} from "./loudnessMetrics";
import {
    createLibraryHealthMetrics,
    type LibraryHealthCachePanel,
    type LibraryHealthCacheResult,
} from "./libraryHealthMetrics";
import {
    createProviderMetrics,
    type VibeProviderEndpoint,
    type VibeProviderOutcome,
} from "./providerMetrics";
import {
    createProviderTrackGcMetrics,
    type ProviderTrackGcBacklogMetrics,
    type ProviderTrackGcOutcome,
    type ProviderTrackGcProvider,
} from "./providerTrackGcMetrics";
import type {
    FederationEmbeddingExportOutcome,
    FederationEmbeddingPageOutcome,
} from "../services/federationEmbeddingSpace";
import {
    createVibeEmbedMetrics,
    type VibeEmbedJobOutcome,
    type VibeEmbeddingCoverage,
    type VibeProviderConfigErrorReason,
    type VibeSpaceTransition,
    type VibeVocabularySpaceMismatchReason,
} from "./vibeEmbedMetrics";
import { VIBE_PROVIDER_QUEUE_KEY } from "../workers/legacyVibeRedisCleanup";
import { prisma } from "../utils/db";
import {
    createRequestMetrics,
    type MusicRequestAction,
} from "./requestMetrics";
import {
    createAlbumDownloadMetrics,
    type AlbumDownloadOutcome,
} from "./albumDownloadMetrics";

export type {
    FederationAuthFailureReason,
    FederationCacheResult,
    FederationQuotaKind,
    FederationStreamOutcome,
    FederationSyncOutcome,
    FederationPresenceFetchOutcome,
    FederationPlaylistCopyOutcome,
    FederationPlaylistFetchOutcome,
    FederationPlaylistFollowOutcome,
} from "./federationMetrics";

/** Single process-local Prometheus registry. */
export const metricsRegistry = new Registry();

collectDefaultMetrics({
    prefix: "soundspan_",
    register: metricsRegistry,
});

const httpMetrics = createHttpRequestMetrics(metricsRegistry);
const domainMetrics = createDomainMetrics(metricsRegistry);
const libraryHealthMetrics = createLibraryHealthMetrics(metricsRegistry);
const providerMetrics = createProviderMetrics(metricsRegistry);
const providerTrackGcMetrics = createProviderTrackGcMetrics(metricsRegistry);
const requestMetrics = createRequestMetrics(metricsRegistry);
const albumDownloadMetrics = createAlbumDownloadMetrics(metricsRegistry);
createLoudnessMetrics(metricsRegistry, prisma, {
    getBackfillOutcomes: async () => {
        const { redisClient } = await import("../utils/redis");
        const values = await redisClient.mGet(
            LOUDNESS_BACKFILL_OUTCOMES.map(loudnessBackfillOutcomeKey),
        );
        return {
            measured_success: parseLoudnessOutcomeCount(values[0] ?? null),
            transient_failure: parseLoudnessOutcomeCount(values[1] ?? null),
            permanently_skipped: parseLoudnessOutcomeCount(values[2] ?? null),
        };
    },
});
const vibeEmbedMetrics = createVibeEmbedMetrics(metricsRegistry, {
    // Resolved at scrape time: importing the client eagerly would pull the
    // validated runtime config into every module that imports metrics.
    getProviderQueueDepth: async () => {
        const { redisClient } = await import("../utils/redis");
        return redisClient.lLen(VIBE_PROVIDER_QUEUE_KEY);
    },
    getProviderStatusFresh: async () => {
        const [{ redisClient }, { readVibeWorkerStatus }] = await Promise.all([
            import("../utils/redis"),
            import("../workers/vibeWorkerStatus"),
        ]);
        return (await readVibeWorkerStatus(redisClient)) !== null;
    },
});
let federationMetrics: FederationMetrics | null = null;

/** Registers federation instruments once for the process role that owns them. */
export function initializeFederationMetrics(role: FederationMetricsRole): void {
    if (federationMetrics) {
        throw new Error("Federation metrics are already initialized");
    }
    federationMetrics = createFederationMetrics(metricsRegistry, { role });
}

// Telemetry must never break request handling: in process roles (or tests)
// that never initialize the federation family, recording is a no-op.
function activeFederationMetrics(): FederationMetrics | null {
    return federationMetrics;
}

/** Express middleware recording bounded HTTP request duration labels. */
export const httpMetricsMiddleware = httpMetrics.middleware;

/** Records one browse-image cache lookup. */
export function recordBrowseImageCacheResult(result: "hit" | "miss"): void {
    domainMetrics.browseImageCacheRequests.inc({ result });
}

/** Records one bounded music request state or rejection action. */
export function recordMusicRequestAction(action: MusicRequestAction): void {
    requestMetrics.requests.inc({ action });
}

/** Records one bounded album download queue outcome. */
export function recordAlbumDownloadOutcome(
    outcome: AlbumDownloadOutcome,
): void {
    albumDownloadMetrics.downloads.inc({ outcome });
}

/** Records one Library Health panel cache outcome. */
export function recordLibraryHealthCacheResult(
    panel: LibraryHealthCachePanel,
    result: LibraryHealthCacheResult,
): void {
    libraryHealthMetrics.cacheResults.inc({ panel, result });
}

/** Records one final federation sync outcome. */
export function recordFederationSyncOutcome(
    outcome: "success" | "failure",
): void {
    domainMetrics.federationSyncs.inc({ outcome });
}

/** Records one completed peer sync duration in the worker registry. */
export function recordFederationPeerSync(
    peerId: string,
    outcome: FederationSyncOutcome,
    durationSeconds: number,
): void {
    activeFederationMetrics()?.recordPeerSync(peerId, outcome, durationSeconds);
}

/** Records one completed consumer-side federation stream proxy request. */
export function recordFederationStreamProxy(
    peerId: string,
    outcome: FederationStreamOutcome,
    durationSeconds: number,
): void {
    activeFederationMetrics()?.recordStreamProxy(
        peerId,
        outcome,
        durationSeconds,
    );
}

/** Records one consumer-side federation stream cache lookup. */
export function recordFederationStreamProxyCache(
    peerId: string,
    result: FederationCacheResult,
): void {
    activeFederationMetrics()?.recordStreamProxyCache(peerId, result);
}

/** Records one completed host-side federation stream request. */
export function recordFederationHostStream(
    peerId: string,
    outcome: FederationStreamOutcome,
): void {
    activeFederationMetrics()?.recordHostStream(peerId, outcome);
}

/** Records one bounded federation authentication or scope failure. */
export function recordFederationAuthFailure(
    peerId: string,
    reason: FederationAuthFailureReason,
): void {
    activeFederationMetrics()?.recordAuthFailure(peerId, reason);
}

/** Records one host-side federation stream quota rejection. */
export function recordFederationQuotaRejection(
    peerId: string,
    kind: FederationQuotaKind,
): void {
    activeFederationMetrics()?.recordQuotaRejection(peerId, kind);
}

/** Records one best-effort consumer presence fetch outcome. */
export function recordFederationPresenceFetch(
    peerId: string,
    outcome: FederationPresenceFetchOutcome,
): void {
    activeFederationMetrics()?.recordPresenceFetch(peerId, outcome);
}

/** Adds the privacy-filtered users served to one authenticated peer. */
export function recordFederationPresenceUsersExported(
    peerId: string,
    count: number,
): void {
    activeFederationMetrics()?.recordPresenceUsersExported(peerId, count);
}

/** Records one final on-demand peer playlist fetch outcome. */
export function recordFederationPlaylistFetch(
    peerId: string,
    outcome: FederationPlaylistFetchOutcome,
): void {
    activeFederationMetrics()?.recordPlaylistFetch(peerId, outcome);
}

/** Records one local peer-playlist follow state change. */
export function recordFederationPlaylistFollow(
    peerId: string,
    outcome: FederationPlaylistFollowOutcome,
): void {
    activeFederationMetrics()?.recordPlaylistFollow(peerId, outcome);
}

/** Records one final peer-playlist copy outcome. */
export function recordFederationPlaylistCopy(
    peerId: string,
    outcome: FederationPlaylistCopyOutcome,
): void {
    activeFederationMetrics()?.recordPlaylistCopy(peerId, outcome);
}

/** Records bounded federation data discarded during compatibility parsing. */
export function recordFederationSyncSkip(
    reason: FederationSyncSkipReason,
    count = 1,
): void {
    domainMetrics.federationSyncSkips.inc({ reason }, count);
}

/** Records one final vibe-provider request outcome and duration. */
export function recordVibeProviderRequest(
    endpoint: VibeProviderEndpoint,
    outcome: VibeProviderOutcome,
    durationSeconds: number,
): void {
    providerMetrics.record(endpoint, outcome, durationSeconds);
}

/** Records one completed provider-track garbage collection pass. */
export function recordProviderTrackGcPass(
    outcome: ProviderTrackGcOutcome,
    durationSeconds: number,
    deleted: Readonly<Record<ProviderTrackGcProvider, number>>,
    health?: ProviderTrackGcBacklogMetrics,
): void {
    providerTrackGcMetrics.record(outcome, durationSeconds, deleted, health);
}

/** Records one final backend-driven audio embedding job outcome. */
export function recordVibeEmbedJobOutcome(outcome: VibeEmbedJobOutcome): void {
    vibeEmbedMetrics.recordJob(outcome);
}

/** Records one embedding-space lifecycle transition. */
export function recordVibeSpaceTransition(
    transition: VibeSpaceTransition,
): void {
    vibeEmbedMetrics.recordSpaceTransition(transition);
}

/** Records one rejected provider configuration. */
export function recordVibeProviderConfigError(
    reason: VibeProviderConfigErrorReason,
): void {
    vibeEmbedMetrics.recordProviderConfigError(reason);
}

/** Records one skipped vocabulary blend due to space incompatibility. */
export function recordVibeVocabularySpaceMismatch(
    reason: VibeVocabularySpaceMismatchReason,
): void {
    vibeEmbedMetrics.recordVocabularySpaceMismatch(reason);
}

/** Replaces the worker target-space audio embedding coverage gauge values. */
export function setVibeEmbeddingCoverage(
    coverage: VibeEmbeddingCoverage,
): void {
    vibeEmbedMetrics.setCoverage(coverage);
}

/** Publishes the configured vibe provider queue admission capacity. */
export function setVibeProviderQueueCapacity(capacity: number): void {
    vibeEmbedMetrics.setProviderQueueCapacity(capacity);
}

/** Marks whether the worker currently owns a migrating target space. */
export function setVibeMigrationActive(active: boolean): void {
    vibeEmbedMetrics.setMigrationActive(active);
}

/** Records one completed federation page carrying peer embeddings. */
export function recordFederationEmbeddingPageOutcome(
    outcome: FederationEmbeddingPageOutcome,
): void {
    domainMetrics.federationEmbeddingPages.inc({ outcome });
}

/** Records one exporter-side embedding compatibility decision. */
export function recordFederationEmbeddingExportOutcome(
    outcome: FederationEmbeddingExportOutcome,
): void {
    domainMetrics.federationEmbeddingExports.inc({ outcome });
}

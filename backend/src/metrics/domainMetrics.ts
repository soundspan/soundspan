import { Counter, type Registry } from "prom-client";

/** Closed reason vocabulary for federation items not ingested as received. */
export type FederationSyncSkipReason = "unknown_key_stripped";

/** Domain counters owned by a process-local Prometheus registry. */
export interface DomainMetrics {
    browseImageCacheRequests: Counter<"result">;
    transcodeCacheRequests: Counter<"result">;
    federationSyncs: Counter<"outcome">;
    federationSyncSkips: Counter<"reason">;
    federationEmbeddingPages: Counter<"outcome">;
    federationEmbeddingExports: Counter<"outcome">;
}

/** Registers low-cardinality cache and federation counters. */
export function createDomainMetrics(registry: Registry): DomainMetrics {
    return {
        browseImageCacheRequests: new Counter({
            name: "soundspan_browse_image_cache_requests_total",
            help: "Browse image cache lookups by result.",
            labelNames: ["result"] as const,
            registers: [registry],
        }),
        transcodeCacheRequests: new Counter({
            name: "soundspan_transcode_cache_requests_total",
            help: "Segmented transcode cache lookups by result.",
            labelNames: ["result"] as const,
            registers: [registry],
        }),
        federationSyncs: new Counter({
            name: "soundspan_federation_syncs_total",
            help: "Federation peer sync processor runs by outcome.",
            labelNames: ["outcome"] as const,
            registers: [registry],
        }),
        federationSyncSkips: new Counter({
            name: "soundspan_federation_sync_skips_total",
            help: "Federation sync fields or items not ingested as received.",
            labelNames: ["reason"] as const,
            registers: [registry],
        }),
        federationEmbeddingPages: new Counter({
            name: "soundspan_federation_embedding_pages_total",
            help: "Federation embedding pages by storage decision.",
            labelNames: ["outcome"] as const,
            registers: [registry],
        }),
        federationEmbeddingExports: new Counter({
            name: "soundspan_federation_embedding_exports_total",
            help: "Federation embedding export requests by compatibility decision.",
            labelNames: ["outcome"] as const,
            registers: [registry],
        }),
    };
}

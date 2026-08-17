import { Counter, type Registry } from "prom-client";

/** Domain counters owned by a process-local Prometheus registry. */
export interface DomainMetrics {
    browseImageCacheRequests: Counter<"result">;
    transcodeCacheRequests: Counter<"result">;
    federationSyncs: Counter<"outcome">;
    federationEmbeddingPages: Counter<"outcome">;
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
        federationEmbeddingPages: new Counter({
            name: "soundspan_federation_embedding_pages_total",
            help: "Federation embedding pages by storage decision.",
            labelNames: ["outcome"] as const,
            registers: [registry],
        }),
    };
}

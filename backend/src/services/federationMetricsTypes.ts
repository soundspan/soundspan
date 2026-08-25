/** Bounded catalog counts collected for one federation peer. */
export type FederationCatalogCounts = Record<
    "artist" | "album" | "track" | "audiobook" | "podcast",
    number
>;

/** Worker-side scrape snapshot for per-peer sync and catalog gauges. */
export interface FederationWorkerMetricSnapshot {
    peerId: string;
    lastSyncSuccessAt: Date | null;
    catalog: FederationCatalogCounts;
}

/** API-side scrape snapshot for active per-peer stream leases. */
export interface FederationLeaseMetricSnapshot {
    peerId: string;
    activeLeases: number;
}

/** Bounded outcomes for one federation page carrying peer vectors. */
export type FederationEmbeddingPageOutcome =
    | "stored"
    | "skipped_mismatch"
    | "skipped_legacy_strict";

/** Bounded outcomes for exporter-side embedding compatibility guards. */
export type FederationEmbeddingExportOutcome = "suppressed_legacy_peer";

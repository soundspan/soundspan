import { Counter, Gauge, type Registry } from "prom-client";

/** Closed catalog write vocabulary. */
export const CATALOG_WRITE_KINDS = ["release_group", "tracklist"] as const;

/** Catalog write-through operation kind. */
export type CatalogWriteKind = (typeof CATALOG_WRITE_KINDS)[number];

/** Registers metadata catalog persistence metrics. */
export function createCatalogMetrics(registry: Registry) {
    return {
        albums: new Gauge({
            name: "soundspan_catalog_albums",
            help: "Current number of persisted CATALOG albums.",
            registers: [registry],
        }),
        writes: new Counter({
            name: "soundspan_catalog_writes_total",
            help: "Successful metadata catalog write-through operations by kind.",
            labelNames: ["kind"] as const,
            registers: [registry],
        }),
        reaped: new Counter({
            name: "soundspan_catalog_reaped_total",
            help: "CATALOG albums removed by retention sweeps.",
            registers: [registry],
        }),
    };
}

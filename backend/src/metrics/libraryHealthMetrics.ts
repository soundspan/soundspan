import { Counter, type Registry } from "prom-client";

/** Closed Library Health cache panel vocabulary. */
export type LibraryHealthCachePanel =
    | "summary"
    | "storage"
    | "quality"
    | "duplicates";
/** Closed Library Health cache result vocabulary. */
export type LibraryHealthCacheResult = "hit" | "miss" | "error";

/** Metrics registered for Library Health dashboard reads. */
export interface LibraryHealthMetrics {
    cacheResults: Counter<"panel" | "result">;
}

/** Registers the bounded Library Health cache result counter. */
export function createLibraryHealthMetrics(
    registry: Registry,
): LibraryHealthMetrics {
    return {
        cacheResults: new Counter({
            name: "soundspan_library_health_cache_total",
            help: "Library Health dashboard cache operations by panel and result.",
            labelNames: ["panel", "result"] as const,
            registers: [registry],
        }),
    };
}

import { Counter, type Registry } from "prom-client";

/** Provider labels allowed on remote-library metrics. */
export type RemoteLibraryMetricProvider = "tidal" | "youtube";

/** Instruments registered for bounded remote-library loading. */
export interface RemoteLibraryMetrics {
    rowsCapped: Counter<"provider">;
}

/** Registers the remote-library row-cap counter. */
export function createRemoteLibraryMetrics(
    registry: Registry,
): RemoteLibraryMetrics {
    return {
        rowsCapped: new Counter({
            name: "soundspan_library_remote_rows_capped_total",
            help: "Remote library provider loads that reached the row cap.",
            labelNames: ["provider"] as const,
            registers: [registry],
        }),
    };
}

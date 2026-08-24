import { Counter, type Registry } from "prom-client";

/** Closed result vocabulary for queued album download attempts. */
export const ALBUM_DOWNLOAD_OUTCOMES = [
    "completed",
    "failed",
    "retried",
] as const;

/** Final or retry outcome for one album download queue attempt. */
export type AlbumDownloadOutcome = (typeof ALBUM_DOWNLOAD_OUTCOMES)[number];

/** Create album download queue metrics in the provided registry. */
export function createAlbumDownloadMetrics(registry: Registry) {
    return {
        downloads: new Counter({
            name: "soundspan_album_downloads_total",
            help: "Album download queue attempts by outcome",
            labelNames: ["outcome"] as const,
            registers: [registry],
        }),
    };
}

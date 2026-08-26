import { Counter, Histogram, type Registry } from "prom-client";

/** Closed outcomes for Soulseek album folder selection. */
export type SoulseekAlbumFolderOutcome =
    | "folder_selected"
    | "per_track_fallback";

/** Metrics for bounded Soulseek album folder decisions. */
export interface SoulseekAlbumMetrics {
    record(outcome: SoulseekAlbumFolderOutcome, coherenceScore: number): void;
}

/** Register Soulseek album folder selection metrics in one registry. */
export function createSoulseekAlbumMetrics(
    registry: Registry,
): SoulseekAlbumMetrics {
    const decisions = new Counter({
        name: "soundspan_soulseek_album_folder_decisions_total",
        help: "Soulseek album folder selection decisions by bounded outcome.",
        labelNames: ["outcome"] as const,
        registers: [registry],
    });
    const coherence = new Histogram({
        name: "soundspan_soulseek_album_coherence_score",
        help: "Best selected Soulseek album folder coherence score from zero to one.",
        buckets: [0.25, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1],
        registers: [registry],
    });
    return {
        record(outcome, coherenceScore): void {
            decisions.inc({ outcome });
            coherence.observe(Math.max(0, Math.min(coherenceScore, 1)));
        },
    };
}

import { enrichmentStateService } from "../services/enrichmentState";

/**
 * Point the live enrichment phase at the outstanding background stage after
 * a cycle ends. The cycle's last phase is podcasts, so without this repoint
 * an incomplete library stays pinned on "Processing podcasts" while only
 * background audio or vibe analysis is actually outstanding.
 */
export async function repointBackgroundPhase(progress: {
    audioAnalysis: { pending: number; processing: number };
}): Promise<void> {
    const audioOutstanding =
        progress.audioAnalysis.pending + progress.audioAnalysis.processing > 0;
    await enrichmentStateService.updateState({
        status: "running",
        currentPhase: audioOutstanding ? "audio" : "vibe",
    });
}

import { type ApiClientConstructor, type ApiData } from "./core";

/** Add enrichment-domain operations to an API client base class. */
export function WithEnrichment<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class EnrichmentApi extends Base {
        // Enrichment
        async getEnrichmentSettings() {
            return this.request<ApiData>("/enrichment/settings");
        }

        async updateEnrichmentSettings(settings: ApiData) {
            return this.request<ApiData>("/enrichment/settings", {
                method: "PUT",
                body: JSON.stringify(settings),
            });
        }

        async startLibraryEnrichment() {
            return this.request<{ success: boolean; message: string }>(
                "/enrichment/start",
                {
                    method: "POST",
                },
            );
        }

        async syncLibraryEnrichment() {
            return this.request<{
                message: string;
                description: string;
                result: {
                    artists: number;
                    tracks: number;
                    audioQueued: number;
                };
            }>("/enrichment/sync", {
                method: "POST",
            });
        }

        async getEnrichmentProgress() {
            return this.request<{
                artists: {
                    total: number;
                    completed: number;
                    pending: number;
                    failed: number;
                    progress: number;
                };
                trackTags: {
                    total: number;
                    enriched: number;
                    pending: number;
                    progress: number;
                };
                audioAnalysis: {
                    total: number;
                    completed: number;
                    pending: number;
                    processing: number;
                    failed: number;
                    progress: number;
                    isBackground: boolean;
                };
                clapEmbeddings: {
                    total: number;
                    completed: number;
                    pending: number;
                    processing: number;
                    failed: number;
                    progress: number;
                    isBackground: boolean;
                };
                coreComplete: boolean;
                isFullyComplete: boolean;
            }>("/enrichment/progress");
        }

        async triggerFullEnrichment(options?: {
            forceVibeRebuild?: boolean;
            forceMoodBucketBackfill?: boolean;
        }) {
            return this.request<{
                message: string;
                description: string;
                forceVibeRebuild?: boolean;
                forceMoodBucketBackfill?: boolean;
            }>("/enrichment/full", {
                method: "POST",
                body: JSON.stringify({
                    forceVibeRebuild: options?.forceVibeRebuild === true,
                    forceMoodBucketBackfill:
                        options?.forceMoodBucketBackfill === true,
                }),
            });
        }

        async resetArtistsOnly() {
            return this.request<{
                message: string;
                description: string;
                count: number;
            }>("/enrichment/reset-artists", { method: "POST" });
        }

        async resetMoodTagsOnly() {
            return this.request<{
                message: string;
                description: string;
                count: number;
            }>("/enrichment/reset-mood-tags", { method: "POST" });
        }

        async resetAudioAnalysisOnly() {
            return this.request<{
                message: string;
                description: string;
                count: number;
            }>("/enrichment/reset-audio-analysis", { method: "POST" });
        }

        async retryFailedAnalysis() {
            return this.request<{ message: string; reset: number }>(
                "/analysis/retry-failed",
                {
                    method: "POST",
                },
            );
        }
    }
    return EnrichmentApi;
}

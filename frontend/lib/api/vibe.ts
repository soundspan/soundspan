import { hasApiErrorStatus, type ApiClientConstructor } from "./core";

/** Map Vibe API failures to concise operator or retry guidance. */
export function vibeErrorMessage(error: unknown, fallback: string): string {
    if (hasApiErrorStatus(error, 503)) {
        return "Vibe matching is unavailable. Enable or check the DCLAP vibe provider, then try again.";
    }
    if (hasApiErrorStatus(error, 504)) {
        return "Vibe matching timed out. Try again in a moment.";
    }
    return error instanceof Error ? error.message : fallback;
}

/** Add Vibe-domain operations to an API client base class. */
export function WithVibe<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class VibeApi extends Base {
        // Vibe (CLAP Similarity) API
        async getVibeSimilarTracks(trackId: string, limit = 20) {
            return this.request<{
                sourceTrackId: string;
                sourceFeatures: {
                    energy: number | null;
                    valence: number | null;
                    danceability: number | null;
                    arousal: number | null;
                } | null;
                tracks: Array<{
                    id: string;
                    title: string;
                    duration: number;
                    trackNo: number;
                    distance: number;
                    album: {
                        id: string;
                        title: string;
                        coverUrl: string | null;
                    };
                    artist: {
                        id: string;
                        name: string;
                    };
                    audioFeatures: {
                        energy: number | null;
                        valence: number | null;
                        danceability: number | null;
                        arousal: number | null;
                    };
                }>;
            }>(`/vibe/similar/${trackId}?limit=${limit}`);
        }

        async vibeSearch(query: string, limit = 20) {
            return this.request<{
                query: string;
                tracks: Array<{
                    id: string;
                    title: string;
                    duration: number;
                    trackNo: number;
                    distance: number;
                    similarity: number;
                    album: {
                        id: string;
                        title: string;
                        coverUrl: string | null;
                    };
                    artist: {
                        id: string;
                        name: string;
                    };
                }>;
                minSimilarity: number;
                totalAboveThreshold: number;
                debug?: {
                    matchedTerms: string[];
                    genreConfidence: number;
                    featureWeight: number;
                };
            }>("/vibe/search", {
                method: "POST",
                body: JSON.stringify({ query, limit }),
            });
        }

        async getVibeStatus() {
            return this.request<{
                totalTracks: number;
                embeddedTracks: number;
                progress: number;
                isComplete: boolean;
            }>("/vibe/status");
        }

        async getVibeMap() {
            return this.request<{
                tracks: Array<{
                    id: string;
                    x: number;
                    y: number;
                    title: string;
                    artist: string;
                    artistId: string;
                    albumId: string;
                    coverUrl: string | null;
                    dominantMood: string;
                    moodScore: number;
                    moods: Record<string, number>;
                    energy: number | null;
                    valence: number | null;
                }>;
                trackCount: number;
                computedAt: string;
            }>("/vibe/map");
        }

        async getVibePath(fromId: string, toId: string, steps = 5) {
            return this.request<{
                from: string;
                to: string;
                steps: Array<{
                    id: string;
                    title: string;
                    distance: number;
                    similarity: number;
                    album: {
                        id: string;
                        title: string;
                        coverUrl: string | null;
                    };
                    artist: { id: string; name: string };
                }>;
            }>(`/vibe/path?from=${fromId}&to=${toId}&steps=${steps}`);
        }

        async vibeAlchemy(trackIds: string[], weights?: number[], limit = 20) {
            return this.request<{
                ingredients: string[];
                weights: number[];
                tracks: Array<{
                    id: string;
                    title: string;
                    distance: number;
                    similarity: number;
                    album: {
                        id: string;
                        title: string;
                        coverUrl: string | null;
                    };
                    artist: { id: string; name: string };
                }>;
            }>("/vibe/alchemy", {
                method: "POST",
                body: JSON.stringify({ trackIds, weights, limit }),
            });
        }

        async getVibeJourney(params: {
            fromTrackId: string;
            toTrackId?: string;
            mood?: string;
            steps?: number;
            excludeTrackIds?: string[];
        }) {
            return this.request<{
                mode: "track" | "mood";
                target:
                    | { trackId: string; title: string }
                    | { mood: string; label: string };
                waypoints: Array<{
                    id: string;
                    title: string;
                    distance: number;
                    similarity: number;
                    album: {
                        id: string;
                        title: string;
                        coverUrl: string | null;
                    };
                    artist: { id: string; name: string };
                }>;
            }>("/vibe/journey", {
                method: "POST",
                body: JSON.stringify(params),
            });
        }

        async getVibeMoods() {
            return this.request<
                Array<{
                    mood: string;
                    trackCount: number;
                }>
            >("/vibe/moods");
        }

        /**
         * Library-calibrated pairwise-distance quantiles (p0..p100, 101 values,
         * ascending) for scoring match percentages as "closer than N% of random
         * pairs in your library" instead of the fixed `1 - distance/2` mapping.
         * `sampleSize: 0` / `quantiles: []` on a library with fewer than 10
         * embedded tracks — callers fall back to the old linear mapping.
         */
        async getVibeCalibration() {
            return this.request<{
                sampleSize: number;
                updatedAt?: string;
                quantiles: number[];
            }>("/vibe/calibration");
        }
    }
    return VibeApi;
}

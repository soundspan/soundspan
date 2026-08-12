import type {
    CreateSegmentedStreamingSessionInput,
    PlaybackClientMetricInput,
    SegmentedStreamingHandoffResponse,
    SegmentedStreamingHeartbeatResponse,
    SegmentedStreamingSessionResponse,
    SegmentedStreamingSnapshotInput,
} from "../api";
import type { ApiClientConstructor } from "./core";

const SEGMENTED_SESSION_TOKEN_QUERY_PARAM = "st";

/** Add media-domain operations to an API client base class. */
export function WithMedia<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class MediaApi extends Base {
        // Streaming
        getStreamUrl(trackId: string): string {
            const baseUrl = `${this.getBaseUrl()}/api/library/tracks/${trackId}/stream`;
            // For audio element requests, cookies may not be sent cross-origin in development
            // Add token as query param for authentication (supported by requireAuthOrToken)
            const token = this.getCurrentToken();
            if (token) {
                return `${baseUrl}?token=${encodeURIComponent(token)}`;
            }
            return baseUrl;
        }

        async createSegmentedStreamingSession(
            input: CreateSegmentedStreamingSessionInput,
        ): Promise<SegmentedStreamingSessionResponse> {
            const headers: Record<string, string> = {};
            if (
                typeof input.startupLoadId === "number" &&
                Number.isFinite(input.startupLoadId)
            ) {
                headers["x-segmented-startup-load-id"] = String(
                    input.startupLoadId,
                );
            }
            if (
                typeof input.startupCorrelationId === "string" &&
                input.startupCorrelationId.trim().length > 0
            ) {
                headers["x-segmented-startup-correlation-id"] =
                    input.startupCorrelationId.trim();
            }
            const session =
                await this.request<SegmentedStreamingSessionResponse>(
                    "/streaming/v1/sessions",
                    {
                        method: "POST",
                        body: JSON.stringify({
                            trackId: input.trackId,
                            sourceType: input.sourceType,
                            desiredQuality: input.desiredQuality,
                            manifestProfile: input.manifestProfile,
                        }),
                        headers,
                    },
                );

            return {
                ...session,
                manifestUrl: this.toAbsoluteApiUrl(session.manifestUrl),
            };
        }

        getStreamingAuthToken(): string | null {
            return this.getCurrentToken();
        }

        /** Fetch a segmented-session manifest without altering its raw response. */
        async fetchSegmentedStreamingManifest(
            manifestUrl: string,
            sessionToken: string,
            signal: AbortSignal,
        ): Promise<Response> {
            return this.fetchSegmentedStreamingAsset(
                manifestUrl,
                sessionToken,
                signal,
            );
        }

        /** Fetch one segmented-session media asset without consuming its body. */
        async fetchSegmentedStreamingSegment(
            sessionId: string,
            sessionToken: string,
            segmentName: string,
            signal: AbortSignal,
        ): Promise<Response> {
            const segmentUrl =
                `/api/streaming/v1/sessions/${sessionId}/segments/${encodeURIComponent(segmentName)}?` +
                `${SEGMENTED_SESSION_TOKEN_QUERY_PARAM}=${encodeURIComponent(sessionToken)}`;
            return this.fetchSegmentedStreamingAsset(
                segmentUrl,
                sessionToken,
                signal,
            );
        }

        private async fetchSegmentedStreamingAsset(
            url: string,
            sessionToken: string,
            signal: AbortSignal,
        ): Promise<Response> {
            const headers: Record<string, string> = {
                "x-streaming-session-token": sessionToken,
            };
            const authToken = this.getStreamingAuthToken();
            if (authToken) {
                headers.Authorization = `Bearer ${authToken}`;
            }
            return fetch(url, {
                method: "GET",
                credentials: "include",
                headers,
                signal,
            });
        }

        async heartbeatSegmentedStreamingSession(
            sessionId: string,
            sessionToken: string,
            snapshot: SegmentedStreamingSnapshotInput,
        ): Promise<SegmentedStreamingHeartbeatResponse> {
            return this.request<SegmentedStreamingHeartbeatResponse>(
                `/streaming/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
                {
                    method: "POST",
                    body: JSON.stringify(snapshot),
                    headers: {
                        "x-streaming-session-token": sessionToken,
                    },
                },
            );
        }

        async handoffSegmentedStreamingSession(
            sessionId: string,
            sessionToken: string,
            snapshot: SegmentedStreamingSnapshotInput,
        ): Promise<SegmentedStreamingHandoffResponse> {
            const handoff =
                await this.request<SegmentedStreamingHandoffResponse>(
                    `/streaming/v1/sessions/${encodeURIComponent(sessionId)}/handoff`,
                    {
                        method: "POST",
                        body: JSON.stringify(snapshot),
                        headers: {
                            "x-streaming-session-token": sessionToken,
                        },
                    },
                );

            return {
                ...handoff,
                manifestUrl: this.toAbsoluteApiUrl(handoff.manifestUrl),
            };
        }

        async reportPlaybackClientMetric(
            input: PlaybackClientMetricInput,
        ): Promise<void> {
            await this.request<void>("/streaming/v1/client-metrics", {
                method: "POST",
                body: JSON.stringify(input),
            });
        }

        /**
         * Get the URL for cover art.
         * @param coverId - The cover ID, URL, or path
         * @param size - Optional size in pixels
         * @param includeToken - Include auth token in URL (needed for canvas color extraction)
         */
        getCoverArtUrl(
            coverId: string,
            size?: number,
            includeToken = true,
        ): string {
            const baseUrl = this.getBaseUrl();
            const token = includeToken ? this.getCurrentToken() : null;

            // Check if this is an audiobook cover path (served by audiobooks endpoint, not proxied)
            if (coverId && coverId.startsWith("/audiobooks/")) {
                const url = `${baseUrl}/api${coverId}`;
                if (token) {
                    return `${url}?token=${encodeURIComponent(token)}`;
                }
                return url;
            }

            // Check if this is a podcast cover path (served by podcasts endpoint, not proxied)
            if (coverId && coverId.startsWith("/podcasts/")) {
                const url = `${baseUrl}/api${coverId}`;
                if (token) {
                    return `${url}?token=${encodeURIComponent(token)}`;
                }
                return url;
            }

            // Check if coverId is an external URL (needs to be proxied)
            // Also handle native: paths which need URL encoding
            if (
                coverId &&
                (coverId.startsWith("http://") ||
                    coverId.startsWith("https://") ||
                    coverId.startsWith("native:"))
            ) {
                // Pass as query parameter to avoid URL encoding issues
                const params = new URLSearchParams({ url: coverId });
                if (size) params.append("size", size.toString());
                if (token) params.append("token", token);
                return `${baseUrl}/api/library/cover-art?${params.toString()}`;
            }

            // Otherwise use as path parameter (cover ID - typically a hash)
            const params = new URLSearchParams();
            if (size) params.append("size", size.toString());
            if (token) params.append("token", token);
            const queryString = params.toString();
            return `${baseUrl}/api/library/cover-art/${encodeURIComponent(coverId)}${
                queryString ? "?" + queryString : ""
            }`;
        }

        /**
         * Get the proxied URL for a YouTube Music browse thumbnail.
         * @param externalUrl - The original external thumbnail URL
         */
        getBrowseImageUrl(externalUrl: string): string {
            const baseUrl = this.getBaseUrl();
            const token = this.getCurrentToken();
            const params = new URLSearchParams({ url: externalUrl });
            if (token) params.append("token", token);
            return `${baseUrl}/api/browse/ytmusic/image?${params.toString()}`;
        }

        async getTrackPreview(artistName: string, trackTitle: string) {
            return this.request<{ videoId: string }>(
                `/artists/preview/${encodeURIComponent(
                    artistName,
                )}/${encodeURIComponent(trackTitle)}`,
            );
        }

        getPreviewStreamUrl(videoId: string): string {
            const baseUrl = `${this.getBaseUrl()}/api/artists/preview-stream/${encodeURIComponent(videoId)}`;
            const token = this.getCurrentToken();
            if (token) {
                return `${baseUrl}?token=${encodeURIComponent(token)}`;
            }
            return baseUrl;
        }

        async getFreshPreviewUrl(playlistId: string, pendingTrackId: string) {
            return this.request<{ previewUrl: string }>(
                `/playlists/${playlistId}/pending/${pendingTrackId}/preview`,
            );
        }
    }
    return MediaApi;
}

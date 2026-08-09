import type { CanonicalMediaSearchResult } from "@soundspan/media-metadata-contract";
import { type ApiClientConstructor } from "./core";

/** Add YouTube Music-domain operations to an API client base class. */
export function WithYtMusic<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class YtMusicApi extends Base {

    async getYtMusicMixes(): Promise<{
        mixes: Array<{ playlistId: string; title: string; description: string; thumbnails: Array<{ url: string; width: number }>; count: string | null }>;
    }> {
        return this.get("/browse/ytmusic/mixes");
    }

    // ── YouTube Music ──────────────────────────────────────────────

    async getYtMusicStatus(): Promise<{
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
        credentialsConfigured: boolean;
    }> {
        return this.request(`/ytmusic/status`);
    }

    async initiateYtMusicAuth(): Promise<{
        device_code: string;
        user_code: string;
        verification_url: string;
        expires_in: number;
        interval: number;
    }> {
        return this.post(`/ytmusic/auth/device-code`);
    }

    async pollYtMusicAuth(deviceCode: string): Promise<{
        status: "pending" | "success" | "error";
        error?: string;
    }> {
        return this.post(`/ytmusic/auth/device-code/poll`, { deviceCode });
    }

    async saveYtMusicOAuthToken(oauthJson: string): Promise<{ success: boolean }> {
        return this.post(`/ytmusic/auth/save-token`, { oauthJson });
    }

    async clearYtMusicAuth(): Promise<{ success: boolean }> {
        return this.post(`/ytmusic/auth/clear`);
    }

    async searchYtMusic(
        query: string,
        filter?: "songs" | "albums" | "artists" | "videos"
    ): Promise<{
        query: string;
        filter: "songs" | "albums" | "artists" | "videos" | null;
        total: number;
        results: CanonicalMediaSearchResult[];
    }> {
        return this.post(`/ytmusic/search`, { query, filter });
    }

    async getYtMusicAlbum(browseId: string): Promise<any> {
        return this.request(`/ytmusic/album/${browseId}`);
    }

    async getYtMusicArtist(channelId: string): Promise<any> {
        return this.request(`/ytmusic/artist/${channelId}`);
    }

    async getYtMusicSong(videoId: string): Promise<any> {
        return this.request(`/ytmusic/song/${videoId}`);
    }

    async matchYtMusicTrack(
        artist: string,
        title: string,
        albumTitle?: string,
        duration?: number,
        isrc?: string
    ): Promise<{
        match: { videoId: string; title: string; duration: number } | null;
    }> {
        return this.post(`/ytmusic/match`, {
            artist,
            title,
            albumTitle,
            duration,
            isrc,
        });
    }

    /**
     * Batch-match multiple tracks against YouTube Music in a single request.
     * Far faster than calling matchYtMusicTrack() N times because the
     * sidecar runs all searches concurrently via asyncio.gather.
     */
    async matchYtMusicBatch(
        tracks: Array<{
            artist: string;
            title: string;
            albumTitle?: string;
            duration?: number;
            isrc?: string;
        }>
    ): Promise<{
        matches: Array<{ videoId: string; title: string; duration: number } | null>;
    }> {
        return this.post(`/ytmusic/match-batch`, { tracks });
    }

    /**
     * Build a stream URL for YouTube Music playback.
     * Like getStreamUrl(), this returns a synchronous URL string
     * that the audio engine can load directly.
     */
    getYtMusicStreamUrl(videoId: string, quality?: string, usePublic?: boolean): string {
        const endpoint = usePublic ? "stream-public" : "stream";
        let url = `${this.getBaseUrl()}/api/ytmusic/${endpoint}/${videoId}`;
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const token = this.getCurrentToken();
        if (token) params.set("token", token);
        const qs = params.toString();
        if (qs) url += `?${qs}`;
        return url;
    }

    /**
     * Fetch stream metadata (bitrate, codec, etc.) for a YouTube Music
     * video. Used by the player UI to display quality information.
     */
    async getYtMusicStreamInfo(
        videoId: string,
        quality?: string
    ): Promise<{
        videoId: string;
        abr: number;
        acodec: string;
        duration: number;
        content_type: string;
    }> {
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const qs = params.toString();
        const suffix = qs ? `?${qs}` : "";
        // Use the public endpoint (no per-user YT Music OAuth required) —
        // consistent with stream-public used for playback.
        return this.get(`/ytmusic/stream-info-public/${videoId}${suffix}`);
    }
    }
    return YtMusicApi;
}

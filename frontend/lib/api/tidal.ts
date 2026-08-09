import { type ApiClientConstructor } from "./core";

/** Add TIDAL-domain operations to an API client base class. */
export function WithTidal<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class TidalApi extends Base {

    // ── TIDAL Streaming ────────────────────────────────────────────

    async getTidalStreamingStatus(): Promise<{
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
        credentialsConfigured: boolean;
    }> {
        return this.request(`/tidal-streaming/status`);
    }

    async initiateTidalAuth(): Promise<{
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
    }> {
        return this.post(`/tidal-streaming/auth/device-code`);
    }

    async pollTidalAuth(deviceCode: string): Promise<{
        status: "pending" | "success" | "error";
        username?: string;
        country_code?: string;
        error?: string;
    }> {
        return this.post(`/tidal-streaming/auth/device-code/poll`, { deviceCode });
    }

    async clearTidalStreamingAuth(): Promise<{ success: boolean }> {
        return this.post(`/tidal-streaming/auth/clear`);
    }

    async searchTidalStreaming(query: string): Promise<{
        tracks: any[];
        albums: any[];
        artists: any[];
    }> {
        return this.post(`/tidal-streaming/search`, { query });
    }

    async matchTidalTrack(
        artist: string,
        title: string,
        albumTitle?: string,
        duration?: number,
        isrc?: string
    ): Promise<{
        match: { id: number; title: string; artist: string; duration: number; isrc?: string } | null;
    }> {
        return this.post(`/tidal-streaming/match`, {
            artist,
            title,
            albumTitle,
            duration,
            isrc,
        });
    }

    /**
     * Batch-match multiple tracks against TIDAL in a single request.
     * Used for gap-fill on album and artist pages.
     */
    async matchTidalBatch(
        tracks: Array<{
            artist: string;
            title: string;
            albumTitle?: string;
            duration?: number;
            isrc?: string;
        }>
    ): Promise<{
        matches: Array<{ id: number; title: string; artist: string; duration: number; isrc?: string } | null>;
    }> {
        return this.post(`/tidal-streaming/match-batch`, { tracks });
    }

    /**
     * Build a stream URL for TIDAL playback.
     * Returns a synchronous URL string that the audio engine can load.
     */
    getTidalStreamUrl(trackId: number, quality?: string): string {
        let url = `${this.getBaseUrl()}/api/tidal-streaming/stream/${trackId}`;
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const token = this.getCurrentToken();
        if (token) params.set("token", token);
        const qs = params.toString();
        if (qs) url += `?${qs}`;
        return url;
    }

    /**
     * Fetch stream metadata (quality, codec) for a TIDAL track.
     */
    async getTidalStreamInfo(
        trackId: number,
        quality?: string
    ): Promise<{
        trackId: number;
        quality: string;
        acodec: string;
        content_type: string;
        bit_depth?: number;
        sample_rate?: number;
    }> {
        const params = new URLSearchParams();
        if (quality) params.set("quality", quality);
        const qs = params.toString();
        const suffix = qs ? `?${qs}` : "";
        return this.get(`/tidal-streaming/stream-info/${trackId}${suffix}`);
    }

    // ── TIDAL Browse ──────────────────────────────────────────────

    getTidalBrowseImageUrl(externalUrl: string): string {
        const baseUrl = this.getBaseUrl();
        const token = this.getCurrentToken();
        const params = new URLSearchParams({ url: externalUrl });
        if (token) params.append("token", token);
        return `${baseUrl}/api/browse/tidal/image?${params.toString()}`;
    }

    async getTidalHomeShelves(): Promise<{
        shelves: Array<{ title: string; contents: Array<{ type: string; playlistId?: string; mixId?: string; albumId?: string; title: string; thumbnailUrl: string | null; subtitle?: string }> }>;
    }> {
        return this.get("/browse/tidal/home");
    }

    async getTidalExploreShelves(): Promise<{
        shelves: Array<{ title: string; contents: Array<{ type: string; playlistId?: string; mixId?: string; albumId?: string; title: string; thumbnailUrl: string | null; subtitle?: string }> }>;
    }> {
        return this.get("/browse/tidal/explore");
    }

    async getTidalGenres(): Promise<{
        genres: Array<{ name: string; path: string; hasPlaylists: boolean; imageUrl: string | null }>;
    }> {
        return this.get("/browse/tidal/genres");
    }

    async getTidalMoods(): Promise<{
        moods: Array<{ name: string; path: string; hasPlaylists: boolean; imageUrl: string | null }>;
    }> {
        return this.get("/browse/tidal/moods");
    }

    async getTidalMixes(): Promise<{
        mixes: Array<{ mixId: string; title: string; subTitle: string; thumbnailUrl: string | null }>;
    }> {
        return this.get("/browse/tidal/mixes");
    }

    async getTidalGenrePlaylists(path: string): Promise<{
        playlists: Array<{ playlistId: string; title: string; thumbnailUrl: string | null; numTracks: number }>;
    }> {
        return this.get(`/browse/tidal/genre-playlists?path=${encodeURIComponent(path)}`);
    }

    async getTidalBrowsePlaylist(id: string, limit?: number): Promise<{
        id: string;
        title: string;
        trackCount: number;
        thumbnailUrl: string | null;
        tracks: Array<{ trackId: number; title: string; artist: string; artists: string[]; album: string; duration: number; isrc: string | null; thumbnailUrl: string | null }>;
    }> {
        const params = new URLSearchParams();
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        return this.get(`/browse/tidal/playlist/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
    }

    async getTidalBrowseMix(id: string): Promise<{
        id: string;
        title: string;
        trackCount: number;
        thumbnailUrl: string | null;
        tracks: Array<{ trackId: number; title: string; artist: string; artists: string[]; album: string; duration: number; isrc: string | null; thumbnailUrl: string | null }>;
    }> {
        return this.get(`/browse/tidal/mix/${encodeURIComponent(id)}`);
    }
    }
    return TidalApi;
}

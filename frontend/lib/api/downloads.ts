import type { AlbumRelease } from "../api";
import { type ApiClientConstructor, type ApiData } from "./core";

/** Add downloads-domain operations to an API client base class. */
export function WithDownloads<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class DownloadsApi extends Base {

    async downloadAlbum(
        artistName: string,
        albumTitle: string,
        rgMbid?: string,
        downloadType: "library" | "discovery" = "library"
    ) {
        return this.request<ApiData>("/downloads", {
            method: "POST",
            body: JSON.stringify({
                type: "album",
                subject: `${artistName} - ${albumTitle}`,
                mbid: rgMbid,
                artistName,
                albumTitle,
                downloadType,
            }),
        });
    }

    async downloadArtist(
        artistName: string,
        mbid: string,
        downloadType: "library" | "discovery" = "library"
    ) {
        return this.request<ApiData>("/downloads", {
            method: "POST",
            body: JSON.stringify({
                type: "artist",
                subject: artistName,
                mbid,
                downloadType,
            }),
        });
    }

    async getDownloadStatus(id: string) {
        return this.request<ApiData>(`/downloads/${id}`);
    }

    async getDownloads(limit?: number, includeDiscovery: boolean = false) {
        const params = new URLSearchParams();
        if (limit) params.set("limit", String(limit));
        params.set("includeDiscovery", String(includeDiscovery));
        const query = params.toString() ? `?${params.toString()}` : "";
        return this.request<ApiData[]>(`/downloads${query}`);
    }

    async getDownloadAvailability() {
        return this.request<{
            enabled: boolean;
            lidarr: boolean;
            soulseek: boolean;
            tidal: boolean;
        }>("/downloads/availability");
    }

    async deleteDownload(id: string) {
        return this.request<{ success: boolean }>(`/downloads/${id}`, {
            method: "DELETE",
        });
    }

    async getAlbumReleases(
        albumMbid: string,
        artistName: string,
        albumTitle: string
    ): Promise<{
        albumMbid: string;
        lidarrAlbumId: number;
        releases: AlbumRelease[];
        total: number;
    }> {
        const params = new URLSearchParams({ artistName, albumTitle });
        return this.request(
            `/downloads/releases/${albumMbid}?${params.toString()}`
        );
    }

    async grabRelease(options: {
        guid: string;
        indexerId: number;
        albumMbid: string;
        lidarrAlbumId: number;
        artistName: string;
        albumTitle: string;
        title: string;
    }): Promise<{
        success: boolean;
        jobId: string;
        message: string;
        duplicate?: boolean;
    }> {
        return this.request("/downloads/grab", {
            method: "POST",
            body: JSON.stringify(options),
        });
    }

    async getActiveDownloads(): Promise<
        Array<{
            id: string;
            subject: string;
            type: string;
            status: string;
            createdAt: string;
            error?: string;
        }>
    > {
        return this.get("/notifications/downloads/active");
    }

    async getDownloadHistory(): Promise<
        Array<{
            id: string;
            subject: string;
            type: string;
            status: string;
            error?: string;
            createdAt: string;
            completedAt?: string;
        }>
    > {
        return this.get("/notifications/downloads/history");
    }

    async clearDownloadFromHistory(id: string): Promise<{ success: boolean }> {
        return this.post(`/notifications/downloads/${id}/clear`);
    }

    async clearAllDownloadHistory(): Promise<{ success: boolean }> {
        return this.post("/notifications/downloads/clear-all");
    }

    async retryFailedDownload(
        id: string
    ): Promise<{ success: boolean; newJobId?: string }> {
        return this.post(`/notifications/downloads/${id}/retry`);
    }
    }
    return DownloadsApi;
}

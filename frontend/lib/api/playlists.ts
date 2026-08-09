import type { ShareLinkRecord } from "../api";
import type { AddToPlaylistRef } from "../trackRef";
import { type ApiClientConstructor, type ApiData } from "./core";

/** Add playlist-domain operations to an API client base class. */
export function WithPlaylists<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class PlaylistsApi extends Base {

    // Playlists
    async getPlaylists() {
        return this.request<ApiData[]>("/playlists");
    }

    async getPlaylist(id: string) {
        return this.request<ApiData>(`/playlists/${id}`);
    }

    async createPlaylist(name: string, isPublic = false) {
        return this.request<ApiData>("/playlists", {
            method: "POST",
            body: JSON.stringify({ name, isPublic }),
        });
    }

    async updatePlaylist(
        id: string,
        data: { name?: string; isPublic?: boolean }
    ) {
        return this.request<ApiData>(`/playlists/${id}`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async deletePlaylist(id: string) {
        return this.request<void>(`/playlists/${id}`, {
            method: "DELETE",
        });
    }

    async createShareLink(input: {
        resourceType: "playlist" | "album" | "track";
        resourceId: string;
        expiresAt?: string;
        maxPlays?: number;
    }) {
        return this.request<ShareLinkRecord>("/share-links", {
            method: "POST",
            body: JSON.stringify(input),
        });
    }

    async listShareLinks() {
        return this.request<ShareLinkRecord[]>("/share-links");
    }

    async revokeShareLink(id: string) {
        return this.request<{ success: boolean }>(`/share-links/${id}`, {
            method: "DELETE",
        });
    }

    async getSharedResource(token: string) {
        return this.request<unknown>(`/share-links/access/${token}`);
    }

    async addTrackToPlaylist(playlistId: string, trackRef: AddToPlaylistRef) {
        return this.request<ApiData>(`/playlists/${playlistId}/items`, {
            method: "POST",
            body: JSON.stringify(trackRef),
        });
    }

    async removeItemFromPlaylist(playlistId: string, itemId: string) {
        return this.request<void>(`/playlists/${playlistId}/items/${itemId}`, {
            method: "DELETE",
        });
    }

    /**
     * Persist a full playlist item order (owner only). `itemIds` is every
     * playlist item id in the desired order (GH #27 reorder).
     */
    async reorderPlaylistItems(playlistId: string, itemIds: string[]) {
        return this.request<void>(`/playlists/${playlistId}/items/reorder`, {
            method: "PUT",
            body: JSON.stringify({ itemIds }),
        });
    }

    async removeTrackFromPlaylist(playlistId: string, itemId: string) {
        return this.removeItemFromPlaylist(playlistId, itemId);
    }

    async hidePlaylist(playlistId: string) {
        return this.request<{ message: string; isHidden: boolean }>(
            `/playlists/${playlistId}/hide`,
            { method: "POST" }
        );
    }

    async unhidePlaylist(playlistId: string) {
        return this.request<{ message: string; isHidden: boolean }>(
            `/playlists/${playlistId}/hide`,
            { method: "DELETE" }
        );
    }

    async retryPendingTrack(playlistId: string, pendingTrackId: string) {
        return this.request<{
            success: boolean;
            message: string;
            error?: string;
            filePath?: string;
        }>(`/playlists/${playlistId}/pending/${pendingTrackId}/retry`, {
            method: "POST",
        });
    }

    async removePendingTrack(playlistId: string, pendingTrackId: string) {
        return this.request<{ message: string }>(
            `/playlists/${playlistId}/pending/${pendingTrackId}`,
            { method: "DELETE" }
        );
    }
    }
    return PlaylistsApi;
}

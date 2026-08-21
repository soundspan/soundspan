import { api } from "@/lib/api";
import type { AlbumSource } from "./types";

/** Loads the lightweight album record, with discovery as the fallback source. */
export async function loadCoreAlbum(albumId: string) {
    if (!albumId) throw new Error("Album ID is required");
    try {
        return await api.getAlbum(albumId, { includeTracks: false });
    } catch {
        return api.getAlbumDiscovery(albumId, { includeTracks: false });
    }
}

/** Hydrates tracks from the endpoint that owns the resolved album source. */
export async function loadAlbumDetails(
    albumId: string,
    source: AlbumSource | null,
) {
    if (!albumId) throw new Error("Album ID is required");
    if (source === "library" || source === "remote") {
        return api.getAlbum(albumId);
    }
    if (source === "discovery") {
        return api.getAlbumDiscovery(albumId, { includeTracks: true });
    }
    throw new Error("Album source is required");
}

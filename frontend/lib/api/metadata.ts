import { type ApiClientConstructor, type ApiData } from "./core";

/** Add metadata-domain operations to an API client base class. */
export function WithMetadata<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class MetadataApi extends Base {

    async updateArtistMetadata(
        artistId: string,
        data: {
            name?: string;
            bio?: string;
            genres?: string[];
            mbid?: string;
            heroUrl?: string;
        }
    ) {
        return this.request<ApiData>(`/enrichment/artists/${artistId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async updateAlbumMetadata(
        albumId: string,
        data: {
            title?: string;
            year?: number;
            genres?: string[];
            rgMbid?: string;
            coverUrl?: string;
        }
    ) {
        return this.request<ApiData>(`/enrichment/albums/${albumId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async updateTrackMetadata(trackId: string, data: ApiData) {
        return this.request<ApiData>(`/enrichment/tracks/${trackId}/metadata`, {
            method: "PUT",
            body: JSON.stringify(data),
        });
    }

    async resetArtistMetadata(artistId: string) {
        return this.request<{ message: string; artist: ApiData }>(
            `/enrichment/artists/${artistId}/reset`,
            { method: "POST" }
        );
    }

    async resetAlbumMetadata(albumId: string) {
        return this.request<{ message: string; album: ApiData }>(
            `/enrichment/albums/${albumId}/reset`,
            { method: "POST" }
        );
    }

    async resetTrackMetadata(trackId: string) {
        return this.request<{ message: string; track: ApiData }>(
            `/enrichment/tracks/${trackId}/reset`,
            { method: "POST" }
        );
    }

    async searchMusicBrainzArtists(query: string): Promise<{
        artists: Array<{
            mbid: string;
            name: string;
            disambiguation: string | null;
            country: string | null;
            type: string | null;
            score: number;
        }>;
    }> {
        return this.request(
            `/enrichment/search/musicbrainz/artists?q=${encodeURIComponent(query)}`
        );
    }

    async searchMusicBrainzReleaseGroups(
        query: string,
        artistName?: string
    ): Promise<{
        albums: Array<{
            rgMbid: string;
            title: string;
            primaryType: string;
            secondaryTypes: string[];
            firstReleaseDate: string | null;
            artistCredit: string;
            score: number;
        }>;
    }> {
        let url = `/enrichment/search/musicbrainz/release-groups?q=${encodeURIComponent(query)}`;
        if (artistName) {
            url += `&artist=${encodeURIComponent(artistName)}`;
        }
        return this.request(url);
    }
    }
    return MetadataApi;
}

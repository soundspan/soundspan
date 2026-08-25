import {
    MAX_PAGE_ITEMS,
    type FederationEnvelope,
} from "../../services/federationClient";

/** Federation artist item accepted by the sync processor. */
export type ArtistEnvelope = Extract<
    FederationEnvelope,
    { mediaType: "artist" }
>;
/** Federation album item accepted by the sync processor. */
export type AlbumEnvelope = Extract<FederationEnvelope, { mediaType: "album" }>;
/** Federation track item accepted by the sync processor. */
export type TrackEnvelope = Extract<FederationEnvelope, { mediaType: "track" }>;
/** Federation podcast item accepted by the sync processor. */
export type PodcastEnvelope = Extract<
    FederationEnvelope,
    { mediaType: "podcast" }
>;
/** Federation audiobook item accepted by the sync processor. */
export type AudiobookEnvelope = Extract<
    FederationEnvelope,
    { mediaType: "audiobook" }
>;

/** Existing remote artist identity loaded for one page. */
export type RemoteArtistRow = { id: string; remoteId: string; mbid: string };
/** Existing remote album identity loaded for one page. */
export type RemoteAlbumRow = {
    id: string;
    remoteId: string;
    rgMbid: string;
    artistId: string;
};
/** Existing remote track identity loaded for one page. */
export type RemoteTrackRow = {
    id: string;
    remoteId: string;
    audioHash: string | null;
};
/** Candidate row used to rebind a peer track whose remote id changed. */
export type RebindTrackRow = {
    id: string;
    audioHash: string | null;
    recordingMbid: string | null;
    isrc: string | null;
    albumId: string;
    discNo: number;
    trackNo: number;
};

/** Batched identity state shared while applying one federation page. */
export interface PageState {
    artists: Map<string, RemoteArtistRow>;
    albums: Map<string, RemoteAlbumRow>;
    tracks: Map<string, RemoteTrackRow>;
    rebindTracks: Map<string, RebindTrackRow>;
    artistCollisionRemoteIds: Set<string>;
    albumCollisionRemoteIds: Set<string>;
    loadedArtistMbids: Set<string>;
    loadedAlbumRgMbids: Set<string>;
}

/** Federation items grouped into dependency-safe media buckets. */
export interface GroupedPage {
    artists: ArtistEnvelope[];
    albums: AlbumEnvelope[];
    tracks: TrackEnvelope[];
    podcasts: PodcastEnvelope[];
    audiobooks: AudiobookEnvelope[];
}

/** Group one bounded page by media type before dependency-ordered writes. */
export function groupFederationPage(
    items: readonly FederationEnvelope[],
): GroupedPage {
    if (items.length > MAX_PAGE_ITEMS) {
        throw new RangeError("Federation page exceeded the item bound");
    }
    const grouped: GroupedPage = {
        artists: [],
        albums: [],
        tracks: [],
        podcasts: [],
        audiobooks: [],
    };
    for (let index = 0; index < MAX_PAGE_ITEMS; index += 1) {
        const item = items[index];
        if (!item) break;
        if (item.mediaType === "artist") grouped.artists.push(item);
        else if (item.mediaType === "album") grouped.albums.push(item);
        else if (item.mediaType === "track") grouped.tracks.push(item);
        else if (item.mediaType === "podcast") grouped.podcasts.push(item);
        else grouped.audiobooks.push(item);
    }
    return grouped;
}

/** Create empty per-page identity maps and collision sets. */
export function createFederationPageState(): PageState {
    return {
        artists: new Map(),
        albums: new Map(),
        tracks: new Map(),
        rebindTracks: new Map(),
        artistCollisionRemoteIds: new Set(),
        albumCollisionRemoteIds: new Set(),
        loadedArtistMbids: new Set(),
        loadedAlbumRgMbids: new Set(),
    };
}

export { syncedFederationTrackValues } from "./federationSyncTrackValues";

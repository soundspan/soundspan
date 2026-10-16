import type { RemoteLibraryArtistStats, RemoteLibraryProvider } from "./types";
import type { LibraryBrowseOrigin } from "../../utils/librarySorting";

/** Artist fields selected by the Library list query. */
export interface LibraryArtistListRow {
    id: string;
    mbid: string;
    name: string;
    heroUrl: string | null;
    userHeroUrl: string | null;
    libraryAlbumCount: number;
    discoveryAlbumCount: number;
    totalTrackCount: number;
    remoteTrackCount: number;
    peerId: string | null;
    federationPeer: {
        id: string;
        name: string;
        outboundStatus: string | null;
    } | null;
}

function storedAlbumCount(
    artist: LibraryArtistListRow,
    countsReady: boolean,
    filter: unknown,
): number {
    if (!countsReady) {
        return artist.libraryAlbumCount + artist.discoveryAlbumCount;
    }
    if (filter === "discovery") return artist.discoveryAlbumCount;
    if (filter === "all") {
        return artist.libraryAlbumCount + artist.discoveryAlbumCount;
    }
    return artist.libraryAlbumCount;
}

function resolveArtistCounts(
    existingAlbumCount: number,
    totalTrackCount: number,
    remoteOnly: boolean,
    remoteStats: { albumCount: number; trackCount: number } | undefined,
) {
    const remoteAlbumCount = remoteStats?.albumCount ?? 0;
    const remoteTrackCount = remoteStats?.trackCount ?? 0;
    return {
        albumCount: remoteOnly
            ? remoteAlbumCount
            : existingAlbumCount + remoteAlbumCount,
        trackCount: remoteOnly
            ? remoteTrackCount
            : totalTrackCount + remoteTrackCount,
    };
}

function formatArtistSource(
    artist: LibraryArtistListRow,
    remoteSource: boolean,
) {
    if (artist.peerId && artist.federationPeer) {
        return {
            source: "federated" as const,
            streamSource: "peer" as const,
            peer: {
                id: artist.federationPeer.id,
                name: artist.federationPeer.name,
                online: artist.federationPeer.outboundStatus === "ACTIVE",
            },
        };
    }
    return remoteSource ? { source: "remote" as const } : {};
}

/** Formats counts and source decoration for one Library artist list row. */
export function formatRemoteAwareArtist(
    artist: LibraryArtistListRow,
    coverArt: string | null,
    input: {
        countsReady: boolean;
        filter: unknown;
        origin: LibraryBrowseOrigin;
        remoteStats?: Pick<
            RemoteLibraryArtistStats,
            "trackCount" | "albumCount"
        > & { providers: ReadonlyArray<RemoteLibraryProvider> };
    },
) {
    const existingAlbumCount = storedAlbumCount(
        artist,
        input.countsReady,
        input.filter,
    );
    const isRemoteSource =
        Boolean(input.remoteStats) &&
        existingAlbumCount === 0 &&
        artist.totalTrackCount === 0 &&
        !artist.peerId;
    const counts = resolveArtistCounts(
        existingAlbumCount,
        artist.totalTrackCount,
        input.origin === "remote",
        input.remoteStats,
    );
    return {
        id: artist.id,
        mbid: artist.mbid,
        name: artist.name,
        heroUrl: coverArt,
        coverArt,
        ...counts,
        ...(input.remoteStats
            ? { remoteSources: [...input.remoteStats.providers] }
            : {}),
        ...formatArtistSource(artist, isRemoteSource),
    };
}

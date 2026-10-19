import type {
    RemoteLibraryArtistStats,
    RemoteLibraryLookups,
    RemoteLibraryProvider,
    RemoteLibraryTrack,
} from "./types";
import { effectiveRemoteArtistId } from "./effectiveArtist";

const PROVIDER_SORT_ORDER: Readonly<Record<RemoteLibraryProvider, number>> = {
    tidal: 0,
    youtube: 1,
};

/** Returns a stable, unique provider list for response payloads. */
export function sortedRemoteProviders(
    providers: Iterable<RemoteLibraryProvider>,
): RemoteLibraryProvider[] {
    return [...new Set(providers)].sort(
        (left, right) => PROVIDER_SORT_ORDER[left] - PROVIDER_SORT_ORDER[right],
    );
}

function artistStats(
    stats: Map<string, RemoteLibraryArtistStats>,
    artistId: string,
): RemoteLibraryArtistStats {
    return (
        stats.get(artistId) ?? {
            trackCount: 0,
            albumCount: 0,
            albumIds: new Set<string>(),
            providers: [],
        }
    );
}

function storeArtistStats(
    stats: Map<string, RemoteLibraryArtistStats>,
    artistId: string,
    current: RemoteLibraryArtistStats,
    provider: RemoteLibraryProvider,
): void {
    current.albumCount = current.albumIds.size;
    current.providers = sortedRemoteProviders([...current.providers, provider]);
    stats.set(artistId, current);
}

function addArtistTrack(
    stats: Map<string, RemoteLibraryArtistStats>,
    row: RemoteLibraryTrack,
): void {
    const artistId = effectiveRemoteArtistId(row);
    if (!artistId) return;
    const current = artistStats(stats, artistId);
    current.trackCount += 1;
    storeArtistStats(stats, artistId, current, row.provider);
}

function addArtistAlbum(
    stats: Map<string, RemoteLibraryArtistStats>,
    row: RemoteLibraryTrack,
): void {
    if (
        row.albumLocation !== "REMOTE" ||
        row.albumMatchedInLibrary ||
        !row.albumId ||
        !row.albumArtistId
    ) {
        return;
    }
    const current = artistStats(stats, row.albumArtistId);
    current.albumIds.add(row.albumId);
    storeArtistStats(stats, row.albumArtistId, current, row.provider);
}

function addArtistRow(
    stats: Map<string, RemoteLibraryArtistStats>,
    row: RemoteLibraryTrack,
): void {
    addArtistTrack(stats, row);
    addArtistAlbum(stats, row);
}

/** Derives per-artist counts and per-album provider sets in memory. */
export function deriveRemoteLibraryLookups(
    tracks: ReadonlyArray<RemoteLibraryTrack>,
): RemoteLibraryLookups {
    const byArtistId = new Map<string, RemoteLibraryArtistStats>();
    const albumProviders = new Map<string, Set<RemoteLibraryProvider>>();
    for (const row of tracks) {
        addArtistRow(byArtistId, row);
        if (
            row.albumLocation !== "REMOTE" ||
            row.albumMatchedInLibrary ||
            !row.albumId
        ) {
            continue;
        }
        const providers = albumProviders.get(row.albumId) ?? new Set();
        providers.add(row.provider);
        albumProviders.set(row.albumId, providers);
    }
    return {
        byArtistId,
        byAlbumId: new Map(
            [...albumProviders].map(([albumId, providers]) => [
                albumId,
                sortedRemoteProviders(providers),
            ]),
        ),
    };
}

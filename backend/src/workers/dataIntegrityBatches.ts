import { resolveDownloadJobMetadata } from "../utils/downloadJobMetadata";

export interface DiscoveryMarkers {
    albumTitles: Set<string>;
    artistNames: Set<string>;
    artistMbids: Set<string>;
    maxEntries: number;
}

export interface AlbumCandidate {
    id: string;
    rgMbid: string;
    title: string;
    artistId: string;
    artist: { name: string; mbid: string | null };
}

interface DiscoveryReference {
    rgMbid: string;
    albumTitle: string;
    artistName: string;
}

interface OwnedReference {
    artistId: string;
    rgMbid: string;
}

function normalize(value: string): string {
    return value.toLowerCase().trim();
}

function totalMarkerEntries(markers: DiscoveryMarkers): number {
    return (
        markers.albumTitles.size +
        markers.artistNames.size +
        markers.artistMbids.size
    );
}

function assertMarkerBound(markers: DiscoveryMarkers): void {
    if (totalMarkerEntries(markers) > markers.maxEntries) {
        throw new Error("Data integrity discovery marker bound exceeded");
    }
}

/** Creates bounded marker sets used across cursor-paginated scans. */
export function createDiscoveryMarkers(maxEntries: number): DiscoveryMarkers {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
        throw new Error("maxEntries must be a positive integer");
    }
    return {
        albumTitles: new Set(),
        artistNames: new Set(),
        artistMbids: new Set(),
        maxEntries,
    };
}

function addMarkerValues(
    markers: DiscoveryMarkers,
    albumTitle?: string,
    artistName?: string,
    artistMbid?: string | null,
): void {
    if (albumTitle) markers.albumTitles.add(normalize(albumTitle));
    if (artistName) markers.artistNames.add(normalize(artistName));
    if (artistMbid) markers.artistMbids.add(artistMbid);
    assertMarkerBound(markers);
}

/** Adds selected discovery-download metadata to the bounded marker sets. */
export function addDownloadJobMarkers(
    markers: DiscoveryMarkers,
    jobs: ReadonlyArray<{ metadata: unknown }>,
): void {
    for (const job of jobs) {
        const metadata = resolveDownloadJobMetadata(job.metadata);
        addMarkerValues(
            markers,
            metadata.normalizedAlbumTitle,
            metadata.normalizedArtistName,
            metadata.artistMbid,
        );
    }
}

/** Adds selected DiscoveryAlbum fields to the bounded marker sets. */
export function addDiscoveryAlbumMarkers(
    markers: DiscoveryMarkers,
    albums: ReadonlyArray<{
        albumTitle: string;
        artistName: string;
        artistMbid: string | null;
    }>,
): void {
    for (const album of albums) {
        addMarkerValues(
            markers,
            album.albumTitle,
            album.artistName,
            album.artistMbid,
        );
    }
}

function matchesDiscovery(
    album: AlbumCandidate,
    markers: DiscoveryMarkers,
): boolean {
    return (
        markers.albumTitles.has(normalize(album.title)) ||
        markers.artistNames.has(normalize(album.artist.name)) ||
        (album.artist.mbid !== null &&
            markers.artistMbids.has(album.artist.mbid))
    );
}

/** Selects discovery matches that have no protected ownership or liked state. */
export function findMislocatedAlbums(
    albums: ReadonlyArray<AlbumCandidate>,
    markers: DiscoveryMarkers,
    protectedArtistIds: ReadonlySet<string>,
    likedArtistMbids: ReadonlySet<string>,
): AlbumCandidate[] {
    return albums.filter(
        (album) =>
            matchesDiscovery(album, markers) &&
            !protectedArtistIds.has(album.artistId) &&
            (album.artist.mbid === null ||
                !likedArtistMbids.has(album.artist.mbid)),
    );
}

function titleArtistKey(title: string, artist: string): string {
    return `${normalize(artist)}|${normalize(title)}`;
}

/** Selects DISCOVER album IDs lacking an exact active or owned reference. */
export function findUnprotectedDiscoverAlbumIds(
    albums: ReadonlyArray<AlbumCandidate>,
    discoveryReferences: ReadonlyArray<DiscoveryReference>,
    ownedReferences: ReadonlyArray<OwnedReference>,
): string[] {
    const activeMbids = new Set(discoveryReferences.map((row) => row.rgMbid));
    const activeTitles = new Set(
        discoveryReferences.map((row) =>
            titleArtistKey(row.albumTitle, row.artistName),
        ),
    );
    const ownedKeys = new Set(
        ownedReferences.map((row) => `${row.artistId}|${row.rgMbid}`),
    );
    return albums
        .filter(
            (album) =>
                !activeMbids.has(album.rgMbid) &&
                !activeTitles.has(
                    titleArtistKey(album.title, album.artist.name),
                ) &&
                !ownedKeys.has(`${album.artistId}|${album.rgMbid}`),
        )
        .map((album) => album.id);
}

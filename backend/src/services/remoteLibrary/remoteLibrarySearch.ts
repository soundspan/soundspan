import {
    findMatchingRemoteLibraryTracks,
    hydrateRemoteLibraryTracks,
    titleMatchRank,
} from "./remoteDisplayHydration";
import {
    searchRemoteLibraryAlbums,
    type RemoteSearchAlbum,
} from "./remoteAlbumSearch";
import { toLibraryRemoteTrack } from "./responseRow";
import { loadRemoteLibrarySet } from "./setLoader";
import type { RemoteLibrarySet, RemoteLibraryTrack } from "./types";

const titleCollator = new Intl.Collator("en", { sensitivity: "base" });
const providerRank = { tidal: 0, youtube: 1 } as const;

function compareProviderRowId(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function compareRemoteTracks(
    normalizedQuery: string,
    left: RemoteLibraryTrack,
    right: RemoteLibraryTrack,
): number {
    const rankDelta =
        titleMatchRank(left.title, normalizedQuery) -
        titleMatchRank(right.title, normalizedQuery);
    if (rankDelta !== 0) return rankDelta;
    const titleDelta = titleCollator.compare(left.title, right.title);
    if (titleDelta !== 0) return titleDelta;
    const providerDelta =
        providerRank[left.provider] - providerRank[right.provider];
    return (
        providerDelta ||
        compareProviderRowId(left.providerRowId, right.providerRowId)
    );
}

/** Returns a ranked copy of remote-library tracks for a full search query. */
export function rankRemoteLibraryTracks(
    rows: ReadonlyArray<RemoteLibraryTrack>,
    query: string,
): RemoteLibraryTrack[] {
    const normalizedQuery = query.trim().toLocaleLowerCase("en");
    return [...rows].sort((left, right) =>
        compareRemoteTracks(normalizedQuery, left, right),
    );
}

async function searchRemoteTracks(
    remoteLibrary: RemoteLibrarySet,
    query: string,
    limit: number,
) {
    const matchingRows = await findMatchingRemoteLibraryTracks(
        remoteLibrary.tracks,
        query,
        limit,
    );
    const selectedRows = rankRemoteLibraryTracks(matchingRows, query).slice(
        0,
        limit,
    );
    const hydratedRows = await hydrateRemoteLibraryTracks(selectedRows);
    return hydratedRows.map(toLibraryRemoteTrack);
}

type RemoteSearchTrack = ReturnType<typeof toLibraryRemoteTrack>;

/** Searches both per-user remote library groups from one loaded set. */
export async function searchRemoteLibrary(
    userId: string | undefined,
    query: string,
    limits: { tracks: number; albums: number },
): Promise<{ tracks: RemoteSearchTrack[]; albums: RemoteSearchAlbum[] }> {
    const normalizedQuery = query.trim();
    if (
        !userId ||
        !normalizedQuery ||
        (limits.tracks < 1 && limits.albums < 1)
    ) {
        return { tracks: [], albums: [] };
    }
    const remoteLibrary = await loadRemoteLibrarySet(userId, {
        reportCap: false,
    });
    const [tracks, albums] = await Promise.all([
        limits.tracks >= 1
            ? searchRemoteTracks(remoteLibrary, normalizedQuery, limits.tracks)
            : Promise.resolve([]),
        limits.albums >= 1
            ? searchRemoteLibraryAlbums(
                  remoteLibrary,
                  normalizedQuery,
                  limits.albums,
              )
            : Promise.resolve([]),
    ]);
    return { tracks, albums };
}

/** Searches and hydrates one user's bounded remote-only track group. */
export async function searchRemoteLibraryTracks(
    userId: string | undefined,
    query: string,
    limit: number,
): Promise<RemoteSearchTrack[]> {
    const result = await searchRemoteLibrary(userId, query, {
        tracks: limit,
        albums: 0,
    });
    return result.tracks;
}

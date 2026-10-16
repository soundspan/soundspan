import {
    findMatchingRemoteLibraryTracks,
    hydrateRemoteLibraryTracks,
} from "./remoteDisplayHydration";
import { toLibraryRemoteTrack } from "./responseRow";
import { loadRemoteLibrarySet } from "./setLoader";
import type { RemoteLibraryTrack } from "./types";

const titleCollator = new Intl.Collator("en", { sensitivity: "base" });
const providerRank = { tidal: 0, youtube: 1 } as const;

function titleMatchRank(title: string, normalizedQuery: string): number {
    const normalizedTitle = title.toLocaleLowerCase("en");
    if (normalizedTitle === normalizedQuery) return 0;
    return normalizedTitle.startsWith(normalizedQuery) ? 1 : 2;
}

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

/** Searches and hydrates one user's bounded remote-only library group. */
export async function searchRemoteLibraryTracks(
    userId: string | undefined,
    query: string,
    limit: number,
) {
    const normalizedQuery = query.trim();
    if (!userId || !normalizedQuery || limit < 1) return [];
    const remoteLibrary = await loadRemoteLibrarySet(userId, {
        reportCap: false,
    });
    const matchingRows = await findMatchingRemoteLibraryTracks(
        remoteLibrary.tracks,
        normalizedQuery,
        limit,
    );
    const selectedRows = rankRemoteLibraryTracks(
        matchingRows,
        normalizedQuery,
    ).slice(0, limit);
    const hydratedRows = await hydrateRemoteLibraryTracks(selectedRows);
    return hydratedRows.map(toLibraryRemoteTrack);
}

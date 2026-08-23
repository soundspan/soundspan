/**
 * Pure view-model for the unified playlist spectrum: local playlists and
 * federated peer playlists merged into one filterable, sortable list.
 * No I/O — callers feed it the payloads from `api.getPlaylists()` and
 * `api.getPeerPlaylists()` and render the returned rows.
 */

export type UnifiedPlaylistFilter = "all" | "mine" | "others" | "peers";
export type UnifiedPlaylistSort = "updated" | "created" | "alphabetical";

/** Local playlist fields the unified list consumes. */
export interface LocalPlaylistInput {
    id: string;
    name: string;
    trackCount?: number;
    createdAt?: string;
    updatedAt?: string;
    isHidden?: boolean;
    isOwner?: boolean;
    user?: { username?: string };
}

/** Peer playlist summary fields the unified list consumes. */
export interface PeerPlaylistInput {
    remoteId: string;
    name: string;
    trackCount: number;
    updatedAt: string;
    owner: { displayName: string };
    peer: { id: string; name: string };
}

interface UnifiedRowBase {
    key: string;
    name: string;
    trackCount: number;
    ownerName: string | null;
    href: string;
    sortUpdated: string;
    sortCreated: string;
}

export type UnifiedPlaylistRow =
    | (UnifiedRowBase & { kind: "local"; id: string; isOwner: boolean })
    | (UnifiedRowBase & { kind: "peer"; peerId: string; peerName: string });

/** Builds the local playlist detail href. */
export function localPlaylistHref(id: string): string {
    return `/playlist/${encodeURIComponent(id)}`;
}

/** Builds the peer playlist detail href. */
export function peerPlaylistHref(peerId: string, remoteId: string): string {
    return `/peer-playlists/${encodeURIComponent(peerId)}/${encodeURIComponent(remoteId)}`;
}

function toLocalRow(playlist: LocalPlaylistInput): UnifiedPlaylistRow {
    return {
        kind: "local",
        key: `local:${playlist.id}`,
        id: playlist.id,
        name: playlist.name,
        trackCount: playlist.trackCount ?? 0,
        ownerName: playlist.user?.username ?? null,
        isOwner: playlist.isOwner !== false,
        href: localPlaylistHref(playlist.id),
        sortUpdated: playlist.updatedAt ?? playlist.createdAt ?? "",
        // Missing createdAt sorts last, matching the pre-merge sidebar.
        sortCreated: playlist.createdAt ?? "",
    };
}

function toPeerRow(playlist: PeerPlaylistInput): UnifiedPlaylistRow {
    // Peer summaries carry no createdAt; updatedAt stands in for both sort
    // keys so peer rows stay ordered instead of sinking to one end.
    return {
        kind: "peer",
        key: `peer:${playlist.peer.id}:${playlist.remoteId}`,
        peerId: playlist.peer.id,
        peerName: playlist.peer.name,
        name: playlist.name,
        trackCount: playlist.trackCount,
        ownerName: playlist.owner.displayName || null,
        href: peerPlaylistHref(playlist.peer.id, playlist.remoteId),
        sortUpdated: playlist.updatedAt,
        sortCreated: playlist.updatedAt,
    };
}

function matchesFilter(
    row: UnifiedPlaylistRow,
    filter: UnifiedPlaylistFilter,
): boolean {
    if (filter === "all") return true;
    if (filter === "peers") return row.kind === "peer";
    if (row.kind !== "local") return false;
    return filter === "mine" ? row.isOwner : !row.isOwner;
}

function compareRows(
    a: UnifiedPlaylistRow,
    b: UnifiedPlaylistRow,
    sort: UnifiedPlaylistSort,
): number {
    if (sort === "alphabetical") return a.name.localeCompare(b.name);
    const key = sort === "created" ? "sortCreated" : "sortUpdated";
    return b[key].localeCompare(a[key]);
}

/** Filter menu options; the peers entry appears only on federated installs. */
export function playlistFilterOptions(
    federation: boolean,
): ReadonlyArray<readonly [UnifiedPlaylistFilter, string]> {
    return [
        ["all", "All playlists"],
        ["mine", "Your playlists"],
        ["others", "Shared playlists"],
        ...(federation
            ? ([["peers", "Peer playlists"]] as const)
            : ([] as const)),
    ];
}

/**
 * Merges local and peer playlists into one filtered, sorted row list.
 * Hidden local playlists are always excluded.
 */
export function buildUnifiedPlaylistRows(
    local: readonly LocalPlaylistInput[],
    peer: readonly PeerPlaylistInput[],
    options: { filter: UnifiedPlaylistFilter; sort: UnifiedPlaylistSort },
): UnifiedPlaylistRow[] {
    const rows = [
        ...local.filter((p) => !p.isHidden).map(toLocalRow),
        ...peer.map(toPeerRow),
    ];
    return rows
        .filter((row) => matchesFilter(row, options.filter))
        .sort((a, b) => compareRows(a, b, options.sort));
}

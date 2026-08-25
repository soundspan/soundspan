import type { GroupedPage, PageState } from "./federationSyncPage";

type RecoverArtist = (remoteId: string) => Promise<string | null>;
type RecoverAlbum = (remoteId: string) => Promise<unknown>;
type MarkAlbumUnavailable = (remoteId: string) => void;

/** Recovers page-external artist and album parents before transactional apply. */
export async function recoverFederationMissingParents(
    grouped: GroupedPage,
    state: PageState,
    recoverArtist: RecoverArtist,
    recoverAlbum: RecoverAlbum,
    markAlbumUnavailable: MarkAlbumUnavailable,
): Promise<void> {
    const pageArtistIds = new Set(grouped.artists.map((item) => item.id));
    for (const item of grouped.albums) {
        if (state.artists.has(item.parentRef)) continue;
        if (pageArtistIds.has(item.parentRef)) continue;
        const artistId = await recoverArtist(item.parentRef);
        if (!artistId) markAlbumUnavailable(item.id);
    }
    const pageAlbumIds = new Set(grouped.albums.map((item) => item.id));
    for (const item of grouped.tracks) {
        if (state.albums.has(item.parentRef)) continue;
        if (pageAlbumIds.has(item.parentRef)) continue;
        await recoverAlbum(item.parentRef);
    }
}

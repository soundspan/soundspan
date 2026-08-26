import {
    normalizeForFuzzyMatch,
    stripAlbumEdition,
} from "../../utils/artistNormalization";
import type { LidarrAlbum } from "./lidarrTypes";

function normalizeAlbumTitle(title: string): string {
    return normalizeForFuzzyMatch(stripAlbumEdition(title));
}

function isContainedMatch(candidate: string, target: string): boolean {
    const shorter = candidate.length < target.length ? candidate : target;
    const longer = candidate.length >= target.length ? candidate : target;
    return longer.includes(shorter) && shorter.length >= longer.length * 0.6;
}

/** Selects an album by MBID, then by the existing strict normalized-title rules. */
export function selectAlbumInCatalogMatch(
    albums: LidarrAlbum[],
    releaseGroupMbid: string,
    albumTitle: string,
): {
    album: LidarrAlbum | null;
    matchType: "mbid" | "exact" | "partial" | null;
} {
    const mbidMatch = albums.find(
        (album) => album.foreignAlbumId === releaseGroupMbid,
    );
    if (mbidMatch) return { album: mbidMatch, matchType: "mbid" };

    const targetTitle = normalizeAlbumTitle(albumTitle);
    const exactMatch = albums.find(
        (album) => normalizeAlbumTitle(album.title) === targetTitle,
    );
    if (exactMatch) return { album: exactMatch, matchType: "exact" };

    const partialMatch = albums.find((album) =>
        isContainedMatch(normalizeAlbumTitle(album.title), targetTitle),
    );
    return {
        album: partialMatch ?? null,
        matchType: partialMatch ? "partial" : null,
    };
}

/** Selects only the album value from the catalog match result. */
export function selectAlbumInCatalog(
    albums: LidarrAlbum[],
    releaseGroupMbid: string,
    albumTitle: string,
): LidarrAlbum | null {
    return selectAlbumInCatalogMatch(albums, releaseGroupMbid, albumTitle)
        .album;
}

/** Selects the edition-stripped fallback album using the existing 70% rule. */
export function selectBaseAlbumInCatalog(
    albums: LidarrAlbum[],
    albumTitle: string,
    baseTitle: string = stripAlbumEdition(albumTitle),
): LidarrAlbum | null {
    if (baseTitle === albumTitle || baseTitle.length <= 2) return null;
    const target = normalizeForFuzzyMatch(baseTitle);
    return (
        albums.find((album) => {
            const candidate = normalizeForFuzzyMatch(album.title);
            if (candidate === target) return true;
            const shorter =
                candidate.length < target.length ? candidate : target;
            const longer =
                candidate.length >= target.length ? candidate : target;
            return (
                longer.includes(shorter) &&
                shorter.length >= longer.length * 0.7
            );
        }) ?? null
    );
}

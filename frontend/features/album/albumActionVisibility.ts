import type { AlbumSource } from "./types";

/** Inputs that determine which album actions are honest and available. */
export interface AlbumActionVisibilityInput {
    source: AlbumSource;
    owned?: boolean;
    albumId: string;
    rgMbid?: string;
    mbid?: string;
    downloadsEnabled: boolean;
    hasAddAllToQueue: boolean;
    hasAlbumPreferenceAction: boolean;
    isInListenTogetherGroup: boolean;
}

/** Album action flags consumed by the action-bar renderer. */
export interface AlbumActionVisibility {
    acquisitionMbid: string | null;
    isOwned: boolean;
    isLibraryVisible: boolean;
    showAcquisition: boolean;
    hasLockedControls: boolean;
    canShowAddAllToQueue: boolean;
    canShowAddToPlaylist: boolean;
    canShowAlbumPreference: boolean;
    canShareAlbum: boolean;
    hasActionControls: boolean;
}

/** Returns true for locally generated release-group identifiers. */
export function isSyntheticRgMbid(value: string | null | undefined): boolean {
    return value?.startsWith("remote:") === true;
}

/** Resolves a real release-group identifier suitable for acquisition routes. */
export function resolveAcquisitionMbid(
    input: Pick<AlbumActionVisibilityInput, "rgMbid" | "mbid">,
): string | null {
    const candidate = input.rgMbid || input.mbid;
    // The acquisition flow must resolve synthetic remote IDs canonically before
    // these controls can send them to MusicBrainz or Lidarr.
    return candidate && !isSyntheticRgMbid(candidate) ? candidate : null;
}

/** Derives every action-bar control from album state and feature policy. */
export function getAlbumActionVisibility(
    input: AlbumActionVisibilityInput,
): AlbumActionVisibility {
    const isOwned = input.owned ?? input.source === "library";
    const isLibraryVisible = isOwned || input.source === "remote";
    const acquisitionMbid = resolveAcquisitionMbid(input);
    const showAcquisition = Boolean(
        input.downloadsEnabled && !isOwned && acquisitionMbid,
    );
    const canShowAlbumPreference =
        isOwned && input.source !== "remote" && input.hasAlbumPreferenceAction;
    const canShareAlbum = Boolean(input.albumId);
    const hasLockedControls = isLibraryVisible || showAcquisition;
    const optionalControls =
        input.hasAddAllToQueue ||
        isLibraryVisible ||
        canShowAlbumPreference ||
        canShareAlbum;

    return {
        acquisitionMbid,
        isOwned,
        isLibraryVisible,
        showAcquisition,
        hasLockedControls,
        canShowAddAllToQueue: input.hasAddAllToQueue,
        canShowAddToPlaylist: isLibraryVisible,
        canShowAlbumPreference,
        canShareAlbum,
        hasActionControls: input.isInListenTogetherGroup
            ? hasLockedControls || optionalControls
            : isLibraryVisible || showAcquisition || optionalControls,
    };
}

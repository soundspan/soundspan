import { useAlbumAcquisition } from "./useAlbumAcquisition";
import { useAlbumPlaybackActions } from "./useAlbumPlaybackActions";
import {
    useAlbumLikedState,
    useAlbumPreferenceActions,
} from "./useAlbumPreferenceActions";

/** Composes focused album playback, acquisition, and preference actions. */
export function useAlbumActions() {
    const playback = useAlbumPlaybackActions();
    const downloadAlbum = useAlbumAcquisition();
    const preference = useAlbumPreferenceActions();
    return { ...playback, downloadAlbum, ...preference };
}

export { useAlbumLikedState };

/**
 * TIDAL account mode shared by streaming, availability, and background jobs.
 *
 * By default each user links their own TIDAL account. When an admin turns on
 * `tidalStreamingUseInstanceAccount`, every user shares the instance (download)
 * account through one sidecar session keyed by `TIDAL_INSTANCE_SESSION_ID`.
 * This module has no runtime dependencies so availability checks can use it
 * without loading the sidecar client.
 */

/** Sidecar session key used by every user while the instance account is shared. */
export const TIDAL_INSTANCE_SESSION_ID = "soundspan-instance";

/** System settings fields that decide the TIDAL account mode. */
export interface TidalAccountModeSettings {
    tidalEnabled?: boolean | null;
    tidalStreamingUseInstanceAccount?: boolean | null;
}

/**
 * TIDAL quality for a user's Playback streaming quality while the instance
 * account is shared. TIDAL has no 192 kbps tier, so Medium rounds up to
 * AAC 320; Original (lossless) asks for TIDAL's best (Max / Hi-Res).
 */
const TIDAL_QUALITY_BY_PLAYBACK_QUALITY: Record<string, string> = {
    original: "HI_RES_LOSSLESS",
    high: "HIGH",
    medium: "HIGH",
    low: "LOW",
};

/** Maps a Playback quality setting to a TIDAL quality, defaulting to HIGH. */
export function tidalQualityForPlaybackQuality(
    playbackQuality: string | null | undefined,
): string {
    return (
        (playbackQuality &&
            TIDAL_QUALITY_BY_PLAYBACK_QUALITY[playbackQuality]) ||
        "HIGH"
    );
}

/** Returns whether every user should use the instance TIDAL account. */
export function usesTidalInstanceAccount(
    settings: TidalAccountModeSettings | null | undefined,
): boolean {
    return (
        settings?.tidalEnabled === true &&
        settings?.tidalStreamingUseInstanceAccount === true
    );
}

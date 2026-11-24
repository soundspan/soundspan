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

/** Returns whether every user should use the instance TIDAL account. */
export function usesTidalInstanceAccount(
    settings: TidalAccountModeSettings | null | undefined,
): boolean {
    return (
        settings?.tidalEnabled === true &&
        settings?.tidalStreamingUseInstanceAccount === true
    );
}

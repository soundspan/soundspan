import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { hasConnectedProviderToken } from "../libraryTrackPreferences";
import {
    DEFAULT_PLAYBACK_SOURCE_ORDER,
    parsePlaybackSourceOrder,
} from "../playbackSourcePriority";
import type { ConnectedRemoteProviders, RemoteLibraryAccess } from "./types";

const NO_PROVIDERS: ConnectedRemoteProviders = {
    tidal: false,
    youtube: false,
};

/** Loads system flags, credentials, and playback order once for one user. */
export async function loadRemoteLibraryAccess(
    userId: string | undefined,
): Promise<RemoteLibraryAccess> {
    if (!userId) {
        return {
            providers: NO_PROVIDERS,
            playbackSourceOrder: DEFAULT_PLAYBACK_SOURCE_ORDER,
        };
    }
    const [userSettings, systemSettings] = await Promise.all([
        prisma.userSettings.findUnique({
            where: { userId },
            select: { tidalOAuthJson: true, ytMusicOAuthJson: true },
        }),
        getSystemSettings(),
    ]);
    return {
        providers: {
            tidal:
                systemSettings?.tidalEnabled === true &&
                hasConnectedProviderToken(userSettings?.tidalOAuthJson),
            // YouTube Music playback has an authenticated public fallback.
            youtube: systemSettings?.ytMusicEnabled === true,
        },
        playbackSourceOrder: parsePlaybackSourceOrder(
            systemSettings?.playbackSourceOrder,
        ),
    };
}

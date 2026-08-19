import type { Prisma } from "@prisma/client";

/** Prefix for the user-and-station key stored in `Playlist.mixId`. */
export const RADIO_PLAYLIST_MIX_ID_PREFIX = "radio-ephemeral:";

/** Builds the ordinary playlist-list filter that omits generated stations. */
export function standardPlaylistListWhere(
    userId: string,
): Prisma.PlaylistWhereInput {
    return {
        AND: [
            { OR: [{ userId }, { isPublic: true }] },
            {
                OR: [
                    { mixId: null },
                    {
                        NOT: {
                            mixId: {
                                startsWith: RADIO_PLAYLIST_MIX_ID_PREFIX,
                            },
                        },
                    },
                ],
            },
        ],
    };
}

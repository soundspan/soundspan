import { z } from "zod";

const playlistOwnerSchema = z.object({
    displayName: z.string().min(1).max(200),
});

/** Forward-compatible public playlist summary received from a peer. */
export const federationPlaylistSummarySchema = z.object({
    remoteId: z.string().min(1).max(256),
    name: z.string().min(1).max(200),
    trackCount: z.number().int().min(0).max(1_000_000),
    updatedAt: z.iso.datetime({ offset: true }),
    owner: playlistOwnerSchema,
});

/** Forward-compatible bounded playlist page received from a peer. */
export const federationPlaylistPageSchema = z.object({
    playlists: z.array(federationPlaylistSummarySchema).max(100),
    nextOffset: z.number().int().min(0).nullable().default(null),
});

/** Forward-compatible public playlist track received from a peer. */
export const federationPlaylistTrackSchema = z.object({
    remoteTrackId: z.string().min(1).max(256),
    title: z.string().min(1).max(2_000),
    artist: z.string().min(1).max(1_000),
    album: z.string().min(1).max(2_000),
    duration: z.number().int().min(0).max(86_400),
});

/** Forward-compatible bounded playlist detail received from a peer. */
export const federationPlaylistDetailSchema = z.object({
    playlist: z.object({
        remoteId: z.string().min(1).max(256),
        name: z.string().min(1).max(200),
        owner: playlistOwnerSchema,
        updatedAt: z.iso.datetime({ offset: true }),
        tracks: z.array(federationPlaylistTrackSchema).max(1_000),
    }),
});

export type FederationPlaylistPage = z.infer<
    typeof federationPlaylistPageSchema
>;
export type FederationPlaylistDetail = z.infer<
    typeof federationPlaylistDetailSchema
>;
export type FederationPlaylistTrack = z.infer<
    typeof federationPlaylistTrackSchema
>;

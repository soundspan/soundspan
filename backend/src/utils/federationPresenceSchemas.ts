import { z } from "zod";

/** Forward-compatible wire parser for an optionally shared current track. */
export const federationPresenceTrackSchema = z.object({
    title: z.string().min(1).max(2_000),
    artist: z.string().min(1).max(1_000),
    album: z.string().min(1).max(2_000),
});

/** Forward-compatible wire parser for one exported peer-presence user. */
export const federationPresenceUserSchema = z.object({
    username: z.string().min(1).max(120),
    displayName: z.string().min(1).max(120).optional(),
    status: z.enum(["playing", "paused", "idle"]),
    track: federationPresenceTrackSchema.optional(),
    updatedAt: z.iso.datetime({ offset: true }),
});

/** Bounded federation presence response parser. */
export const federationPresenceSchema = z.object({
    users: z.array(federationPresenceUserSchema).max(100),
});

/** Versioned Redis snapshot parser with peer provenance and fetch freshness. */
export const federationPeerPresenceSnapshotSchema = z.object({
    peerId: z.string().min(1).max(128),
    peerName: z.string().min(1).max(120),
    users: z.array(federationPresenceUserSchema).max(100),
    fetchedAt: z.iso.datetime({ offset: true }),
});

/** Validated federation presence response. */
export type FederationPresence = z.infer<typeof federationPresenceSchema>;
/** One privacy-filtered user in a federation presence response. */
export type FederationPresenceUser = z.infer<
    typeof federationPresenceUserSchema
>;
/** Cached consumer snapshot merged into the local social roster. */
export type FederationPeerPresenceSnapshot = z.infer<
    typeof federationPeerPresenceSnapshotSchema
>;

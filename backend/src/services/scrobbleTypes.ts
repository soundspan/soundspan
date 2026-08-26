import { z } from "zod";

/** Supported outbound scrobbling services. */
export const SCROBBLE_SERVICES = ["lastfm", "listenbrainz"] as const;
export type ScrobbleService = (typeof SCROBBLE_SERVICES)[number];

/** Closed submission modes accepted by both provider adapters. */
export type ScrobbleKind = "scrobble" | "now_playing";

/** Provider-neutral music metadata stored in a durable queue job. */
export interface ScrobbleTrack {
    artist: string;
    title: string;
    album?: string;
    durationSeconds?: number;
}

/** Durable, secret-free payload for one provider submission. */
export interface ScrobbleJobData {
    service: ScrobbleService;
    userId: string;
    kind: ScrobbleKind;
    listenedAtSeconds: number;
    track: ScrobbleTrack;
}

/** Runtime queue boundary for durable jobs that may outlive a deployment. */
export const scrobbleJobSchema: z.ZodType<ScrobbleJobData> = z.strictObject({
    service: z.enum(SCROBBLE_SERVICES),
    userId: z.string().min(1).max(128),
    kind: z.enum(["scrobble", "now_playing"]),
    listenedAtSeconds: z.number().int().safe().positive(),
    track: z.strictObject({
        artist: z.string().min(1).max(1_000),
        title: z.string().min(1).max(1_000),
        album: z.string().max(1_000).optional(),
        durationSeconds: z.number().int().nonnegative().max(604_800).optional(),
    }),
});

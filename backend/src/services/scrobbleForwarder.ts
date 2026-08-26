import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import type {
    ScrobbleKind,
    ScrobbleJobData,
    ScrobbleTrack,
} from "./scrobbleTypes";
import { SCROBBLE_SERVICES } from "./scrobbleTypes";

const log = logger.child("ScrobbleForwarder");

export interface ScrobbleForwardingEvent {
    userId: string;
    mediaType: "music" | "audiobook" | "podcast";
    kind: ScrobbleKind;
    listenedAt: Date;
    track: ScrobbleTrack;
}

export type MusicTrackReference =
    | { source: "local"; id: string }
    | { source: "tidal"; id: string }
    | { source: "youtube"; id: string };

export interface TrackReferenceEvent {
    userId: string;
    mediaType: "music" | "audiobook" | "podcast";
    kind: ScrobbleKind;
    listenedAt: Date;
    reference: MusicTrackReference;
}

async function resolveTrack(
    reference: MusicTrackReference,
): Promise<ScrobbleTrack | null> {
    if (reference.source === "local") {
        const track = await prisma.track.findUnique({
            where: { id: reference.id },
            select: {
                title: true,
                duration: true,
                album: {
                    select: { title: true, artist: { select: { name: true } } },
                },
            },
        });
        return track
            ? {
                  title: track.title,
                  artist: track.album.artist.name,
                  album: track.album.title,
                  durationSeconds: track.duration,
              }
            : null;
    }
    const selection = {
        title: true,
        artist: true,
        album: true,
        duration: true,
    } as const;
    const track =
        reference.source === "tidal"
            ? await prisma.trackTidal.findUnique({
                  where: { id: reference.id },
                  select: selection,
              })
            : await prisma.trackYtMusic.findUnique({
                  where: { id: reference.id },
                  select: selection,
              });
    return track
        ? {
              title: track.title,
              artist: track.artist,
              album: track.album,
              durationSeconds: track.duration,
          }
        : null;
}

/** Fans a music event out to each enabled, connected provider queue lane. */
export async function forwardScrobble(
    event: ScrobbleForwardingEvent,
): Promise<void> {
    if (event.mediaType !== "music") return;
    const connections = await prisma.scrobbleConnection.findMany({
        where: {
            userId: event.userId,
            enabled: true,
            encryptedCredential: { not: null },
            service: { in: [...SCROBBLE_SERVICES] },
        },
        select: { service: true },
        take: 2,
        orderBy: { service: "asc" },
    });
    const listenedAtSeconds = Math.floor(event.listenedAt.getTime() / 1000);
    const { scrobbleQueue } = await import("../workers/queues");
    const jobs = connections.map((connection) => {
        const data: ScrobbleJobData = {
            service: connection.service as ScrobbleJobData["service"],
            userId: event.userId,
            kind: event.kind,
            listenedAtSeconds,
            track: event.track,
        };
        return scrobbleQueue.add("submit", data);
    });
    const results = await Promise.allSettled(jobs);
    if (results.some((result) => result.status === "rejected")) {
        log.warn("One or more scrobble jobs could not be queued", {
            userId: event.userId,
        });
    }
}

/** Runs forwarding without allowing queue or lookup failures into play requests. */
export function forwardScrobbleIsolated(event: ScrobbleForwardingEvent): void {
    void forwardScrobble(event).catch((error: unknown) => {
        log.warn("Scrobble forwarding enqueue failed", {
            userId: event.userId,
            error,
        });
    });
}

/** Resolves provider-neutral music metadata and queues forwarding in isolation. */
export function forwardTrackReferenceIsolated(
    event: TrackReferenceEvent,
): void {
    if (event.mediaType !== "music") return;
    void resolveTrack(event.reference)
        .then((track) => {
            if (!track) return;
            return forwardScrobble({ ...event, track });
        })
        .catch((error: unknown) => {
            log.warn("Scrobble track resolution or enqueue failed", {
                userId: event.userId,
                error,
            });
        });
}

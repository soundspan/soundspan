import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const log = logger.child("ListenTogetherResolution");

export type ResolvedSource =
    | { available: true; source: "local"; trackId: string }
    | {
          available: true;
          source: "tidal";
          tidalTrackId: number;
          trackTidalId: string;
      }
    | {
          available: true;
          source: "youtube";
          youtubeVideoId: string;
          trackYtMusicId: string;
      }
    | {
          available: false;
          reason:
              | "no-provider"
              | "no-mapping"
              | "duration-mismatch"
              | "low-confidence"
              | "stale";
      };

export interface UserProviderProfile {
    userId: string;
    hasLocal: true;
    hasTidal: boolean;
    hasYtMusic: boolean;
}

export interface TrackResolutionInput {
    id: string;
    duration: number;
    localTrackId?: string;
    trackMappingId?: string;
    trackTidalId?: string;
    trackYtMusicId?: string;
    tidalTrackId?: number;
    youtubeVideoId?: string;
    originSource?: "local" | "tidal" | "youtube";
}

const PROFILE_CACHE_TTL_MS = 60_000;
const DURATION_MISMATCH_THRESHOLD_SECONDS = 15;
const MIN_MAPPING_CONFIDENCE = 0.7;

const profileCache = new Map<
    string,
    { expiresAt: number; profile: UserProviderProfile }
>();

function hasToken(value: string | null | undefined): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

function hasDurationMismatch(expectedSeconds: number, actualSeconds: number): boolean {
    if (!Number.isFinite(expectedSeconds) || !Number.isFinite(actualSeconds)) {
        return false;
    }
    return (
        Math.abs(Math.trunc(expectedSeconds) - Math.trunc(actualSeconds)) >
        DURATION_MISMATCH_THRESHOLD_SECONDS
    );
}

/**
 * Returns cached per-user provider connectivity flags used for queue resolution.
 */
export async function getUserProviderProfile(
    userId: string
): Promise<UserProviderProfile> {
    const cached = profileCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.profile;
    }

    const [settings, systemSettings] = await Promise.all([
        prisma.userSettings.findUnique({
            where: { userId },
            select: {
                tidalOAuthJson: true,
            },
        }),
        prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { ytMusicEnabled: true },
        }),
    ]);

    const profile: UserProviderProfile = {
        userId,
        hasLocal: true,
        hasTidal: hasToken(settings?.tidalOAuthJson),
        // YouTube playback/search has a public fallback path and should not require
        // per-user OAuth connectivity to mark tracks playable. Still respect
        // global system-level YouTube enablement.
        hasYtMusic: systemSettings?.ytMusicEnabled !== false,
    };

    profileCache.set(userId, {
        profile,
        expiresAt: Date.now() + PROFILE_CACHE_TTL_MS,
    });
    return profile;
}

type MappingWithTargets = {
    id: string;
    stale: boolean;
    confidence: number;
    trackId: string | null;
    trackTidal: { id: string; tidalId: number; duration: number } | null;
    trackYtMusic: { id: string; videoId: string; duration: number } | null;
};

interface ResolveTrackContext {
    mappingsById?: Map<string, MappingWithTargets>;
    trackTidalById?: Map<string, { id: string; tidalId: number; duration: number }>;
    trackYtById?: Map<string, { id: string; videoId: string; duration: number }>;
}

async function loadMapping(
    mappingId: string,
    context?: ResolveTrackContext
): Promise<MappingWithTargets | null> {
    const cached = context?.mappingsById?.get(mappingId);
    if (cached) return cached;

    log.debug(`Loading mapping ${mappingId} for track resolution`);
    const mapping = await prisma.trackMapping.findUnique({
        where: { id: mappingId },
        select: {
            id: true,
            stale: true,
            confidence: true,
            trackId: true,
            trackTidal: {
                select: {
                    id: true,
                    tidalId: true,
                    duration: true,
                },
            },
            trackYtMusic: {
                select: {
                    id: true,
                    videoId: true,
                    duration: true,
                },
            },
        },
    });
    return mapping;
}

/**
 * Resolves a queue item to the best available source for a given user profile.
 */
export async function resolveTrackForUser(
    item: TrackResolutionInput,
    profile: UserProviderProfile,
    context?: ResolveTrackContext
): Promise<ResolvedSource> {
    const localTrackId =
        item.localTrackId ??
        (item.originSource === "local" ? item.id : undefined);
    if (localTrackId) {
        return { available: true, source: "local", trackId: localTrackId };
    }

    if (item.trackMappingId) {
        const mapping = await loadMapping(item.trackMappingId, context);
        if (!mapping) {
            return { available: false, reason: "no-mapping" };
        }
        if (mapping.stale) {
            return { available: false, reason: "stale" };
        }
        if (mapping.trackId) {
            return { available: true, source: "local", trackId: mapping.trackId };
        }

        if (!profile.hasTidal && !profile.hasYtMusic) {
            return { available: false, reason: "no-provider" };
        }
        if (mapping.confidence < MIN_MAPPING_CONFIDENCE) {
            return { available: false, reason: "low-confidence" };
        }

        if (mapping.trackTidal && profile.hasTidal) {
            if (hasDurationMismatch(item.duration, mapping.trackTidal.duration)) {
                return { available: false, reason: "duration-mismatch" };
            }
            return {
                available: true,
                source: "tidal",
                tidalTrackId: mapping.trackTidal.tidalId,
                trackTidalId: mapping.trackTidal.id,
            };
        }

        if (mapping.trackYtMusic && profile.hasYtMusic) {
            if (hasDurationMismatch(item.duration, mapping.trackYtMusic.duration)) {
                return { available: false, reason: "duration-mismatch" };
            }
            return {
                available: true,
                source: "youtube",
                youtubeVideoId: mapping.trackYtMusic.videoId,
                trackYtMusicId: mapping.trackYtMusic.id,
            };
        }

        return { available: false, reason: "no-provider" };
    }

    if (item.trackTidalId || typeof item.tidalTrackId === "number") {
        // Resolve the TrackTidal row so we have a stable DB ID for both
        // direct playback and cross-provider mapping lookups.
        let tidalTrack = item.trackTidalId
            ? context?.trackTidalById?.get(item.trackTidalId)
            : undefined;
        if (!tidalTrack && item.trackTidalId) {
            tidalTrack = (await prisma.trackTidal.findUnique({
                where: { id: item.trackTidalId },
                select: { id: true, tidalId: true, duration: true },
            })) ?? undefined;
        }
        if (!tidalTrack && typeof item.tidalTrackId === "number") {
            tidalTrack = (await prisma.trackTidal.findUnique({
                where: { tidalId: item.tidalTrackId },
                select: { id: true, tidalId: true, duration: true },
            })) ?? undefined;
        }

        if (profile.hasTidal && tidalTrack) {
            return {
                available: true,
                source: "tidal",
                tidalTrackId: tidalTrack.tidalId,
                trackTidalId: tidalTrack.id,
            };
        }

        // Tidal unavailable or track not found — try cross-provider fallback
        // via TrackMapping to find a YouTube link for the same track.
        const resolvedTidalId = tidalTrack?.id ?? item.trackTidalId;
        if (profile.hasYtMusic && resolvedTidalId) {
            const crossMapping = await prisma.trackMapping.findFirst({
                where: {
                    stale: false,
                    trackTidalId: resolvedTidalId,
                    trackYtMusicId: { not: null },
                },
                select: {
                    confidence: true,
                    trackYtMusic: {
                        select: { id: true, videoId: true, duration: true },
                    },
                },
                orderBy: { confidence: "desc" },
            });
            if (
                crossMapping?.trackYtMusic &&
                crossMapping.confidence >= MIN_MAPPING_CONFIDENCE
            ) {
                if (!hasDurationMismatch(item.duration, crossMapping.trackYtMusic.duration)) {
                    return {
                        available: true,
                        source: "youtube",
                        youtubeVideoId: crossMapping.trackYtMusic.videoId,
                        trackYtMusicId: crossMapping.trackYtMusic.id,
                    };
                }
            }
        }

        return { available: false, reason: resolvedTidalId ? "no-provider" : "no-mapping" };
    }

    if (item.trackYtMusicId || typeof item.youtubeVideoId === "string") {
        // Resolve the TrackYtMusic row so we have a stable DB ID for both
        // direct playback and cross-provider mapping lookups.
        let ytTrack = item.trackYtMusicId
            ? context?.trackYtById?.get(item.trackYtMusicId)
            : undefined;
        if (!ytTrack && item.trackYtMusicId) {
            ytTrack = (await prisma.trackYtMusic.findUnique({
                where: { id: item.trackYtMusicId },
                select: { id: true, videoId: true, duration: true },
            })) ?? undefined;
        }
        if (!ytTrack && typeof item.youtubeVideoId === "string") {
            ytTrack = (await prisma.trackYtMusic.findUnique({
                where: { videoId: item.youtubeVideoId },
                select: { id: true, videoId: true, duration: true },
            })) ?? undefined;
        }

        if (profile.hasYtMusic && ytTrack) {
            return {
                available: true,
                source: "youtube",
                youtubeVideoId: ytTrack.videoId,
                trackYtMusicId: ytTrack.id,
            };
        }

        // YouTube unavailable or track not found — try cross-provider fallback
        // via TrackMapping to find a Tidal link for the same track.
        const resolvedYtId = ytTrack?.id ?? item.trackYtMusicId;
        if (profile.hasTidal && resolvedYtId) {
            const crossMapping = await prisma.trackMapping.findFirst({
                where: {
                    stale: false,
                    trackYtMusicId: resolvedYtId,
                    trackTidalId: { not: null },
                },
                select: {
                    confidence: true,
                    trackTidal: {
                        select: { id: true, tidalId: true, duration: true },
                    },
                },
                orderBy: { confidence: "desc" },
            });
            if (
                crossMapping?.trackTidal &&
                crossMapping.confidence >= MIN_MAPPING_CONFIDENCE
            ) {
                if (!hasDurationMismatch(item.duration, crossMapping.trackTidal.duration)) {
                    return {
                        available: true,
                        source: "tidal",
                        tidalTrackId: crossMapping.trackTidal.tidalId,
                        trackTidalId: crossMapping.trackTidal.id,
                    };
                }
            }
        }

        return { available: false, reason: resolvedYtId ? "no-provider" : "no-mapping" };
    }

    return { available: false, reason: "no-mapping" };
}

/**
 * Resolves an entire queue to per-index availability for a specific user.
 */
export async function resolveQueueForUser(
    queue: TrackResolutionInput[],
    userId: string
): Promise<Map<number, ResolvedSource>> {
    const profile = await getUserProviderProfile(userId);

    const mappingIds = Array.from(
        new Set(
            queue
                .map((item) => item.trackMappingId)
                .filter((value): value is string => typeof value === "string")
        )
    );
    const trackTidalIds = Array.from(
        new Set(
            queue
                .map((item) => item.trackTidalId)
                .filter((value): value is string => typeof value === "string")
        )
    );
    const trackYtMusicIds = Array.from(
        new Set(
            queue
                .map((item) => item.trackYtMusicId)
                .filter((value): value is string => typeof value === "string")
        )
    );

    const [mappings, tidalTracks, ytTracks] = await Promise.all([
        mappingIds.length > 0
            ? prisma.trackMapping.findMany({
                  where: { id: { in: mappingIds } },
                  select: {
                      id: true,
                      stale: true,
                      confidence: true,
                      trackId: true,
                      trackTidal: {
                          select: { id: true, tidalId: true, duration: true },
                      },
                      trackYtMusic: {
                          select: { id: true, videoId: true, duration: true },
                      },
                  },
              })
            : Promise.resolve([]),
        trackTidalIds.length > 0
            ? prisma.trackTidal.findMany({
                  where: { id: { in: trackTidalIds } },
                  select: { id: true, tidalId: true, duration: true },
              })
            : Promise.resolve([]),
        trackYtMusicIds.length > 0
            ? prisma.trackYtMusic.findMany({
                  where: { id: { in: trackYtMusicIds } },
                  select: { id: true, videoId: true, duration: true },
              })
            : Promise.resolve([]),
    ]);

    const context: ResolveTrackContext = {
        mappingsById: new Map(mappings.map((mapping) => [mapping.id, mapping])),
        trackTidalById: new Map(tidalTracks.map((track) => [track.id, track])),
        trackYtById: new Map(ytTracks.map((track) => [track.id, track])),
    };

    const resolved = new Map<number, ResolvedSource>();
    for (let index = 0; index < queue.length; index += 1) {
        resolved.set(index, await resolveTrackForUser(queue[index], profile, context));
    }

    const available = Array.from(resolved.values()).filter((r) => r.available).length;
    log.debug(`Resolved queue for user ${userId}: ${available}/${queue.length} available`);

    return resolved;
}

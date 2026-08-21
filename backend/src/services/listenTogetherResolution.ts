import type { ResolvedMediaSource } from "@soundspan/media-metadata-contract";
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
    originSource?: ResolvedMediaSource;
}

type TidalTrack = { id: string; tidalId: number; duration: number };
type YouTubeTrack = { id: string; videoId: string; duration: number };

const PROFILE_CACHE_TTL_MS = 60_000;
const DURATION_MISMATCH_THRESHOLD_SECONDS = 15;
const MIN_MAPPING_CONFIDENCE = 0.7;

const profileCache = new Map<
    string,
    { expiresAt: number; profile: UserProviderProfile }
>();

interface ResolutionOptions {
    signal?: AbortSignal;
}

async function awaitResolutionOperation<T>(
    operation: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (!signal) return operation;
    signal.throwIfAborted();
    let rejectAbort: (reason?: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        return await Promise.race([operation, aborted]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

function hasToken(value: string | null | undefined): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

function hasDurationMismatch(
    expectedSeconds: number,
    actualSeconds: number,
): boolean {
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
    userId: string,
    options: ResolutionOptions = {},
): Promise<UserProviderProfile> {
    options.signal?.throwIfAborted();
    const cached = profileCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.profile;
    }

    const [settings, systemSettings] = await awaitResolutionOperation(
        Promise.all([
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
        ]),
        options.signal,
    );

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
    trackTidalById?: Map<string, TidalTrack>;
    signal?: AbortSignal;
    trackYtById?: Map<string, YouTubeTrack>;
}

async function loadMapping(
    mappingId: string,
    context?: ResolveTrackContext,
): Promise<MappingWithTargets | null> {
    const cached = context?.mappingsById?.get(mappingId);
    if (cached) return cached;

    log.debug(`Loading mapping ${mappingId} for track resolution`);
    const mapping = await awaitResolutionOperation(
        prisma.trackMapping.findUnique({
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
        }),
        context?.signal,
    );
    return mapping;
}

async function resolveMappedTrack(
    item: TrackResolutionInput,
    profile: UserProviderProfile,
    context?: ResolveTrackContext,
): Promise<ResolvedSource> {
    const mapping = await loadMapping(item.trackMappingId!, context);
    if (!mapping) return { available: false, reason: "no-mapping" };
    if (mapping.stale) return { available: false, reason: "stale" };
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

async function loadTidalTrack(
    item: TrackResolutionInput,
    context?: ResolveTrackContext,
): Promise<TidalTrack | undefined> {
    let track = item.trackTidalId
        ? context?.trackTidalById?.get(item.trackTidalId)
        : undefined;
    if (!track && item.trackTidalId) {
        track =
            (await awaitResolutionOperation(
                prisma.trackTidal.findUnique({
                    where: { id: item.trackTidalId },
                    select: { id: true, tidalId: true, duration: true },
                }),
                context?.signal,
            )) ?? undefined;
    }
    if (!track && typeof item.tidalTrackId === "number") {
        track =
            (await awaitResolutionOperation(
                prisma.trackTidal.findUnique({
                    where: { tidalId: item.tidalTrackId },
                    select: { id: true, tidalId: true, duration: true },
                }),
                context?.signal,
            )) ?? undefined;
    }
    return track;
}

async function findYouTubeFallback(
    item: TrackResolutionInput,
    tidalTrackId: string,
    context?: ResolveTrackContext,
): Promise<ResolvedSource | null> {
    const crossMapping = await awaitResolutionOperation(
        prisma.trackMapping.findFirst({
            where: {
                stale: false,
                trackTidalId: tidalTrackId,
                trackYtMusicId: { not: null },
            },
            select: {
                confidence: true,
                trackYtMusic: {
                    select: { id: true, videoId: true, duration: true },
                },
            },
            orderBy: { confidence: "desc" },
        }),
        context?.signal,
    );
    if (
        !crossMapping?.trackYtMusic ||
        crossMapping.confidence < MIN_MAPPING_CONFIDENCE ||
        hasDurationMismatch(item.duration, crossMapping.trackYtMusic.duration)
    ) {
        return null;
    }
    return {
        available: true,
        source: "youtube",
        youtubeVideoId: crossMapping.trackYtMusic.videoId,
        trackYtMusicId: crossMapping.trackYtMusic.id,
    };
}

async function resolveTidalTrack(
    item: TrackResolutionInput,
    profile: UserProviderProfile,
    context?: ResolveTrackContext,
): Promise<ResolvedSource> {
    const tidalTrack = await loadTidalTrack(item, context);
    if (profile.hasTidal && tidalTrack) {
        return {
            available: true,
            source: "tidal",
            tidalTrackId: tidalTrack.tidalId,
            trackTidalId: tidalTrack.id,
        };
    }
    const resolvedTidalId = tidalTrack?.id ?? item.trackTidalId;
    if (profile.hasYtMusic && resolvedTidalId) {
        const fallback = await findYouTubeFallback(
            item,
            resolvedTidalId,
            context,
        );
        if (fallback) return fallback;
    }
    return {
        available: false,
        reason: resolvedTidalId ? "no-provider" : "no-mapping",
    };
}

async function loadYouTubeTrack(
    item: TrackResolutionInput,
    context?: ResolveTrackContext,
): Promise<YouTubeTrack | undefined> {
    let track = item.trackYtMusicId
        ? context?.trackYtById?.get(item.trackYtMusicId)
        : undefined;
    if (!track && item.trackYtMusicId) {
        track =
            (await awaitResolutionOperation(
                prisma.trackYtMusic.findUnique({
                    where: { id: item.trackYtMusicId },
                    select: { id: true, videoId: true, duration: true },
                }),
                context?.signal,
            )) ?? undefined;
    }
    if (!track && typeof item.youtubeVideoId === "string") {
        track =
            (await awaitResolutionOperation(
                prisma.trackYtMusic.findUnique({
                    where: { videoId: item.youtubeVideoId },
                    select: { id: true, videoId: true, duration: true },
                }),
                context?.signal,
            )) ?? undefined;
    }
    return track;
}

async function findTidalFallback(
    item: TrackResolutionInput,
    youtubeTrackId: string,
    context?: ResolveTrackContext,
): Promise<ResolvedSource | null> {
    const crossMapping = await awaitResolutionOperation(
        prisma.trackMapping.findFirst({
            where: {
                stale: false,
                trackYtMusicId: youtubeTrackId,
                trackTidalId: { not: null },
            },
            select: {
                confidence: true,
                trackTidal: {
                    select: { id: true, tidalId: true, duration: true },
                },
            },
            orderBy: { confidence: "desc" },
        }),
        context?.signal,
    );
    if (
        !crossMapping?.trackTidal ||
        crossMapping.confidence < MIN_MAPPING_CONFIDENCE ||
        hasDurationMismatch(item.duration, crossMapping.trackTidal.duration)
    ) {
        return null;
    }
    return {
        available: true,
        source: "tidal",
        tidalTrackId: crossMapping.trackTidal.tidalId,
        trackTidalId: crossMapping.trackTidal.id,
    };
}

async function resolveYouTubeTrack(
    item: TrackResolutionInput,
    profile: UserProviderProfile,
    context?: ResolveTrackContext,
): Promise<ResolvedSource> {
    const ytTrack = await loadYouTubeTrack(item, context);
    if (profile.hasYtMusic && ytTrack) {
        return {
            available: true,
            source: "youtube",
            youtubeVideoId: ytTrack.videoId,
            trackYtMusicId: ytTrack.id,
        };
    }
    const resolvedYtId = ytTrack?.id ?? item.trackYtMusicId;
    if (profile.hasTidal && resolvedYtId) {
        const fallback = await findTidalFallback(item, resolvedYtId, context);
        if (fallback) return fallback;
    }
    return {
        available: false,
        reason: resolvedYtId ? "no-provider" : "no-mapping",
    };
}

/**
 * Resolves a queue item to the best available source for a given user profile.
 */
export async function resolveTrackForUser(
    item: TrackResolutionInput,
    profile: UserProviderProfile,
    context?: ResolveTrackContext,
): Promise<ResolvedSource> {
    context?.signal?.throwIfAborted();
    const localTrackId =
        item.localTrackId ??
        (item.originSource === "local" ? item.id : undefined);
    if (localTrackId) {
        return { available: true, source: "local", trackId: localTrackId };
    }

    if (item.trackMappingId) {
        return resolveMappedTrack(item, profile, context);
    }

    if (item.trackTidalId || typeof item.tidalTrackId === "number") {
        return resolveTidalTrack(item, profile, context);
    }

    if (item.trackYtMusicId || typeof item.youtubeVideoId === "string") {
        return resolveYouTubeTrack(item, profile, context);
    }

    return { available: false, reason: "no-mapping" };
}

function collectQueueIds(
    queue: TrackResolutionInput[],
    select: (item: TrackResolutionInput) => string | undefined,
): string[] {
    return Array.from(
        new Set(
            queue
                .map(select)
                .filter((value): value is string => typeof value === "string"),
        ),
    );
}

async function preloadMappings(ids: string[]): Promise<MappingWithTargets[]> {
    if (ids.length === 0) return [];
    return prisma.trackMapping.findMany({
        where: { id: { in: ids } },
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
    });
}

async function preloadTidalTracks(ids: string[]): Promise<TidalTrack[]> {
    if (ids.length === 0) return [];
    return prisma.trackTidal.findMany({
        where: { id: { in: ids } },
        select: { id: true, tidalId: true, duration: true },
    });
}

async function preloadYouTubeTracks(ids: string[]): Promise<YouTubeTrack[]> {
    if (ids.length === 0) return [];
    return prisma.trackYtMusic.findMany({
        where: { id: { in: ids } },
        select: { id: true, videoId: true, duration: true },
    });
}

async function preloadResolutionContext(
    queue: TrackResolutionInput[],
    signal?: AbortSignal,
): Promise<ResolveTrackContext> {
    const mappingIds = collectQueueIds(queue, (item) => item.trackMappingId);
    const tidalIds = collectQueueIds(queue, (item) => item.trackTidalId);
    const youtubeIds = collectQueueIds(queue, (item) => item.trackYtMusicId);
    const [mappings, tidalTracks, ytTracks] = await awaitResolutionOperation(
        Promise.all([
            preloadMappings(mappingIds),
            preloadTidalTracks(tidalIds),
            preloadYouTubeTracks(youtubeIds),
        ]),
        signal,
    );
    return {
        mappingsById: new Map(mappings.map((mapping) => [mapping.id, mapping])),
        trackTidalById: new Map(tidalTracks.map((track) => [track.id, track])),
        trackYtById: new Map(ytTracks.map((track) => [track.id, track])),
        signal,
    };
}

async function resolveQueueItems(
    queue: TrackResolutionInput[],
    profile: UserProviderProfile,
    context: ResolveTrackContext,
): Promise<Map<number, ResolvedSource>> {
    const resolved = new Map<number, ResolvedSource>();
    for (let index = 0; index < queue.length; index += 1) {
        context.signal?.throwIfAborted();
        resolved.set(
            index,
            await resolveTrackForUser(queue[index], profile, context),
        );
    }
    return resolved;
}

/**
 * Resolves an entire queue to per-index availability for a specific user.
 */
export async function resolveQueueForUser(
    queue: TrackResolutionInput[],
    userId: string,
    options: ResolutionOptions = {},
): Promise<Map<number, ResolvedSource>> {
    const profile = await getUserProviderProfile(userId, options);
    const context = await preloadResolutionContext(queue, options.signal);
    const resolved = await resolveQueueItems(queue, profile, context);

    const available = Array.from(resolved.values()).filter(
        (r) => r.available,
    ).length;
    log.debug(
        `Resolved queue for user ${userId}: ${available}/${queue.length} available`,
    );

    return resolved;
}

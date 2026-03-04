import { prisma } from "../utils/db";
import {
    getUserProviderProfile,
    resolveQueueForUser,
    type ResolvedSource,
    type TrackResolutionInput,
    type UserProviderProfile,
} from "./listenTogetherResolution";
import type {
    UnifiedLocalTrackRecord,
    UnifiedPlaylistItemRecord,
    UnifiedTrackTidalRecord,
    UnifiedTrackYtMusicRecord,
} from "./unifiedTrackResponse";

interface MappingLinkageRow {
    id: string;
    source: string;
    confidence: number;
    createdAt: Date;
    trackId: string | null;
    trackTidalId: string | null;
    trackYtMusicId: string | null;
}

const SOURCE_PRIORITY: Record<string, number> = {
    manual: 4,
    isrc: 3,
    "import-match": 2,
    "gap-fill": 1,
};

const FALLBACK_UNRESOLVED: ResolvedSource = {
    available: false,
    reason: "no-mapping",
};

function sourcePriority(source: string): number {
    return SOURCE_PRIORITY[source] ?? 0;
}

function compareMappings(
    left: MappingLinkageRow,
    right: MappingLinkageRow
): number {
    const sourceDiff = sourcePriority(right.source) - sourcePriority(left.source);
    if (sourceDiff !== 0) return sourceDiff;

    const confidenceDiff = right.confidence - left.confidence;
    if (confidenceDiff !== 0) return confidenceDiff;

    const createdAtDiff = right.createdAt.getTime() - left.createdAt.getTime();
    if (createdAtDiff !== 0) return createdAtDiff;

    return right.id.localeCompare(left.id);
}

function getMappingTokens(mapping: MappingLinkageRow): string[] {
    const tokens: string[] = [];
    if (mapping.trackId) tokens.push(`l:${mapping.trackId}`);
    if (mapping.trackTidalId) tokens.push(`t:${mapping.trackTidalId}`);
    if (mapping.trackYtMusicId) tokens.push(`y:${mapping.trackYtMusicId}`);
    return tokens;
}

function getItemToken(item: UnifiedPlaylistItemRecord): string | null {
    if (item.trackId) return `l:${item.trackId}`;
    if (item.trackTidalId) return `t:${item.trackTidalId}`;
    if (item.trackYtMusicId) return `y:${item.trackYtMusicId}`;
    return null;
}

function selectPreferredMappingForItem(
    candidates: MappingLinkageRow[],
    profile: UserProviderProfile
): MappingLinkageRow | undefined {
    if (candidates.length === 0) return undefined;
    const ranked = [...candidates].sort(compareMappings);

    const localCandidate = ranked.find((candidate) => candidate.trackId !== null);
    if (localCandidate) return localCandidate;

    if (profile.hasTidal) {
        const tidalCandidate = ranked.find(
            (candidate) => candidate.trackTidalId !== null
        );
        if (tidalCandidate) return tidalCandidate;
    }

    if (profile.hasYtMusic) {
        const ytCandidate = ranked.find(
            (candidate) => candidate.trackYtMusicId !== null
        );
        if (ytCandidate) return ytCandidate;
    }

    // Only return a mapping if it has at least one usable provider for this
    // user. Returning a provider-less mapping prevents the resolver from
    // falling through to cross-provider lookup paths.
    const usable = ranked.find(
        (c) =>
            c.trackId !== null ||
            (c.trackTidalId !== null && profile.hasTidal) ||
            (c.trackYtMusicId !== null && profile.hasYtMusic)
    );
    return usable;
}

function toResolutionInput(
    item: UnifiedPlaylistItemRecord,
    mappingId: string | undefined
): TrackResolutionInput {
    const rawDuration =
        item.track?.duration ??
        item.trackTidal?.duration ??
        item.trackYtMusic?.duration ??
        0;
    const duration = Number.isFinite(rawDuration)
        ? Math.max(0, Math.trunc(rawDuration))
        : 0;

    return {
        id: item.id,
        duration,
        localTrackId: item.trackId ?? undefined,
        trackMappingId: mappingId,
        trackTidalId: item.trackTidalId ?? undefined,
        trackYtMusicId: item.trackYtMusicId ?? undefined,
        tidalTrackId:
            typeof item.trackTidal?.tidalId === "number"
                ? item.trackTidal.tidalId
                : undefined,
        youtubeVideoId:
            typeof item.trackYtMusic?.videoId === "string" &&
            item.trackYtMusic.videoId.trim().length > 0
                ? item.trackYtMusic.videoId.trim()
                : undefined,
        originSource: item.track
            ? "local"
            : item.trackTidal
            ? "tidal"
            : item.trackYtMusic
            ? "youtube"
            : undefined,
    };
}

export interface ResolvedPlaylistItem {
    original: UnifiedPlaylistItemRecord;
    effective: UnifiedPlaylistItemRecord;
    resolution: ResolvedSource;
}

/**
 * Resolves playlist items to each viewer's best available source, reusing the
 * same per-user provider/mapping resolver contract as Listen Together.
 */
export async function resolvePlaylistItemsForUser(
    items: UnifiedPlaylistItemRecord[],
    userId: string
): Promise<ResolvedPlaylistItem[]> {
    if (items.length === 0) return [];

    const trackIds = Array.from(
        new Set(
            items
                .map((item) => item.trackId)
                .filter((value): value is string => typeof value === "string")
        )
    );
    const trackTidalIds = Array.from(
        new Set(
            items
                .map((item) => item.trackTidalId)
                .filter((value): value is string => typeof value === "string")
        )
    );
    const trackYtMusicIds = Array.from(
        new Set(
            items
                .map((item) => item.trackYtMusicId)
                .filter((value): value is string => typeof value === "string")
        )
    );

    const mappingWhereOr: Array<{
        trackId?: { in: string[] };
        trackTidalId?: { in: string[] };
        trackYtMusicId?: { in: string[] };
    }> = [];
    if (trackIds.length > 0) {
        mappingWhereOr.push({ trackId: { in: trackIds } });
    }
    if (trackTidalIds.length > 0) {
        mappingWhereOr.push({ trackTidalId: { in: trackTidalIds } });
    }
    if (trackYtMusicIds.length > 0) {
        mappingWhereOr.push({ trackYtMusicId: { in: trackYtMusicIds } });
    }

    const candidateMappings: MappingLinkageRow[] =
        mappingWhereOr.length > 0
            ? await prisma.trackMapping.findMany({
                  where: {
                      stale: false,
                      OR: mappingWhereOr,
                  },
                  select: {
                      id: true,
                      source: true,
                      confidence: true,
                      createdAt: true,
                      trackId: true,
                      trackTidalId: true,
                      trackYtMusicId: true,
                  },
              })
            : [];

    const mappingCandidatesByToken = new Map<string, MappingLinkageRow[]>();
    for (const mapping of candidateMappings) {
        for (const token of getMappingTokens(mapping)) {
            const existing = mappingCandidatesByToken.get(token) ?? [];
            existing.push(mapping);
            mappingCandidatesByToken.set(token, existing);
        }
    }
    const profile = await getUserProviderProfile(userId);

    const resolutionInputs = items.map((item) => {
        const token = getItemToken(item);
        const mappingId =
            token
                ? selectPreferredMappingForItem(
                      mappingCandidatesByToken.get(token) ?? [],
                      profile
                  )?.id
                : undefined;
        return toResolutionInput(item, mappingId);
    });
    const resolvedByIndex = await resolveQueueForUser(resolutionInputs, userId);

    const localById = new Map<string, UnifiedLocalTrackRecord>();
    const tidalById = new Map<string, UnifiedTrackTidalRecord>();
    const ytById = new Map<string, UnifiedTrackYtMusicRecord>();

    for (const item of items) {
        if (item.track?.id) {
            localById.set(item.track.id, item.track);
        }
        if (item.trackTidal?.id) {
            tidalById.set(item.trackTidal.id, item.trackTidal);
        }
        if (item.trackYtMusic?.id) {
            ytById.set(item.trackYtMusic.id, item.trackYtMusic);
        }
    }

    const missingLocalIds = new Set<string>();
    const missingTidalIds = new Set<string>();
    const missingYtIds = new Set<string>();

    for (let index = 0; index < items.length; index += 1) {
        const resolved = resolvedByIndex.get(index);
        if (!resolved || !resolved.available) continue;
        if (resolved.source === "local" && !localById.has(resolved.trackId)) {
            missingLocalIds.add(resolved.trackId);
        } else if (
            resolved.source === "tidal" &&
            !tidalById.has(resolved.trackTidalId)
        ) {
            missingTidalIds.add(resolved.trackTidalId);
        } else if (
            resolved.source === "youtube" &&
            !ytById.has(resolved.trackYtMusicId)
        ) {
            missingYtIds.add(resolved.trackYtMusicId);
        }
    }

    const [localRows, tidalRows, ytRows] = await Promise.all([
        missingLocalIds.size > 0
            ? prisma.track.findMany({
                  where: { id: { in: Array.from(missingLocalIds) } },
                  include: {
                      album: {
                          include: {
                              artist: {
                                  select: {
                                      id: true,
                                      name: true,
                                      mbid: true,
                                  },
                              },
                          },
                      },
                  },
              })
            : Promise.resolve([]),
        missingTidalIds.size > 0
            ? prisma.trackTidal.findMany({
                  where: { id: { in: Array.from(missingTidalIds) } },
              })
            : Promise.resolve([]),
        missingYtIds.size > 0
            ? prisma.trackYtMusic.findMany({
                  where: { id: { in: Array.from(missingYtIds) } },
              })
            : Promise.resolve([]),
    ]);

    for (const row of localRows) {
        localById.set(row.id, row as unknown as UnifiedLocalTrackRecord);
    }
    for (const row of tidalRows) {
        tidalById.set(row.id, row as unknown as UnifiedTrackTidalRecord);
    }
    for (const row of ytRows) {
        ytById.set(row.id, row as unknown as UnifiedTrackYtMusicRecord);
    }

    return items.map((item, index) => {
        const baseResolution = resolvedByIndex.get(index) ?? FALLBACK_UNRESOLVED;
        let effective = item;
        let resolution: ResolvedSource = baseResolution;

        if (baseResolution.available) {
            if (baseResolution.source === "local") {
                const localTrack = localById.get(baseResolution.trackId);
                if (localTrack) {
                    effective = {
                        ...item,
                        trackId: baseResolution.trackId,
                        trackTidalId: null,
                        trackYtMusicId: null,
                        track: localTrack,
                        trackTidal: null,
                        trackYtMusic: null,
                    };
                } else {
                    resolution = { available: false, reason: "no-mapping" };
                }
            } else if (baseResolution.source === "tidal") {
                const tidalTrack = tidalById.get(baseResolution.trackTidalId);
                if (tidalTrack) {
                    effective = {
                        ...item,
                        trackId: null,
                        trackTidalId: baseResolution.trackTidalId,
                        trackYtMusicId: null,
                        track: null,
                        trackTidal: tidalTrack,
                        trackYtMusic: null,
                    };
                } else {
                    resolution = { available: false, reason: "no-mapping" };
                }
            } else {
                const ytTrack = ytById.get(baseResolution.trackYtMusicId);
                if (ytTrack) {
                    effective = {
                        ...item,
                        trackId: null,
                        trackTidalId: null,
                        trackYtMusicId: baseResolution.trackYtMusicId,
                        track: null,
                        trackTidal: null,
                        trackYtMusic: ytTrack,
                    };
                } else {
                    resolution = { available: false, reason: "no-mapping" };
                }
            }
        }

        return {
            original: item,
            effective,
            resolution,
        };
    });
}

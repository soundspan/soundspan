import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { resolveArtistForRemoteTrack } from "./artistResolutionService";
import { resolveAlbumForRemoteTrack } from "./albumResolutionService";
import { updateArtistCounts } from "./artistCountsService";

const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("TrackMappingService")
        : logger;

const SOURCE_PRIORITY: Record<CreateMappingData["source"], number> = {
    manual: 4,
    isrc: 3,
    "import-match": 2,
    "gap-fill": 1,
};

interface MappingLinkage {
    trackId: string | null;
    trackTidalId: string | null;
    trackYtMusicId: string | null;
}

interface MappingCandidate extends MappingLinkage {
    id: string;
    confidence: number;
    source: string;
    createdAt: Date;
}

export interface UpsertTrackTidalData {
    tidalId: number;
    title: string;
    artist: string;
    album: string;
    duration: number;
    isrc?: string;
    quality?: string;
    explicit?: boolean;
}

export interface UpsertTrackYtMusicData {
    videoId: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    thumbnailUrl?: string;
}

export interface CreateMappingData {
    trackId?: string;
    trackTidalId?: string;
    trackYtMusicId?: string;
    confidence: number;
    source: "gap-fill" | "isrc" | "import-match" | "manual";
}

export interface EnsureRemoteTrackData {
    provider: "tidal" | "youtube";
    tidalId?: number;
    videoId?: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    isrc?: string;
    quality?: string;
    explicit?: boolean;
    thumbnailUrl?: string;
}

export interface EnsuredRemoteTrackResult {
    provider: "tidal" | "youtube";
    id: string;
    created: boolean;
}

const PLACEHOLDER_TITLES = new Set(["unknown", ""]);
const DEFAULT_PLACEHOLDER_DURATION = 180;

/**
 * Determines whether an incoming metadata field should be replaced by the existing value.
 * Returns true when the incoming value looks like a placeholder and the existing value is real.
 */
function shouldPreserveField(
    incoming: string,
    existing: string | null | undefined
): boolean {
    if (!existing) return false;
    return PLACEHOLDER_TITLES.has(incoming.toLowerCase().trim());
}

/**
 * Determines whether an incoming duration should be replaced by an existing real duration.
 */
function shouldPreserveDuration(
    incoming: number,
    existing: number | null | undefined
): boolean {
    if (existing == null || existing <= 0) return false;
    return incoming === DEFAULT_PLACEHOLDER_DURATION && existing !== DEFAULT_PLACEHOLDER_DURATION;
}

class TrackMappingService {
    private requireNonEmptyString(value: unknown, fieldName: string): string {
        if (typeof value !== "string") {
            throw new Error(`ensureRemoteTrack requires non-empty ${fieldName}`);
        }
        const normalized = value.trim();
        if (normalized.length === 0) {
            throw new Error(`ensureRemoteTrack requires non-empty ${fieldName}`);
        }
        return normalized;
    }

    private normalizeOptionalString(value: unknown): string | undefined {
        if (typeof value !== "string") return undefined;
        const normalized = value.trim();
        return normalized.length > 0 ? normalized : undefined;
    }

    private sourcePriority(source: string): number {
        return SOURCE_PRIORITY[source as CreateMappingData["source"]] ?? 0;
    }

    private normalizeLinkage(data: CreateMappingData): MappingLinkage {
        const toNullable = (value?: string): string | null =>
            value && value.trim().length > 0 ? value.trim() : null;

        return {
            trackId: toNullable(data.trackId),
            trackTidalId: toNullable(data.trackTidalId),
            trackYtMusicId: toNullable(data.trackYtMusicId),
        };
    }

    private assertLinkage(linkage: MappingLinkage): void {
        if (!linkage.trackId && !linkage.trackTidalId && !linkage.trackYtMusicId) {
            throw new Error(
                "TrackMapping requires at least one linkage key: trackId, trackTidalId, or trackYtMusicId"
            );
        }
    }

    private compareMappingPreference(a: MappingCandidate, b: MappingCandidate): number {
        const sourceDiff = this.sourcePriority(b.source) - this.sourcePriority(a.source);
        if (sourceDiff !== 0) return sourceDiff;

        const confidenceA =
            typeof a.confidence === "number" && Number.isFinite(a.confidence)
                ? a.confidence
                : 0;
        const confidenceB =
            typeof b.confidence === "number" && Number.isFinite(b.confidence)
                ? b.confidence
                : 0;
        const confidenceDiff = confidenceB - confidenceA;
        if (confidenceDiff !== 0) return confidenceDiff;

        const createdAtA = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const createdAtB = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        const createdAtDiff = createdAtB - createdAtA;
        if (createdAtDiff !== 0) return createdAtDiff;

        return b.id.localeCompare(a.id);
    }

    private isIncomingPreferred(
        incoming: Pick<CreateMappingData, "source" | "confidence">,
        existing: Pick<MappingCandidate, "source" | "confidence">
    ): boolean {
        const sourceDiff =
            this.sourcePriority(incoming.source) - this.sourcePriority(existing.source);
        if (sourceDiff !== 0) return sourceDiff > 0;

        const confidenceDiff = incoming.confidence - existing.confidence;
        if (confidenceDiff !== 0) return confidenceDiff > 0;

        return false;
    }

    private getSelectionKeys(mapping: MappingCandidate): string[] {
        const keys: string[] = [];

        if (mapping.trackId && mapping.trackTidalId) {
            keys.push(`track:${mapping.trackId}:tidal`);
        }
        if (mapping.trackId && mapping.trackYtMusicId) {
            keys.push(`track:${mapping.trackId}:ytmusic`);
        }
        if (!mapping.trackId && mapping.trackTidalId) {
            keys.push(`remote:tidal:${mapping.trackTidalId}`);
        }
        if (!mapping.trackId && mapping.trackYtMusicId) {
            keys.push(`remote:ytmusic:${mapping.trackYtMusicId}`);
        }
        if (mapping.trackId && !mapping.trackTidalId && !mapping.trackYtMusicId) {
            keys.push(`track:${mapping.trackId}:local-only`);
        }

        if (keys.length === 0) {
            keys.push(`id:${mapping.id}`);
        }

        return keys;
    }

    private selectDeterministicMappings<T extends MappingCandidate>(mappings: T[]): T[] {
        const ranked = [...mappings].sort((a, b) =>
            this.compareMappingPreference(a, b)
        );

        const preferredByKey = new Map<string, T>();
        for (const mapping of ranked) {
            const keys = this.getSelectionKeys(mapping);
            for (const key of keys) {
                if (!preferredByKey.has(key)) {
                    preferredByKey.set(key, mapping);
                }
            }
        }

        const uniqueById = new Map<string, T>();
        for (const mapping of preferredByKey.values()) {
            if (!uniqueById.has(mapping.id)) {
                uniqueById.set(mapping.id, mapping);
            }
        }

        return [...uniqueById.values()].sort((a, b) => {
            const trackA = a.trackId ?? "";
            const trackB = b.trackId ?? "";
            const trackDiff = trackA.localeCompare(trackB);
            if (trackDiff !== 0) return trackDiff;
            return this.compareMappingPreference(a, b);
        });
    }

    /**
     * Upsert a TrackTidal record by tidalId.
     * Creates if new, updates metadata if existing.
     */
    async upsertTrackTidal(data: UpsertTrackTidalData) {
        try {
            const existing = await prisma.trackTidal.findUnique({
                where: { tidalId: data.tidalId },
                select: { title: true, artist: true, album: true, duration: true },
            });

            const updateTitle = existing && shouldPreserveField(data.title, existing.title) ? existing.title : data.title;
            const updateArtist = existing && shouldPreserveField(data.artist, existing.artist) ? existing.artist : data.artist;
            const updateAlbum = existing && shouldPreserveField(data.album, existing.album) ? existing.album : data.album;
            const updateDuration = existing && shouldPreserveDuration(data.duration, existing.duration) ? existing.duration : data.duration;

            const result = await prisma.trackTidal.upsert({
                where: { tidalId: data.tidalId },
                update: {
                    title: updateTitle,
                    artist: updateArtist,
                    album: updateAlbum,
                    duration: updateDuration,
                    isrc: data.isrc,
                    quality: data.quality,
                    explicit: data.explicit,
                },
                create: {
                    tidalId: data.tidalId,
                    title: data.title,
                    artist: data.artist,
                    album: data.album,
                    duration: data.duration,
                    isrc: data.isrc,
                    quality: data.quality,
                    explicit: data.explicit,
                },
            });
            log.debug(`Upserted TrackTidal tidalId=${data.tidalId}`);

            // Resolve artist/album entity linkage if not yet populated
            if ((result.artistId === null || result.albumId === null) && data.artist) {
                try {
                    const artistResult = result.artistId
                        ? { id: result.artistId, name: data.artist, created: false }
                        : await resolveArtistForRemoteTrack(data.artist);
                    const albumResult = result.albumId
                        ? null
                        : data.album
                          ? await resolveAlbumForRemoteTrack(data.album, artistResult.id, "tidal")
                          : null;

                    await prisma.trackTidal.update({
                        where: { id: result.id },
                        data: {
                            artistId: artistResult.id,
                            albumId: albumResult?.id ?? result.albumId ?? null,
                        },
                    });

                    // Fire-and-forget count refresh
                    updateArtistCounts(artistResult.id).catch((err) => {
                        log.warn(`Count refresh failed for artist=${artistResult.id}`, err);
                    });
                    log.debug(`Resolved artist="${artistResult.name}" for TrackTidal tidalId=${data.tidalId}`);
                } catch (resolutionError) {
                    log.warn(`Artist/album resolution failed for TrackTidal tidalId=${data.tidalId}`, resolutionError);
                }
            }

            return result;
        } catch (error) {
            log.error(`Failed to upsert TrackTidal tidalId=${data.tidalId}`, error);
            throw error;
        }
    }

    /**
     * Upsert a TrackYtMusic record by videoId.
     * Creates if new, updates metadata if existing.
     */
    async upsertTrackYtMusic(data: UpsertTrackYtMusicData) {
        try {
            const existing = await prisma.trackYtMusic.findUnique({
                where: { videoId: data.videoId },
                select: { title: true, artist: true, album: true, duration: true },
            });

            const updateTitle = existing && shouldPreserveField(data.title, existing.title) ? existing.title : data.title;
            const updateArtist = existing && shouldPreserveField(data.artist, existing.artist) ? existing.artist : data.artist;
            const updateAlbum = existing && shouldPreserveField(data.album, existing.album) ? existing.album : data.album;
            const updateDuration = existing && shouldPreserveDuration(data.duration, existing.duration) ? existing.duration : data.duration;

            const result = await prisma.trackYtMusic.upsert({
                where: { videoId: data.videoId },
                update: {
                    title: updateTitle,
                    artist: updateArtist,
                    album: updateAlbum,
                    duration: updateDuration,
                    thumbnailUrl: data.thumbnailUrl,
                },
                create: {
                    videoId: data.videoId,
                    title: data.title,
                    artist: data.artist,
                    album: data.album,
                    duration: data.duration,
                    thumbnailUrl: data.thumbnailUrl,
                },
            });
            log.debug(`Upserted TrackYtMusic videoId=${data.videoId}`);

            // Resolve artist/album entity linkage if not yet populated
            if ((result.artistId === null || result.albumId === null) && data.artist) {
                try {
                    const artistResult = result.artistId
                        ? { id: result.artistId, name: data.artist, created: false }
                        : await resolveArtistForRemoteTrack(data.artist);
                    const albumResult = result.albumId
                        ? null
                        : data.album
                          ? await resolveAlbumForRemoteTrack(data.album, artistResult.id, "youtube")
                          : null;

                    await prisma.trackYtMusic.update({
                        where: { id: result.id },
                        data: {
                            artistId: artistResult.id,
                            albumId: albumResult?.id ?? result.albumId ?? null,
                        },
                    });

                    // Fire-and-forget count refresh
                    updateArtistCounts(artistResult.id).catch((err) => {
                        log.warn(`Count refresh failed for artist=${artistResult.id}`, err);
                    });
                    log.debug(`Resolved artist="${artistResult.name}" for TrackYtMusic videoId=${data.videoId}`);
                } catch (resolutionError) {
                    log.warn(`Artist/album resolution failed for TrackYtMusic videoId=${data.videoId}`, resolutionError);
                }
            }

            return result;
        } catch (error) {
            log.error(`Failed to upsert TrackYtMusic videoId=${data.videoId}`, error);
            throw error;
        }
    }

    /**
     * Ensure a remote provider row exists and return the linked FK id.
     * Provider and identifier coupling is strict and deterministic.
     */
    async ensureRemoteTrack(
        data: EnsureRemoteTrackData
    ): Promise<EnsuredRemoteTrackResult> {
        const title = this.requireNonEmptyString(data.title, "title");
        const artist = this.requireNonEmptyString(data.artist, "artist");
        const album = this.requireNonEmptyString(data.album, "album");
        if (!Number.isFinite(data.duration) || data.duration < 0) {
            throw new Error("ensureRemoteTrack requires duration >= 0");
        }
        const duration = Math.trunc(data.duration);

        if (data.provider === "tidal") {
            if (data.videoId !== undefined) {
                throw new Error(
                    "ensureRemoteTrack requires videoId to be omitted for tidal provider"
                );
            }

            const tidalId = Math.trunc(data.tidalId as number);
            if (!Number.isFinite(tidalId) || tidalId <= 0) {
                throw new Error("ensureRemoteTrack requires tidalId > 0");
            }

            const existingTrack = await prisma.trackTidal.findUnique({
                where: { tidalId },
                select: { id: true },
            });
            const trackTidal = await this.upsertTrackTidal({
                tidalId,
                title,
                artist,
                album,
                duration,
                isrc: this.normalizeOptionalString(data.isrc),
                quality: this.normalizeOptionalString(data.quality),
                explicit:
                    typeof data.explicit === "boolean"
                        ? data.explicit
                        : undefined,
            });

            await this.ensureMapping("tidal", trackTidal.id);

            return {
                provider: "tidal",
                id: trackTidal.id,
                created: existingTrack === null,
            };
        }

        if (data.provider !== "youtube") {
            throw new Error("ensureRemoteTrack requires provider to be tidal or youtube");
        }
        if (data.tidalId !== undefined) {
            throw new Error(
                "ensureRemoteTrack requires tidalId to be omitted for youtube provider"
            );
        }
        const videoId = this.requireNonEmptyString(data.videoId, "videoId");
        const existingTrack = await prisma.trackYtMusic.findUnique({
            where: { videoId },
            select: { id: true },
        });
        const trackYtMusic = await this.upsertTrackYtMusic({
            videoId,
            title,
            artist,
            album,
            duration,
            thumbnailUrl: this.normalizeOptionalString(data.thumbnailUrl),
        });

        await this.ensureMapping("youtube", trackYtMusic.id);

        return {
            provider: "youtube",
            id: trackYtMusic.id,
            created: existingTrack === null,
        };
    }

    /**
     * Ensure a TrackMapping exists for a remote provider row.
     * Creates a remote-only mapping if no active (non-stale) mapping exists.
     */
    private async ensureMapping(
        provider: "tidal" | "youtube",
        providerRowId: string
    ): Promise<void> {
        try {
            const existingMapping = await prisma.trackMapping.findFirst({
                where: {
                    ...(provider === "tidal"
                        ? { trackTidalId: providerRowId }
                        : { trackYtMusicId: providerRowId }),
                    stale: false,
                },
            });
            if (!existingMapping) {
                await this.createMapping({
                    ...(provider === "tidal"
                        ? { trackTidalId: providerRowId }
                        : { trackYtMusicId: providerRowId }),
                    confidence: 1.0,
                    source: "gap-fill",
                });
            }
        } catch (err) {
            log.warn(
                `Failed to ensure TrackMapping for ${provider} row ${providerRowId}`,
                err
            );
        }
    }

    /**
     * Create a new TrackMapping linking track entities.
     *
     * Uniqueness policy:
     * - Non-stale rows are unique on linkage tuple (trackId, trackTidalId, trackYtMusicId).
     * - If legacy duplicates exist for the same active linkage tuple, keep the preferred row
     *   (source priority, then confidence, then newest createdAt/id) and mark others stale.
     */
    async createMapping(data: CreateMappingData) {
        const linkage = this.normalizeLinkage(data);
        this.assertLinkage(linkage);

        try {
            const result = await prisma.$transaction(async (tx) => {
                const existingActive = await tx.trackMapping.findMany({
                    where: {
                        trackId: linkage.trackId,
                        trackTidalId: linkage.trackTidalId,
                        trackYtMusicId: linkage.trackYtMusicId,
                        stale: false,
                    },
                });

                if (existingActive.length === 0) {
                    return tx.trackMapping.create({
                        data: {
                            ...linkage,
                            confidence: data.confidence,
                            source: data.source,
                        },
                    });
                }

                const preferredExisting = [...existingActive].sort((a, b) =>
                    this.compareMappingPreference(
                        a as MappingCandidate,
                        b as MappingCandidate
                    )
                )[0];

                const selected = this.isIncomingPreferred(data, preferredExisting)
                    ? await tx.trackMapping.update({
                          where: { id: preferredExisting.id },
                          data: {
                              ...linkage,
                              confidence: data.confidence,
                              source: data.source,
                              stale: false,
                          },
                      })
                    : preferredExisting;

                const duplicateIds = existingActive
                    .map((m) => m.id)
                    .filter((id) => id !== selected.id);

                if (duplicateIds.length > 0) {
                    await tx.trackMapping.updateMany({
                        where: { id: { in: duplicateIds } },
                        data: { stale: true },
                    });
                    log.warn(
                        `Deduplicated ${duplicateIds.length} TrackMapping rows for linkage tuple ` +
                            `trackId=${linkage.trackId || "null"} ` +
                            `tidalId=${linkage.trackTidalId || "null"} ` +
                            `ytId=${linkage.trackYtMusicId || "null"}`
                    );
                }

                return selected;
            });

            log.debug(
                `Created TrackMapping id=${result.id} ` +
                    `trackId=${linkage.trackId || "null"} ` +
                    `tidalId=${linkage.trackTidalId || "null"} ` +
                    `ytId=${linkage.trackYtMusicId || "null"}`
            );
            return result;
        } catch (error) {
            log.error(
                `Failed to create TrackMapping trackId=${linkage.trackId || "null"} ` +
                    `tidalId=${linkage.trackTidalId || "null"} ytId=${linkage.trackYtMusicId || "null"}`,
                error
            );
            throw error;
        }
    }

    /**
     * Find all mappings for a given local track.
     */
    async findMappingsForTrack(trackId: string) {
        try {
            const mappings = await prisma.trackMapping.findMany({
                where: { trackId, stale: false },
                include: {
                    trackTidal: true,
                    trackYtMusic: true,
                },
            });

            return this.selectDeterministicMappings(mappings as MappingCandidate[]);
        } catch (error) {
            log.error(`Failed to find mappings for trackId=${trackId}`, error);
            return [];
        }
    }

    /**
     * Get all mappings for tracks in an album (single DB round-trip).
     * Returns mappings grouped by trackId.
     */
    async getMappingsForAlbum(albumId: string) {
        try {
            const tracks = await prisma.track.findMany({
                where: { albumId },
                select: { id: true },
            });

            if (tracks.length === 0) return [];

            const trackIds = tracks.map((t) => t.id);

            const mappings = await prisma.trackMapping.findMany({
                where: {
                    trackId: { in: trackIds },
                    stale: false,
                },
                include: {
                    trackTidal: true,
                    trackYtMusic: true,
                },
            });

            return this.selectDeterministicMappings(mappings as MappingCandidate[]);
        } catch (error) {
            log.error(
                `Failed to get mappings for albumId=${albumId}`,
                error
            );
            return [];
        }
    }

    /**
     * Mark a mapping as stale (e.g. when a stream source becomes unavailable).
     */
    async markStale(mappingId: string) {
        try {
            const result = await prisma.trackMapping.update({
                where: { id: mappingId },
                data: { stale: true },
            });
            log.info(`Marked TrackMapping id=${mappingId} as stale`);
            return result;
        } catch (error) {
            log.error(`Failed to mark mapping id=${mappingId} as stale`, error);
            throw error;
        }
    }
}

export const trackMappingService = new TrackMappingService();

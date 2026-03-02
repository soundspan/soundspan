import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

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

class TrackMappingService {
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
            const result = await prisma.trackTidal.upsert({
                where: { tidalId: data.tidalId },
                update: {
                    title: data.title,
                    artist: data.artist,
                    album: data.album,
                    duration: data.duration,
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
            const result = await prisma.trackYtMusic.upsert({
                where: { videoId: data.videoId },
                update: {
                    title: data.title,
                    artist: data.artist,
                    album: data.album,
                    duration: data.duration,
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
            return result;
        } catch (error) {
            log.error(`Failed to upsert TrackYtMusic videoId=${data.videoId}`, error);
            throw error;
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
            log.error("Failed to create TrackMapping", error);
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

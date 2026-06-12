/**
 * TrackReconciliationService — Links remote-only TrackMapping rows to local library tracks.
 *
 * Queries TrackMapping rows where trackId IS NULL (remote-only), attempts
 * local library matching using the linked TrackTidal/TrackYtMusic metadata
 * (ISRC first, then artist+title+album+duration). Updates TrackMapping.trackId
 * when a high-confidence match is found.
 *
 * Designed to run as a scheduled background job after library scans complete
 * and on a configurable interval.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    matchTrackAgainstLibrary,
    type TrackMatchInput,
    type LocalTrackCandidate,
} from "../utils/trackMatching";
import { trackMappingService } from "./trackMappingService";
import { tidalStreamingService } from "./tidalStreaming";

const log = logger.child("TrackReconciliation");

const DEFAULT_BATCH_SIZE = 50;
const MIN_CONFIDENCE_THRESHOLD = 70;
const TIDAL_UPGRADE_CONFIDENCE = 0.85;
const TIDAL_UPGRADE_MATCH_BATCH_SIZE = 25;
const TIDAL_USER_SCAN_BATCH_SIZE = 100;

function tryDecryptOAuthJson(value: string): string {
    try {
        // Defer loading encryption module so tests without encryption env can still run.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { decrypt } = require("../utils/encryption") as {
            decrypt: (text: string) => string;
        };
        return decrypt(value);
    } catch {
        return value;
    }
}

export interface ReconciliationResult {
    processed: number;
    linked: number;
    skipped: number;
}

export interface ProviderUpgradeResult {
    processed: number;
    upgraded: number;
    skipped: number;
}

interface ReconciliationCursor {
    createdAt: Date;
    id: string;
}

class TrackReconciliationService {
    private buildCursorWhere(cursor?: ReconciliationCursor) {
        if (!cursor) {
            return {};
        }

        return {
            OR: [
                { createdAt: { gt: cursor.createdAt } },
                {
                    createdAt: cursor.createdAt,
                    id: { gt: cursor.id },
                },
            ],
        };
    }

    private async getUnlinkedMappingsBatch(
        batchSize: number,
        cursor?: ReconciliationCursor
    ) {
        return prisma.trackMapping.findMany({
            where: {
                trackId: null,
                stale: false,
                ...this.buildCursorWhere(cursor),
            },
            include: {
                trackTidal: true,
                trackYtMusic: true,
            },
            take: batchSize,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
    }

    private async linkMappingsBatch(
        mappings: Array<{
            id: string;
            trackTidalId: string | null;
            trackYtMusicId: string | null;
            trackTidal: {
                title: string;
                artist: string;
                album: string;
                duration: number;
                isrc: string | null;
            } | null;
            trackYtMusic: {
                title: string;
                artist: string;
                album: string;
                duration: number;
            } | null;
        }>,
        localCandidates: LocalTrackCandidate[]
    ): Promise<{ linked: number; skipped: number }> {
        let linked = 0;
        let skipped = 0;

        for (const mapping of mappings) {
            const metadata = this.extractMetadata(mapping);
            if (!metadata) {
                log.debug(`Mapping ${mapping.id}: no extractable metadata, skipping`);
                skipped++;
                continue;
            }

            const match = matchTrackAgainstLibrary(metadata, localCandidates);
            if (match && match.matchConfidence >= MIN_CONFIDENCE_THRESHOLD) {
                const conflicting = await prisma.trackMapping.findFirst({
                    where: {
                        trackId: match.trackId,
                        trackTidalId: mapping.trackTidalId ?? null,
                        trackYtMusicId: mapping.trackYtMusicId ?? null,
                        stale: false,
                        id: { not: mapping.id },
                    },
                });
                if (conflicting) {
                    log.info(
                        `Mapping ${mapping.id}: conflict with existing mapping ${conflicting.id} for trackId=${match.trackId}, marking stale`
                    );
                    await prisma.trackMapping.update({
                        where: { id: mapping.id },
                        data: { stale: true },
                    });
                    skipped++;
                } else {
                    await prisma.trackMapping.update({
                        where: { id: mapping.id },
                        data: {
                            trackId: match.trackId,
                            confidence: match.matchConfidence / 100,
                        },
                    });
                    linked++;
                }
            } else {
                log.debug(
                    `Mapping ${mapping.id}: no match above threshold (best=${match?.matchConfidence ?? 0}%)`
                );
                skipped++;
            }
        }

        return { linked, skipped };
    }

    private async getRestoredTidalUserId(): Promise<string | null> {
        let cursorUserId: string | null = null;
        while (true) {
            const usersWithTidal: Array<{
                userId: string;
                tidalOAuthJson: string | null;
            }> = await prisma.userSettings.findMany({
                where: { tidalOAuthJson: { not: null } },
                select: {
                    userId: true,
                    tidalOAuthJson: true,
                },
                orderBy: { userId: "asc" },
                take: TIDAL_USER_SCAN_BATCH_SIZE,
                ...(cursorUserId
                    ? {
                          cursor: { userId: cursorUserId },
                          skip: 1,
                      }
                    : {}),
            });
            if (usersWithTidal.length === 0) {
                break;
            }

            for (const userWithTidal of usersWithTidal) {
                if (!userWithTidal.tidalOAuthJson) {
                    continue;
                }

                const oauthJson = tryDecryptOAuthJson(userWithTidal.tidalOAuthJson);
                const restored = await tidalStreamingService.restoreOAuth(
                    userWithTidal.userId,
                    oauthJson
                );
                if (restored) {
                    return userWithTidal.userId;
                }

                log.warn(
                    `[YT->TIDAL] TIDAL credentials exist for ${userWithTidal.userId}, but session restore failed`
                );
            }

            cursorUserId = usersWithTidal[usersWithTidal.length - 1]?.userId ?? null;
        }

        return null;
    }

    /**
     * Run a reconciliation pass: find unlinked TrackMapping rows and attempt
     * to link them to local library tracks.
     */
    async reconcile(
        batchSize: number = DEFAULT_BATCH_SIZE,
        maxRows?: number
    ): Promise<ReconciliationResult> {
        const effectiveBatchSize = Math.max(1, Math.trunc(batchSize));
        const requestedMaxRows =
            typeof maxRows === "number" && Number.isFinite(maxRows)
                ? Math.trunc(maxRows)
                : null;
        const effectiveMaxRows =
            requestedMaxRows && requestedMaxRows > 0
                ? Math.max(effectiveBatchSize, requestedMaxRows)
                : Number.MAX_SAFE_INTEGER;
        let processed = 0;
        let linked = 0;
        let skipped = 0;
        let cursor: ReconciliationCursor | undefined;

        const firstBatch = await this.getUnlinkedMappingsBatch(
            Math.min(effectiveBatchSize, effectiveMaxRows),
            cursor
        );

        if (firstBatch.length === 0) {
            log.debug("No unlinked mappings to reconcile — early exit");
            return { processed: 0, linked: 0, skipped: 0 };
        }

        if (requestedMaxRows && requestedMaxRows > 0) {
            log.info(
                `Reconciling up to ${effectiveMaxRows} unlinked TrackMapping rows in batches of ${effectiveBatchSize}...`
            );
        } else {
            log.info(
                `Reconciling unlinked TrackMapping rows in batches of ${effectiveBatchSize} until exhausted...`
            );
        }

        // Load local library candidates once for the whole sweep.
        const localCandidates = await this.getLocalLibraryCandidates();

        if (localCandidates.length === 0) {
            log.debug("No local library tracks — nothing to match against");
            return this.exhaustUnlinkedMappingsWithoutMatches(
                firstBatch,
                effectiveBatchSize,
                effectiveMaxRows
            );
        }

        let currentBatch = firstBatch;
        let currentBatchSize = Math.min(effectiveBatchSize, effectiveMaxRows);
        while (currentBatch.length > 0 && processed < effectiveMaxRows) {
            const batchResult = await this.linkMappingsBatch(
                currentBatch,
                localCandidates
            );
            processed += currentBatch.length;
            linked += batchResult.linked;
            skipped += batchResult.skipped;

            if (
                processed >= effectiveMaxRows ||
                currentBatch.length < currentBatchSize
            ) {
                break;
            }

            const lastMapping = currentBatch[currentBatch.length - 1];
            cursor = {
                createdAt: lastMapping.createdAt,
                id: lastMapping.id,
            };
            const remaining = effectiveMaxRows - processed;
            currentBatchSize = Math.min(effectiveBatchSize, remaining);
            currentBatch = await this.getUnlinkedMappingsBatch(
                currentBatchSize,
                cursor
            );
        }

        log.info(
            `Reconciliation complete: ${linked} linked, ${skipped} skipped out of ${processed}`
        );

        return {
            processed,
            linked,
            skipped,
        };
    }

    private async exhaustUnlinkedMappingsWithoutMatches(
        firstBatch: Array<{
            id: string;
            createdAt: Date;
        }>,
        batchSize: number,
        maxRows: number
    ): Promise<ReconciliationResult> {
        let processed = firstBatch.length;
        let skipped = firstBatch.length;
        let currentBatch = firstBatch;
        let currentBatchSize = Math.min(batchSize, maxRows);

        while (currentBatch.length > 0 && processed < maxRows) {
            if (currentBatch.length < currentBatchSize) {
                break;
            }

            const lastMapping = currentBatch[currentBatch.length - 1];
            const remaining = maxRows - processed;
            currentBatchSize = Math.min(batchSize, remaining);
            currentBatch = await this.getUnlinkedMappingsBatch(currentBatchSize, {
                createdAt: lastMapping.createdAt,
                id: lastMapping.id,
            });
            processed += currentBatch.length;
            skipped += currentBatch.length;
        }

        return { processed, linked: 0, skipped };
    }

    /**
     * Attempt to upgrade YT-only mappings to include a TIDAL linkage.
     * This allows future playlist/listen resolution to prefer TIDAL where possible.
     */
    async reconcileYoutubeToTidal(
        batchSize: number = DEFAULT_BATCH_SIZE
    ): Promise<ProviderUpgradeResult> {
        const ytOnlyMappings = await prisma.trackMapping.findMany({
            where: {
                stale: false,
                trackId: { not: null },
                trackYtMusicId: { not: null },
                trackTidalId: null,
            },
            select: {
                id: true,
                trackId: true,
                trackYtMusicId: true,
                confidence: true,
                trackYtMusic: {
                    select: {
                        title: true,
                        artist: true,
                        album: true,
                        duration: true,
                    },
                },
            },
            take: batchSize,
            orderBy: { createdAt: "asc" },
        });

        if (ytOnlyMappings.length === 0) {
            return { processed: 0, upgraded: 0, skipped: 0 };
        }

        const tidalUserId = await this.getRestoredTidalUserId();
        if (!tidalUserId) {
            log.debug(
                `[YT->TIDAL] No restorable TIDAL user available, skipping ${ytOnlyMappings.length} mappings`
            );
            return {
                processed: ytOnlyMappings.length,
                upgraded: 0,
                skipped: ytOnlyMappings.length,
            };
        }

        let upgraded = 0;
        let skipped = 0;

        for (
            let startIndex = 0;
            startIndex < ytOnlyMappings.length;
            startIndex += TIDAL_UPGRADE_MATCH_BATCH_SIZE
        ) {
            const batch = ytOnlyMappings.slice(
                startIndex,
                startIndex + TIDAL_UPGRADE_MATCH_BATCH_SIZE
            );
            const matchInputs = batch.map((mapping) => {
                const yt = mapping.trackYtMusic;
                return {
                    artist: yt?.artist ?? "",
                    title: yt?.title ?? "",
                    albumTitle: yt?.album ?? undefined,
                    duration: yt?.duration ?? undefined,
                    isrc: undefined,
                };
            });

            const matches = await tidalStreamingService.findMatchesForAlbum(
                tidalUserId,
                matchInputs
            );

            for (let index = 0; index < batch.length; index += 1) {
                const mapping = batch[index];
                const yt = mapping.trackYtMusic;
                const match = matches[index];

                if (!mapping.trackYtMusicId || !yt || !yt.title || !yt.artist) {
                    skipped += 1;
                    continue;
                }
                if (!match) {
                    skipped += 1;
                    continue;
                }

                try {
                    const tidalRow = await trackMappingService.upsertTrackTidal({
                        tidalId: match.id,
                        title: match.title,
                        artist: match.artist,
                        album: yt.album || "",
                        duration: match.duration,
                        isrc: match.isrc,
                    });

                    const conflicting = await prisma.trackMapping.findFirst({
                        where: {
                            id: { not: mapping.id },
                            stale: false,
                            trackId: mapping.trackId ?? null,
                            trackYtMusicId: mapping.trackYtMusicId,
                            trackTidalId: tidalRow.id,
                        },
                        select: { id: true },
                    });
                    if (conflicting) {
                        skipped += 1;
                        continue;
                    }

                    await prisma.trackMapping.update({
                        where: { id: mapping.id },
                        data: {
                            trackTidalId: tidalRow.id,
                            confidence: Math.max(
                                mapping.confidence,
                                TIDAL_UPGRADE_CONFIDENCE
                            ),
                        },
                    });

                    upgraded += 1;
                } catch (error) {
                    log.warn(
                        `[YT->TIDAL] Failed to upgrade mapping ${mapping.id}`,
                        error
                    );
                    skipped += 1;
                }
            }
        }

        return {
            processed: ytOnlyMappings.length,
            upgraded,
            skipped,
        };
    }

    /**
     * Find orphaned provider rows (TrackTidal/TrackYtMusic with no active TrackMapping)
     * and create remote-only mappings for them.
     */
    async reconcileOrphans(batchSize: number = DEFAULT_BATCH_SIZE): Promise<{ created: number }> {
        const orphanedTidal = await prisma.trackTidal.findMany({
            where: { mappings: { none: { stale: false } } },
            select: { id: true },
            take: batchSize,
        });
        const orphanedYt = await prisma.trackYtMusic.findMany({
            where: { mappings: { none: { stale: false } } },
            select: { id: true },
            take: batchSize,
        });

        let created = 0;

        for (const row of orphanedTidal) {
            try {
                await trackMappingService.createMapping({
                    trackTidalId: row.id,
                    confidence: 1.0,
                    source: "gap-fill",
                });
                created++;
            } catch (err) {
                log.warn(`Failed to create mapping for orphaned TrackTidal id=${row.id}`, err);
            }
        }

        for (const row of orphanedYt) {
            try {
                await trackMappingService.createMapping({
                    trackYtMusicId: row.id,
                    confidence: 1.0,
                    source: "gap-fill",
                });
                created++;
            } catch (err) {
                log.warn(`Failed to create mapping for orphaned TrackYtMusic id=${row.id}`, err);
            }
        }

        if (created > 0) {
            log.info(`Orphan reconciliation: created ${created} mappings (${orphanedTidal.length} Tidal, ${orphanedYt.length} YT Music orphans found)`);
        }

        return { created };
    }

    /**
     * Extract match metadata from a mapping's linked provider rows.
     * Prefers Tidal (has ISRC) over YT Music.
     */
    private extractMetadata(
        mapping: {
            trackTidal: {
                title: string;
                artist: string;
                album: string;
                duration: number;
                isrc: string | null;
            } | null;
            trackYtMusic: {
                title: string;
                artist: string;
                album: string;
                duration: number;
            } | null;
        }
    ): TrackMatchInput | null {
        if (mapping.trackTidal) {
            return {
                artist: mapping.trackTidal.artist,
                title: mapping.trackTidal.title,
                album: mapping.trackTidal.album,
                duration: mapping.trackTidal.duration,
            };
        }

        if (mapping.trackYtMusic) {
            return {
                artist: mapping.trackYtMusic.artist,
                title: mapping.trackYtMusic.title,
                album: mapping.trackYtMusic.album,
                duration: mapping.trackYtMusic.duration,
            };
        }

        return null;
    }

    /**
     * Load all local library tracks for matching.
     */
    private async getLocalLibraryCandidates(): Promise<LocalTrackCandidate[]> {
        const tracks = await prisma.track.findMany({
            select: {
                id: true,
                title: true,
                duration: true,
                filePath: true,
                album: {
                    select: {
                        title: true,
                        artist: { select: { name: true } },
                    },
                },
            },
        });

        return tracks.map((t) => ({
            id: t.id,
            title: t.title,
            duration: t.duration,
            albumTitle: t.album.title,
            artistName: t.album.artist.name,
            filePath: t.filePath,
        }));
    }
}

export const trackReconciliationService = new TrackReconciliationService();

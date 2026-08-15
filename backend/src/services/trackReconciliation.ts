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
import { config } from "../config";
import {
    buildTrackMatchIndex,
    matchTrackAgainstIndex,
    type TrackMatchInput,
    type TrackMatchIndex,
    type LocalTrackCandidate,
} from "../utils/trackMatching";
import { yieldToEventLoop } from "../utils/async";
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

/** Counts produced by one bounded remote-to-local reconciliation run. */
export interface ReconciliationResult {
    /** Remote mappings examined during the run. */
    processed: number;
    /** Mappings linked to a local library track. */
    linked: number;
    /** Mappings left unlinked or marked stale. */
    skipped: number;
}

/** Cancellation controls for one bounded reconciliation run. */
export interface ReconciliationRunOptions {
    /** Stops the run between database calls and mapping attempts. */
    signal?: AbortSignal;
}

/** Stable keyset position used to continue a later reconciliation window. */
export interface ReconciliationCursor {
    createdAt: Date;
    id: string;
}

/** Inputs for one bounded, resumable reconciliation window. */
export interface ReconciliationWindowOptions extends ReconciliationRunOptions {
    batchSize?: number;
    maxRows?: number;
    startAfter?: ReconciliationCursor;
}

/** Result and optional continuation position for a reconciliation window. */
export interface ReconciliationWindowResult {
    result: ReconciliationResult;
    nextCursor: ReconciliationCursor | null;
}

/** Counts produced by one YT Music-to-TIDAL upgrade run. */
export interface ProviderUpgradeResult {
    processed: number;
    upgraded: number;
    skipped: number;
}

interface ReconciliationMapping {
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
}

interface ReconciliationRow extends ReconciliationMapping {
    createdAt: Date;
}

interface ReconciliationLimits {
    batchSize: number;
    maxRows: number;
}

function resolveReconciliationLimits(
    batchSize: number,
    maxRows: number | undefined,
): ReconciliationLimits {
    const configuredMaxRows = config.workers.trackReconciliationMaxRows;
    const requestedMaxRows =
        typeof maxRows === "number" && Number.isFinite(maxRows)
            ? Math.trunc(maxRows)
            : configuredMaxRows;
    const effectiveMaxRows =
        requestedMaxRows > 0
            ? Math.min(requestedMaxRows, configuredMaxRows)
            : configuredMaxRows;
    const requestedBatchSize = Math.max(1, Math.trunc(batchSize));

    return {
        batchSize: Math.min(requestedBatchSize, effectiveMaxRows),
        maxRows: effectiveMaxRows,
    };
}

function createReconciliationSignal(callerSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(
        config.workers.trackReconciliationTimeoutMs,
    );
    return callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal;
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
        signal: AbortSignal,
        cursor?: ReconciliationCursor,
    ): Promise<ReconciliationRow[]> {
        signal.throwIfAborted();
        const mappings = await prisma.trackMapping.findMany({
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
        signal.throwIfAborted();
        return mappings;
    }

    private async linkMappingsBatch(
        mappings: ReconciliationMapping[],
        matchIndex: TrackMatchIndex,
        signal: AbortSignal,
    ): Promise<{ linked: number; skipped: number }> {
        let linked = 0;
        let skipped = 0;

        for (const mapping of mappings) {
            signal.throwIfAborted();
            const outcome = await this.linkMapping(mapping, matchIndex, signal);
            if (outcome === "linked") linked += 1;
            else skipped += 1;
            await yieldToEventLoop();
            signal.throwIfAborted();
        }

        return { linked, skipped };
    }

    private async linkMapping(
        mapping: ReconciliationMapping,
        matchIndex: TrackMatchIndex,
        signal: AbortSignal,
    ): Promise<"linked" | "skipped"> {
        const metadata = this.extractMetadata(mapping);
        if (!metadata) {
            log.debug(
                `Mapping ${mapping.id}: no extractable metadata, skipping`,
            );
            return "skipped";
        }

        const match = matchTrackAgainstIndex(metadata, matchIndex);
        if (!match || match.matchConfidence < MIN_CONFIDENCE_THRESHOLD) {
            log.debug(
                `Mapping ${mapping.id}: no match above threshold (best=${match?.matchConfidence ?? 0}%)`,
            );
            return "skipped";
        }

        const conflicting = await prisma.trackMapping.findFirst({
            where: {
                trackId: match.trackId,
                trackTidalId: mapping.trackTidalId ?? null,
                trackYtMusicId: mapping.trackYtMusicId ?? null,
                stale: false,
                id: { not: mapping.id },
            },
        });
        signal.throwIfAborted();
        if (conflicting) {
            log.info(
                `Mapping ${mapping.id}: conflict with existing mapping ${conflicting.id} for trackId=${match.trackId}, marking stale`,
            );
            await prisma.trackMapping.update({
                where: { id: mapping.id },
                data: { stale: true },
            });
            return "skipped";
        }

        await prisma.trackMapping.update({
            where: { id: mapping.id },
            data: {
                trackId: match.trackId,
                confidence: match.matchConfidence / 100,
            },
        });
        return "linked";
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

                const oauthJson = tryDecryptOAuthJson(
                    userWithTidal.tidalOAuthJson,
                );
                const restored = await tidalStreamingService.restoreOAuth(
                    userWithTidal.userId,
                    oauthJson,
                );
                if (restored) {
                    return userWithTidal.userId;
                }

                log.warn(
                    `[YT->TIDAL] TIDAL credentials exist for ${userWithTidal.userId}, but session restore failed`,
                );
            }

            cursorUserId =
                usersWithTidal[usersWithTidal.length - 1]?.userId ?? null;
        }

        return null;
    }

    /**
     * Links a bounded set of remote-only mappings to local library tracks.
     *
     * The configured row limit is a hard ceiling even when a caller requests
     * more. Prisma queries cannot be interrupted in flight, so cancellation is
     * observed immediately before and after each query and mapping attempt.
     *
     * @param batchSize Desired rows per database page.
     * @param maxRows Optional lower per-run row limit.
     * @param options Caller cancellation propagated into this run.
     * @throws The abort reason when the caller cancels or the configured
     * reconciliation deadline expires.
     */
    async reconcile(
        batchSize: number = DEFAULT_BATCH_SIZE,
        maxRows?: number,
        options: ReconciliationRunOptions = {},
    ): Promise<ReconciliationResult> {
        const window = await this.reconcileWindow({
            batchSize,
            maxRows,
            signal: options.signal,
        });
        return window.result;
    }

    /**
     * Reconciles one bounded keyset window and returns where the next run starts.
     *
     * @param options Batch, row-limit, cancellation, and continuation inputs.
     * @throws The abort reason when cancelled or the configured deadline expires.
     */
    async reconcileWindow(
        options: ReconciliationWindowOptions = {},
    ): Promise<ReconciliationWindowResult> {
        const limits = resolveReconciliationLimits(
            options.batchSize ?? DEFAULT_BATCH_SIZE,
            options.maxRows,
        );
        const signal = createReconciliationSignal(options.signal);
        signal.throwIfAborted();

        const firstBatch = await this.getUnlinkedMappingsBatch(
            limits.batchSize,
            signal,
            options.startAfter,
        );

        if (firstBatch.length === 0) {
            log.debug("No unlinked mappings to reconcile — early exit");
            return {
                result: { processed: 0, linked: 0, skipped: 0 },
                nextCursor: null,
            };
        }

        log.info(
            `Reconciling up to ${limits.maxRows} unlinked TrackMapping rows in batches of ${limits.batchSize}...`,
        );

        // Load local library candidates once for the whole sweep.
        const localCandidates = await this.getLocalLibraryCandidates(signal);

        if (localCandidates.length === 0) {
            log.debug("No local library tracks — nothing to match against");
            return this.exhaustUnlinkedMappingsWithoutMatches(
                firstBatch,
                limits,
                signal,
            );
        }
        signal.throwIfAborted();
        const matchIndex = buildTrackMatchIndex(localCandidates);
        signal.throwIfAborted();
        const window = await this.processReconciliationBatches(
            firstBatch,
            matchIndex,
            limits,
            signal,
        );
        const { result } = window;

        log.info(
            `Reconciliation complete: ${result.linked} linked, ${result.skipped} skipped out of ${result.processed}`,
        );
        if (result.processed >= limits.maxRows) {
            log.info(
                `Reconciliation reached the per-run row limit of ${limits.maxRows}`,
            );
        }

        return window;
    }

    private async processReconciliationBatches(
        firstBatch: ReconciliationRow[],
        matchIndex: TrackMatchIndex,
        limits: ReconciliationLimits,
        signal: AbortSignal,
    ): Promise<ReconciliationWindowResult> {
        const result = { processed: 0, linked: 0, skipped: 0 };
        let currentBatch = firstBatch;
        let currentBatchSize = limits.batchSize;

        while (currentBatch.length > 0 && result.processed < limits.maxRows) {
            const batchResult = await this.linkMappingsBatch(
                currentBatch,
                matchIndex,
                signal,
            );
            result.processed += currentBatch.length;
            result.linked += batchResult.linked;
            result.skipped += batchResult.skipped;
            if (
                result.processed >= limits.maxRows ||
                currentBatch.length < currentBatchSize
            ) {
                break;
            }

            const lastMapping = currentBatch[currentBatch.length - 1];
            const remaining = limits.maxRows - result.processed;
            currentBatchSize = Math.min(limits.batchSize, remaining);
            currentBatch = await this.getUnlinkedMappingsBatch(
                currentBatchSize,
                signal,
                { createdAt: lastMapping.createdAt, id: lastMapping.id },
            );
        }

        return {
            result,
            nextCursor: this.getContinuationCursor(
                currentBatch,
                result.processed,
                limits.maxRows,
            ),
        };
    }

    private getContinuationCursor(
        lastBatch: ReconciliationRow[],
        processed: number,
        maxRows: number,
    ): ReconciliationCursor | null {
        if (processed < maxRows) return null;
        const lastMapping = lastBatch[lastBatch.length - 1];
        if (!lastMapping) return null;
        return { createdAt: lastMapping.createdAt, id: lastMapping.id };
    }

    private async exhaustUnlinkedMappingsWithoutMatches(
        firstBatch: ReconciliationRow[],
        limits: ReconciliationLimits,
        signal: AbortSignal,
    ): Promise<ReconciliationWindowResult> {
        let processed = firstBatch.length;
        let skipped = firstBatch.length;
        let currentBatch = firstBatch;
        let currentBatchSize = limits.batchSize;

        while (currentBatch.length > 0 && processed < limits.maxRows) {
            signal.throwIfAborted();
            if (currentBatch.length < currentBatchSize) {
                break;
            }

            const lastMapping = currentBatch[currentBatch.length - 1];
            const remaining = limits.maxRows - processed;
            currentBatchSize = Math.min(limits.batchSize, remaining);
            currentBatch = await this.getUnlinkedMappingsBatch(
                currentBatchSize,
                signal,
                {
                    createdAt: lastMapping.createdAt,
                    id: lastMapping.id,
                },
            );
            processed += currentBatch.length;
            skipped += currentBatch.length;
        }

        return {
            result: { processed, linked: 0, skipped },
            nextCursor: this.getContinuationCursor(
                currentBatch,
                processed,
                limits.maxRows,
            ),
        };
    }

    /**
     * Attempt to upgrade YT-only mappings to include a TIDAL linkage.
     * This allows future playlist/listen resolution to prefer TIDAL where possible.
     */
    async reconcileYoutubeToTidal(
        batchSize: number = DEFAULT_BATCH_SIZE,
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
                `[YT->TIDAL] No restorable TIDAL user available, skipping ${ytOnlyMappings.length} mappings`,
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
                startIndex + TIDAL_UPGRADE_MATCH_BATCH_SIZE,
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
                matchInputs,
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
                    const tidalRow = await trackMappingService.upsertTrackTidal(
                        {
                            tidalId: match.id,
                            title: match.title,
                            artist: match.artist,
                            album: yt.album || "",
                            duration: match.duration,
                            isrc: match.isrc,
                        },
                    );

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
                                TIDAL_UPGRADE_CONFIDENCE,
                            ),
                        },
                    });

                    upgraded += 1;
                } catch (error) {
                    log.warn(
                        `[YT->TIDAL] Failed to upgrade mapping ${mapping.id}`,
                        error,
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
    async reconcileOrphans(
        batchSize: number = DEFAULT_BATCH_SIZE,
    ): Promise<{ created: number }> {
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
                log.warn(
                    `Failed to create mapping for orphaned TrackTidal id=${row.id}`,
                    err,
                );
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
                log.warn(
                    `Failed to create mapping for orphaned TrackYtMusic id=${row.id}`,
                    err,
                );
            }
        }

        if (created > 0) {
            log.info(
                `Orphan reconciliation: created ${created} mappings (${orphanedTidal.length} Tidal, ${orphanedYt.length} YT Music orphans found)`,
            );
        }

        return { created };
    }

    /**
     * Extract match metadata from a mapping's linked provider rows.
     * Prefers Tidal (has ISRC) over YT Music.
     */
    private extractMetadata(mapping: {
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
    }): TrackMatchInput | null {
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
    private async getLocalLibraryCandidates(
        signal: AbortSignal,
    ): Promise<LocalTrackCandidate[]> {
        signal.throwIfAborted();
        const tracks = await prisma.track.findMany({
            where: { origin: "LOCAL", filePath: { not: null } },
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
        signal.throwIfAborted();

        return tracks.flatMap((track) =>
            track.filePath === null
                ? []
                : [
                      {
                          id: track.id,
                          title: track.title,
                          duration: track.duration,
                          albumTitle: track.album.title,
                          artistName: track.album.artist.name,
                          filePath: track.filePath,
                      },
                  ],
        );
    }
}

/** Shared reconciliation service used by scan and scheduler workers. */
export const trackReconciliationService = new TrackReconciliationService();

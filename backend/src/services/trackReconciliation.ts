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

const log = logger.child("TrackReconciliation");

const DEFAULT_BATCH_SIZE = 50;
const MIN_CONFIDENCE_THRESHOLD = 70;

export interface ReconciliationResult {
    processed: number;
    linked: number;
    skipped: number;
}

class TrackReconciliationService {
    /**
     * Run a reconciliation pass: find unlinked TrackMapping rows and attempt
     * to link them to local library tracks.
     */
    async reconcile(
        batchSize: number = DEFAULT_BATCH_SIZE
    ): Promise<ReconciliationResult> {
        // 1. Find unlinked mappings (trackId IS NULL, not stale)
        const unlinkedMappings = await prisma.trackMapping.findMany({
            where: {
                trackId: null,
                stale: false,
            },
            include: {
                trackTidal: true,
                trackYtMusic: true,
            },
            take: batchSize,
            orderBy: { createdAt: "asc" },
        });

        if (unlinkedMappings.length === 0) {
            log.debug("No unlinked mappings to reconcile — early exit");
            return { processed: 0, linked: 0, skipped: 0 };
        }

        log.info(
            `Reconciling ${unlinkedMappings.length} unlinked TrackMapping rows...`
        );

        // 2. Load local library candidates (one query for the whole batch)
        const localCandidates = await this.getLocalLibraryCandidates();

        if (localCandidates.length === 0) {
            log.debug("No local library tracks — nothing to match against");
            return {
                processed: unlinkedMappings.length,
                linked: 0,
                skipped: unlinkedMappings.length,
            };
        }

        let linked = 0;
        let skipped = 0;

        // 3. For each unlinked mapping, try to match
        for (const mapping of unlinkedMappings) {
            const metadata = this.extractMetadata(mapping);
            if (!metadata) {
                skipped++;
                continue;
            }

            // Metadata matching (artist + title + album + duration)
            const match = matchTrackAgainstLibrary(metadata, localCandidates);
            if (match && match.matchConfidence >= MIN_CONFIDENCE_THRESHOLD) {
                await prisma.trackMapping.update({
                    where: { id: mapping.id },
                    data: {
                        trackId: match.trackId,
                        confidence: match.matchConfidence / 100,
                    },
                });
                linked++;
            } else {
                skipped++;
            }
        }

        log.info(
            `Reconciliation complete: ${linked} linked, ${skipped} skipped out of ${unlinkedMappings.length}`
        );

        return {
            processed: unlinkedMappings.length,
            linked,
            skipped,
        };
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

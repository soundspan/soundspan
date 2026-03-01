/**
 * PlaylistImportService — Multi-provider playlist import.
 *
 * Resolves tracks: local library first → YT Music (universal fallback)
 * → Tidal (if user connected). Creates PlaylistItems with appropriate
 * provider FKs.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { spotifyService } from "./spotify";
import { deezerService } from "./deezer";
import { ytMusicService } from "./youtubeMusic";
import { tidalStreamingService } from "./tidalStreaming";
import { trackMappingService } from "./trackMappingService";
import {
    matchTrackAgainstLibrary,
    type LocalTrackCandidate,
} from "../utils/trackMatching";

const log = logger.child("PlaylistImportService");
const MATCH_BATCH_SIZE = 25;
const MATCH_BATCH_CONCURRENCY = 2;
const UPSERT_CONCURRENCY = 6;
const MAPPING_CREATE_CONCURRENCY = 8;

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
    if (values.length === 0) return [];
    const size = Math.max(1, chunkSize);
    const chunks: T[][] = [];
    for (let i = 0; i < values.length; i += size) {
        chunks.push(values.slice(i, i + size));
    }
    return chunks;
}

async function mapWithConcurrency<T, R>(
    values: T[],
    concurrency: number,
    worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
    if (values.length === 0) return [];

    const results = new Array<R>(values.length);
    const limit = Math.max(1, Math.min(concurrency, values.length));
    let cursor = 0;

    async function runWorker() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= values.length) return;
            results[index] = await worker(values[index], index);
        }
    }

    await Promise.all(Array.from({ length: limit }, () => runWorker()));
    return results;
}

export interface ImportTrackMeta {
    artist: string;
    title: string;
    album?: string;
    duration?: number;
    isrc?: string;
}

export interface ResolvedTrack {
    index: number;
    artist: string;
    title: string;
    album?: string;
    /** Local library track ID, if matched */
    trackId?: string;
    /** TrackYtMusic record ID, if resolved */
    trackYtMusicId?: string;
    /** TrackTidal record ID, if resolved */
    trackTidalId?: string;
    /** Resolution source */
    source: "local" | "youtube" | "tidal" | "unresolved";
    /** Match confidence (0-100) */
    confidence: number;
}

type SourceType = "spotify" | "deezer";
type ProviderMatchInput = {
    artist: string;
    title: string;
    albumTitle?: string;
    duration?: number;
    isrc?: string;
};
type YtMatch = { videoId: string; title: string; duration: number };
type TidalMatch = {
    id: number;
    title: string;
    artist: string;
    duration: number;
    isrc?: string;
};
type IndexedImportTrack = { index: number; track: ImportTrackMeta };

class PlaylistImportService {
    /**
     * Parse a playlist URL and detect the source type.
     */
    parseSourceUrl(
        url: string
    ): { source: SourceType; id: string } | null {
        // Spotify
        const spotifyParsed = spotifyService.parseUrl(url);
        if (spotifyParsed && spotifyParsed.type === "playlist") {
            return { source: "spotify", id: spotifyParsed.id };
        }

        // Deezer
        const deezerMatch = url.match(
            /deezer\.com\/(?:\w+\/)?playlist\/(\d+)/i
        );
        if (deezerMatch) {
            return { source: "deezer", id: deezerMatch[1] };
        }

        return null;
    }

    /**
     * Fetch track metadata from the source URL.
     */
    async fetchSourceTracks(
        source: SourceType,
        sourceId: string
    ): Promise<{ name: string; tracks: ImportTrackMeta[] }> {
        if (source === "spotify") {
            const playlist = await spotifyService.getPlaylist(sourceId);
            if (!playlist) throw new Error("Spotify playlist not found");

            return {
                name: playlist.name,
                tracks: playlist.tracks.map((t) => ({
                    artist: t.artist || "Unknown",
                    title: t.title,
                    album: t.album || undefined,
                    duration: t.durationMs
                        ? Math.round(t.durationMs / 1000)
                        : undefined,
                    isrc: t.isrc || undefined,
                })),
            };
        }

        if (source === "deezer") {
            const playlist = await deezerService.getPlaylist(sourceId);
            if (!playlist) throw new Error("Deezer playlist not found");

            return {
                name: playlist.title,
                tracks: playlist.tracks.map((t) => ({
                    artist: t.artist || "Unknown",
                    title: t.title,
                    album: t.album || undefined,
                    duration: t.durationMs
                        ? Math.round(t.durationMs / 1000)
                        : undefined,
                })),
            };
        }

        throw new Error(`Unsupported source: ${source}`);
    }

    /**
     * Resolve a single track against available providers.
     * Priority: local library → YT Music → Tidal (if authenticated).
     */
    async resolveTrack(
        trackMeta: ImportTrackMeta,
        localCandidates: LocalTrackCandidate[],
        userId: string,
        hasTidalAuth: boolean
    ): Promise<Omit<ResolvedTrack, "index">> {
        const base = {
            artist: trackMeta.artist,
            title: trackMeta.title,
            album: trackMeta.album,
        };

        // 1. Try local library match
        const localMatch = matchTrackAgainstLibrary(trackMeta, localCandidates);
        if (localMatch && localMatch.matchConfidence >= 70) {
            return {
                ...base,
                trackId: localMatch.trackId,
                source: "local",
                confidence: localMatch.matchConfidence,
            };
        }

        // 2. Try YT Music (unauthenticated, universal fallback)
        try {
            const providerInput = this.toProviderMatchInput(trackMeta);
            const [ytMatch] = await ytMusicService.findMatchesForAlbum(
                "__public__",
                [providerInput]
            );
            if (ytMatch) {
                const ytRow = await trackMappingService.upsertTrackYtMusic({
                    videoId: ytMatch.videoId,
                    title: ytMatch.title,
                    artist: trackMeta.artist,
                    album: trackMeta.album || "",
                    duration: ytMatch.duration,
                });
                return {
                    ...base,
                    trackYtMusicId: ytRow.id,
                    source: "youtube",
                    confidence: 85,
                };
            }
        } catch (err) {
            log.warn("YT Music match failed during import:", err);
        }

        // 3. Try Tidal (if user has OAuth)
        if (hasTidalAuth) {
            try {
                const providerInput = this.toProviderMatchInput(trackMeta);
                const [tidalMatch] =
                    await tidalStreamingService.findMatchesForAlbum(userId, [
                        providerInput,
                    ]);
                if (tidalMatch) {
                    const tidalRow =
                        await trackMappingService.upsertTrackTidal({
                            tidalId: tidalMatch.id,
                            title: tidalMatch.title,
                            artist: tidalMatch.artist,
                            album: trackMeta.album || "",
                            duration: tidalMatch.duration,
                            isrc: tidalMatch.isrc,
                        });
                    return {
                        ...base,
                        trackTidalId: tidalRow.id,
                        source: "tidal",
                        confidence: 85,
                    };
                }
            } catch (err) {
                log.warn("Tidal match failed during import:", err);
            }
        }

        return { ...base, source: "unresolved", confidence: 0 };
    }

    /**
     * Preview import — resolves all tracks but doesn't create playlist.
     */
    async previewImport(
        userId: string,
        sourceUrl: string
    ): Promise<{
        playlistName: string;
        resolved: ResolvedTrack[];
        summary: { total: number; local: number; youtube: number; tidal: number; unresolved: number };
    }> {
        const parsed = this.parseSourceUrl(sourceUrl);
        if (!parsed) throw new Error("Unsupported playlist URL");

        const { name, tracks } = await this.fetchSourceTracks(
            parsed.source,
            parsed.id
        );

        // Fetch local library for matching
        const localCandidates = await this.getLocalLibraryCandidates();

        // Check Tidal auth
        const hasTidalAuth = await this.checkTidalAuth(userId);

        const resolved = await this.resolveTracks(
            tracks,
            localCandidates,
            userId,
            hasTidalAuth
        );

        const summary = {
            total: resolved.length,
            local: resolved.filter((r) => r.source === "local").length,
            youtube: resolved.filter((r) => r.source === "youtube").length,
            tidal: resolved.filter((r) => r.source === "tidal").length,
            unresolved: resolved.filter((r) => r.source === "unresolved")
                .length,
        };

        return { playlistName: name, resolved, summary };
    }

    /**
     * Execute import — creates Playlist + PlaylistItems.
     */
    async importPlaylist(
        userId: string,
        sourceUrl: string,
        playlistName: string
    ): Promise<{
        playlistId: string;
        summary: { total: number; local: number; youtube: number; tidal: number; unresolved: number };
    }> {
        const preview = await this.previewImport(userId, sourceUrl);
        const effectivePlaylistName = playlistName || preview.playlistName;
        const { importableTracks, skippedDuplicateLocalTracks } =
            this.buildImportableTracks(preview.resolved);

        const playlist = await prisma.$transaction(async (tx) => {
            const createdPlaylist = await tx.playlist.create({
                data: {
                    userId,
                    name: effectivePlaylistName,
                },
            });

            const items = importableTracks.map((r, sort) => ({
                playlistId: createdPlaylist.id,
                trackId: r.trackId || null,
                trackTidalId: r.trackTidalId || null,
                trackYtMusicId: r.trackYtMusicId || null,
                sort,
            }));

            if (items.length > 0) {
                await tx.playlistItem.createMany({
                    data: items,
                    skipDuplicates: true,
                });
            }

            return createdPlaylist;
        });

        await mapWithConcurrency(
            importableTracks,
            MAPPING_CREATE_CONCURRENCY,
            async (resolvedTrack) => {
                try {
                    await trackMappingService.createMapping({
                        trackId: resolvedTrack.trackId,
                        trackTidalId: resolvedTrack.trackTidalId,
                        trackYtMusicId: resolvedTrack.trackYtMusicId,
                        confidence: resolvedTrack.confidence / 100,
                        source: "import-match",
                    });
                } catch (err) {
                    log.warn("Track mapping creation failed after import:", err);
                }
            }
        );

        if (skippedDuplicateLocalTracks > 0) {
            log.warn(
                `Skipped ${skippedDuplicateLocalTracks} duplicate local matches ` +
                    `for playlist "${effectivePlaylistName}" to satisfy unique (playlistId, trackId)`
            );
        }

        log.info(
            `Imported playlist "${effectivePlaylistName}" for user ${userId}: ` +
                `${preview.summary.total} tracks (${preview.summary.local} local, ` +
                `${preview.summary.youtube} YT, ${preview.summary.tidal} Tidal, ` +
                `${preview.summary.unresolved} unresolved)`
        );

        return {
            playlistId: playlist.id,
            summary: preview.summary,
        };
    }

    private toProviderMatchInput(trackMeta: ImportTrackMeta): ProviderMatchInput {
        return {
            artist: trackMeta.artist,
            title: trackMeta.title,
            albumTitle: trackMeta.album,
            duration: trackMeta.duration,
            isrc: trackMeta.isrc,
        };
    }

    private buildImportableTracks(
        resolvedTracks: ResolvedTrack[]
    ): {
        importableTracks: ResolvedTrack[];
        skippedDuplicateLocalTracks: number;
    } {
        const importableTracks: ResolvedTrack[] = [];
        const seenLocalTrackIds = new Set<string>();
        let skippedDuplicateLocalTracks = 0;

        for (const resolved of resolvedTracks) {
            if (resolved.source === "unresolved") continue;
            if (
                resolved.trackId &&
                seenLocalTrackIds.has(resolved.trackId)
            ) {
                skippedDuplicateLocalTracks += 1;
                continue;
            }
            if (resolved.trackId) {
                seenLocalTrackIds.add(resolved.trackId);
            }
            importableTracks.push(resolved);
        }

        return { importableTracks, skippedDuplicateLocalTracks };
    }

    private async resolveTracks(
        tracks: ImportTrackMeta[],
        localCandidates: LocalTrackCandidate[],
        userId: string,
        hasTidalAuth: boolean
    ): Promise<ResolvedTrack[]> {
        const resolved: ResolvedTrack[] = tracks.map((track, index) => ({
            index,
            artist: track.artist,
            title: track.title,
            album: track.album,
            source: "unresolved",
            confidence: 0,
        }));
        const unresolved: IndexedImportTrack[] = [];
        const seenLocalTrackIds = new Set<string>();
        let duplicateLocalMatches = 0;

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const localMatch = matchTrackAgainstLibrary(track, localCandidates);
            if (localMatch && localMatch.matchConfidence >= 70) {
                if (!seenLocalTrackIds.has(localMatch.trackId)) {
                    seenLocalTrackIds.add(localMatch.trackId);
                    resolved[i] = {
                        ...resolved[i],
                        trackId: localMatch.trackId,
                        source: "local",
                        confidence: localMatch.matchConfidence,
                    };
                    continue;
                }
                duplicateLocalMatches += 1;
            }

            unresolved.push({ index: i, track });
        }

        await this.resolveWithYouTube(unresolved, resolved);

        if (hasTidalAuth) {
            const tidalCandidates = unresolved.filter(
                (item) => resolved[item.index].source === "unresolved"
            );
            await this.resolveWithTidal(userId, tidalCandidates, resolved);
        }

        if (duplicateLocalMatches > 0) {
            log.info(
                `Detected ${duplicateLocalMatches} duplicate local matches; ` +
                    "re-routed duplicates through provider matching"
            );
        }

        return resolved;
    }

    private async resolveWithYouTube(
        unresolved: IndexedImportTrack[],
        resolved: ResolvedTrack[]
    ): Promise<void> {
        if (unresolved.length === 0) return;

        const matchedTracks = await this.matchYouTubeInBatches(unresolved);
        if (matchedTracks.length === 0) return;

        const ytRows = await mapWithConcurrency(
            matchedTracks,
            UPSERT_CONCURRENCY,
            async ({ track, match, index }) => {
                try {
                    const row = await trackMappingService.upsertTrackYtMusic({
                        videoId: match.videoId,
                        title: match.title,
                        artist: track.artist,
                        album: track.album || "",
                        duration: match.duration,
                    });
                    return { index, trackYtMusicId: row.id };
                } catch (err) {
                    log.warn("YT Music upsert failed during import:", err);
                    return null;
                }
            }
        );

        for (const ytRow of ytRows) {
            if (!ytRow) continue;
            const current = resolved[ytRow.index];
            resolved[ytRow.index] = {
                ...current,
                trackYtMusicId: ytRow.trackYtMusicId,
                source: "youtube",
                confidence: 85,
            };
        }
    }

    private async resolveWithTidal(
        userId: string,
        unresolved: IndexedImportTrack[],
        resolved: ResolvedTrack[]
    ): Promise<void> {
        if (unresolved.length === 0) return;

        const matchedTracks = await this.matchTidalInBatches(
            userId,
            unresolved
        );
        if (matchedTracks.length === 0) return;

        const tidalRows = await mapWithConcurrency(
            matchedTracks,
            UPSERT_CONCURRENCY,
            async ({ track, match, index }) => {
                try {
                    const row = await trackMappingService.upsertTrackTidal({
                        tidalId: match.id,
                        title: match.title,
                        artist: match.artist,
                        album: track.album || "",
                        duration: match.duration,
                        isrc: match.isrc,
                    });
                    return { index, trackTidalId: row.id };
                } catch (err) {
                    log.warn("Tidal upsert failed during import:", err);
                    return null;
                }
            }
        );

        for (const tidalRow of tidalRows) {
            if (!tidalRow) continue;
            const current = resolved[tidalRow.index];
            resolved[tidalRow.index] = {
                ...current,
                trackTidalId: tidalRow.trackTidalId,
                source: "tidal",
                confidence: 85,
            };
        }
    }

    private async matchYouTubeInBatches(
        unresolved: IndexedImportTrack[]
    ): Promise<Array<IndexedImportTrack & { match: YtMatch }>> {
        const batches = chunkArray(unresolved, MATCH_BATCH_SIZE);
        const batchResults = await mapWithConcurrency(
            batches,
            MATCH_BATCH_CONCURRENCY,
            async (batch) => {
                try {
                    const matches = await ytMusicService.findMatchesForAlbum(
                        "__public__",
                        batch.map(({ track }) =>
                            this.toProviderMatchInput(track)
                        )
                    );

                    return batch.flatMap((item, index) => {
                        const match = matches[index];
                        return match ? [{ ...item, match }] : [];
                    });
                } catch (err) {
                    log.warn("YT Music batch match failed during import:", err);
                    return [];
                }
            }
        );

        return batchResults.flat();
    }

    private async matchTidalInBatches(
        userId: string,
        unresolved: IndexedImportTrack[]
    ): Promise<Array<IndexedImportTrack & { match: TidalMatch }>> {
        const batches = chunkArray(unresolved, MATCH_BATCH_SIZE);
        const batchResults = await mapWithConcurrency(
            batches,
            MATCH_BATCH_CONCURRENCY,
            async (batch) => {
                try {
                    const matches =
                        await tidalStreamingService.findMatchesForAlbum(
                            userId,
                            batch.map(({ track }) =>
                                this.toProviderMatchInput(track)
                            )
                        );

                    return batch.flatMap((item, index) => {
                        const match = matches[index];
                        return match ? [{ ...item, match }] : [];
                    });
                } catch (err) {
                    log.warn("Tidal batch match failed during import:", err);
                    return [];
                }
            }
        );

        return batchResults.flat();
    }

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

    private async checkTidalAuth(userId: string): Promise<boolean> {
        try {
            const settings = await prisma.userSettings.findUnique({
                where: { userId },
                select: { tidalOAuthJson: true },
            });
            return !!settings?.tidalOAuthJson;
        } catch {
            return false;
        }
    }
}

export const playlistImportService = new PlaylistImportService();

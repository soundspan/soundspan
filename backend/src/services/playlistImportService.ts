/**
 * PlaylistImportService — Multi-provider playlist import.
 *
 * Resolves tracks: local library first → Tidal (if user connected)
 * → YT Music (universal fallback). Creates PlaylistItems with appropriate
 * provider FKs.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { decrypt } from "../utils/encryption";
import { getSystemSettings } from "../utils/systemSettings";
import { spotifyService } from "./spotify";
import { deezerService } from "./deezer";
import { ytMusicService } from "./youtubeMusic";
import { tidalStreamingService } from "./tidalStreaming";
import { trackMappingService } from "./trackMappingService";
import {
    matchM3UEntryAgainstLibrary,
    matchTrackAgainstLibrary,
    type LocalTrackCandidate,
} from "../utils/trackMatching";
import { parseM3U } from "./m3uParser";

const log = logger.child("PlaylistImportService");
const MATCH_BATCH_SIZE = 25;
const MATCH_BATCH_CONCURRENCY = 2;
const UPSERT_CONCURRENCY = 6;
const MAPPING_CREATE_CONCURRENCY = 8;
const TIDAL_IMPORT_QUALITY = "HIGH";

function getErrorStatusCode(error: unknown): number | null {
    const status = (error as { response?: { status?: number } })?.response?.status;
    return typeof status === "number" ? status : null;
}

function parseProviderUrlCandidate(rawUrl: string): URL | null {
    try {
        return new URL(rawUrl);
    } catch {
        const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl);
        if (hasExplicitScheme) {
            return null;
        }
        try {
            return new URL(`https://${rawUrl}`);
        } catch {
            return null;
        }
    }
}

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
    /** YT Music native playlist track videoId */
    videoId?: string;
    /** Tidal native playlist track ID */
    tidalId?: number;
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

type SourceType = "spotify" | "deezer" | "youtube" | "tidal";
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
        const normalizedUrl = url.trim();
        const parsedUrl = parseProviderUrlCandidate(normalizedUrl);
        const host = parsedUrl?.hostname.toLowerCase().replace(/^www\./, "") ?? "";
        const pathSegments = (parsedUrl?.pathname ?? "")
            .split("/")
            .filter(Boolean);

        // Spotify
        const isSpotifyUri = normalizedUrl.toLowerCase().startsWith("spotify:");
        const spotifyParsed =
            isSpotifyUri ||
            host === "spotify.com" ||
            host === "open.spotify.com" ||
            host === "play.spotify.com"
                ? spotifyService.parseUrl(normalizedUrl)
                : null;
        if (spotifyParsed && spotifyParsed.type === "playlist") {
            return { source: "spotify", id: spotifyParsed.id };
        }

        // Deezer
        if (host === "deezer.com") {
            const playlistIdx = pathSegments.findIndex(
                (segment) => segment.toLowerCase() === "playlist"
            );
            const deezerId =
                playlistIdx >= 0 && playlistIdx < pathSegments.length - 1
                    ? pathSegments[playlistIdx + 1]
                    : null;
            if (deezerId && /^\d+$/.test(deezerId)) {
                return { source: "deezer", id: deezerId };
            }
        }

        // YouTube / YouTube Music — use URL parsing for robust query-param extraction
        if (
            (
                host === "music.youtube.com" ||
                host === "youtube.com" ||
                host === "m.youtube.com"
            ) &&
            parsedUrl?.pathname.replace(/\/+$/, "") === "/playlist"
        ) {
            const listId = parsedUrl.searchParams.get("list");
            if (listId && /^[A-Za-z0-9_-]+$/.test(listId)) {
                return { source: "youtube", id: listId };
            }
        }

        // Tidal
        if (host === "tidal.com" || host === "listen.tidal.com") {
            let tidalId: string | null = null;
            if (
                pathSegments.length === 2 &&
                pathSegments[0].toLowerCase() === "playlist"
            ) {
                tidalId = pathSegments[1];
            } else if (
                pathSegments.length === 3 &&
                pathSegments[0].toLowerCase() === "browse" &&
                pathSegments[1].toLowerCase() === "playlist"
            ) {
                tidalId = pathSegments[2];
            }
            if (tidalId && /^[0-9a-f-]+$/i.test(tidalId)) {
                return { source: "tidal", id: tidalId };
            }
        }

        return null;
    }

    /**
     * Fetch track metadata from the source URL.
     */
    async fetchSourceTracks(
        source: SourceType,
        sourceId: string,
        userId?: string
    ): Promise<{ name: string; tracks: ImportTrackMeta[] }> {
        if (source === "spotify") {
            const playlist = await spotifyService.getPlaylist(sourceId);
            if (!playlist) throw new Error("Spotify playlist not found");

            return {
                name: playlist.name,
                tracks: playlist.tracks.map((t) => ({
                    artist: t.artist || "Unknown",
                    title: t.title || "Unknown",
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
                    title: t.title || "Unknown",
                    album: t.album || undefined,
                    duration: t.durationMs
                        ? Math.round(t.durationMs / 1000)
                        : undefined,
                })),
            };
        }

        if (source === "youtube") {
            const ytBrowseUserId =
                userId && (await this.checkYtMusicAuth(userId))
                    ? userId
                    : "__public__";
            const playlist = await ytMusicService.getBrowsePlaylist(
                sourceId,
                100,
                ytBrowseUserId
            );
            return {
                name: playlist.title,
                tracks: playlist.tracks.map((t) => ({
                    artist: t.artist || "Unknown",
                    title: t.title || "Unknown",
                    album: t.album || undefined,
                    duration: t.duration,
                    videoId: t.videoId,
                })),
            };
        }

        if (source === "tidal") {
            const loadPublicPlaylist = async () => {
                try {
                    return await tidalStreamingService.getPublicBrowsePlaylist(
                        sourceId,
                        TIDAL_IMPORT_QUALITY
                    );
                } catch (error) {
                    const statusCode = getErrorStatusCode(error);
                    if (statusCode === 404) {
                        throw new Error("Tidal playlist not found");
                    }
                    if (statusCode === 401 || statusCode === 403) {
                        throw new Error("Tidal import requires authentication");
                    }
                    throw error;
                }
            };

            let playlist = null as Awaited<
                ReturnType<typeof tidalStreamingService.getBrowsePlaylist>
            > | null;

            if (userId) {
                const hasTidalAuth = await this.checkTidalAuth(userId);
                if (hasTidalAuth) {
                    try {
                        playlist = await tidalStreamingService.getBrowsePlaylist(
                            userId,
                            sourceId,
                            TIDAL_IMPORT_QUALITY
                        );
                    } catch (error) {
                        const statusCode = getErrorStatusCode(error);
                        if (statusCode && statusCode !== 401 && statusCode !== 403) {
                            if (statusCode === 404) {
                                throw new Error("Tidal playlist not found");
                            }
                            throw error;
                        }
                    }
                }
            }

            if (!playlist) {
                playlist = await loadPublicPlaylist();
            }

            return {
                name: playlist.title,
                tracks: playlist.tracks.map((t) => ({
                    artist: t.artist || "Unknown",
                    title: t.title || "Unknown",
                    album: t.album || undefined,
                    duration: t.duration,
                    isrc: t.isrc || undefined,
                    tidalId: t.trackId,
                })),
            };
        }

        throw new Error(`Unsupported source: ${source}`);
    }

    /**
     * Resolve a single track against available providers.
     * Priority: local library → Tidal (if authenticated) → YT Music.
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

        // 2. Try Tidal (if user has OAuth)
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

        // 3. Try YT Music (unauthenticated, universal fallback)
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
            parsed.id,
            userId
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
     * Preview import for a local M3U or M3U8 playlist file.
     * Resolves only against the local library using deterministic tiered matching.
     */
    async previewM3UImport(
        playlistName: string,
        content: string
    ): Promise<{
        playlistName: string;
        resolved: ResolvedTrack[];
        summary: {
            total: number;
            local: number;
            youtube: number;
            tidal: number;
            unresolved: number;
        };
    }> {
        const entries = parseM3U(content);
        const localCandidates = await this.getLocalLibraryCandidates();

        const resolved = entries.map((entry, index) => {
            const match = matchM3UEntryAgainstLibrary(entry, localCandidates);
            return {
                index,
                artist: entry.artist || "",
                title: entry.title || getFallbackTitleFromPath(entry.filePath),
                ...(match ?
                    {
                        trackId: match.trackId,
                        source: "local" as const,
                        confidence: match.matchConfidence,
                    }
                :   {
                        source: "unresolved" as const,
                        confidence: 0,
                    }),
            };
        });

        return {
            playlistName,
            resolved,
            summary: {
                total: resolved.length,
                local: resolved.filter((track) => track.source === "local").length,
                youtube: 0,
                tidal: 0,
                unresolved: resolved.filter((track) => track.source === "unresolved")
                    .length,
            },
        };
    }

    /**
     * Execute import — creates Playlist + PlaylistItems from preview data.
     * Accepts pre-resolved preview data directly to avoid re-fetching.
     */
    async importPlaylist(
        userId: string,
        previewData: {
            playlistName: string;
            resolved: ResolvedTrack[];
            summary: { total: number; local: number; youtube: number; tidal: number; unresolved: number };
        },
        overrideName?: string
    ): Promise<{
        playlistId: string;
        summary: { total: number; local: number; youtube: number; tidal: number; unresolved: number };
    }> {
        const effectivePlaylistName = overrideName || previewData.playlistName;
        const { importableTracks, skippedDuplicateLocalTracks } =
            this.buildImportableTracks(previewData.resolved);

        await this.validateResolvedTrackIds(importableTracks);

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
                `${previewData.summary.total} tracks (${previewData.summary.local} local, ` +
                `${previewData.summary.youtube} YT, ${previewData.summary.tidal} Tidal, ` +
                `${previewData.summary.unresolved} unresolved)`
        );

        return {
            playlistId: playlist.id,
            summary: previewData.summary,
        };
    }

    /**
     * Validates that all track IDs referenced in resolved tracks exist in the database.
     */
    private async validateResolvedTrackIds(
        tracks: ResolvedTrack[]
    ): Promise<void> {
        const trackIds = [
            ...new Set(tracks.filter((t) => t.trackId).map((t) => t.trackId!)),
        ];
        const ytIds = [
            ...new Set(
                tracks
                    .filter((t) => t.trackYtMusicId)
                    .map((t) => t.trackYtMusicId!)
            ),
        ];
        const tidalIds = [
            ...new Set(
                tracks
                    .filter((t) => t.trackTidalId)
                    .map((t) => t.trackTidalId!)
            ),
        ];

        const missing: string[] = [];

        if (trackIds.length > 0) {
            const found = await prisma.track.findMany({
                where: { id: { in: trackIds } },
                select: { id: true },
            });
            const foundSet = new Set(found.map((r) => r.id));
            for (const id of trackIds) {
                if (!foundSet.has(id)) missing.push(`trackId:${id}`);
            }
        }

        if (ytIds.length > 0) {
            const found = await prisma.trackYtMusic.findMany({
                where: { id: { in: ytIds } },
                select: { id: true },
            });
            const foundSet = new Set(found.map((r) => r.id));
            for (const id of ytIds) {
                if (!foundSet.has(id)) missing.push(`trackYtMusicId:${id}`);
            }
        }

        if (tidalIds.length > 0) {
            const found = await prisma.trackTidal.findMany({
                where: { id: { in: tidalIds } },
                select: { id: true },
            });
            const foundSet = new Set(found.map((r) => r.id));
            for (const id of tidalIds) {
                if (!foundSet.has(id)) missing.push(`trackTidalId:${id}`);
            }
        }

        if (missing.length > 0) {
            throw new Error(
                `Invalid track reference(s): ${missing.join(", ")}`
            );
        }
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

        // Resolve tracks that already have native provider IDs (e.g. from YT/Tidal playlist import)
        await this.resolveNativeProviderTracks(unresolved, resolved);

        // Filter down to tracks still unresolved after native resolution
        const stillUnresolved = unresolved.filter(
            (item) => resolved[item.index].source === "unresolved"
        );

        if (hasTidalAuth) {
            await this.resolveWithTidal(userId, stillUnresolved, resolved);
        }

        const youtubeCandidates = stillUnresolved.filter(
            (item) => resolved[item.index].source === "unresolved"
        );
        await this.resolveWithYouTube(youtubeCandidates, resolved);

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

    /**
     * Resolve tracks that carry native provider IDs (videoId or tidalId)
     * directly, without search. These come from YT Music or Tidal playlist imports.
     */
    private async resolveNativeProviderTracks(
        unresolved: IndexedImportTrack[],
        resolved: ResolvedTrack[]
    ): Promise<void> {
        const nativeTracks = unresolved.filter(
            (item) => !!item.track.videoId || !!item.track.tidalId
        );
        if (nativeTracks.length === 0) return;

        await mapWithConcurrency(
            nativeTracks,
            UPSERT_CONCURRENCY,
            async ({ index, track }) => {
                try {
                    if (track.videoId) {
                        const ytRow = await trackMappingService.upsertTrackYtMusic({
                            videoId: track.videoId,
                            title: track.title,
                            artist: track.artist,
                            album: track.album || "",
                            duration: track.duration || 0,
                        });
                        resolved[index] = {
                            ...resolved[index],
                            trackYtMusicId: ytRow.id,
                            source: "youtube",
                            confidence: 100,
                        };
                    } else if (track.tidalId) {
                        const tidalRow = await trackMappingService.upsertTrackTidal({
                            tidalId: track.tidalId,
                            title: track.title,
                            artist: track.artist,
                            album: track.album || "",
                            duration: track.duration || 0,
                            isrc: track.isrc,
                        });
                        resolved[index] = {
                            ...resolved[index],
                            trackTidalId: tidalRow.id,
                            source: "tidal",
                            confidence: 100,
                        };
                    }
                } catch (err) {
                    log.warn("Native provider upsert failed during import:", err);
                }
            }
        );
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

    private async checkYtMusicAuth(userId: string): Promise<boolean> {
        try {
            const settings = await prisma.userSettings.findUnique({
                where: { userId },
                select: { ytMusicOAuthJson: true },
            });
            if (!settings?.ytMusicOAuthJson) {
                return false;
            }

            let oauthJson = settings.ytMusicOAuthJson;
            try {
                oauthJson = decrypt(settings.ytMusicOAuthJson);
            } catch {
                // keep plaintext legacy payloads compatible
            }

            const systemSettings = await getSystemSettings();
            await ytMusicService.restoreOAuthWithCredentials(
                userId,
                oauthJson,
                systemSettings?.ytMusicClientId || undefined,
                systemSettings?.ytMusicClientSecret || undefined
            );
            return true;
        } catch (error) {
            log.warn(
                `[PlaylistImport] YT Music credentials restore failed for ${userId}; falling back to public browse`,
                error
            );
            return false;
        }
    }

    private async checkTidalAuth(userId: string): Promise<boolean> {
        try {
            const settings = await prisma.userSettings.findUnique({
                where: { userId },
                select: { tidalOAuthJson: true },
            });
            if (!settings?.tidalOAuthJson) {
                return false;
            }

            let oauthJson = settings.tidalOAuthJson;
            try {
                oauthJson = decrypt(settings.tidalOAuthJson);
            } catch {
                // keep plaintext legacy payloads compatible
            }

            const restored = await tidalStreamingService.restoreOAuth(
                userId,
                oauthJson
            );
            if (!restored) {
                log.warn(
                    `[PlaylistImport] TIDAL credentials exist for ${userId}, but session restore failed; skipping TIDAL matching`
                );
            }
            return restored;
        } catch {
            return false;
        }
    }
}

function getFallbackTitleFromPath(filePath: string): string {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const filename = normalizedPath.split("/").pop() || filePath;
    return filename.replace(/\.[^.]+$/, "");
}

export const playlistImportService = new PlaylistImportService();

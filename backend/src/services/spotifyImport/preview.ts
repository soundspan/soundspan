import { spotifyService, type SpotifyTrack } from "../spotify";
import { logger } from "../../utils/logger";
import { musicBrainzService } from "../musicbrainz";
import PQueue from "p-queue";
import { stripTrackSuffix } from "../../utils/trackMatching";
import { SpotifyImportMatchingService } from "./matching";
import type { AlbumToDownload, ImportPreview, MatchedTrack } from "./types";

export class SpotifyImportPreviewService extends SpotifyImportMatchingService {
    /**
     * Shared preview generator for any source tracklist
     */
    protected async buildPreviewFromTracklist(
        tracks: SpotifyTrack[],
        playlistMeta: {
            id: string;
            name: string;
            description: string | null;
            owner: string;
            imageUrl: string | null;
            trackCount: number;
        },
        source: "Spotify" | "Deezer",
    ): Promise<ImportPreview> {
        const logPrefix =
            source === "Spotify" ? "[Spotify Import]" : "[Deezer Import]";

        // PHASE 0: Early MusicBrainz resolution for "Unknown Album" tracks
        // This MUST happen BEFORE grouping so tracks get grouped by actual albums
        const unknownCount = tracks.filter(
            (t) => t.album === "Unknown Album",
        ).length;

        if (unknownCount > 0) {
            logger?.info(
                `${logPrefix} Found ${unknownCount} tracks with Unknown Album, attempting MusicBrainz resolution...`,
            );
            try {
                await this.enrichUnknownAlbumsViaMusicBrainz(tracks, logPrefix);
            } catch (error: unknown) {
                const errorMsg =
                    error instanceof Error ? error.message : String(error);
                logger?.error(
                    `${logPrefix} MusicBrainz enrichment failed: ${errorMsg}`,
                );
                // Continue with original tracks - graceful degradation
            }

            // Log remaining unknown after resolution
            const stillUnknown = tracks.filter(
                (t) => t.album === "Unknown Album",
            ).length;
            if (stillUnknown > 0) {
                logger?.info(
                    `${logPrefix} ${stillUnknown} tracks still have Unknown Album after MusicBrainz resolution`,
                );
            }
        }

        // matchTrack is purely Prisma-bound (no per-track external API calls --
        // MusicBrainz lookups only happen later, per unmatched album), so the
        // per-track DB round trips can safely overlap. Concurrency is bounded to
        // the worker's Prisma pool size (4 connections); going higher just queues
        // at the pool instead of buying more overlap.
        //
        // Order stability is required: matchedTracks must stay in the exact
        // input order (the UI and downstream consumers rely on it), and the
        // unmatchedByAlbum grouping must produce the same Map insertion order as
        // the old serial loop (it drives albumsToDownload order downstream). So
        // we collect the queued promises in input order via Promise.all (which
        // preserves array position regardless of resolution order) and only
        // build unmatchedByAlbum AFTER every match has resolved, iterating the
        // ordered results -- never inside the concurrent phase.
        const SPOTIFY_IMPORT_MATCH_CONCURRENCY = 4;
        const matchQueue = new PQueue({
            concurrency: SPOTIFY_IMPORT_MATCH_CONCURRENCY,
        });
        const matchedTracks: MatchedTrack[] = await Promise.all(
            tracks.map((track) => matchQueue.add(() => this.matchTrack(track))),
        );

        // Group by the ORIGINAL input track (positionally zipped via the same
        // index Promise.all/.map preserved), not by matchedTracks[i].spotifyTrack
        // -- matchTrack always echoes its input back unchanged in production, but
        // matching on the input track directly, like the old serial loop did,
        // keeps this immune to that assumption either way.
        const unmatchedByAlbum = new Map<string, SpotifyTrack[]>();
        tracks.forEach((track, index) => {
            const matched = matchedTracks[index];
            if (!matched.localTrack) {
                const key = `${track.artist}|||${track.album}`;
                const existing = unmatchedByAlbum.get(key) || [];
                existing.push(track);
                unmatchedByAlbum.set(key, existing);
            }
        });

        const albumsToDownload: AlbumToDownload[] = [];

        for (const [key, albumTracks] of unmatchedByAlbum.entries()) {
            const [artistName, albumName] = key.split("|||");

            let resolvedAlbumName = albumName;
            let artistMbid: string | null = null;
            let albumMbid: string | null = null;

            // Check if this album was resolved via MusicBrainz (albumId starts with "mbid:")
            const firstTrack = albumTracks[0];
            const wasMbResolved = firstTrack.albumId?.startsWith("mbid:");
            const preResolvedMbid = wasMbResolved
                ? firstTrack.albumId!.replace("mbid:", "")
                : null;

            logger?.debug(
                `\n${logPrefix} ========================================`,
            );
            logger?.debug(
                `${logPrefix} Looking up: "${artistName}" - "${albumName}"`,
            );

            // If we have MBID from early resolution, use it directly
            if (preResolvedMbid) {
                albumMbid = preResolvedMbid;
                logger?.debug(
                    `${logPrefix} Using pre-resolved MBID: ${albumMbid}`,
                );
                // Still get artistMbid for completeness
                const artists = await musicBrainzService.searchArtist(
                    artistName,
                    1,
                );
                if (artists && artists.length > 0) {
                    artistMbid = artists[0].id;
                }
            } else if (albumName && albumName !== "Unknown Album") {
                // Normalize album name to remove live/remaster suffixes
                const normalizedAlbumName = stripTrackSuffix(albumName);
                const wasNormalized = normalizedAlbumName !== albumName;

                logger?.debug(
                    `${logPrefix} Searching for album "${albumName}" by ${artistName}...`,
                );
                if (wasNormalized) {
                    logger?.debug(
                        `${logPrefix}   → Normalized to: "${normalizedAlbumName}"`,
                    );
                }

                const mbResult = await this.findAlbumMbid(
                    artistName,
                    normalizedAlbumName,
                );
                artistMbid = mbResult.artistMbid;
                albumMbid = mbResult.albumMbid;

                if (albumMbid) {
                    logger?.debug(
                        `${logPrefix} ✓ Found album directly: "${albumName}" (MBID: ${albumMbid})`,
                    );
                }
            }

            if (!albumMbid) {
                logger?.debug(
                    `${logPrefix} Album not found, trying track-based search...`,
                );
                for (const track of albumTracks) {
                    // Normalize track title to remove live/remaster suffixes
                    const normalizedTrackTitle = stripTrackSuffix(track.title);
                    const wasNormalized = normalizedTrackTitle !== track.title;

                    logger?.debug(
                        `${logPrefix}   Searching for track "${track.title}"...`,
                    );
                    if (wasNormalized) {
                        logger?.debug(
                            `${logPrefix}     → Normalized to: "${normalizedTrackTitle}"`,
                        );
                    }

                    const recordingInfo =
                        await musicBrainzService.searchRecording(
                            normalizedTrackTitle,
                            artistName,
                        );

                    if (recordingInfo) {
                        resolvedAlbumName = recordingInfo.albumName;
                        artistMbid = recordingInfo.artistMbid;
                        albumMbid = recordingInfo.albumMbid;

                        logger?.debug(
                            `${logPrefix} ✓ Found via track: "${resolvedAlbumName}" (MBID: ${albumMbid})`,
                        );
                        break;
                    }
                }
            }

            if (!albumMbid) {
                logger?.debug(
                    `${logPrefix} ✗ Could not find album MBID for ${artistName} - "${resolvedAlbumName}"`,
                );
                if (albumName === "Unknown Album") {
                    logger?.debug(
                        `${logPrefix} ℹ But can still download via Soulseek (track-based search)`,
                    );
                }
            }

            const albumToDownload: AlbumToDownload = {
                spotifyAlbumId:
                    albumTracks[0].albumId?.replace("mbid:", "") || "",
                albumName: resolvedAlbumName,
                artistName,
                artistMbid,
                albumMbid,
                coverUrl: albumTracks[0].coverUrl,
                trackCount: albumTracks.length,
                tracksNeeded: albumTracks,
            };

            logger?.debug(`${logPrefix} Download strategy:`);
            if (albumMbid) {
                logger?.debug(`   Will request album from Lidarr/Soulseek:`);
                logger?.debug(
                    `   Artist: "${artistName}" (MBID: ${artistMbid || "NONE"})`,
                );
                logger?.debug(
                    `   Album: "${resolvedAlbumName}" (MBID: ${albumMbid})`,
                );
            } else {
                // No MBID - will try Soulseek track-based search
                logger?.debug(
                    `   Will request individual tracks via Soulseek (no MBID):`,
                );
                logger?.debug(`   Artist: "${artistName}"`);
                logger?.debug(
                    `   Tracks: ${albumTracks
                        .map((t) => `"${t.title}"`)
                        .join(", ")}`,
                );
            }
            logger?.debug(
                `${logPrefix} ========================================\n`,
            );

            albumsToDownload.push(albumToDownload);
        }

        const inLibrary = matchedTracks.filter(
            (m) => m.localTrack !== null,
        ).length;

        // All albums are now downloadable via Soulseek (either album-based with MBID or track-based without)
        const downloadableAlbums = albumsToDownload;

        const downloadable = downloadableAlbums.reduce(
            (sum, a) => sum + a.tracksNeeded.length,
            0,
        );
        // Soulseek track-level fallback means there is no not-found bucket here.
        const notFound = 0;

        return {
            playlist: playlistMeta,
            matchedTracks,
            albumsToDownload,
            summary: {
                total: playlistMeta.trackCount,
                inLibrary,
                downloadable,
                notFound,
            },
        };
    }

    /**
     * Generate a preview of what will be imported
     */
    async generatePreview(spotifyUrl: string): Promise<ImportPreview> {
        // Clear any stale null cache entries before processing
        // This ensures we retry previously failed lookups
        await musicBrainzService.clearStaleRecordingCaches();

        const playlist = await spotifyService.getPlaylist(spotifyUrl);
        if (!playlist) {
            throw new Error(
                "Could not fetch playlist from Spotify. Make sure it's a valid public playlist URL.",
            );
        }

        return this.buildPreviewFromTracklist(
            playlist.tracks,
            {
                id: playlist.id,
                name: playlist.name,
                description: playlist.description,
                owner: playlist.owner,
                imageUrl: playlist.imageUrl,
                trackCount: playlist.trackCount,
            },
            "Spotify",
        );
    }

    /**
     * Generate a preview from a Deezer playlist
     * Converts Deezer tracks to Spotify format and processes them
     */
    async generatePreviewFromDeezer(
        deezerPlaylist: any,
    ): Promise<ImportPreview> {
        // Clear any stale null cache entries before processing
        await musicBrainzService.clearStaleRecordingCaches();

        logger?.debug(
            "[Deezer Debug] Sample track from Deezer:",
            JSON.stringify(deezerPlaylist.tracks[0], null, 2),
        );

        const spotifyTracks: SpotifyTrack[] = deezerPlaylist.tracks.map(
            (track: any, index: number) => ({
                spotifyId: track.deezerId,
                title: track.title,
                artist: track.artist,
                artistId: track.artistId || "",
                album: track.album || "Unknown Album",
                albumId: track.albumId || "",
                isrc: null,
                durationMs: track.durationMs,
                trackNumber: track.trackNumber || index + 1,
                previewUrl: track.previewUrl || null,
                coverUrl: track.coverUrl || deezerPlaylist.imageUrl || null,
            }),
        );

        logger?.debug(
            "[Deezer Debug] Sample converted track:",
            JSON.stringify(spotifyTracks[0], null, 2),
        );

        return this.buildPreviewFromTracklist(
            spotifyTracks,
            {
                id: deezerPlaylist.id,
                name: deezerPlaylist.title,
                description: deezerPlaylist.description || null,
                owner: deezerPlaylist.creator || "Deezer",
                imageUrl: deezerPlaylist.imageUrl || null,
                trackCount: deezerPlaylist.trackCount || spotifyTracks.length,
            },
            "Deezer",
        );
    }
}

import { logger } from "../utils/logger";
import { config } from "../config";
import { getSystemSettings } from "../utils/systemSettings";
import {
    normalizeForExactKey,
    stripAlbumEdition,
} from "../utils/artistNormalization";
import {
    getLidarrErrorMessage,
    lidarrErrorLogFields,
    LidarrHttpClient,
} from "./lidarr/lidarrHttpClient";
import {
    blocklistQueueDownload,
    clearFailedQueue as clearFailedLidarrQueue,
} from "./lidarr/lidarrQueue";
import {
    awaitArtistCatalog,
    ensureArtistPresent,
    type LidarrCatalogClock,
} from "./lidarr/lidarrArtistCatalog";
import { selectAlbumInCatalogMatch } from "./lidarr/lidarrAlbumSelection";
import { grabRelease as grabCatalogRelease } from "./lidarr/lidarrReleaseGrab";
import {
    getReconciliationSnapshot as fetchReconciliationSnapshot,
    isAlbumAvailableInSnapshot as snapshotHasAlbum,
    isDownloadActiveInSnapshot as snapshotHasActiveDownload,
    type ReconciliationSnapshot,
} from "./lidarr/lidarrReconciliation";
import { LidarrTagService } from "./lidarr/lidarrTagService";
import type {
    LidarrAlbum,
    LidarrArtist,
    LidarrTag,
} from "./lidarr/lidarrTypes";

/**
 * Error types for music acquisition failures
 * Used to determine fallback strategies
 */
export enum AcquisitionErrorType {
    ARTIST_NOT_FOUND = "ARTIST_NOT_FOUND",
    ALBUM_NOT_FOUND = "ALBUM_NOT_FOUND",
    NO_INDEXER_RESULTS = "NO_INDEXER_RESULTS",
    NO_RELEASES_AVAILABLE = "NO_RELEASES_AVAILABLE",
    INDEXER_TIMEOUT = "INDEXER_TIMEOUT",
    METADATA_ERROR = "METADATA_ERROR",
    NETWORK_ERROR = "NETWORK_ERROR",
    UNKNOWN = "UNKNOWN",
}

/**
 * Structured error class for acquisition failures
 * Includes error type and recoverability flag for fallback logic
 */
export class AcquisitionError extends Error {
    public readonly type: AcquisitionErrorType;
    public readonly isRecoverable: boolean;
    public readonly originalError?: Error;

    constructor(
        message: string,
        type: AcquisitionErrorType,
        isRecoverable: boolean = true,
        originalError?: Error,
    ) {
        super(message);
        this.name = "AcquisitionError";
        this.type = type;
        this.isRecoverable = isRecoverable;
        this.originalError = originalError;

        // Maintain proper stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AcquisitionError);
        }
    }
}

class LidarrService {
    private client: LidarrHttpClient | null = null;
    private enabled: boolean;
    private initialized: boolean = false;
    private _indexerCountLogged: boolean = false;
    private readonly clock: LidarrCatalogClock = {
        sleep: (delayMs) =>
            new Promise((resolve) => setTimeout(resolve, delayMs)),
    };
    private readonly tagService: LidarrTagService;

    constructor() {
        this.tagService = new LidarrTagService({
            getClient: () => this.client,
            isEnabled: () => this.enabled,
            getTags: () => this.getTags(),
            createTag: (label) => this.createTag(label),
            getArtists: () => this.getArtists(),
            getArtistsByTag: (tagId) => this.getArtistsByTag(tagId),
            getDiscoveryTagId: () => this.getOrCreateDiscoveryTag(),
            removeTagsFromArtist: (artistId, tagIds) =>
                this.removeTagsFromArtist(artistId, tagIds),
        });
        // Initial check from .env (for backwards compatibility)
        this.enabled = config.lidarr?.enabled || false;

        // Under SECRETS_DB_ONLY the env-sourced apiKey is blanked at the
        // config boundary, so no env-based client is constructed.
        if (this.enabled && config.lidarr && !config.secretsDbOnly) {
            this.client = new LidarrHttpClient(
                { baseUrl: config.lidarr.url, apiKey: config.lidarr.apiKey },
                { timeoutMs: 30_000 },
            );
        }
    }

    private async ensureInitialized() {
        if (this.initialized) return;

        try {
            // Try to load from database
            const settings = await getSystemSettings();

            if (settings && settings.lidarrEnabled) {
                const url = settings.lidarrUrl || config.lidarr?.url;
                const apiKey = settings.lidarrApiKey || config.lidarr?.apiKey;

                if (url && apiKey) {
                    logger.debug("Lidarr configured from database");
                    this.client = new LidarrHttpClient(
                        { baseUrl: url, apiKey },
                        { timeoutMs: 30_000 },
                    );
                    this.enabled = true;
                } else {
                    logger.warn(
                        config.secretsDbOnly
                            ? "SECRETS_DB_ONLY: Lidarr enabled but missing URL or API key in system settings"
                            : "  Lidarr enabled but missing URL or API key",
                    );
                    this.enabled = false;
                    this.client = null;
                }
            } else if (config.lidarr && !config.secretsDbOnly) {
                // Fallback to .env
                logger.debug("Lidarr configured from .env");
                this.enabled = true;
            } else if (config.secretsDbOnly) {
                logger.debug(
                    "SECRETS_DB_ONLY: Lidarr is not configured in system settings (no .env fallback)",
                );
                this.enabled = false;
                this.client = null;
            } else {
                logger.debug("  Lidarr not enabled");
                this.enabled = false;
            }
        } catch (error) {
            if (config.secretsDbOnly) {
                logger.error(
                    "SECRETS_DB_ONLY: system settings unreadable; Lidarr disabled (no .env fallback)",
                );
                this.enabled = false;
                this.client = null;
            } else {
                logger.error("Failed to load Lidarr settings:", error);
                // Keep .env config if database fails
            }
        }

        this.initialized = true;
    }

    async isEnabled(): Promise<boolean> {
        await this.ensureInitialized();
        return this.enabled;
    }

    /**
     * Ensure the root folder exists in Lidarr, fallback to first available if not
     */
    private async ensureRootFolderExists(
        requestedPath: string,
    ): Promise<string> {
        if (!this.client) {
            return requestedPath;
        }

        try {
            // Get all root folders from Lidarr
            const response = await this.client.get("/api/v1/rootfolder");
            const rootFolders = response.data;

            if (rootFolders.length === 0) {
                logger.warn("  No root folders configured in Lidarr!");
                return requestedPath;
            }

            // Check if requested path exists
            const exists = rootFolders.find(
                (folder: any) => folder.path === requestedPath,
            );

            if (exists) {
                return requestedPath;
            }

            // Fallback to first available root folder
            const fallback = rootFolders[0].path;
            logger.debug(
                `  Root folder "${requestedPath}" not found in Lidarr`,
            );
            logger.debug(`   Using fallback: "${fallback}"`);
            return fallback;
        } catch (error) {
            logger.error("Error checking root folders:", error);
            return requestedPath; // Return requested path and let Lidarr error if needed
        }
    }

    async searchArtist(
        artistName: string,
        mbid?: string,
    ): Promise<LidarrArtist[]> {
        await this.ensureInitialized();

        // DEBUG: Log exact parameters received
        logger.debug(
            `[LIDARR_SEARCH_ARTIST] artistName="${artistName}", mbid="${mbid}"`,
        );

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            const response = await this.client.get("/api/v1/artist/lookup", {
                params: {
                    term: mbid ? `lidarr:${mbid}` : artistName,
                },
            });

            // If Lidarr's lookup returned results, use them
            if (response.data && response.data.length > 0) {
                return response.data;
            }

            // FALLBACK: Lidarr's metadata server may be having issues
            // If we have an MBID, create a minimal artist object from our own MusicBrainz data
            if (mbid) {
                logger.debug(
                    `   [FALLBACK] Lidarr lookup failed, using direct MusicBrainz data for MBID: ${mbid}`,
                );

                try {
                    // Import MusicBrainz service dynamically to avoid circular deps
                    const { musicBrainzService } =
                        await import("./musicbrainz");

                    // Get artist info from MusicBrainz directly
                    const mbArtists = await musicBrainzService.searchArtist(
                        artistName,
                        5,
                    );
                    const mbArtist =
                        mbArtists?.find((a: any) => a.id === mbid) ||
                        mbArtists?.[0];

                    if (mbArtist) {
                        // Create a minimal Lidarr-compatible artist object
                        const fallbackArtist: LidarrArtist = {
                            id: 0, // Will be assigned when added
                            artistName: mbArtist.name || artistName,
                            foreignArtistId: mbid,
                            artistType: mbArtist.type || "Person",
                            monitored: false,
                            qualityProfileId: 1,
                            metadataProfileId: 1,
                            rootFolderPath: "/music",
                            tags: [],
                            statistics: { albumCount: 0 },
                        };

                        logger.debug(
                            `   [FALLBACK] Created artist from MusicBrainz: ${fallbackArtist.artistName}`,
                        );
                        return [fallbackArtist];
                    }
                } catch (mbError: any) {
                    logger.error(
                        `   [FALLBACK] MusicBrainz lookup also failed:`,
                        mbError.message,
                    );
                }
            }

            return response.data || [];
        } catch (error) {
            logger.error("Lidarr artist search error:", error);

            // FALLBACK on error too
            if (mbid) {
                logger.debug(
                    `   [FALLBACK] Lidarr error, trying MusicBrainz for MBID: ${mbid}`,
                );
                try {
                    const { musicBrainzService } =
                        await import("./musicbrainz");
                    const mbArtists = await musicBrainzService.searchArtist(
                        artistName,
                        5,
                    );
                    const mbArtist =
                        mbArtists?.find((a: any) => a.id === mbid) ||
                        mbArtists?.[0];

                    if (mbArtist) {
                        const fallbackArtist: LidarrArtist = {
                            id: 0,
                            artistName: mbArtist.name || artistName,
                            foreignArtistId: mbid,
                            artistType: mbArtist.type || "Person",
                            monitored: false,
                            qualityProfileId: 1,
                            metadataProfileId: 1,
                            rootFolderPath: "/music",
                            tags: [],
                            statistics: { albumCount: 0 },
                        };
                        logger.debug(
                            `   [FALLBACK] Created artist from MusicBrainz: ${fallbackArtist.artistName}`,
                        );
                        return [fallbackArtist];
                    }
                } catch (mbError: any) {
                    logger.error(
                        `   [FALLBACK] MusicBrainz also failed:`,
                        mbError.message,
                    );
                }
            }

            return [];
        }
    }

    async addArtist(
        mbid: string,
        artistName: string,
        rootFolderPath: string = "/music",
        searchForMissingAlbums: boolean = true,
        monitorAllAlbums: boolean = true,
        isDiscovery: boolean = false,
    ): Promise<LidarrArtist | null> {
        await this.ensureInitialized();

        // DEBUG: Log exact parameters received
        logger.debug(
            `[LIDARR_ADD_ARTIST] artistName="${artistName}", mbid="${mbid}"`,
        );

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        // Get discovery tag ID if this is a discovery add
        let discoveryTagId: number | null = null;
        if (isDiscovery) {
            discoveryTagId = await this.getOrCreateDiscoveryTag();
            if (discoveryTagId) {
                logger.debug(
                    `[LIDARR] Will apply discovery tag (ID: ${discoveryTagId}) to artist`,
                );
            }
        }

        try {
            // Ensure root folder exists, fallback to default if not
            const validRootFolder =
                await this.ensureRootFolderExists(rootFolderPath);

            logger.debug(
                ` Searching Lidarr for artist: "${artistName}"${
                    mbid ? ` (MBID: ${mbid})` : " (no MBID - using name search)"
                }`,
            );
            logger.debug(`   Root folder: ${validRootFolder}`);

            // Search for artist (by MBID if available, otherwise by name)
            const searchResults = await this.searchArtist(artistName, mbid);

            if (searchResults.length === 0) {
                logger.error(` Artist not found in Lidarr: ${artistName}`);
                return null;
            }

            logger.debug(
                `   Found ${searchResults.length} results from Lidarr`,
            );

            let artistData: LidarrArtist;

            if (mbid) {
                // STRICT MBID FILTERING - Only use exact MBID match
                const exactMatch = searchResults.find(
                    (artist) => artist.foreignArtistId === mbid,
                );

                if (!exactMatch) {
                    logger.error(
                        ` No exact MBID match found for: ${artistName} (${mbid})`,
                    );
                    logger.debug(
                        "   Available results:",
                        searchResults.map((a) => ({
                            name: a.artistName,
                            mbid: a.foreignArtistId,
                            type: a.artistType,
                        })),
                    );
                    return null;
                }

                // ADDITIONAL CHECK: If exact match is a "Group" with 0 albums,
                // look for a better match with same name but different type
                if (
                    exactMatch.artistType === "Group" &&
                    (exactMatch.statistics?.albumCount || 0) === 0
                ) {
                    logger.debug(
                        ` Exact MBID match is a Group with 0 albums - checking for better match...`,
                    );

                    // Look for same artist name but different type with albums
                    const betterMatch = searchResults.find(
                        (artist) =>
                            artist.artistName.toLowerCase() ===
                                exactMatch.artistName.toLowerCase() &&
                            artist.foreignArtistId !== mbid &&
                            (artist.statistics?.albumCount || 0) > 0 &&
                            (artist.artistType === "Person" ||
                                artist.artistType === "Artist"),
                    );

                    if (betterMatch) {
                        logger.debug(
                            `   Found better match: "${
                                betterMatch.artistName
                            }" (Type: ${betterMatch.artistType}, Albums: ${
                                betterMatch.statistics?.albumCount || 0
                            })`,
                        );
                        artistData = betterMatch;
                    } else {
                        logger.debug(
                            ` No better match found, using Group entry`,
                        );
                        artistData = exactMatch;
                    }
                } else {
                    logger.debug(
                        `Exact match found: "${exactMatch.artistName}" (Type: ${
                            exactMatch.artistType
                        }, Albums: ${exactMatch.statistics?.albumCount || 0})`,
                    );
                    artistData = exactMatch;
                }
            } else {
                // FALLBACK: No MBID - Use smart filtering for best match
                logger.debug(" No MBID available - using smart selection...");

                // Filter and score results
                const scoredResults = searchResults.map((artist) => {
                    let score = 0;

                    // Prefer "Person" or "Group" types for actual artists
                    const type = (artist.artistType || "").toLowerCase();
                    if (type === "person") score += 1000;
                    else if (type === "group") score += 900;
                    else if (type === "artist") score += 800;

                    // Album count (more albums = more likely correct)
                    const albumCount = artist.statistics?.albumCount || 0;
                    score += albumCount * 10;

                    // Exact name match bonus (case-insensitive)
                    const artistNameNormalized = (artist.artistName || "")
                        .toLowerCase()
                        .trim();
                    const searchNameNormalized = artistName
                        .toLowerCase()
                        .trim();

                    if (artistNameNormalized === searchNameNormalized) {
                        score += 500;
                    } else if (
                        artistNameNormalized.includes(searchNameNormalized) ||
                        searchNameNormalized.includes(artistNameNormalized)
                    ) {
                        score += 250; // Partial match
                    }

                    // Popularity
                    if (artist.ratings?.votes && artist.ratings?.votes > 0) {
                        score += Math.min(artist.ratings.votes / 10, 100);
                    }

                    // Penalize "Various Artists" entries
                    if (
                        artistNameNormalized.includes("various") ||
                        artistNameNormalized.includes("compilation")
                    ) {
                        score -= 1000;
                    }

                    return { artist, score };
                });

                // Sort by score
                scoredResults.sort((a, b) => b.score - a.score);

                // Log candidates for debugging
                logger.debug("   Candidates:");
                scoredResults.slice(0, 3).forEach((item, i) => {
                    logger.debug(
                        `     ${i + 1}. "${item.artist.artistName}" - Type: ${
                            item.artist.artistType || "Unknown"
                        } - Albums: ${
                            item.artist.statistics?.albumCount || 0
                        } - Score: ${item.score}${i === 0 ? " ← SELECTED" : ""}`,
                    );
                });

                artistData = scoredResults[0].artist;
            }

            // Check if already exists
            const existingArtists = await this.client.get("/api/v1/artist");
            const exists = existingArtists.data.find(
                (a: LidarrArtist) =>
                    a.foreignArtistId === artistData.foreignArtistId ||
                    (mbid && a.foreignArtistId === mbid),
            );

            if (exists) {
                logger.debug(`Artist already in Lidarr: ${artistName}`);

                // If this is a discovery add and artist doesn't have discovery tag, add it
                if (isDiscovery && discoveryTagId) {
                    const existingTags = exists.tags || [];
                    if (!existingTags.includes(discoveryTagId)) {
                        logger.debug(
                            `   Adding discovery tag to existing artist...`,
                        );
                        await this.addTagsToArtist(exists.id, [discoveryTagId]);
                    }
                }

                // If monitorAllAlbums is true, update the artist to monitor all albums
                if (monitorAllAlbums) {
                    logger.debug(`   Updating artist to monitor all albums...`);
                    try {
                        // Update artist settings
                        const updated = await this.client.put(
                            `/api/v1/artist/${exists.id}`,
                            {
                                ...exists,
                                monitored: true,
                                monitorNewItems: "all",
                            },
                        );

                        // Get all albums for this artist and monitor them
                        const albumsResponse = await this.client.get(
                            `/api/v1/album?artistId=${exists.id}`,
                        );
                        const albums = albumsResponse.data;

                        logger.debug(
                            `   Found ${albums.length} albums to monitor`,
                        );

                        // Monitor all albums
                        for (const album of albums) {
                            if (!album.monitored) {
                                await this.client.put(
                                    `/api/v1/album/${album.id}`,
                                    {
                                        ...album,
                                        monitored: true,
                                    },
                                );
                            }
                        }

                        // Trigger search for all albums if requested
                        if (searchForMissingAlbums && albums.length > 0) {
                            logger.debug(
                                `   Triggering search for ${albums.length} albums...`,
                            );
                            await this.client.post("/api/v1/command", {
                                name: "AlbumSearch",
                                albumIds: albums.map((a: any) => a.id),
                            });
                        }

                        logger.debug(
                            `   Updated existing artist and monitored all albums`,
                        );
                        return updated.data;
                    } catch (error: any) {
                        logger.error(
                            `   Failed to update artist:`,
                            error.message,
                        );
                        // Return original artist if update fails
                        return exists;
                    }
                }

                return exists;
            }

            // Add artist - use "existing" monitor option to ensure album catalog is fetched
            // even if we don't want to download all albums
            const artistPayload: any = {
                ...artistData,
                rootFolderPath: validRootFolder,
                qualityProfileId: 1, // Uses default profile - could be made configurable via settings
                metadataProfileId: 1,
                monitored: true,
                monitorNewItems: monitorAllAlbums ? "all" : "none",
                addOptions: {
                    monitor: "existing", // Always fetch album catalog, but don't monitor unless requested
                    searchForMissingAlbums,
                },
            };

            // Apply discovery tag if this is a discovery add
            if (discoveryTagId) {
                artistPayload.tags = [discoveryTagId];
            }

            let response;
            try {
                response = await this.client.post(
                    "/api/v1/artist",
                    artistPayload,
                );
            } catch (postError: unknown) {
                const errorMsg = getLidarrErrorMessage(postError);
                if (
                    errorMsg.includes("already exists") ||
                    errorMsg.includes("UNIQUE constraint failed")
                ) {
                    logger.debug(
                        `   Artist added by another process, fetching existing...`,
                    );
                    const artists = await this.client.get("/api/v1/artist");
                    const existing = artists.data.find(
                        (a: LidarrArtist) =>
                            a.foreignArtistId === artistData.foreignArtistId,
                    );
                    if (existing) return existing;
                }
                throw postError;
            }

            logger.debug(
                `Added artist to Lidarr: ${artistName}${
                    isDiscovery ? " (tagged as discovery)" : ""
                }`,
            );

            // Trigger metadata refresh to ensure album catalog is populated
            if (!searchForMissingAlbums) {
                // Add a small delay to let Lidarr's internal state settle
                await this.clock.sleep(2000);

                logger.debug(
                    `   Triggering metadata refresh for new artist...`,
                );
                try {
                    await this.client.post("/api/v1/command", {
                        name: "RefreshArtist",
                        artistId: response.data.id,
                    });
                } catch (refreshError) {
                    logger.warn(
                        `   Metadata refresh command failed (non-blocking)`,
                    );
                }
            }

            return response.data;
        } catch (error: unknown) {
            logger.error(
                "Lidarr add artist error:",
                lidarrErrorLogFields(error),
            );
            return null;
        }
    }

    async searchAlbum(
        artistName: string,
        albumTitle: string,
        rgMbid?: string,
    ): Promise<LidarrAlbum[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            const searchTerm = rgMbid
                ? `lidarr:${rgMbid}`
                : `${artistName} ${albumTitle}`;
            logger.debug(`   Searching Lidarr for album: ${searchTerm}`);

            const response = await this.client.get("/api/v1/album/lookup", {
                params: {
                    term: searchTerm,
                },
            });

            // If results found, return them
            if (response.data.length > 0) {
                logger.debug(
                    `   Found ${response.data.length} album result(s)`,
                );
                return response.data;
            }

            // If no results and not using MBID, try with stripped album title
            if (!rgMbid) {
                const strippedTitle = stripAlbumEdition(albumTitle);
                if (strippedTitle !== albumTitle && strippedTitle.length > 2) {
                    const fallbackTerm = `${artistName} ${strippedTitle}`;
                    logger.debug(
                        `   No results, trying stripped title: ${fallbackTerm}`,
                    );

                    const fallbackResponse = await this.client.get(
                        "/api/v1/album/lookup",
                        {
                            params: {
                                term: fallbackTerm,
                            },
                        },
                    );

                    if (fallbackResponse.data.length > 0) {
                        logger.debug(
                            `   Found ${fallbackResponse.data.length} result(s) with stripped title`,
                        );
                        return fallbackResponse.data;
                    }
                }
            }

            logger.debug(`   Found 0 album result(s)`);
            return response.data;
        } catch (error: unknown) {
            logger.error(
                "Lidarr album search error:",
                lidarrErrorLogFields(error),
            );
            return [];
        }
    }

    /**
     * Extract base album title by removing edition markers
     * E.g., "Abbey Road (Remastered)" → "Abbey Road"
     * Uses the shared stripAlbumEdition utility for consistency
     */
    private extractBaseTitle(title: string): string {
        return stripAlbumEdition(title);
    }

    /**
     * Get all albums for an artist that exist in Lidarr's catalog
     * Used for same-artist fallback to avoid trying MusicBrainz albums that Lidarr can't find
     */
    async getArtistAlbums(artistMbid: string): Promise<LidarrAlbum[]> {
        if (!this.client) {
            logger.warn("Lidarr not enabled");
            return [];
        }

        try {
            // First find the artist in Lidarr
            const artistsResponse = await this.client.get("/api/v1/artist");
            const artist = artistsResponse.data.find(
                (a: LidarrArtist) => a.foreignArtistId === artistMbid,
            );

            if (!artist) {
                logger.debug(`   Artist not found in Lidarr: ${artistMbid}`);
                return [];
            }

            // Get albums for this artist
            const albumsResponse = await this.client.get(
                `/api/v1/album?artistId=${artist.id}`,
            );
            return albumsResponse.data || [];
        } catch (error: any) {
            logger.error(`   Failed to get artist albums: ${error.message}`);
            return [];
        }
    }

    /**
     * Wait for a Lidarr command to complete
     * @param commandId The command ID to poll
     * @param timeoutMs Maximum time to wait (default: 30s)
     * @param pollIntervalMs Time between polls (default: 2s)
     * @returns The completed command status
     */
    private async waitForCommand(
        commandId: number,
        timeoutMs: number = 30000,
        pollIntervalMs: number = 2000,
    ): Promise<{ status: string; message: string }> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const response = await this.client!.get(
                `/api/v1/command/${commandId}`,
            );
            const { status, message, body } = response.data;

            // Check if command finished (completed, failed, aborted)
            if (status !== "started" && status !== "queued") {
                logger.debug(
                    `   Command ${commandId} completed with status: ${status}`,
                );
                return {
                    status,
                    message: message || body?.records?.[0]?.message || "",
                };
            }

            await this.clock.sleep(pollIntervalMs);
        }

        throw new Error(`Command ${commandId} timed out after ${timeoutMs}ms`);
    }

    async addAlbum(
        rgMbid: string,
        artistName: string,
        albumTitle: string,
        rootFolderPath: string = "/music",
        artistMbid?: string,
        isDiscovery: boolean = false,
    ): Promise<LidarrAlbum | null> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }
        try {
            logger.debug(`   Adding album: ${albumTitle} by ${artistName}`);
            const presence = await this.ensureAlbumArtist(
                artistName,
                rootFolderPath,
                artistMbid,
                isDiscovery,
            );
            if (!presence.artist) {
                logger.error(" Artist not found and could not be added");
                return null;
            }
            const catalog = await this.selectAlbumForAdd(
                presence.artist,
                presence.justAddedArtist,
                rgMbid,
                albumTitle,
                artistName,
            );
            return await this.grabCatalogAlbum(
                presence.artist,
                catalog.album,
                catalog.artistAlbums,
                albumTitle,
            );
        } catch (error: unknown) {
            if (
                error instanceof Error &&
                error.message.includes("No releases available")
            ) {
                throw error;
            }
            logger.error(
                "Lidarr add album error:",
                lidarrErrorLogFields(error),
            );
            return null;
        }
    }

    private async ensureAlbumArtist(
        artistName: string,
        rootFolderPath: string,
        artistMbid: string | undefined,
        isDiscovery: boolean,
    ): Promise<{ artist: LidarrArtist | null; justAddedArtist: boolean }> {
        const response =
            await this.client!.get<LidarrArtist[]>("/api/v1/artist");
        return ensureArtistPresent({
            artists: response.data,
            artistMbid,
            artistName,
            rootFolderPath,
            isDiscovery,
            addArtist: (...args) => this.addArtist(...args),
            ensureDiscoveryTag: (artist) =>
                this.ensureDiscoveryTagForArtist(artist),
        });
    }

    private async selectAlbumForAdd(
        artist: LidarrArtist,
        justAddedArtist: boolean,
        rgMbid: string,
        albumTitle: string,
        artistName: string,
    ): Promise<{ album: LidarrAlbum; artistAlbums: LidarrAlbum[] }> {
        const artistAlbums = await awaitArtistCatalog({
            client: this.client!,
            artist,
            justAddedArtist,
            clock: this.clock,
        });
        const selection = selectAlbumInCatalogMatch(
            artistAlbums,
            rgMbid,
            albumTitle,
        );
        if (!selection.album) {
            throw new AcquisitionError(
                `Album "${albumTitle}" not found in Lidarr catalog for ${artistName}`,
                AcquisitionErrorType.ALBUM_NOT_FOUND,
                true,
            );
        }
        if (selection.matchType === "exact") {
            logger.debug(
                ` Matched exact normalized: "${selection.album.title}"`,
            );
        } else if (selection.matchType === "partial") {
            logger.debug(
                ` Matched partial (contained): "${selection.album.title}"`,
            );
        }
        return { album: selection.album, artistAlbums };
    }

    private grabCatalogAlbum(
        artist: LidarrArtist,
        album: LidarrAlbum,
        artistAlbums: LidarrAlbum[],
        albumTitle: string,
    ): Promise<LidarrAlbum> {
        return grabCatalogRelease({
            client: this.client!,
            artist,
            album,
            artistAlbums,
            requestedTitle: albumTitle,
            sleep: (delayMs) => this.clock.sleep(delayMs),
            waitForCommand: (id, timeoutMs) =>
                this.waitForCommand(id, timeoutMs),
            createNoReleasesError: () =>
                new AcquisitionError(
                    `No releases available for "${albumTitle}" - indexers found no matching downloads. Album may not be available on configured indexers, or MBID mismatch between Lidarr and indexers.`,
                    AcquisitionErrorType.NO_RELEASES_AVAILABLE,
                    true,
                ),
            indexerCountLogged: () => this._indexerCountLogged,
            markIndexerCountLogged: () => {
                this._indexerCountLogged = true;
            },
            extractBaseTitle: (title) => this.extractBaseTitle(title),
        });
    }

    private async ensureDiscoveryTagForArtist(
        artist: LidarrArtist,
    ): Promise<void> {
        const tagId = await this.getOrCreateDiscoveryTag();
        if (tagId && !artist.tags?.includes(tagId)) {
            await this.addTagsToArtist(artist.id, [tagId]);
        }
    }

    async rescanLibrary(): Promise<void> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            await this.client.post("/api/v1/command", {
                name: "RescanFolders",
            });

            logger.debug("Triggered Lidarr library rescan");
        } catch (error) {
            logger.error("Lidarr rescan error:", error);
            throw error;
        }
    }

    async getArtists(): Promise<LidarrArtist[]> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return [];
        }

        try {
            const response = await this.client.get("/api/v1/artist");
            return response.data;
        } catch (error) {
            logger.error("Lidarr get artists error:", error);
            return [];
        }
    }

    /**
     * Delete an artist from Lidarr by MusicBrainz ID
     * This removes the artist and optionally deletes files
     */
    async deleteArtist(
        mbid: string,
        deleteFiles: boolean = true,
    ): Promise<{ success: boolean; message: string }> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return {
                success: false,
                message: "Lidarr not enabled or configured",
            };
        }

        if (!mbid || mbid.startsWith("temp-")) {
            return { success: false, message: "Invalid or temporary MBID" };
        }

        try {
            // Find artist in Lidarr by foreignArtistId (MBID)
            const artists = await this.getArtists();
            const lidarrArtist = artists.find(
                (a) => a.foreignArtistId === mbid,
            );

            if (!lidarrArtist) {
                logger.debug(
                    `[LIDARR] Artist with MBID ${mbid} not found in Lidarr`,
                );
                return {
                    success: true,
                    message:
                        "Artist not in Lidarr (already removed or never added)",
                };
            }

            logger.debug(
                `[LIDARR] Deleting artist: ${lidarrArtist.artistName} (ID: ${lidarrArtist.id})`,
            );

            // Delete the artist from Lidarr (with timeout to prevent hanging)
            await this.client.delete(`/api/v1/artist/${lidarrArtist.id}`, {
                params: {
                    deleteFiles: deleteFiles,
                    addImportListExclusion: false,
                },
            });

            logger.debug(
                `[LIDARR] Successfully deleted artist: ${lidarrArtist.artistName}`,
            );
            return {
                success: true,
                message: `Deleted ${lidarrArtist.artistName} from Lidarr`,
            };
        } catch (error: any) {
            logger.error(
                "[LIDARR] Delete artist error:",
                error?.message || error,
            );
            return {
                success: false,
                message: error?.message || "Failed to delete from Lidarr",
            };
        }
    }

    /**
     * Delete an album from Lidarr by Lidarr album ID
     * This unmonitors the album and optionally deletes files
     */
    async deleteAlbum(
        lidarrAlbumId: number,
        deleteFiles: boolean = true,
    ): Promise<{ success: boolean; message: string }> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return {
                success: false,
                message: "Lidarr not enabled or configured",
            };
        }

        try {
            logger.debug(`[LIDARR] Deleting album ID: ${lidarrAlbumId}`);

            // First get the album to check for track files
            const albumResponse = await this.client.get(
                `/api/v1/album/${lidarrAlbumId}`,
            );
            const album = albumResponse.data;
            const artistId = album.artistId;
            const albumTitle = album.title || "Unknown";

            if (deleteFiles) {
                // Get track files for this album
                const trackFilesResponse = await this.client.get(
                    "/api/v1/trackFile",
                    {
                        params: { albumId: lidarrAlbumId },
                    },
                );

                const trackFiles = trackFilesResponse.data;

                if (trackFiles && trackFiles.length > 0) {
                    // Delete each track file
                    for (const trackFile of trackFiles) {
                        try {
                            await this.client.delete(
                                `/api/v1/trackFile/${trackFile.id}`,
                            );
                        } catch (e) {
                            // Ignore individual file deletion errors
                        }
                    }
                    logger.debug(
                        `[LIDARR] Deleted ${trackFiles.length} track files for album: ${albumTitle}`,
                    );
                }
            }

            // Unmonitor the album (don't delete the album record, just unmonitor)
            await this.client.put(`/api/v1/album/${lidarrAlbumId}`, {
                ...album,
                monitored: false,
            });

            logger.debug(
                `[LIDARR] Successfully unmonitored album: ${albumTitle}`,
            );
            return {
                success: true,
                message: `Deleted files and unmonitored ${albumTitle}`,
            };
        } catch (error: any) {
            logger.error(
                "[LIDARR] Delete album error:",
                error?.message || error,
            );
            return {
                success: false,
                message: error?.message || "Failed to delete album from Lidarr",
            };
        }
    }

    /**
     * Check if an album exists in Lidarr and has files (already downloaded)
     * Returns true if the album is already available in Lidarr
     */
    async isAlbumAvailable(albumMbid: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            // Search for the album by MBID
            const response = await this.client.get("/api/v1/album", {
                params: { foreignAlbumId: albumMbid },
            });

            const albums = response.data;
            if (!albums || albums.length === 0) {
                return false;
            }

            // Check if any matching album has files (statistics.percentOfTracks > 0)
            for (const album of albums) {
                if (album.foreignAlbumId === albumMbid) {
                    // Album exists in Lidarr - check if it has files
                    const hasFiles = album.statistics?.percentOfTracks > 0;
                    if (hasFiles) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error: any) {
            // If 404 or other error, album doesn't exist
            if (error.response?.status === 404) {
                return false;
            }
            logger.error("Lidarr album check error:", error.message);
            return false;
        }
    }

    /**
     * Check if an album exists in Lidarr by artist name and album title
     * Handles MBID mismatches between MusicBrainz and Lidarr
     */
    async isAlbumAvailableByTitle(
        artistName: string,
        albumTitle: string,
    ): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        const normalizedArtist = normalizeForExactKey(artistName);
        const normalizedAlbum = normalizeForExactKey(albumTitle);

        try {
            // Get all artists from Lidarr
            const artistsResponse = await this.client.get("/api/v1/artist");
            const artists = artistsResponse.data || [];

            // Find matching artist by name
            const matchingArtist = artists.find(
                (a: any) =>
                    normalizeForExactKey(a.artistName || "") ===
                        normalizedArtist ||
                    normalizeForExactKey(a.sortName || "") === normalizedArtist,
            );

            if (!matchingArtist) {
                return false;
            }

            // Get albums for this artist
            const albumsResponse = await this.client.get("/api/v1/album", {
                params: { artistId: matchingArtist.id },
            });
            const albums = albumsResponse.data || [];

            // Check if any album matches the title and has files
            for (const album of albums) {
                const albumTitleNorm = normalizeForExactKey(album.title || "");
                if (
                    albumTitleNorm === normalizedAlbum ||
                    albumTitleNorm.includes(normalizedAlbum)
                ) {
                    const hasFiles = album.statistics?.percentOfTracks > 0;
                    if (hasFiles) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error: any) {
            logger.error("Lidarr album check by title error:", error.message);
            return false;
        }
    }

    /**
     * Check if an artist exists in Lidarr
     */
    async isArtistInLidarr(artistMbid: string): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return false;
        }

        try {
            const response = await this.client.get("/api/v1/artist");
            const artists = response.data;
            return artists.some((a: any) => a.foreignArtistId === artistMbid);
        } catch (error) {
            return false;
        }
    }

    /**
     * Get all tags from Lidarr
     */
    private get discoveryTagId(): number | null {
        return this.tagService.cachedDiscoveryTagId;
    }

    private set discoveryTagId(value: number | null) {
        this.tagService.cachedDiscoveryTagId = value;
    }

    /** Get all tags from Lidarr. */
    async getTags(): Promise<LidarrTag[]> {
        await this.ensureInitialized();
        return this.tagService.getTags();
    }

    /** Create a tag in Lidarr. */
    async createTag(label: string): Promise<LidarrTag | null> {
        await this.ensureInitialized();
        return this.tagService.createTag(label);
    }

    /** Get or create the discovery tag. */
    async getOrCreateDiscoveryTag(): Promise<number | null> {
        await this.ensureInitialized();
        return this.tagService.getOrCreateDiscoveryTag();
    }

    /** Add tags to an artist. */
    async addTagsToArtist(
        artistId: number,
        tagIds: number[],
    ): Promise<boolean> {
        await this.ensureInitialized();
        return this.tagService.addTagsToArtist(artistId, tagIds);
    }

    /** Remove tags from an artist. */
    async removeTagsFromArtist(
        artistId: number,
        tagIds: number[],
    ): Promise<boolean> {
        await this.ensureInitialized();
        return this.tagService.removeTagsFromArtist(artistId, tagIds);
    }

    /** Get artists carrying one Lidarr tag. */
    async getArtistsByTag(tagId: number): Promise<LidarrArtist[]> {
        await this.ensureInitialized();
        return this.tagService.getArtistsByTag(tagId);
    }

    /** Get all discovery-tagged artists. */
    async getDiscoveryArtists(): Promise<LidarrArtist[]> {
        await this.ensureInitialized();
        return this.tagService.getDiscoveryArtists();
    }

    /** Remove the discovery tag from an artist by MBID. */
    async removeDiscoveryTagByMbid(artistMbid: string): Promise<boolean> {
        await this.ensureInitialized();
        return this.tagService.removeDiscoveryTagByMbid(artistMbid);
    }

    async deleteArtistById(
        lidarrId: number,
        deleteFiles: boolean = true,
    ): Promise<{ success: boolean; message: string }> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return { success: false, message: "Lidarr not enabled" };
        }

        try {
            await this.client.delete(`/api/v1/artist/${lidarrId}`, {
                params: {
                    deleteFiles,
                    addImportListExclusion: false,
                },
            });

            return { success: true, message: "Artist deleted" };
        } catch (error: any) {
            if (error.response?.status === 404) {
                return { success: true, message: "Artist already removed" };
            }
            logger.error("[LIDARR] Delete artist by ID error:", error.message);
            return { success: false, message: error.message };
        }
    }

    /** Returns Lidarr's interactive-search releases for an album. */
    async getAlbumReleases(lidarrAlbumId: number): Promise<LidarrRelease[]> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }
        try {
            logger.debug(
                `[LIDARR] Fetching releases for album ID: ${lidarrAlbumId}`,
            );
            const response = await this.client.get("/api/v1/release", {
                params: { albumId: lidarrAlbumId },
                timeoutMs: 60_000,
                maxRetries: 0,
            });
            const releases: LidarrRelease[] = response.data || [];
            logger.debug(
                `[LIDARR] Found ${releases.length} releases from indexers`,
            );

            releases.sort((a, b) => {
                if (a.approved && !b.approved) return -1;
                if (!a.approved && b.approved) return 1;
                if (a.seeders !== undefined && b.seeders !== undefined) {
                    return b.seeders - a.seeders;
                }
                return 0;
            });
            return releases;
        } catch (error: unknown) {
            logger.error(
                `[LIDARR] Failed to fetch releases:`,
                lidarrErrorLogFields(error),
            );
            return [];
        }
    }

    /** Tells Lidarr to download a release by GUID. */
    async grabRelease(release: LidarrRelease): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        try {
            logger.debug(`[LIDARR] Grabbing release: ${release.title}`);
            logger.debug(`   GUID: ${release.guid}`);
            logger.debug(`   Indexer: ${release.indexer || "unknown"}`);
            logger.debug(
                `   Size: ${Math.round((release.size || 0) / 1024 / 1024)} MB`,
            );

            await this.client.post("/api/v1/release", {
                guid: release.guid,
                indexerId: release.indexerId || 0,
            });

            logger.debug(`[LIDARR] Release grabbed successfully`);
            return true;
        } catch (error: unknown) {
            logger.error(
                `[LIDARR] Failed to grab release:`,
                lidarrErrorLogFields(error),
            );
            return false;
        }
    }

    /** Removes a release; skipRedownload selects replacement ownership. */
    async blocklistAndRemove(
        downloadId: string,
        skipRedownload: boolean,
    ): Promise<boolean> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            throw new Error("Lidarr not enabled");
        }

        return blocklistQueueDownload(this.client, downloadId, skipRedownload);
    }

    /** Clears failed queue entries and asks Lidarr to search their albums again. */
    async clearFailedQueue(
        signal?: AbortSignal,
    ): Promise<{ removed: number; errors: string[] }> {
        await this.ensureInitialized();
        if (!this.enabled || !this.client) {
            return { removed: 0, errors: ["Lidarr not configured"] };
        }
        return clearFailedLidarrQueue(this.client, signal);
    }

    /**
     * Find queue item by download ID
     */
    async findQueueItemByDownloadId(downloadId: string): Promise<any | null> {
        await this.ensureInitialized();

        if (!this.enabled || !this.client) {
            return null;
        }

        try {
            const response = await this.client.get("/api/v1/queue", {
                params: { page: 1, pageSize: 100 },
            });

            return (
                response.data.records.find(
                    (item: any) => item.downloadId === downloadId,
                ) || null
            );
        } catch (error: any) {
            logger.error(`[LIDARR] Failed to find queue item:`, error.message);
            return null;
        }
    }

    /**
     * Get upcoming and recent releases from Lidarr calendar
     * Returns albums releasing within the specified date range for monitored artists
     */
    async getCalendar(
        startDate: Date,
        endDate: Date,
    ): Promise<CalendarRelease[]> {
        await this.ensureInitialized();

        if (!this.client) {
            logger.debug("[LIDARR] Not configured - cannot fetch calendar");
            return [];
        }

        try {
            const start = startDate.toISOString().split("T")[0];
            const end = endDate.toISOString().split("T")[0];

            const response = await this.client.get(`/api/v1/calendar`, {
                params: {
                    start,
                    end,
                    includeArtist: true,
                },
            });

            const releases: CalendarRelease[] = response.data.map(
                (album: any) => ({
                    id: album.id,
                    title: album.title,
                    artistName: album.artist?.artistName || "Unknown Artist",
                    artistId: album.artist?.id,
                    artistMbid: album.artist?.foreignArtistId,
                    albumMbid: album.foreignAlbumId,
                    releaseDate: album.releaseDate,
                    monitored: album.monitored,
                    grabbed: album.grabbed || false,
                    hasFile: album.statistics?.percentOfTracks === 100,
                    coverUrl:
                        album.images?.find(
                            (img: any) => img.coverType === "cover",
                        )?.remoteUrl || null,
                }),
            );

            logger.debug(
                `[LIDARR] Calendar: Found ${releases.length} releases between ${start} and ${end}`,
            );
            return releases;
        } catch (error: any) {
            logger.error(`[LIDARR] Failed to fetch calendar:`, error.message);
            return [];
        }
    }

    /**
     * Get all monitored artists from Lidarr
     */
    async getMonitoredArtists(): Promise<
        { id: number; name: string; mbid: string }[]
    > {
        await this.ensureInitialized();

        if (!this.client) {
            return [];
        }

        try {
            const response = await this.client.get(`/api/v1/artist`);
            return response.data
                .filter((artist: any) => artist.monitored)
                .map((artist: any) => ({
                    id: artist.id,
                    name: artist.artistName,
                    mbid: artist.foreignArtistId,
                }));
        } catch (error: any) {
            logger.error(
                `[LIDARR] Failed to fetch monitored artists:`,
                error.message,
            );
            return [];
        }
    }

    /**
     * Fetch all data needed for reconciliation in minimal API calls.
     * Returns indexed Maps for O(1) lookups against job data.
     *
     * This replaces multiple per-job API calls with a single snapshot fetch.
     */
    /** Fetch all data needed for reconciliation in minimal API calls. */
    async getReconciliationSnapshot(
        signal?: AbortSignal,
    ): Promise<ReconciliationSnapshot> {
        await this.ensureInitialized();
        return fetchReconciliationSnapshot(this.client, this.enabled, signal);
    }

    /** Check album availability against a pre-fetched snapshot. */
    isAlbumAvailableInSnapshot(
        snapshot: ReconciliationSnapshot,
        mbid?: string,
        artistName?: string,
        albumTitle?: string,
    ): boolean {
        return snapshotHasAlbum(snapshot, mbid, artistName, albumTitle);
    }

    /** Check download activity against a pre-fetched snapshot. */
    isDownloadActiveInSnapshot(
        snapshot: ReconciliationSnapshot,
        downloadId: string,
    ): { active: boolean; progress?: number } {
        return snapshotHasActiveDownload(snapshot, downloadId);
    }
}

export type {
    AlbumSnapshotInfo,
    QueueSnapshotItem,
    ReconciliationSnapshot,
} from "./lidarr/lidarrReconciliation";

// Interface for calendar release data
export interface CalendarRelease {
    id: number;
    title: string;
    artistName: string;
    artistId?: number;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    monitored: boolean;
    grabbed: boolean;
    hasFile: boolean;
    coverUrl: string | null;
}

// Interface for release data from Lidarr (exported for use by simpleDownloadManager)
export interface LidarrRelease {
    guid: string;
    title: string;
    indexerId: number;
    indexer?: string;
    size?: number;
    seeders?: number;
    leechers?: number;
    protocol: string; // usenet, torrent
    approved: boolean;
    rejected: boolean;
    rejections?: string[];
    quality?: {
        quality: { name: string };
    };
}

export const lidarrService = new LidarrService();

export {
    cleanStuckDownloads,
    getQueue,
    getQueueCount,
    getRecentCompletedDownloads,
    isDownloadActive,
} from "./lidarr/lidarrQueue";

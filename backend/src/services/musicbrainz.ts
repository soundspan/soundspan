import axios, { AxiosInstance } from "axios";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { rateLimiter } from "./rateLimiter";
import {
    normalizeFullwidth,
    normalizeQuotes,
} from "../utils/stringNormalization";
import { BRAND_USER_AGENT } from "../config/brand";
import { isValidMbid } from "../utils/musicIds";
import { asPlainObject, isPlainObject } from "../utils/plainObject";

export { isValidMbid } from "../utils/musicIds";

type MbidEntity = "artist" | "release group" | "release";

/** Artist fields returned by MusicBrainz search. */
export interface MusicBrainzArtistSearchResult {
    id: string;
    name: string;
    disambiguation?: string;
    country?: string;
    type?: string;
    score?: number | string;
}

/** Artist-credit fields returned with a MusicBrainz release group. */
export interface MusicBrainzArtistCredit {
    name?: string;
    artist?: { id?: string; name?: string };
}

/** Release-group fields returned by MusicBrainz search. */
export interface MusicBrainzReleaseGroupSearchResult {
    id: string;
    title: string;
    "primary-type"?: string;
    "secondary-types"?: string[];
    "first-release-date"?: string;
    "artist-credit"?: MusicBrainzArtistCredit[];
    score?: number | string;
}

interface MusicBrainzAlbumRelease {
    id: string;
    status?: string;
    media?: unknown[];
}

interface MusicBrainzAlbumReleasePage {
    releases: MusicBrainzAlbumRelease[];
    total: number;
}

interface MusicBrainzAlbumTrack {
    title: string;
    position?: number;
    duration?: number;
}

const MUSICBRAINZ_RELEASE_PAGE_SIZE = 100;
const MAX_RELEASE_GROUP_PAGES = 100;
const MAX_RELEASE_MEDIA = 100;
const MAX_MEDIUM_TRACKS = 1_000;

function hasReleaseGroupIdentity(
    value: unknown,
): value is MusicBrainzReleaseGroupSearchResult {
    return (
        isPlainObject(value) &&
        typeof value.id === "string" &&
        typeof value.title === "string"
    );
}

function parseReleaseGroupsWithCredits(
    value: unknown,
): MusicBrainzReleaseGroupSearchResult[] {
    if (!Array.isArray(value)) {
        throw new TypeError("Invalid MusicBrainz release-groups response");
    }
    const releaseGroups = value.filter(hasReleaseGroupIdentity);
    const droppedCount = value.length - releaseGroups.length;
    if (droppedCount > 0) {
        logger.warn(
            "MusicBrainz release-group response dropped malformed entries",
            { droppedCount },
        );
    }
    return releaseGroups;
}

function validateMbid(value: unknown, entity: MbidEntity): string {
    if (!isValidMbid(value)) {
        throw new TypeError(`Invalid ${entity} MBID`);
    }

    return value;
}

function encodeMbidPathSegment(value: unknown, entity: MbidEntity): string {
    return encodeURIComponent(validateMbid(value, entity));
}

function parseAlbumReleases(value: unknown): MusicBrainzAlbumRelease[] {
    if (!Array.isArray(value) || value.length > MUSICBRAINZ_RELEASE_PAGE_SIZE) {
        throw new TypeError("Invalid MusicBrainz album releases response");
    }
    return value.flatMap((item) => {
        if (!isPlainObject(item) || !isValidMbid(item.id)) return [];
        return [
            {
                id: item.id,
                status:
                    typeof item.status === "string" ? item.status : undefined,
                media: Array.isArray(item.media) ? item.media : undefined,
            },
        ];
    });
}

function parseAlbumReleasePage(value: unknown): MusicBrainzAlbumReleasePage {
    const page = asPlainObject(value);
    const releases = parseAlbumReleases(page.releases);
    const reportedTotal = page["release-count"];
    const total =
        Number.isSafeInteger(reportedTotal) &&
        (reportedTotal as number) >= releases.length
            ? (reportedTotal as number)
            : releases.length;
    return { releases, total };
}

function releaseTrackCount(release: MusicBrainzAlbumRelease): number | null {
    const media = release.media;
    if (!media || media.length === 0 || media.length > MAX_RELEASE_MEDIA) {
        return null;
    }
    let total = 0;
    for (const item of media) {
        const medium = asPlainObject(item);
        const count = medium["track-count"];
        if (!Number.isSafeInteger(count) || (count as number) < 0) return null;
        total += count as number;
        if (!Number.isSafeInteger(total)) return null;
    }
    return total;
}

function expectedTrackCount(releases: MusicBrainzAlbumRelease[]): number {
    const official = releases.filter(
        (release) => release.status === "Official",
    );
    const eligible = official.length > 0 ? official : releases;
    const counts = eligible.flatMap((release) => {
        const count = releaseTrackCount(release);
        return count === null ? [] : [count];
    });
    return counts.length === 0 ? 0 : Math.min(...counts);
}

function flattenAlbumTracks(value: unknown): MusicBrainzAlbumTrack[] {
    if (!Array.isArray(value) || value.length > MAX_RELEASE_MEDIA) {
        throw new TypeError("Invalid MusicBrainz release media response");
    }
    const tracks: MusicBrainzAlbumTrack[] = [];
    for (const item of value) {
        const mediumTracks = asPlainObject(item).tracks;
        if (
            !Array.isArray(mediumTracks) ||
            mediumTracks.length > MAX_MEDIUM_TRACKS
        ) {
            throw new TypeError("Invalid MusicBrainz medium tracks response");
        }
        for (const itemTrack of mediumTracks) {
            const track = asPlainObject(itemTrack);
            const recording = asPlainObject(track.recording);
            const title =
                typeof track.title === "string"
                    ? track.title
                    : typeof recording.title === "string"
                      ? recording.title
                      : "";
            tracks.push({
                title,
                position:
                    typeof track.position === "number"
                        ? track.position
                        : undefined,
                duration:
                    typeof track.length === "number"
                        ? track.length
                        : typeof recording.length === "number"
                          ? recording.length
                          : undefined,
            });
        }
    }
    return tracks;
}

class MusicBrainzService {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: "https://musicbrainz.org/ws/2",
            timeout: 10000,
            headers: {
                "User-Agent": BRAND_USER_AGENT,
            },
        });
    }

    private async cachedRequest<T>(
        cacheKey: string,
        requestFn: () => Promise<T>,
        ttlSeconds = 2592000, // 30 days
        fallbackValue?: T,
    ): Promise<T> {
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached) as T;
            }
        } catch (err) {
            logger.warn("Redis get error:", err);
        }

        let data: T;
        try {
            // Use global rate limiter instead of local rate limiting
            data = await rateLimiter.execute("musicbrainz", requestFn);
        } catch (error: any) {
            logger.warn(
                `[MusicBrainz] Request failed for key "${cacheKey}": ${error.message}`,
            );

            // Preserve 404 behavior for callers that use it as control flow
            // (e.g., try release-group first, then fall back to release).
            if (error?.response?.status === 404) {
                throw error;
            }

            if (fallbackValue !== undefined) {
                try {
                    // Short cache for fallback prevents immediate repeated failures.
                    await redisClient.setEx(
                        cacheKey,
                        120,
                        JSON.stringify(fallbackValue),
                    );
                } catch (err) {
                    logger.warn("Redis set fallback error:", err);
                }

                return fallbackValue;
            }

            throw error;
        }

        try {
            // Use shorter TTL for null results (1 hour) vs successful results (30 days)
            // This allows retrying failed lookups sooner while still caching successes
            const actualTtl = data === null ? 3600 : ttlSeconds;
            await redisClient.setEx(cacheKey, actualTtl, JSON.stringify(data));
        } catch (err) {
            logger.warn("Redis set error:", err);
        }

        return data;
    }

    async searchArtist(query: string, limit = 10) {
        const cacheKey = `mb:search:artist:${query}:${limit}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get("/artist", {
                    params: {
                        query,
                        limit,
                        fmt: "json",
                    },
                });
                return response.data.artists || [];
            },
            2592000,
            [],
        );
    }

    async searchReleaseGroups(query: string, artistName?: string, limit = 10) {
        const normalizedQuery = query.trim();
        const normalizedArtist = artistName?.trim() || "";
        const cacheKey = `mb:search:release-group:${normalizedQuery}:${normalizedArtist}:${limit}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                let searchQuery = `releasegroup:"${this.escapeLucene(normalizedQuery)}"`;
                if (normalizedArtist) {
                    searchQuery += ` AND artist:"${this.escapeLucene(normalizedArtist)}"`;
                }

                const response = await this.client.get("/release-group", {
                    params: {
                        query: searchQuery,
                        limit,
                        fmt: "json",
                    },
                });

                return response.data["release-groups"] || [];
            },
            2592000,
            [],
        );
    }

    async getArtist(mbid: string, includes: string[] = ["url-rels", "tags"]) {
        const artistMbid = encodeMbidPathSegment(mbid, "artist");
        const cacheKey = `mb:artist:${artistMbid}:${includes.join(",")}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get(
                    `/artist/${artistMbid}`,
                    {
                        params: {
                            inc: includes.join("+"),
                            fmt: "json",
                        },
                    },
                );
                return response.data;
            },
            2592000,
            null,
        );
    }

    async getReleaseGroups(
        artistMbid: string,
        types: string[] = ["album", "ep"],
        limit = 100,
    ) {
        const validatedArtistMbid = validateMbid(artistMbid, "artist");
        const cacheKey = `mb:rg:${validatedArtistMbid}:${types.join(",")}:${limit}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get("/release-group", {
                    params: {
                        artist: validatedArtistMbid,
                        type: types.join("|"),
                        limit,
                        fmt: "json",
                    },
                });
                return response.data["release-groups"] || [];
            },
            2592000,
            [],
        );
    }

    /**
     * Browse an artist's release groups with artist-credit data included.
     * Uses a dedicated cache namespace so credit-less browse results cannot
     * satisfy callers that require credit eligibility checks.
     */
    async getReleaseGroupsWithCredits(
        artistMbid: string,
        types: string[] = ["album", "ep"],
        limit = 100,
    ): Promise<MusicBrainzReleaseGroupSearchResult[]> {
        const validatedArtistMbid = validateMbid(artistMbid, "artist");
        const cacheKey = `mb:rg:credits2:${validatedArtistMbid}:${types.join(",")}:${limit}`;

        const releaseGroups = await this.cachedRequest<unknown>(
            cacheKey,
            async () => {
                const response = await this.client.get("/release-group", {
                    params: {
                        artist: validatedArtistMbid,
                        type: types.join("|"),
                        limit,
                        inc: "artist-credits",
                        "release-group-status": "website-default",
                        fmt: "json",
                    },
                });
                const payload = isPlainObject(response.data)
                    ? response.data["release-groups"]
                    : undefined;
                return parseReleaseGroupsWithCredits(payload);
            },
            2592000,
        );
        return parseReleaseGroupsWithCredits(releaseGroups);
    }

    async getReleaseGroup(rgMbid: string) {
        const releaseGroupMbid = encodeMbidPathSegment(rgMbid, "release group");
        const cacheKey = `mb:rg:${releaseGroupMbid}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get(
                    `/release-group/${releaseGroupMbid}`,
                    {
                        params: {
                            inc: "artist-credits+releases",
                            fmt: "json",
                        },
                    },
                );
                return response.data;
            },
            2592000,
            null,
        );
    }

    async getReleaseGroupDetails(rgMbid: string) {
        const releaseGroupMbid = encodeMbidPathSegment(rgMbid, "release group");
        const cacheKey = `mb:rg:details:${releaseGroupMbid}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get(
                    `/release-group/${releaseGroupMbid}`,
                    {
                        params: {
                            inc: "artist-credits+releases+labels",
                            fmt: "json",
                        },
                    },
                );
                return response.data;
            },
            2592000,
            null,
        );
    }

    async getRelease(releaseMbid: string) {
        const validatedReleaseMbid = encodeMbidPathSegment(
            releaseMbid,
            "release",
        );
        const cacheKey = `mb:release:${validatedReleaseMbid}`;

        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get(
                    `/release/${validatedReleaseMbid}`,
                    {
                        params: {
                            inc: "recordings+artist-credits+labels",
                            fmt: "json",
                        },
                    },
                );
                return response.data;
            },
            2592000,
            null,
        );
    }

    extractPrimaryArtist(artistCredits: any[]): string {
        if (!artistCredits || artistCredits.length === 0)
            return "Unknown Artist";
        return (
            artistCredits[0].name ||
            artistCredits[0].artist?.name ||
            "Unknown Artist"
        );
    }

    /**
     * Escape special characters for Lucene query syntax
     * MusicBrainz uses Lucene, which requires escaping: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
     */
    private escapeLucene(str: string): string {
        return str.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1");
    }

    /**
     * Normalize album/artist names for better matching
     * Removes common suffixes and cleans up the string
     */
    private normalizeForSearch(str: string): string {
        const normalizedInput = normalizeFullwidth(normalizeQuotes(str));

        return (
            normalizedInput
                .replace(/\s*\([^)]*\)\s*/g, " ") // Remove parenthetical content
                .replace(/\s*\[[^\]]*\]\s*/g, " ") // Remove bracketed content
                // Remove "- YEAR Remaster", "- Remastered YEAR", "- Deluxe Edition", etc.
                .replace(
                    /\s*-\s*(\d{4}\s+)?(deluxe|remastered|remaster|edition|version|expanded|bonus|explicit|clean|single|radio edit|remix|acoustic|live|mono|stereo)(\s+\d{4})?\s*(edition|version|mix)?\s*/gi,
                    " ",
                )
                // Also catch standalone year suffixes like "- 2011"
                .replace(/\s*-\s*\d{4}\s*$/gi, " ")
                .replace(/\s+/g, " ")
                .trim()
        );
    }

    /**
     * Strip all punctuation from string for fuzzy matching
     * Used as a fallback when normal search fails (e.g., "Do You Realize??")
     */
    private stripPunctuation(str: string): string {
        return str
            .replace(/[^\w\s]/g, "") // Remove all non-word, non-space chars
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * Search for an album (release-group) by title and artist name
     * Returns the first matching release group or null
     * Uses multiple search strategies for better matching
     */
    async searchAlbum(
        albumTitle: string,
        artistName: string,
    ): Promise<{ id: string; title: string } | null> {
        const cacheKey = `mb:search:album:${artistName}:${albumTitle}`;

        return this.cachedRequest(cacheKey, async () => {
            // Strategy 1: Exact match with escaped special characters
            const escapedTitle = this.escapeLucene(albumTitle);
            const escapedArtist = this.escapeLucene(artistName);

            try {
                const query1 = `releasegroup:"${escapedTitle}" AND artist:"${escapedArtist}"`;
                const response1 = await this.client.get("/release-group", {
                    params: {
                        query: query1,
                        limit: 5,
                        fmt: "json",
                    },
                });

                const releaseGroups1 = response1.data["release-groups"] || [];
                if (releaseGroups1.length > 0) {
                    return {
                        id: releaseGroups1[0].id,
                        title: releaseGroups1[0].title,
                    };
                }
            } catch (e) {
                // Continue to strategy 2
            }

            // Strategy 2: Normalized/cleaned title search
            const normalizedTitle = this.normalizeForSearch(albumTitle);
            const normalizedArtist = this.normalizeForSearch(artistName);

            if (
                normalizedTitle !== albumTitle ||
                normalizedArtist !== artistName
            ) {
                try {
                    const escapedNormTitle = this.escapeLucene(normalizedTitle);
                    const escapedNormArtist =
                        this.escapeLucene(normalizedArtist);
                    const query2 = `releasegroup:"${escapedNormTitle}" AND artist:"${escapedNormArtist}"`;
                    const response2 = await this.client.get("/release-group", {
                        params: {
                            query: query2,
                            limit: 5,
                            fmt: "json",
                        },
                    });

                    const releaseGroups2 =
                        response2.data["release-groups"] || [];
                    if (releaseGroups2.length > 0) {
                        return {
                            id: releaseGroups2[0].id,
                            title: releaseGroups2[0].title,
                        };
                    }
                } catch (e) {
                    // Continue to strategy 3
                }
            }

            // Strategy 3: Fuzzy search without quotes (last resort)
            try {
                // Use simple terms without quotes for fuzzy matching
                const simpleTitle = normalizedTitle
                    .split(" ")
                    .slice(0, 3)
                    .join(" "); // First 3 words
                const simpleArtist = normalizedArtist.split(" ")[0]; // First word of artist
                const query3 = `${this.escapeLucene(
                    simpleTitle,
                )} AND artist:${this.escapeLucene(simpleArtist)}`;

                const response3 = await this.client.get("/release-group", {
                    params: {
                        query: query3,
                        limit: 10,
                        fmt: "json",
                    },
                });

                const releaseGroups3 = response3.data["release-groups"] || [];

                // Find a match where the artist name contains our search term
                for (const rg of releaseGroups3) {
                    const rgArtist =
                        rg["artist-credit"]?.[0]?.name ||
                        rg["artist-credit"]?.[0]?.artist?.name ||
                        "";
                    if (
                        rgArtist
                            .toLowerCase()
                            .includes(simpleArtist.toLowerCase())
                    ) {
                        return {
                            id: rg.id,
                            title: rg.title,
                        };
                    }
                }
            } catch (e) {
                // All strategies failed
            }

            return null;
        });
    }

    /**
     * Search for a recording (track) and return album information
     * This is useful when we have artist + track title but not album name
     * Returns the album (release group) that the track appears on
     */
    async searchRecording(
        trackTitle: string,
        artistName: string,
    ): Promise<{
        albumName: string;
        albumMbid: string;
        artistMbid: string;
        trackMbid: string;
    } | null> {
        const cacheKey = `mb:search:recording:${artistName}:${trackTitle}`;

        return this.cachedRequest(cacheKey, async () => {
            try {
                // Normalize track title first - removes "- 2011 Remaster", "(Radio Edit)", etc.
                const normalizedTitle = this.normalizeForSearch(trackTitle);
                const normalizedArtist = this.normalizeForSearch(artistName);

                // Search for recording by normalized track title and artist
                const escapedTitle = this.escapeLucene(normalizedTitle);
                const escapedArtist = this.escapeLucene(normalizedArtist);

                const query = `recording:"${escapedTitle}" AND artist:"${escapedArtist}"`;

                const response = await this.client.get("/recording", {
                    params: {
                        query,
                        limit: 50, // Need high limit because bootleg recordings often rank first
                        fmt: "json",
                        inc: "releases+release-groups+artists",
                    },
                });

                const allRecordings = response.data.recordings || [];

                logger.debug(
                    `[MusicBrainz] Query: "${trackTitle}" by "${artistName}"`,
                );
                logger.debug(
                    `[MusicBrainz] Found ${allRecordings.length} total recordings`,
                );

                // Log first 5 recordings for debugging
                allRecordings.slice(0, 5).forEach((rec: any, i: number) => {
                    const disambig = rec.disambiguation || "(studio)";
                    const releases = rec.releases || [];
                    const albumNames = releases
                        .slice(0, 2)
                        .map((r: any) => r["release-group"]?.title || "?")
                        .join(", ");
                    logger.debug(
                        `   ${i + 1}. [${disambig}] → ${
                            albumNames || "(no albums)"
                        }`,
                    );
                });

                // Filter out live recordings - they have disambiguation like "live, 1995-07-28"
                // We want the studio recording, not live versions
                const recordings = allRecordings.filter((rec: any) => {
                    const disambig = (rec.disambiguation || "").toLowerCase();
                    // Skip if disambiguation contains "live" or date patterns
                    if (disambig.includes("live")) return false;
                    if (disambig.match(/\d{4}[-‐]\d{2}[-‐]\d{2}/)) return false;
                    if (disambig.includes("demo")) return false;
                    if (disambig.includes("acoustic")) return false;
                    if (disambig.includes("remix")) return false;
                    return true;
                });

                logger.debug(
                    `[MusicBrainz] After filtering live/demo: ${recordings.length} studio recordings`,
                );

                if (recordings.length === 0) {
                    // Try fuzzy search without quotes
                    const normalizedTitle = this.normalizeForSearch(trackTitle);
                    const normalizedArtist =
                        this.normalizeForSearch(artistName);
                    const fuzzyQuery = `${this.escapeLucene(
                        normalizedTitle,
                    )} AND artist:${this.escapeLucene(normalizedArtist)}`;

                    const fuzzyResponse = await this.client.get("/recording", {
                        params: {
                            query: fuzzyQuery,
                            limit: 10,
                            fmt: "json",
                            inc: "releases+release-groups+artists",
                        },
                    });

                    const fuzzyRecordings = fuzzyResponse.data.recordings || [];

                    // Find best match by checking artist name similarity
                    for (const rec of fuzzyRecordings) {
                        const recArtist =
                            rec["artist-credit"]?.[0]?.name ||
                            rec["artist-credit"]?.[0]?.artist?.name ||
                            "";
                        if (
                            recArtist
                                .toLowerCase()
                                .includes(
                                    normalizedArtist
                                        .toLowerCase()
                                        .split(" ")[0],
                                )
                        ) {
                            const result = this.extractAlbumFromRecording(rec);
                            if (result) return result; // Only return if we found a good album
                        }
                    }

                    // Strategy 3: Strip all punctuation (handles "Do You Realize??" etc.)
                    const strippedTitle = this.stripPunctuation(trackTitle);
                    const strippedArtist = this.stripPunctuation(artistName);

                    if (strippedTitle !== normalizedTitle) {
                        logger.debug(
                            `[MusicBrainz] Trying punctuation-stripped search: "${strippedTitle}" by ${strippedArtist}`,
                        );

                        const strippedQuery = `${strippedTitle} AND artist:${strippedArtist}`;
                        const strippedResponse = await this.client.get(
                            "/recording",
                            {
                                params: {
                                    query: strippedQuery,
                                    limit: 10,
                                    fmt: "json",
                                    inc: "releases+release-groups+artists",
                                },
                            },
                        );

                        const strippedRecordings =
                            strippedResponse.data.recordings || [];
                        logger.debug(
                            `[MusicBrainz] Punctuation-stripped search found ${strippedRecordings.length} recordings`,
                        );

                        for (const rec of strippedRecordings) {
                            const recArtist =
                                rec["artist-credit"]?.[0]?.name ||
                                rec["artist-credit"]?.[0]?.artist?.name ||
                                "";
                            if (
                                recArtist
                                    .toLowerCase()
                                    .includes(
                                        strippedArtist
                                            .toLowerCase()
                                            .split(" ")[0],
                                    )
                            ) {
                                const result =
                                    this.extractAlbumFromRecording(rec);
                                if (result) {
                                    logger.debug(
                                        `[MusicBrainz] Found via punctuation-stripped search: ${result.albumName}`,
                                    );
                                    return result;
                                }
                            }
                        }
                    }

                    return null;
                }

                // Try each recording until we find one with a good (non-bootleg) album
                for (const rec of recordings) {
                    const disambig =
                        rec.disambiguation || "(no disambiguation)";
                    logger.debug(
                        `[MusicBrainz] Trying recording: "${rec.title}" [${disambig}]`,
                    );
                    const result = this.extractAlbumFromRecording(rec, false);
                    if (result) {
                        logger.debug(
                            `[MusicBrainz] Found album: "${result.albumName}" (MBID: ${result.albumMbid})`,
                        );
                        return result; // Found a good album
                    } else {
                        logger.debug(
                            `[MusicBrainz] No valid album found for this recording`,
                        );
                    }
                }

                // Fallback: Try again accepting Singles/EPs as last resort
                logger.debug(
                    `[MusicBrainz] No official albums found, trying to find Singles/EPs...`,
                );
                for (const rec of recordings) {
                    const result = this.extractAlbumFromRecording(rec, true);
                    if (result) {
                        logger.debug(
                            `[MusicBrainz] Found Single/EP: "${result.albumName}" (MBID: ${result.albumMbid})`,
                        );
                        return result;
                    }
                }

                // No good albums found in any recording
                logger.debug(
                    `[MusicBrainz] No official albums or singles found for "${trackTitle}" by ${artistName} (checked ${recordings.length} recordings)`,
                );
                return null;
            } catch (error: any) {
                logger.error(
                    "MusicBrainz recording search error:",
                    error.message,
                );
                return null;
            }
        });
    }

    /**
     * Extract album information from a MusicBrainz recording result
     * Prioritizes studio albums and filters out compilations, live albums, and bootlegs
     * @param allowSingles - If true, accepts Singles/EPs as a fallback (lower threshold)
     */
    private extractAlbumFromRecording(
        recording: any,
        allowSingles: boolean = false,
    ): {
        albumName: string;
        albumMbid: string;
        artistMbid: string;
        trackMbid: string;
    } | null {
        // Get artist MBID
        const artistMbid = recording["artist-credit"]?.[0]?.artist?.id || "";
        const trackMbid = recording.id || "";

        // Find the best release (prefer studio albums, avoid compilations/live/bootlegs)
        const releases = recording.releases || [];

        if (releases.length === 0) {
            return null;
        }

        // Score each release to find the best one
        const scoredReleases = releases.map((release: any) => {
            const rg = release["release-group"];
            if (!rg?.id) return { release, score: -1000 };

            let score = 0;
            const primaryType = rg["primary-type"] || "";
            const secondaryTypes: string[] = rg["secondary-types"] || [];
            const title = (rg.title || "").toLowerCase();

            // Primary type scoring
            if (primaryType === "Album") score += 100;
            else if (primaryType === "EP") score += 50;
            else if (primaryType === "Single") score += 25;
            else score -= 50; // Unknown type

            // Heavy penalties for compilations, live, bootlegs, soundtracks
            if (secondaryTypes.includes("Compilation")) score -= 200;
            if (secondaryTypes.includes("Live")) score -= 150;
            if (secondaryTypes.includes("Remix")) score -= 100;
            if (secondaryTypes.includes("DJ-mix")) score -= 200;
            if (secondaryTypes.includes("Mixtape/Street")) score -= 100;
            if (secondaryTypes.includes("Soundtrack")) score -= 150; // Movie/TV soundtracks

            // Title-based penalties (catch bootlegs and compilations missed by types)
            if (title.match(/\d{4}[-‐]\d{2}[-‐]\d{2}/)) score -= 300; // Dates like "2006-03-11" = bootleg
            if (title.includes("live at") || title.includes("live from"))
                score -= 150;
            if (title.includes("best of") || title.includes("greatest hits"))
                score -= 200;
            if (title.includes("compilation") || title.includes("collection"))
                score -= 200;
            if (title.includes("soundtrack")) score -= 100;
            if (title.includes("various artists")) score -= 300;
            if (title.includes("sounds of the")) score -= 200; // "Sounds of the 70s" etc.
            if (title.includes("deep sounds")) score -= 200;

            // Bonus for official status
            if (release.status === "Official") score += 20;

            return { release, score };
        });

        // Sort by score (highest first)
        scoredReleases.sort((a: any, b: any) => b.score - a.score);

        // Find the first release with a GOOD score
        // Normal mode: score > 50 (studio album = 100+, EP = 50+)
        // Allow singles mode: score > 0 (Single = 25+, excludes compilations with negative scores)
        const threshold = allowSingles ? 0 : 50;
        const bestResult = scoredReleases.find((r: any) => r.score > threshold);

        if (!bestResult) {
            // No good releases found with this threshold - return null so we try the next recording
            const modeText = allowSingles ? "singles" : "albums";
            const topScores = scoredReleases.slice(0, 3).map((r: any) => {
                const title =
                    r.release["release-group"]?.title || r.release.title;
                return `"${title}" (${r.score})`;
            });
            logger.debug(
                `[MusicBrainz] Skipping recording - no ${modeText} found in ${
                    releases.length
                } releases (threshold: ${threshold}). Top scores: ${topScores.join(
                    ", ",
                )}`,
            );
            return null;
        }

        const bestRelease = bestResult.release;
        const releaseGroup = bestRelease["release-group"];

        if (!releaseGroup?.id) {
            return null;
        }

        logger.debug(
            `[MusicBrainz] Selected "${releaseGroup.title}" (score: ${bestResult.score}) from ${releases.length} releases`,
        );

        return {
            albumName:
                releaseGroup.title || bestRelease.title || "Unknown Album",
            albumMbid: releaseGroup.id,
            artistMbid,
            trackMbid,
        };
    }

    /**
     * Clear cached recording search result
     * Useful for retrying failed lookups
     */
    async clearRecordingCache(
        trackTitle: string,
        artistName: string,
    ): Promise<boolean> {
        const cacheKey = `mb:search:recording:${artistName}:${trackTitle}`;
        try {
            await redisClient.del(cacheKey);
            logger.debug(
                `[MusicBrainz] Cleared cache for: "${trackTitle}" by ${artistName}`,
            );
            return true;
        } catch (err) {
            logger.warn("Redis del error:", err);
            return false;
        }
    }

    /**
     * Clear all stale null cache entries for recording searches
     * Returns the number of entries cleared
     */
    async clearStaleRecordingCaches(): Promise<number> {
        try {
            // Get all recording cache keys
            const keys = await redisClient.keys("mb:search:recording:*");
            let cleared = 0;

            for (const key of keys) {
                const value = await redisClient.get(key);
                if (value === "null") {
                    await redisClient.del(key);
                    cleared++;
                }
            }

            logger.debug(
                `[MusicBrainz] Cleared ${cleared} stale null cache entries`,
            );
            return cleared;
        } catch (err) {
            logger.error("Error clearing stale caches:", err);
            return 0;
        }
    }

    private getAlbumReleasePage(
        releaseGroupMbid: string,
        offset: number,
    ): Promise<MusicBrainzAlbumReleasePage | null> {
        const cacheKey = `mb:album-releases:${releaseGroupMbid}:${offset}`;
        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get("/release", {
                    params: {
                        "release-group": releaseGroupMbid,
                        inc: "media",
                        limit: MUSICBRAINZ_RELEASE_PAGE_SIZE,
                        offset,
                        fmt: "json",
                    },
                });
                return parseAlbumReleasePage(response.data);
            },
            2592000,
            // The 120s fallback TTL bounds MB retries without 30-day poisoning.
            null,
        );
    }

    private async getAlbumReleases(
        releaseGroupMbid: string,
    ): Promise<MusicBrainzAlbumRelease[]> {
        const releases: MusicBrainzAlbumRelease[] = [];
        for (
            let pageIndex = 0;
            pageIndex < MAX_RELEASE_GROUP_PAGES;
            pageIndex++
        ) {
            const page = await this.getAlbumReleasePage(
                releaseGroupMbid,
                releases.length,
            );
            if (!page) return [];
            releases.push(...page.releases);
            if (releases.length >= page.total) return releases;
            if (page.releases.length === 0) return [];
        }
        logger.warn("MusicBrainz release-group paging exceeded its bound", {
            releaseGroupMbid,
            pageLimit: MAX_RELEASE_GROUP_PAGES,
        });
        return [];
    }

    /** Return the minimum total for official editions, or all editions. */
    async getExpectedTrackCount(rgMbid: string): Promise<number> {
        const releaseGroupMbid = encodeMbidPathSegment(rgMbid, "release group");
        const releases = await this.getAlbumReleases(releaseGroupMbid);
        return expectedTrackCount(releases);
    }

    /** Get tracks from the first official release, or the first release. */
    async getAlbumTracks(rgMbid: string): Promise<MusicBrainzAlbumTrack[]> {
        const releaseGroupMbid = encodeMbidPathSegment(rgMbid, "release group");
        const releases = await this.getAlbumReleases(releaseGroupMbid);
        if (releases.length === 0) {
            logger.debug(
                `[MusicBrainz] No releases found for release group ${releaseGroupMbid}`,
            );
            return [];
        }
        const release =
            releases.find((candidate) => candidate.status === "Official") ??
            releases[0];
        const releaseMbid = encodeMbidPathSegment(release.id, "release");
        const cacheKey = `mb:albumtracks:v2:${releaseGroupMbid}:${releaseMbid}`;
        return this.cachedRequest(
            cacheKey,
            async () => {
                const response = await this.client.get(
                    `/release/${releaseMbid}`,
                    { params: { inc: "recordings", fmt: "json" } },
                );
                const tracks = flattenAlbumTracks(response.data?.media);
                logger.debug(
                    `[MusicBrainz] Found ${tracks.length} tracks for release group ${releaseGroupMbid}`,
                );
                return tracks;
            },
            2592000,
            [],
        );
    }
}

export const musicBrainzService = new MusicBrainzService();

import axios, { AxiosInstance } from "axios";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { buildSectionsWhenPresent } from "./audiobookSections";

const STREAM_HEADER_TIMEOUT_MS = 30_000;
const UNSAFE_AUDIO_TRACK_URL_ERROR =
    "Audiobookshelf returned an unsafe audio track URL";

function resolveStreamContentPath(
    contentUrl: unknown,
    baseUrl: string | null,
): string {
    if (typeof contentUrl !== "string" || !baseUrl) {
        throw new Error(UNSAFE_AUDIO_TRACK_URL_ERROR);
    }

    let configuredBase: URL;
    let resolvedContentUrl: URL;
    try {
        configuredBase = new URL(baseUrl);
        resolvedContentUrl = new URL(
            contentUrl,
            `${configuredBase.href.replace(/\/$/, "")}/`,
        );
    } catch {
        throw new Error(UNSAFE_AUDIO_TRACK_URL_ERROR);
    }

    const usesHttp =
        resolvedContentUrl.protocol === "http:" ||
        resolvedContentUrl.protocol === "https:";
    const hasCredentials =
        resolvedContentUrl.username !== "" ||
        resolvedContentUrl.password !== "";
    if (
        !usesHttp ||
        hasCredentials ||
        resolvedContentUrl.origin !== configuredBase.origin
    ) {
        throw new Error(UNSAFE_AUDIO_TRACK_URL_ERROR);
    }

    return `${resolvedContentUrl.pathname}${resolvedContentUrl.search}`;
}

interface StreamDisconnectSource {
    readonly aborted?: boolean;
    readonly destroyed?: boolean;
    once(event: "close" | "aborted", listener: () => void): unknown;
    off(event: "close" | "aborted", listener: () => void): unknown;
}

interface StreamAcquisitionLifecycle {
    request: StreamDisconnectSource;
    response: StreamDisconnectSource;
}

function bindStreamDisconnect(
    lifecycle: StreamAcquisitionLifecycle,
    controller: AbortController,
): () => void {
    const onDisconnect = () => {
        if (!controller.signal.aborted) {
            controller.abort(
                new Error("Client disconnected during stream acquisition"),
            );
        }
    };

    lifecycle.request.once("close", onDisconnect);
    lifecycle.request.once("aborted", onDisconnect);
    lifecycle.response.once("close", onDisconnect);
    lifecycle.response.once("aborted", onDisconnect);

    if (
        lifecycle.request.aborted ||
        lifecycle.request.destroyed ||
        lifecycle.response.destroyed
    ) {
        onDisconnect();
    }

    return () => {
        lifecycle.request.off("close", onDisconnect);
        lifecycle.request.off("aborted", onDisconnect);
        lifecycle.response.off("close", onDisconnect);
        lifecycle.response.off("aborted", onDisconnect);
    };
}

/**
 * Audiobookshelf API Service
 * Handles all interactions with the Audiobookshelf server
 */
class AudiobookshelfService {
    private client: AxiosInstance | null = null;
    private baseUrl: string | null = null;
    private apiKey: string | null = null;
    private initialized = false;
    private podcastCache: { items: any[]; expiresAt: number } | null = null;
    private readonly PODCAST_CACHE_TTL_MS = 5 * 60 * 1000;

    private async ensureInitialized() {
        if (this.initialized && this.client) return;

        try {
            // Try to get from database first
            const settings = await getSystemSettings();

            // Check if Audiobookshelf is explicitly disabled
            if (settings && settings.audiobookshelfEnabled === false) {
                throw new Error("Audiobookshelf is disabled in settings");
            }

            if (
                settings?.audiobookshelfEnabled &&
                settings?.audiobookshelfUrl &&
                settings?.audiobookshelfApiKey
            ) {
                this.baseUrl = settings.audiobookshelfUrl.replace(/\/$/, ""); // Remove trailing slash
                this.apiKey = settings.audiobookshelfApiKey;
                this.client = axios.create({
                    baseURL: this.baseUrl as string,
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                    timeout: 30000, // 30 seconds for remote server
                });
                logger.debug("Audiobookshelf configured from database");
                this.initialized = true;
                return;
            }
        } catch (error: any) {
            if (error.message === "Audiobookshelf is disabled in settings") {
                throw error;
            }
            if (config.secretsDbOnly) {
                throw new Error(
                    "SECRETS_DB_ONLY: system settings unreadable; Audiobookshelf credentials unavailable (no .env fallback)",
                );
            }
            logger.debug(
                "  Could not load Audiobookshelf from database, checking .env",
            );
        }

        if (config.secretsDbOnly) {
            throw new Error(
                "SECRETS_DB_ONLY requires Audiobookshelf credentials in system settings",
            );
        }

        // Fallback to env-based configuration via the config boundary.
        const envConfig = config.audiobookshelf;
        if (envConfig) {
            this.baseUrl = envConfig.url.replace(/\/$/, "");
            this.apiKey = envConfig.apiKey;
            this.client = axios.create({
                baseURL: this.baseUrl,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                },
                timeout: 30000, // 30 seconds for remote server
            });
            logger.debug("Audiobookshelf configured from .env");
            this.initialized = true;
        } else {
            throw new Error("Audiobookshelf not configured");
        }
    }

    /**
     * Test connection to Audiobookshelf
     */
    async ping(): Promise<boolean> {
        try {
            await this.ensureInitialized();
            const response = await this.client!.get("/api/libraries");
            return response.status === 200;
        } catch (error) {
            logger.error("Audiobookshelf connection failed:", error);
            return false;
        }
    }

    /**
     * Get all libraries from Audiobookshelf
     */
    async getLibraries() {
        await this.ensureInitialized();
        const response = await this.client!.get("/api/libraries");
        return response.data.libraries || [];
    }

    /**
     * Get all audiobooks from a specific library
     */
    async getLibraryItems(libraryId: string) {
        await this.ensureInitialized();
        const response = await this.client!.get(
            `/api/libraries/${libraryId}/items`,
        );
        return response.data.results || [];
    }

    /**
     * Get all audiobooks from all libraries
     */
    async getAllAudiobooks() {
        await this.ensureInitialized();
        const libraries = await this.getLibraries();

        const allBooks: any[] = [];
        for (const library of libraries) {
            if (library.mediaType === "book") {
                // Only get audiobook libraries
                const items = await this.getLibraryItems(library.id);

                // DEBUG: Log the structure of the first item with series
                if (items.length > 0) {
                    const itemsWithSeries = items.filter(
                        (item: any) =>
                            item.media?.metadata?.series ||
                            item.media?.metadata?.seriesName,
                    );
                    if (itemsWithSeries.length > 0) {
                        logger.debug(
                            "[AUDIOBOOKSHELF DEBUG] Sample item WITH series:",
                            JSON.stringify(
                                itemsWithSeries[0],
                                null,
                                2,
                            ).substring(0, 2000),
                        );
                    } else {
                        logger.debug(
                            "[AUDIOBOOKSHELF DEBUG] No items with series found! Sample item:",
                            JSON.stringify(items[0], null, 2).substring(
                                0,
                                1000,
                            ),
                        );
                    }
                }

                allBooks.push(...items);
            }
        }

        return allBooks;
    }

    /**
     * Get all podcasts from all libraries
     */
    async getAllPodcasts(forceRefresh = false) {
        await this.ensureInitialized();

        if (
            !forceRefresh &&
            this.podcastCache &&
            this.podcastCache.expiresAt > Date.now()
        ) {
            return this.podcastCache.items;
        }

        const libraries = await this.getLibraries();
        const podcastLibraries = libraries.filter(
            (library: any) => library.mediaType === "podcast",
        );

        const libraryResults = await Promise.all(
            podcastLibraries.map(async (library: any) => {
                try {
                    return await this.getLibraryItems(library.id);
                } catch (error) {
                    logger.error(
                        `Audiobookshelf: failed to load podcast library ${library.id}`,
                        error,
                    );
                    return [];
                }
            }),
        );

        const allPodcasts = libraryResults.flat();

        this.podcastCache = {
            items: allPodcasts,
            expiresAt: Date.now() + this.PODCAST_CACHE_TTL_MS,
        };

        return allPodcasts;
    }

    /**
     * Get a specific audiobook by ID
     */
    async getAudiobook(audiobookId: string, signal?: AbortSignal) {
        await this.ensureInitialized();
        const path = `/api/items/${audiobookId}?expanded=1`;
        const response = signal
            ? await this.client!.get(path, { signal })
            : await this.client!.get(path);
        return response.data;
    }

    /**
     * Get a specific podcast by ID (alias for getAudiobook since API is the same)
     */
    async getPodcast(podcastId: string) {
        return this.getAudiobook(podcastId);
    }

    /**
     * Get user's progress for an audiobook
     */
    async getProgress(audiobookId: string) {
        await this.ensureInitialized();
        const response = await this.client!.get(
            `/api/me/progress/${audiobookId}`,
        );
        return response.data;
    }

    /**
     * Update user's progress for an audiobook
     */
    async updateProgress(
        audiobookId: string,
        currentTime: number,
        duration: number,
        isFinished: boolean = false,
    ) {
        await this.ensureInitialized();
        const response = await this.client!.patch(
            `/api/me/progress/${audiobookId}`,
            {
                currentTime,
                duration,
                isFinished,
            },
        );
        return response.data;
    }

    /**
     * Get stream URL for an audiobook
     */
    async getStreamUrl(audiobookId: string): Promise<string> {
        await this.ensureInitialized();
        return `${this.baseUrl}/api/items/${audiobookId}/play`;
    }

    /**
     * Stream an audiobook with authentication
     * Returns a readable stream that can be piped to the response
     */
    async streamAudiobook(
        audiobookId: string,
        rangeHeader?: string,
        lifecycle?: StreamAcquisitionLifecycle,
    ) {
        const controller = new AbortController();
        const detachDisconnect = lifecycle
            ? bindStreamDisconnect(lifecycle, controller)
            : () => undefined;
        const timeoutError = new Error(
            `Audiobookshelf stream headers timed out after ${STREAM_HEADER_TIMEOUT_MS}ms`,
        );
        const timeoutId = setTimeout(() => {
            if (!controller.signal.aborted) controller.abort(timeoutError);
        }, STREAM_HEADER_TIMEOUT_MS);

        try {
            await this.ensureInitialized();
            const audiobook = await this.getAudiobook(
                audiobookId,
                controller.signal,
            );
            const contentUrl = audiobook.media?.tracks?.[0]?.contentUrl;
            if (!contentUrl) {
                throw new Error("No audio track found for this audiobook");
            }
            const contentPath = resolveStreamContentPath(
                contentUrl,
                this.baseUrl,
            );

            const headers: Record<string, string> = {};
            if (rangeHeader) headers["Range"] = rangeHeader;
            const response = await this.client!.get(contentPath, {
                allowAbsoluteUrls: false,
                responseType: "stream",
                timeout: 0,
                signal: controller.signal,
                headers,
                validateStatus: (status) => status >= 200 && status < 300,
            });
            return {
                stream: response.data,
                headers: response.headers,
                status: response.status,
            };
        } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            throw error;
        } finally {
            clearTimeout(timeoutId);
            detachDisconnect();
        }
    }

    /**
     * Stream a podcast episode with authentication
     * For podcasts, we need to get a specific episode ID
     */
    async streamPodcastEpisode(podcastId: string, episodeId: string) {
        await this.ensureInitialized();

        // Get the podcast to find the episode
        const podcast = await this.getPodcast(podcastId);
        const episode = podcast.media?.episodes?.find(
            (ep: any) => ep.id === episodeId,
        );

        if (!episode) {
            throw new Error("Episode not found");
        }

        // Podcast episodes use audioTrack.contentUrl, not audioFile.contentUrl
        const contentUrl =
            episode.audioTrack?.contentUrl || episode.audioFile?.contentUrl;

        if (!contentUrl) {
            throw new Error("No audio file found for this episode");
        }

        const response = await this.client!.get(contentUrl, {
            responseType: "stream",
            timeout: 0,
        });

        return {
            stream: response.data,
            headers: response.headers,
        };
    }

    /**
     * Search audiobooks
     */
    async searchAudiobooks(query: string) {
        await this.ensureInitialized();
        const response = await this.client!.get(
            `/api/search/books?q=${encodeURIComponent(query)}`,
        );
        return response.data.book || [];
    }

    /**
     * Sync audiobooks from Audiobookshelf to local database cache
     * This populates the Audiobook table for full-text search
     */
    async syncAudiobooksToCache() {
        await this.ensureInitialized();
        logger.debug("[AUDIOBOOKSHELF] Starting audiobook sync to cache...");

        try {
            // Fetch all audiobooks from Audiobookshelf API
            const audiobooks = await this.getAllAudiobooks();
            logger.debug(
                `[AUDIOBOOKSHELF] Found ${audiobooks.length} audiobooks to sync`,
            );

            // Map and upsert each audiobook to database
            let syncedCount = 0;
            for (const item of audiobooks) {
                try {
                    const metadata = item.media?.metadata || {};
                    const sections = buildSectionsWhenPresent({
                        durationSeconds: item.media?.duration,
                        chapters: item.media?.chapters,
                        audioFiles: item.media?.audioFiles,
                    });

                    // Extract series information (check both possible formats)
                    let series: string | null = null;
                    let seriesSequence: string | null = null;

                    if (
                        metadata.series &&
                        Array.isArray(metadata.series) &&
                        metadata.series.length > 0
                    ) {
                        series = metadata.series[0].name || null;
                        seriesSequence = metadata.series[0].sequence || null;
                    } else if (metadata.seriesName) {
                        series = metadata.seriesName;
                        seriesSequence = metadata.seriesSequence || null;
                    }

                    await prisma.audiobook.upsert({
                        where: { id: item.id },
                        update: {
                            title: metadata.title || "Untitled",
                            author:
                                metadata.authorName || metadata.author || null,
                            narrator:
                                metadata.narratorName ||
                                metadata.narrator ||
                                null,
                            description: metadata.description || null,
                            publishedYear: metadata.publishedYear
                                ? parseInt(metadata.publishedYear, 10)
                                : null,
                            publisher: metadata.publisher || null,
                            series,
                            seriesSequence,
                            duration: item.media?.duration || null,
                            numTracks: item.media?.numTracks || null,
                            ...(sections === null ? {} : { sections }),
                            size: item.media?.size
                                ? BigInt(item.media.size)
                                : null,
                            isbn: metadata.isbn || null,
                            asin: metadata.asin || null,
                            language: metadata.language || null,
                            genres: metadata.genres || [],
                            tags: item.media?.tags || [],
                            coverUrl: metadata.coverPath
                                ? `${this.baseUrl}${metadata.coverPath}`
                                : null,
                            audioUrl: `${this.baseUrl}/api/items/${item.id}/play`,
                            libraryId: item.libraryId || null,
                            lastSyncedAt: new Date(),
                        },
                        create: {
                            id: item.id,
                            title: metadata.title || "Untitled",
                            author:
                                metadata.authorName || metadata.author || null,
                            narrator:
                                metadata.narratorName ||
                                metadata.narrator ||
                                null,
                            description: metadata.description || null,
                            publishedYear: metadata.publishedYear
                                ? parseInt(metadata.publishedYear, 10)
                                : null,
                            publisher: metadata.publisher || null,
                            series,
                            seriesSequence,
                            duration: item.media?.duration || null,
                            numTracks: item.media?.numTracks || null,
                            sections: sections ?? Prisma.DbNull,
                            size: item.media?.size
                                ? BigInt(item.media.size)
                                : null,
                            isbn: metadata.isbn || null,
                            asin: metadata.asin || null,
                            language: metadata.language || null,
                            genres: metadata.genres || [],
                            tags: item.media?.tags || [],
                            coverUrl: metadata.coverPath
                                ? `${this.baseUrl}${metadata.coverPath}`
                                : null,
                            audioUrl: `${this.baseUrl}/api/items/${item.id}/play`,
                            libraryId: item.libraryId || null,
                        },
                    });
                    syncedCount++;
                } catch (error) {
                    logger.error(
                        `[AUDIOBOOKSHELF] Failed to sync audiobook ${item.id}:`,
                        error,
                    );
                }
            }

            logger.debug(
                `[AUDIOBOOKSHELF] Successfully synced ${syncedCount}/${audiobooks.length} audiobooks to cache`,
            );
            return { synced: syncedCount, total: audiobooks.length };
        } catch (error) {
            logger.error("[AUDIOBOOKSHELF] Audiobook sync failed:", error);
            throw error;
        }
    }
}

export const audiobookshelfService = new AudiobookshelfService();

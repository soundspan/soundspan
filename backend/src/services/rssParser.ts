import Parser from "rss-parser";
import axios, { type AxiosResponse } from "axios";
import { logger } from "../utils/logger";
import {
    resolveSafeOutboundUrl,
    resolveSafeOutboundRedirectTarget,
} from "./outboundUrlSafety";

/** Redirect-hop cap for feed fetches (matches the image proxy's limit). */
const MAX_FEED_REDIRECTS = 5;
/** Maximum RSS payload accepted before XML parsing. */
export const MAX_PODCAST_FEED_BYTES = 5 * 1024 * 1024;
/** Maximum number of feed items accepted from one RSS document. */
export const MAX_PODCAST_FEED_EPISODES = 1000;
/** Maximum declared podcast enclosure size accepted during ingestion. */
export const MAX_PODCAST_ENCLOSURE_BYTES = 1024 * 1024 * 1024;
const rssParserLogger = logger.child("RSSParser");

interface DestroyableFeedStream {
    on: (event: string, listener: (...args: any[]) => void) => unknown;
    destroy: () => unknown;
}

function isDestroyableFeedStream(
    value: unknown,
): value is DestroyableFeedStream {
    return (
        typeof value === "object" &&
        value !== null &&
        "on" in value &&
        typeof value.on === "function" &&
        "destroy" in value &&
        typeof value.destroy === "function"
    );
}

function destroyFeedBody(body: unknown): void {
    if (isDestroyableFeedStream(body)) {
        body.destroy();
    }
}

function describeRSSParserError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return "Unknown error";
}

class RSSFeedLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RSSFeedLimitError";
    }
}

interface RSSPodcast {
    title: string;
    author?: string;
    description?: string;
    imageUrl?: string;
    language?: string;
    explicit?: boolean;
    itunesId?: string;
}

interface RSSEpisode {
    guid: string;
    title: string;
    description?: string;
    audioUrl: string;
    duration: number; // seconds
    publishedAt: Date;
    episodeNumber?: number;
    season?: number;
    imageUrl?: string;
    fileSize?: number; // bytes
    mimeType?: string;
}

interface ParsedPodcastFeed {
    podcast: RSSPodcast;
    episodes: RSSEpisode[];
    feedMetadata: {
        etag?: string;
        lastModified?: string;
    };
}

interface RSSFeedRequestOptions {
    headers?: Record<string, string>;
}

type FeedMetadata = ParsedPodcastFeed["feedMetadata"];

export class RSSFeedNotModifiedError extends Error {
    readonly etag?: string;
    readonly lastModified?: string;

    constructor(etag?: string, lastModified?: string) {
        super("Feed not modified");
        this.name = "RSSFeedNotModifiedError";
        this.etag = etag;
        this.lastModified = lastModified;
    }
}

class RSSParserService {
    private createParser(): Parser {
        return new Parser({
            customFields: {
                feed: [
                    ["itunes:author", "itunesAuthor"] as any,
                    ["itunes:image", "itunesImage"] as any,
                    ["itunes:explicit", "itunesExplicit"] as any,
                    ["itunes:type", "itunesType"] as any,
                ],
                item: [
                    ["itunes:author", "itunesAuthor"] as any,
                    ["itunes:duration", "itunesDuration"] as any,
                    ["itunes:image", "itunesImage"] as any,
                    ["itunes:episode", "itunesEpisode"] as any,
                    ["itunes:season", "itunesSeason"] as any,
                    ["itunes:explicit", "itunesExplicit"] as any,
                ],
            },
        });
    }

    private getHeaderValue(
        headers: Record<string, unknown>,
        name: string,
    ): string | undefined {
        const value = headers[name];
        return typeof value === "string" && value.trim().length > 0
            ? value.trim()
            : undefined;
    }

    private async fetchFeedResponse(
        safeFeedUrl: string,
        options: RSSFeedRequestOptions,
    ): Promise<AxiosResponse<unknown>> {
        let currentUrl = safeFeedUrl;
        for (let hop = 0; hop <= MAX_FEED_REDIRECTS; hop += 1) {
            const response = await axios.get<unknown>(currentUrl, {
                responseType: "stream",
                timeout: 60000,
                maxRedirects: 0,
                headers: {
                    Accept: "application/rss+xml",
                    "User-Agent": "rss-parser",
                    ...(options.headers ?? {}),
                },
                validateStatus: (status) =>
                    (status >= 200 && status < 300) ||
                    status === 304 ||
                    (status >= 300 && status < 400),
            });
            if (response.status < 300 || response.status === 304) {
                return response;
            }

            destroyFeedBody(response.data);
            if (hop === MAX_FEED_REDIRECTS) {
                throw new Error("Too many redirects");
            }
            const location = this.getHeaderValue(response.headers, "location");
            if (!location) {
                throw new Error("Redirect without a Location header");
            }
            const nextUrl = await resolveSafeOutboundRedirectTarget(
                location,
                currentUrl,
            );
            if (!nextUrl) {
                throw new Error("Invalid or private feed redirect target");
            }
            rssParserLogger.debug(
                `Following feed redirect (${response.status}) -> ${nextUrl}`,
            );
            currentUrl = nextUrl;
        }
        throw new Error("Too many redirects");
    }

    private async readFeedBody(
        response: AxiosResponse<unknown>,
    ): Promise<string> {
        const declaredHeader = this.getHeaderValue(
            response.headers,
            "content-length",
        );
        const declaredLength = Number(declaredHeader ?? 0);
        if (
            !Number.isSafeInteger(declaredLength) ||
            declaredLength < 0 ||
            declaredLength > MAX_PODCAST_FEED_BYTES
        ) {
            destroyFeedBody(response.data);
            throw new RSSFeedLimitError("Podcast feed exceeds maximum size");
        }

        if (typeof response.data === "string") {
            if (Buffer.byteLength(response.data) > MAX_PODCAST_FEED_BYTES) {
                throw new RSSFeedLimitError(
                    "Podcast feed exceeds maximum size",
                );
            }
            return response.data;
        }
        if (Buffer.isBuffer(response.data)) {
            if (response.data.byteLength > MAX_PODCAST_FEED_BYTES) {
                throw new RSSFeedLimitError(
                    "Podcast feed exceeds maximum size",
                );
            }
            return response.data.toString("utf8");
        }
        if (!isDestroyableFeedStream(response.data)) {
            throw new Error("Feed response body is not readable");
        }

        return this.readFeedStream(response.data);
    }

    private readFeedStream(stream: DestroyableFeedStream): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            let settled = false;
            const settle = (error?: Error) => {
                if (settled) return;
                settled = true;
                if (error) reject(error);
                else resolve(Buffer.concat(chunks).toString("utf8"));
            };

            stream.on("data", (chunk: Buffer | Uint8Array | string) => {
                if (settled) return;
                const buffer = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk);
                totalBytes += buffer.byteLength;
                if (totalBytes > MAX_PODCAST_FEED_BYTES) {
                    settle(
                        new RSSFeedLimitError(
                            "Podcast feed exceeds maximum size",
                        ),
                    );
                    stream.destroy();
                    return;
                }
                chunks.push(buffer);
            });
            stream.on("end", () => settle());
            stream.on("error", (error: Error) => settle(error));
            stream.on("aborted", () =>
                settle(new Error("Feed response was aborted")),
            );
        });
    }

    private getFeedMetadata(response: AxiosResponse<unknown>): FeedMetadata {
        return {
            etag: this.getHeaderValue(response.headers, "etag"),
            lastModified: this.getHeaderValue(
                response.headers,
                "last-modified",
            ),
        };
    }

    private parsePodcast(feed: any): RSSPodcast {
        return {
            title: feed.title || "Unknown Podcast",
            author: feed.itunesAuthor || feed.author || undefined,
            description: feed.description || undefined,
            imageUrl: this.extractImageUrl(feed),
            language: feed.language || undefined,
            explicit: this.parseExplicit(feed.itunesExplicit),
            itunesId: this.extractItunesId(feed),
        };
    }

    private getBoundedFeedItems(feed: any): any[] {
        const items = Array.isArray(feed.items) ? feed.items : [];
        if (items.length > MAX_PODCAST_FEED_EPISODES) {
            throw new RSSFeedLimitError(
                "Podcast feed exceeds maximum episode count",
            );
        }
        return items;
    }

    /**
     * Parse an RSS podcast feed from a URL
     */
    async parseFeed(
        feedUrl: string,
        options: RSSFeedRequestOptions = {},
    ): Promise<ParsedPodcastFeed> {
        try {
            const safeFeedUrl = await resolveSafeOutboundUrl(feedUrl);
            if (!safeFeedUrl) {
                throw new Error("Invalid or private feed URL");
            }
            rssParserLogger.debug(`Fetching feed: ${safeFeedUrl}`);
            const response = await this.fetchFeedResponse(safeFeedUrl, options);
            const feedMetadata = this.getFeedMetadata(response);

            if (response.status === 304) {
                throw new RSSFeedNotModifiedError(
                    feedMetadata.etag,
                    feedMetadata.lastModified,
                );
            }

            const feedBody = await this.readFeedBody(response);
            const feed = await this.createParser().parseString(feedBody);
            const items = this.getBoundedFeedItems(feed);
            const podcast = this.parsePodcast(feed);

            rssParserLogger.debug(`Podcast: ${podcast.title}`);
            rssParserLogger.debug(`Author: ${podcast.author || "Unknown"}`);
            rssParserLogger.debug(`Episodes found: ${items.length}`);
            const episodes = this.parseEpisodes(items, podcast);
            rssParserLogger.debug(
                `Successfully parsed ${episodes.length} episodes`,
            );

            return { podcast, episodes, feedMetadata };
        } catch (error) {
            if (error instanceof RSSFeedNotModifiedError) {
                throw error;
            }

            const errorMessage =
                axios.isAxiosError(error) && error.response
                    ? `Status code ${error.response.status}`
                    : error instanceof Error
                      ? error.message
                      : "Unknown feed error";

            rssParserLogger.error("Failed to parse feed", errorMessage);
            throw new Error(`Failed to parse podcast feed: ${errorMessage}`);
        }
    }

    private parseEpisodes(items: any[], podcast: RSSPodcast): RSSEpisode[] {
        return items
            .map((item) => {
                try {
                    return this.parseEpisode(item, podcast);
                } catch (error) {
                    rssParserLogger.error(
                        `Error parsing episode "${item.title}"`,
                        describeRSSParserError(error),
                    );
                    return null;
                }
            })
            .filter((episode): episode is RSSEpisode => episode !== null);
    }

    private parseEpisode(item: any, podcast: RSSPodcast): RSSEpisode | null {
        const audioEnclosure = this.findAudioEnclosure(item);
        if (!audioEnclosure) {
            rssParserLogger.warn(
                `Skipping episode "${item.title}" - no audio found`,
            );
            return null;
        }
        const fileSize = this.parseEnclosureSize(audioEnclosure.length);
        if (this.isRejectedEnclosureSize(audioEnclosure.length)) {
            rssParserLogger.warn(
                `Skipping episode "${item.title}" - enclosure exceeds size limit`,
            );
            return null;
        }

        return {
            guid: item.guid || item.link || item.title || "",
            title: item.title || "Unknown Episode",
            description: item.content || item.contentSnippet || undefined,
            audioUrl: audioEnclosure.url,
            duration: this.parseDuration(item.itunesDuration),
            publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
            episodeNumber: item.itunesEpisode
                ? parseInt(item.itunesEpisode)
                : undefined,
            season: item.itunesSeason ? parseInt(item.itunesSeason) : undefined,
            imageUrl:
                this.extractImageUrl(item) || podcast.imageUrl || undefined,
            fileSize,
            mimeType: audioEnclosure.type || "audio/mpeg",
        };
    }

    private parseEnclosureSize(length?: string): number | undefined {
        if (!length) return undefined;
        const parsed = Number(length);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    }

    private isRejectedEnclosureSize(length?: string): boolean {
        if (!length) return false;
        const parsed = Number(length);
        return (
            !Number.isSafeInteger(parsed) ||
            parsed < 0 ||
            parsed > MAX_PODCAST_ENCLOSURE_BYTES
        );
    }

    /**
     * Extract image URL from feed/item
     */
    private extractImageUrl(data: any): string | undefined {
        // Try iTunes image first
        if (data.itunesImage) {
            if (typeof data.itunesImage === "string") {
                return data.itunesImage;
            }
            if (data.itunesImage.href) {
                return data.itunesImage.href;
            }
            if (data.itunesImage.$ && data.itunesImage.$.href) {
                return data.itunesImage.$.href;
            }
        }

        // Try standard image field
        if (data.image) {
            if (typeof data.image === "string") {
                return data.image;
            }
            if (data.image.url) {
                return data.image.url;
            }
        }

        return undefined;
    }

    /**
     * Find audio enclosure in episode
     */
    private findAudioEnclosure(
        item: any,
    ): { url: string; type?: string; length?: string } | null {
        // Check enclosure field
        if (item.enclosure) {
            const enc = item.enclosure;
            if (enc.url && this.isAudioMimeType(enc.type)) {
                return {
                    url: enc.url,
                    type: enc.type,
                    length: enc.length,
                };
            }
        }

        // Check enclosures array
        if (Array.isArray(item.enclosures)) {
            for (const enc of item.enclosures) {
                if (enc.url && this.isAudioMimeType(enc.type)) {
                    return {
                        url: enc.url,
                        type: enc.type,
                        length: enc.length,
                    };
                }
            }
        }

        return null;
    }

    /**
     * Check if MIME type is audio
     */
    private isAudioMimeType(mimeType?: string): boolean {
        if (!mimeType) return false;
        return (
            mimeType.startsWith("audio/") ||
            mimeType.includes("mpeg") ||
            mimeType.includes("mp3") ||
            mimeType.includes("m4a")
        );
    }

    /**
     * Parse iTunes duration format
     * Supports: "HH:MM:SS", "MM:SS", or just seconds
     */
    private parseDuration(duration?: string): number {
        if (!duration) return 0;

        // If it's already a number (seconds)
        const asNumber = parseInt(duration);
        if (!isNaN(asNumber) && asNumber.toString() === duration) {
            return asNumber;
        }

        // Parse time format (HH:MM:SS or MM:SS)
        const parts = duration.split(":").map((p) => parseInt(p));
        if (parts.length === 3) {
            // HH:MM:SS
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
        } else if (parts.length === 2) {
            // MM:SS
            return parts[0] * 60 + parts[1];
        }

        return 0;
    }

    /**
     * Parse explicit flag
     */
    private parseExplicit(explicit?: string): boolean {
        if (!explicit) return false;
        const lower = explicit.toLowerCase();
        return lower === "yes" || lower === "true" || lower === "explicit";
    }

    /**
     * Extract iTunes ID from feed
     */
    private extractItunesId(feed: any): string | undefined {
        // Try to extract from feed link (e.g., https://podcasts.apple.com/us/podcast/podcast-name/id123456789)
        if (feed.link) {
            const match = feed.link.match(/\/id(\d+)/);
            if (match) {
                return match[1];
            }
        }

        // Try from feed image URL
        if (feed.image?.url) {
            const match = feed.image.url.match(/\/id(\d+)/);
            if (match) {
                return match[1];
            }
        }

        return undefined;
    }
}

export const rssParserService = new RSSParserService();

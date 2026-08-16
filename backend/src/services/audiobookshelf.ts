import axios, { AxiosInstance } from "axios";
import { Prisma } from "@prisma/client";
import { Readable } from "stream";
import { z } from "zod";
import { config } from "../config";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { buildSectionsWhenPresent } from "./audiobookSections";
import {
    buildAudiobookStreamMap,
    resolveAudiobookRange,
    type AudiobookFileSlice,
    type AudiobookStreamMap,
} from "./audiobookStreamMap";

const STREAM_HEADER_TIMEOUT_MS = 30_000;
const AUDIOBOOK_STREAM_MAP_CACHE_TTL_MS = 15 * 60 * 1000;
const AUDIOBOOK_STREAM_MAP_CACHE_MAX_ITEMS = 256;
const MAX_AUDIOBOOK_TRACKS = 10_000;
const UNSAFE_AUDIO_TRACK_URL_ERROR =
    "Audiobookshelf returned an unsafe audio track URL";

const audiobookTrackSchema = z.looseObject({
    contentUrl: z.string().min(1).max(8192),
    mimeType: z.string().min(1).max(255).nullish(),
    metadata: z
        .looseObject({
            size: z.number().int().nonnegative().safe().nullish(),
        })
        .nullish(),
});
const audiobookTracksSchema = z
    .array(audiobookTrackSchema)
    .min(1)
    .max(MAX_AUDIOBOOK_TRACKS);
const contentLengthSchema = z.union([
    z.number().int().nonnegative().safe(),
    z
        .string()
        .regex(/^\d+$/)
        .transform(Number)
        .pipe(z.number().int().nonnegative().safe()),
]);

type AudiobookTrack = Readonly<{
    contentPath: string;
    byteLength?: number;
    mimeType?: string;
}>;

type CachedAudiobookStreamMap = Readonly<{
    fingerprint: string;
    byteLengths: ReadonlyArray<number>;
    contentType?: string;
    expiresAt: number;
}>;

type OpenTrackStream = Readonly<{
    stream: Readable;
    contentType?: string;
    close(): void;
}>;

type RequestController = Readonly<{
    controller: AbortController;
    headersReceived(): void;
    dispose(): void;
}>;

type AudiobookStreamResult = Readonly<{
    stream: Readable;
    headers: Record<string, string>;
    status: number;
}>;

type ResolvedTrackMetadata = Readonly<{
    byteLengths: number[];
    contentType?: string;
}>;

type AudiobookStreamPlan = Readonly<{
    status: 200 | 206 | 416;
    totalBytes: number;
    contentLength: number;
    contentRange?: string;
    slices: ReadonlyArray<AudiobookFileSlice>;
}>;

type PreparedAudiobookStream = Readonly<{
    tracks: ReadonlyArray<AudiobookTrack>;
    metadata: ResolvedTrackMetadata;
    plan: AudiobookStreamPlan;
}>;

type StreamSlicesInput = Readonly<{
    tracks: ReadonlyArray<AudiobookTrack>;
    byteLengths: ReadonlyArray<number>;
    slices: ReadonlyArray<AudiobookFileSlice>;
    firstOpen: OpenTrackStream;
    contentType: string;
    signal: AbortSignal;
    detachDisconnect(): void;
}>;

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

function parseAudiobookTracks(
    payload: unknown,
    baseUrl: string | null,
): AudiobookTrack[] {
    const tracksValue =
        typeof payload === "object" && payload !== null && "media" in payload
            ? (payload as { media?: { tracks?: unknown } }).media?.tracks
            : undefined;
    if (Array.isArray(tracksValue) && tracksValue.length === 0) {
        throw new Error("No audio track found for this audiobook");
    }
    const tracks = audiobookTracksSchema.parse(tracksValue);
    return tracks.map((track) => ({
        contentPath: resolveStreamContentPath(track.contentUrl, baseUrl),
        ...(track.metadata?.size === null || track.metadata?.size === undefined
            ? {}
            : { byteLength: track.metadata.size }),
        ...(track.mimeType ? { mimeType: track.mimeType } : {}),
    }));
}

function streamMapFingerprint(tracks: ReadonlyArray<AudiobookTrack>): string {
    return tracks.map((track) => track.contentPath).join("\u0000");
}

function normalizedContentType(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== ""
        ? value.split(";", 1)[0]?.trim().toLowerCase()
        : undefined;
}

function sliceByteLength(slice: AudiobookFileSlice): number {
    return slice.fileEndByte - slice.fileStartByte + 1;
}

function resolveStreamPlan(
    map: AudiobookStreamMap,
    rangeHeader?: string,
): AudiobookStreamPlan {
    const totalBytes = map.totalBytes();
    const range = rangeHeader
        ? resolveAudiobookRange(rangeHeader, map)
        : undefined;
    if (range?.kind === "unsatisfiable") {
        return {
            status: 416,
            totalBytes,
            contentLength: 0,
            contentRange: `bytes */${totalBytes}`,
            slices: [],
        };
    }
    if (range?.kind === "partial") {
        return {
            status: 206,
            totalBytes,
            contentLength: range.endByte - range.startByte + 1,
            contentRange: `bytes ${range.startByte}-${range.endByte}/${totalBytes}`,
            slices: range.slices,
        };
    }
    return {
        status: 200,
        totalBytes,
        contentLength: totalBytes,
        slices: totalBytes === 0 ? [] : map.resolveRange(0, totalBytes - 1),
    };
}

function streamHeaders(
    plan: AudiobookStreamPlan,
    contentType?: string,
): Record<string, string> {
    return {
        ...(plan.status === 416
            ? {}
            : { "content-type": contentType ?? "audio/mpeg" }),
        "accept-ranges": "bytes",
        "content-length": String(plan.contentLength),
        ...(plan.contentRange ? { "content-range": plan.contentRange } : {}),
    };
}

function abortOnEarlyClose(
    stream: Readable,
    controller: AbortController,
): void {
    stream.once("close", () => {
        if (!stream.readableEnded && !controller.signal.aborted) {
            controller.abort(
                new Error("Audiobook response stream closed early"),
            );
        }
    });
}

function warnOnContentTypeMismatch(
    expectedContentType: string,
    actualContentType: string | undefined,
    fileIndex: number,
): void {
    if (!actualContentType || actualContentType === expectedContentType) return;
    logger
        .child("AudiobookStream")
        .warn("Audiobook track content type differs from the first file", {
            firstContentType: expectedContentType,
            trackContentType: actualContentType,
            fileIndex,
        });
}

function asStreamChunk(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === "string" || value instanceof Uint8Array) {
        return Buffer.from(value);
    }
    throw new Error("Audiobookshelf returned a non-byte stream chunk");
}

async function* readExactStream(
    stream: Readable,
    expectedBytes: number,
): AsyncGenerator<Buffer> {
    let emittedBytes = 0;
    // The byte count bounds this transport-driven loop even though chunking is upstream-owned.
    for await (const value of stream) {
        const chunk = asStreamChunk(value);
        if (emittedBytes + chunk.byteLength > expectedBytes) {
            throw new Error(
                "Audiobookshelf track exceeded its declared byte range",
            );
        }
        emittedBytes += chunk.byteLength;
        yield chunk;
    }
    if (emittedBytes !== expectedBytes) {
        throw new Error(
            "Audiobookshelf track ended before its declared byte range",
        );
    }
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
    private readonly audiobookStreamMapCache = new Map<
        string,
        CachedAudiobookStreamMap
    >();

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

    private createRequestController(
        parentSignal: AbortSignal,
    ): RequestController {
        const controller = new AbortController();
        const abortFromParent = () => controller.abort(parentSignal.reason);
        parentSignal.addEventListener("abort", abortFromParent, { once: true });
        if (parentSignal.aborted) abortFromParent();
        const timeoutId = setTimeout(() => {
            controller.abort(
                new Error(
                    `Audiobookshelf stream headers timed out after ${STREAM_HEADER_TIMEOUT_MS}ms`,
                ),
            );
        }, STREAM_HEADER_TIMEOUT_MS);
        return {
            controller,
            headersReceived: () => clearTimeout(timeoutId),
            dispose: () => {
                clearTimeout(timeoutId);
                parentSignal.removeEventListener("abort", abortFromParent);
            },
        };
    }

    private getCachedStreamMap(
        audiobookId: string,
        fingerprint: string,
    ): CachedAudiobookStreamMap | undefined {
        const cached = this.audiobookStreamMapCache.get(audiobookId);
        if (
            !cached ||
            cached.fingerprint !== fingerprint ||
            cached.expiresAt <= Date.now()
        ) {
            this.audiobookStreamMapCache.delete(audiobookId);
            return undefined;
        }
        this.audiobookStreamMapCache.delete(audiobookId);
        this.audiobookStreamMapCache.set(audiobookId, cached);
        return cached;
    }

    private cacheStreamMap(
        audiobookId: string,
        entry: CachedAudiobookStreamMap,
    ): void {
        this.audiobookStreamMapCache.delete(audiobookId);
        if (
            this.audiobookStreamMapCache.size >=
            AUDIOBOOK_STREAM_MAP_CACHE_MAX_ITEMS
        ) {
            const oldestKey = this.audiobookStreamMapCache.keys().next().value;
            if (typeof oldestKey === "string") {
                this.audiobookStreamMapCache.delete(oldestKey);
            }
        }
        this.audiobookStreamMapCache.set(audiobookId, entry);
    }

    private async headTrack(
        track: AudiobookTrack,
        parentSignal: AbortSignal,
    ): Promise<{ byteLength: number; contentType?: string }> {
        const request = this.createRequestController(parentSignal);
        try {
            const response = await this.client!.head(track.contentPath, {
                allowAbsoluteUrls: false,
                timeout: STREAM_HEADER_TIMEOUT_MS,
                signal: request.controller.signal,
                validateStatus: (status) => status >= 200 && status < 300,
            });
            request.headersReceived();
            return {
                byteLength: contentLengthSchema.parse(
                    response.headers["content-length"],
                ),
                ...(normalizedContentType(response.headers["content-type"])
                    ? {
                          contentType: normalizedContentType(
                              response.headers["content-type"],
                          ),
                      }
                    : {}),
            };
        } finally {
            request.dispose();
        }
    }

    private async resolveTrackMetadata(
        audiobookId: string,
        tracks: ReadonlyArray<AudiobookTrack>,
        signal: AbortSignal,
    ): Promise<ResolvedTrackMetadata> {
        const fingerprint = streamMapFingerprint(tracks);
        const cached = this.getCachedStreamMap(audiobookId, fingerprint);
        const byteLengths = tracks.map(
            (track, index) => track.byteLength ?? cached?.byteLengths[index],
        );
        let contentType =
            normalizedContentType(tracks[0]?.mimeType) ?? cached?.contentType;
        for (let index = 0; index < tracks.length; index += 1) {
            const track = tracks[index];
            if (!track) throw new Error("Audiobook track index is missing");
            const needsType = index === 0 && contentType === undefined;
            if (byteLengths[index] !== undefined && !needsType) continue;
            const head = await this.headTrack(track, signal);
            byteLengths[index] ??= head.byteLength;
            if (needsType) contentType = head.contentType;
        }
        const resolvedLengths = z
            .array(z.number().int().nonnegative().safe())
            .length(tracks.length)
            .parse(byteLengths);
        this.cacheStreamMap(audiobookId, {
            fingerprint,
            byteLengths: resolvedLengths,
            ...(contentType ? { contentType } : {}),
            expiresAt: Date.now() + AUDIOBOOK_STREAM_MAP_CACHE_TTL_MS,
        });
        return {
            byteLengths: resolvedLengths,
            ...(contentType ? { contentType } : {}),
        };
    }

    private async openTrackStream(
        track: AudiobookTrack,
        fileByteLength: number,
        slice: AudiobookFileSlice,
        parentSignal: AbortSignal,
    ): Promise<OpenTrackStream> {
        const request = this.createRequestController(parentSignal);
        const isFullFile =
            slice.fileStartByte === 0 &&
            slice.fileEndByte === fileByteLength - 1;
        try {
            const response = await this.client!.get(track.contentPath, {
                allowAbsoluteUrls: false,
                responseType: "stream",
                timeout: STREAM_HEADER_TIMEOUT_MS,
                signal: request.controller.signal,
                headers: isFullFile
                    ? {}
                    : {
                          Range: `bytes=${slice.fileStartByte}-${slice.fileEndByte}`,
                      },
                validateStatus: (status) => status >= 200 && status < 300,
            });
            request.headersReceived();
            if (!isFullFile && response.status !== 206) {
                throw new Error("Audiobookshelf ignored a track byte range");
            }
            if (!(response.data instanceof Readable)) {
                throw new Error(
                    "Audiobookshelf track response is not readable",
                );
            }
            return this.manageOpenTrack(
                response.data,
                response.headers["content-type"],
                request,
                parentSignal,
            );
        } catch (error) {
            request.dispose();
            throw error;
        }
    }

    private manageOpenTrack(
        stream: Readable,
        contentType: unknown,
        request: RequestController,
        parentSignal: AbortSignal,
    ): OpenTrackStream {
        const destroyOnAbort = () => stream.destroy(parentSignal.reason);
        parentSignal.addEventListener("abort", destroyOnAbort, { once: true });
        if (parentSignal.aborted) destroyOnAbort();
        return {
            stream,
            contentType: normalizedContentType(contentType),
            close: () => {
                parentSignal.removeEventListener("abort", destroyOnAbort);
                stream.destroy();
                request.dispose();
            },
        };
    }

    private async openSlice(
        input: StreamSlicesInput,
        slice: AudiobookFileSlice,
        index: number,
    ): Promise<OpenTrackStream> {
        if (index === 0) return input.firstOpen;
        const track = input.tracks[slice.fileIndex];
        const byteLength = input.byteLengths[slice.fileIndex];
        if (!track || byteLength === undefined) {
            throw new Error("Audiobook stream map references a missing track");
        }
        return this.openTrackStream(track, byteLength, slice, input.signal);
    }

    private async *streamSlices(
        input: StreamSlicesInput,
    ): AsyncGenerator<Buffer> {
        try {
            for (let index = 0; index < input.slices.length; index += 1) {
                const slice = input.slices[index];
                if (!slice)
                    throw new Error("Audiobook stream slice is missing");
                const opened = await this.openSlice(input, slice, index);
                try {
                    warnOnContentTypeMismatch(
                        input.contentType,
                        opened.contentType,
                        slice.fileIndex,
                    );
                    yield* readExactStream(
                        opened.stream,
                        sliceByteLength(slice),
                    );
                } finally {
                    opened.close();
                }
            }
        } finally {
            input.detachDisconnect();
        }
    }

    private async prepareAudiobookStream(
        audiobookId: string,
        rangeHeader: string | undefined,
        signal: AbortSignal,
    ): Promise<PreparedAudiobookStream> {
        const payload = await this.getAudiobook(audiobookId, signal);
        const tracks = parseAudiobookTracks(payload, this.baseUrl);
        const metadata = await this.resolveTrackMetadata(
            audiobookId,
            tracks,
            signal,
        );
        const map = buildAudiobookStreamMap(
            metadata.byteLengths.map((byteLength, index) => ({
                index,
                byteLength,
            })),
        );
        return {
            tracks,
            metadata,
            plan: resolveStreamPlan(map, rangeHeader),
        };
    }

    private async createAudiobookStreamResult(
        prepared: PreparedAudiobookStream,
        controller: AbortController,
        detachDisconnect: () => void,
    ): Promise<AudiobookStreamResult> {
        const firstSlice = prepared.plan.slices[0];
        if (!firstSlice) {
            detachDisconnect();
            return {
                stream: Readable.from([]),
                status: prepared.plan.status,
                headers: streamHeaders(
                    prepared.plan,
                    prepared.metadata.contentType,
                ),
            };
        }
        const firstTrack = prepared.tracks[firstSlice.fileIndex];
        const firstLength = prepared.metadata.byteLengths[firstSlice.fileIndex];
        if (!firstTrack || firstLength === undefined) {
            throw new Error("Audiobook first stream slice is invalid");
        }
        const firstOpen = await this.openTrackStream(
            firstTrack,
            firstLength,
            firstSlice,
            controller.signal,
        );
        // One book is one resource. Mixed containers keep the first file's type.
        const contentType =
            prepared.metadata.contentType ??
            (firstSlice.fileIndex === 0 ? firstOpen.contentType : undefined) ??
            "audio/mpeg";
        const stream = Readable.from(
            this.streamSlices({
                tracks: prepared.tracks,
                byteLengths: prepared.metadata.byteLengths,
                slices: prepared.plan.slices,
                firstOpen,
                contentType,
                signal: controller.signal,
                detachDisconnect,
            }),
        );
        abortOnEarlyClose(stream, controller);
        return {
            stream,
            status: prepared.plan.status,
            headers: streamHeaders(prepared.plan, contentType),
        };
    }

    /** Stream all audiobook tracks as one byte-addressable readable stream. */
    async streamAudiobook(
        audiobookId: string,
        rangeHeader?: string,
        lifecycle?: StreamAcquisitionLifecycle,
    ): Promise<AudiobookStreamResult> {
        const sessionController = new AbortController();
        const detachDisconnect = lifecycle
            ? bindStreamDisconnect(lifecycle, sessionController)
            : () => undefined;
        try {
            await this.ensureInitialized();
            const prepared = await this.prepareAudiobookStream(
                audiobookId,
                rangeHeader,
                sessionController.signal,
            );
            return await this.createAudiobookStreamResult(
                prepared,
                sessionController,
                detachDisconnect,
            );
        } catch (error) {
            detachDisconnect();
            if (sessionController.signal.aborted) {
                throw sessionController.signal.reason;
            }
            throw error;
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

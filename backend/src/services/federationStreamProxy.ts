import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import {
    createFederationClient,
    FederationHttpError,
} from "./federationClient";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { config } from "../config";
import {
    AudioStreamingService,
    FederatedCacheCapacityError,
    type FederatedStreamSource,
    type Quality,
} from "./audioStreaming";
import {
    recordFederationStreamProxy,
    recordFederationStreamProxyCache,
    type FederationStreamOutcome,
} from "../metrics";
import { safeFederationErrorMessage } from "./federationPeerHealth";

const log = logger.child("FederationStreamProxy");
const PASSTHROUGH_HEADERS = [
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
] as const;

interface FederationStreamPeer {
    id: string;
    baseUrl: string | null;
    outboundToken: string | null;
}

interface FederationStreamInput {
    req: Request;
    res: Response;
    peer: FederationStreamPeer;
    remoteId: string;
    trackId: string;
    sourceModified: Date;
    sourceMime: string | null;
    quality: Quality;
}

function copyResponseHeaders(
    res: Response,
    headers: Record<string, unknown>,
): void {
    for (let index = 0; index < PASSTHROUGH_HEADERS.length; index += 1) {
        const name = PASSTHROUGH_HEADERS[index];
        const value = headers[name];
        if (typeof value === "string" || typeof value === "number") {
            res.setHeader(name, String(value));
        }
    }
}

function parseContentLength(headers: Record<string, unknown>): number | null {
    const value = headers["content-length"];
    const parsed =
        typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number(value)
              : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function markPeerOffline(peerId: string, error: unknown): Promise<void> {
    const lastError = safeFederationErrorMessage(error);
    const lastErrorAt = new Date();
    try {
        const result = await prisma.federationPeer.updateMany({
            where: { id: peerId, outboundStatus: "ACTIVE" },
            data: {
                outboundStatus: "OFFLINE",
                lastError,
                lastErrorAt,
            },
        });
        if (result.count === 1) {
            log.info(`peerId=${peerId} status=OFFLINE previous=ACTIVE`);
            return;
        }
        await prisma.federationPeer.updateMany({
            where: { id: peerId, outboundStatus: { not: "REVOKED" } },
            data: { lastError, lastErrorAt },
        });
    } catch (cause) {
        log.warn("Failed to persist federation peer stream diagnostic", {
            peerId,
            cause,
        });
    }
}

async function loadPeerStream(
    input: FederationStreamInput,
    range: string | undefined,
    signal: AbortSignal,
): Promise<{
    status: number;
    headers: Record<string, unknown>;
    data: Readable;
}> {
    const response = await createFederationClient(input.peer, {
        allowPrivatePeers: config.federation.allowPrivatePeers,
    }).getStream({
        remoteId: input.remoteId,
        quality: input.quality,
        range,
        signal,
    });
    if (!(response.data instanceof Readable)) {
        throw new Error("Federation stream response is not readable");
    }
    return {
        status: response.status,
        headers: response.headers,
        data: response.data,
    };
}

async function proxyRangeMiss(
    input: FederationStreamInput,
    signal: AbortSignal,
    state: ProxyStreamState,
): Promise<void> {
    const range = input.req.headers.range;
    const response = await loadPeerStream(
        input,
        typeof range === "string" ? range : undefined,
        signal,
    );
    state.upstream = response.data;
    input.res.status(response.status);
    copyResponseHeaders(input.res, response.headers);
    await pipeline(response.data, input.res);
}

interface ProxyStreamState {
    upstream: Readable | null;
}

async function passthroughPeerStream(
    input: FederationStreamInput,
    source: {
        status: number;
        headers?: Record<string, unknown>;
        stream: Readable;
    },
): Promise<void> {
    input.res.status(source.status);
    copyResponseHeaders(input.res, source.headers ?? {});
    await pipeline(source.stream, input.res);
}

async function loadPeerStreamSource(
    input: FederationStreamInput,
    signal: AbortSignal,
    state: ProxyStreamState,
    fallbackMime: string,
): Promise<FederatedStreamSource> {
    const response = await loadPeerStream(input, undefined, signal);
    state.upstream = response.data;
    const contentType = response.headers["content-type"];
    return {
        stream: response.data,
        mimeType: typeof contentType === "string" ? contentType : fallbackMime,
        status: response.status,
        contentLength: parseContentLength(response.headers),
        headers: response.headers,
    };
}

async function cacheOrReloadPeerStream(
    input: FederationStreamInput,
    service: AudioStreamingService,
    signal: AbortSignal,
    state: ProxyStreamState,
    fallbackMime: string,
) {
    try {
        return await service.cacheFederatedStream(
            input.trackId,
            input.quality,
            input.sourceModified,
            fallbackMime,
            () => loadPeerStreamSource(input, signal, state, fallbackMime),
        );
    } catch (error) {
        if (!(error instanceof FederatedCacheCapacityError)) throw error;
        log.debug(
            "Federated stream cache capacity exceeded; retrying uncached",
            { peerId: input.peer.id, trackId: input.trackId },
        );
        return loadPeerStreamSource(input, signal, state, fallbackMime);
    }
}

async function serveFederatedStream(
    input: FederationStreamInput,
    service: AudioStreamingService,
    signal: AbortSignal,
    state: ProxyStreamState,
): Promise<void> {
    const fallbackMime =
        input.quality === "original"
            ? (input.sourceMime ?? "audio/mpeg")
            : "audio/mpeg";
    const cached = await service.getCachedFederatedStreamFilePath(
        input.trackId,
        input.quality,
        fallbackMime,
    );
    if (cached) {
        recordFederationStreamProxyCache(input.peer.id, "hit");
        await service.streamFileWithRangeSupport(
            input.req,
            input.res,
            cached.filePath,
            cached.mimeType,
        );
        return;
    }
    recordFederationStreamProxyCache(input.peer.id, "miss");
    if (typeof input.req.headers.range === "string") {
        await proxyRangeMiss(input, signal, state);
        return;
    }
    const complete = await cacheOrReloadPeerStream(
        input,
        service,
        signal,
        state,
        fallbackMime,
    );
    if ("stream" in complete) {
        await passthroughPeerStream(input, complete);
        return;
    }
    await service.streamFileWithRangeSupport(
        input.req,
        input.res,
        complete.filePath,
        complete.mimeType,
    );
}

function proxyOutcome(
    error: unknown,
    disconnected: boolean,
    statusCode: number,
): FederationStreamOutcome {
    if (disconnected) return "aborted";
    if (error instanceof FederationHttpError) {
        if (error.status !== null && error.status >= 500) return "http_5xx";
        if (error.status !== null && error.status >= 400) return "http_4xx";
        return error.transient ? "timeout" : "error";
    }
    if (statusCode >= 500) return "http_5xx";
    if (statusCode >= 400) return "http_4xx";
    return error ? "error" : "ok";
}

/** Proxies one federated audio response with backpressure and abort propagation. */
export async function proxyFederatedTrackStream(input: {
    req: Request;
    res: Response;
    peer: FederationStreamPeer;
    remoteId: string;
    trackId: string;
    sourceModified: Date;
    sourceMime: string | null;
    quality: Quality;
}): Promise<void> {
    const streamInput: FederationStreamInput = input;
    const controller = new AbortController();
    const startedAt = process.hrtime.bigint();
    const state: ProxyStreamState = { upstream: null };
    let disconnected = false;
    let outcome: FederationStreamOutcome = "ok";
    const service = new AudioStreamingService(
        config.music.musicPath,
        config.music.transcodeCachePath,
        config.music.transcodeCacheMaxGb,
    );
    const onDisconnect = () => {
        if (input.res.writableEnded) return;
        disconnected = true;
        controller.abort();
        state.upstream?.destroy();
    };
    input.req.once("aborted", onDisconnect);
    input.res.once("close", onDisconnect);
    try {
        await serveFederatedStream(
            streamInput,
            service,
            controller.signal,
            state,
        );
    } catch (error) {
        outcome = proxyOutcome(error, disconnected, input.res.statusCode);
        if (disconnected) return;
        if (error instanceof FederationHttpError && error.transient) {
            await markPeerOffline(input.peer.id, error);
        }
        throw error;
    } finally {
        outcome =
            proxyOutcome(null, disconnected, input.res.statusCode) === "ok"
                ? outcome
                : proxyOutcome(null, disconnected, input.res.statusCode);
        recordFederationStreamProxy(
            input.peer.id,
            outcome,
            Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
        );
        input.req.off("aborted", onDisconnect);
        input.res.off("close", onDisconnect);
        state.upstream?.destroy();
        service.destroy();
    }
}

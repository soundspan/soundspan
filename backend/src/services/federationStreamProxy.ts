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
import { AudioStreamingService, type Quality } from "./audioStreaming";

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

async function markPeerOffline(peerId: string): Promise<void> {
    const result = await prisma.federationPeer.updateMany({
        where: { id: peerId, outboundStatus: "ACTIVE" },
        data: { outboundStatus: "OFFLINE" },
    });
    if (result.count === 1) {
        log.info(`peerId=${peerId} status=OFFLINE previous=ACTIVE`);
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
    const response = await createFederationClient(input.peer).getStream({
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
): Promise<Readable> {
    const range = input.req.headers.range;
    const response = await loadPeerStream(
        input,
        typeof range === "string" ? range : undefined,
        signal,
    );
    input.res.status(response.status);
    copyResponseHeaders(input.res, response.headers);
    await pipeline(response.data, input.res);
    return response.data;
}

interface ProxyStreamState {
    upstream: Readable | null;
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
        await service.streamFileWithRangeSupport(
            input.req,
            input.res,
            cached.filePath,
            cached.mimeType,
        );
        return;
    }
    if (typeof input.req.headers.range === "string") {
        state.upstream = await proxyRangeMiss(input, signal);
        return;
    }
    const complete = await service.cacheFederatedStream(
        input.trackId,
        input.quality,
        input.sourceModified,
        fallbackMime,
        async () => {
            const response = await loadPeerStream(input, undefined, signal);
            state.upstream = response.data;
            const contentType = response.headers["content-type"];
            return {
                stream: response.data,
                mimeType:
                    typeof contentType === "string"
                        ? contentType
                        : fallbackMime,
            };
        },
    );
    await service.streamFileWithRangeSupport(
        input.req,
        input.res,
        complete.filePath,
        complete.mimeType,
    );
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
    const state: ProxyStreamState = { upstream: null };
    let disconnected = false;
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
        if (disconnected) return;
        if (error instanceof FederationHttpError && error.transient) {
            await markPeerOffline(input.peer.id);
        }
        throw error;
    } finally {
        input.req.off("aborted", onDisconnect);
        input.res.off("close", onDisconnect);
        state.upstream?.destroy();
        service.destroy();
    }
}

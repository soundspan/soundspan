import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    createFederationClient,
    FederationHttpError,
} from "./federationClient";

const log = logger.child("FederationAudiobookProxy");
const AUDIO_HEADERS = [
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
] as const;
const COVER_HEADERS = [
    "content-type",
    "content-length",
    "etag",
    "cache-control",
] as const;

interface AudiobookPeer {
    id: string;
    baseUrl: string | null;
    outboundToken: string | null;
}

function copyHeaders(
    res: Response,
    headers: Record<string, unknown>,
    names: readonly string[],
): void {
    for (const name of names) {
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

function bindDisconnect(
    req: Request,
    res: Response,
    controller: AbortController,
    getUpstream: () => Readable | null,
): () => void {
    const disconnect = () => {
        if (res.writableEnded) return;
        controller.abort();
        getUpstream()?.destroy();
    };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    return () => {
        req.off("aborted", disconnect);
        res.off("close", disconnect);
    };
}

/** Proxies a peer-owned audiobook stream with Range and abort passthrough. */
export async function proxyFederatedAudiobookStream(input: {
    req: Request;
    res: Response;
    peer: AudiobookPeer;
    remoteId: string;
}): Promise<void> {
    const controller = new AbortController();
    let upstream: Readable | null = null;
    const detach = bindDisconnect(
        input.req,
        input.res,
        controller,
        () => upstream,
    );
    try {
        const range = input.req.headers.range;
        const response = await createFederationClient(
            input.peer,
        ).getAudiobookStream({
            remoteId: input.remoteId,
            range: typeof range === "string" ? range : undefined,
            signal: controller.signal,
        });
        if (!(response.data instanceof Readable)) {
            throw new Error("Federation audiobook response is not readable");
        }
        upstream = response.data;
        input.res.status(response.status);
        copyHeaders(input.res, response.headers, AUDIO_HEADERS);
        if (!input.res.hasHeader("accept-ranges")) {
            input.res.setHeader("accept-ranges", "bytes");
        }
        await pipeline(upstream, input.res);
    } catch (error) {
        if (error instanceof FederationHttpError && error.transient) {
            await markPeerOffline(input.peer.id);
        }
        throw error;
    } finally {
        detach();
        upstream?.destroy();
    }
}

/** Proxies a peer-owned audiobook cover without exposing its credential. */
export async function proxyFederatedAudiobookCover(input: {
    req: Request;
    res: Response;
    peer: AudiobookPeer;
    remoteId: string;
}): Promise<boolean> {
    const controller = new AbortController();
    let upstream: Readable | null = null;
    const detach = bindDisconnect(
        input.req,
        input.res,
        controller,
        () => upstream,
    );
    try {
        const response = await createFederationClient(
            input.peer,
        ).getAudiobookCover(input.remoteId, controller.signal);
        if (response.status === 404) {
            if (response.data instanceof Readable) response.data.destroy();
            return false;
        }
        copyHeaders(input.res, response.headers, COVER_HEADERS);
        if (response.status === 304) {
            input.res.status(304).end();
            return true;
        }
        if (!(response.data instanceof Readable)) {
            throw new Error("Federation audiobook cover is not readable");
        }
        upstream = response.data;
        input.res.status(200);
        await pipeline(upstream, input.res);
        return true;
    } catch (error) {
        if (error instanceof FederationHttpError && error.transient) {
            await markPeerOffline(input.peer.id);
        }
        throw error;
    } finally {
        detach();
        upstream?.destroy();
    }
}

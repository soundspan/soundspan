import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import {
    createFederationClient,
    FederationHttpError,
} from "./federationClient";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

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
        where: { id: peerId, status: "ACTIVE" },
        data: { status: "OFFLINE" },
    });
    if (result.count === 1) {
        log.info(`peerId=${peerId} status=OFFLINE previous=ACTIVE`);
    }
}

/** Proxies one federated audio response with backpressure and abort propagation. */
export async function proxyFederatedTrackStream(input: {
    req: Request;
    res: Response;
    peer: FederationStreamPeer;
    remoteId: string;
    quality: string;
}): Promise<void> {
    const controller = new AbortController();
    let upstream: Readable | null = null;
    let disconnected = false;
    const onDisconnect = () => {
        if (input.res.writableEnded) return;
        disconnected = true;
        controller.abort();
        upstream?.destroy();
    };
    input.req.once("aborted", onDisconnect);
    input.res.once("close", onDisconnect);
    try {
        const response = await createFederationClient(input.peer).getStream({
            remoteId: input.remoteId,
            quality: input.quality,
            range:
                typeof input.req.headers.range === "string"
                    ? input.req.headers.range
                    : undefined,
            signal: controller.signal,
        });
        if (!(response.data instanceof Readable)) {
            throw new Error("Federation stream response is not readable");
        }
        upstream = response.data;
        input.res.status(response.status);
        copyResponseHeaders(input.res, response.headers);
        await pipeline(upstream, input.res);
    } catch (error) {
        if (disconnected) return;
        if (error instanceof FederationHttpError && error.transient) {
            await markPeerOffline(input.peer.id);
        }
        throw error;
    } finally {
        input.req.off("aborted", onDisconnect);
        input.res.off("close", onDisconnect);
        upstream?.destroy();
    }
}

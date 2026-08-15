import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { createFederationClient } from "./federationClient";

const COVER_HEADERS = [
    "content-type",
    "content-length",
    "etag",
    "cache-control",
] as const;

function copyCoverHeaders(
    res: Response,
    headers: Record<string, unknown>,
): void {
    for (let index = 0; index < COVER_HEADERS.length; index += 1) {
        const name = COVER_HEADERS[index];
        const value = headers[name];
        if (typeof value === "string" || typeof value === "number") {
            res.setHeader(name, String(value));
        }
    }
}

/** Streams a peer-owned album cover without exposing its credential. */
export async function proxyFederatedCover(input: {
    req: Request;
    res: Response;
    peer: {
        id: string;
        baseUrl: string | null;
        outboundToken: string | null;
        outboundStatus: string | null;
    };
    remoteId: string;
}): Promise<boolean> {
    const controller = new AbortController();
    let upstream: Readable | null = null;
    const onDisconnect = () => {
        if (input.res.writableEnded) return;
        controller.abort();
        upstream?.destroy();
    };
    input.req.once("aborted", onDisconnect);
    input.res.once("close", onDisconnect);
    try {
        const response = await createFederationClient(input.peer).getCover(
            input.remoteId,
            controller.signal,
        );
        if (response.status === 404) {
            const body = response.data as { destroy?: () => void };
            body.destroy?.();
            return false;
        }
        copyCoverHeaders(input.res, response.headers);
        if (response.status === 304) {
            input.res.status(304).end();
            return true;
        }
        if (!(response.data instanceof Readable)) {
            throw new Error("Federation cover response is not readable");
        }
        upstream = response.data;
        input.res.status(200);
        await pipeline(upstream, input.res);
        return true;
    } finally {
        input.req.off("aborted", onDisconnect);
        input.res.off("close", onDisconnect);
        upstream?.destroy();
    }
}

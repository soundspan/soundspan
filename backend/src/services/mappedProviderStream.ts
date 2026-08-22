import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { PeerPlaybackFallback } from "./peerPlaybackFallback";

const FORWARDED_STREAM_HEADERS = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
] as const;

/** Observable response state after a mapped provider attempt. */
export interface MappedProviderResponseState {
    headersSent: boolean;
    destroyed: boolean;
    writableEnded: boolean;
}

/** Result of one mapped provider stream attempt. */
export type MappedProviderStreamResult =
    | { status: "served" }
    | { status: "unavailable" }
    | {
          status: "failed";
          failure: unknown;
          responseState: MappedProviderResponseState;
      };

/** Reports whether a response can still accept a fallback or error body. */
export function mappedProviderResponseState(
    res: Response,
): MappedProviderResponseState {
    return {
        headersSent: res.headersSent,
        destroyed: res.destroyed,
        writableEnded: res.writableEnded,
    };
}

/** Returns whether no further response write is safe. */
export function isMappedProviderResponseUnusable(
    state: MappedProviderResponseState,
): boolean {
    return state.headersSent || state.destroyed || state.writableEnded;
}

function forwardStreamHeaders(
    res: Response,
    headers: Record<string, unknown>,
): void {
    for (let index = 0; index < FORWARDED_STREAM_HEADERS.length; index += 1) {
        const name = FORWARDED_STREAM_HEADERS[index];
        const value = headers[name];
        if (typeof value === "string" || typeof value === "number") {
            res.setHeader(name, String(value));
        }
    }
}

/** Proxies one already-mapped provider fallback through its bounded sidecar call. */
export async function serveMappedProviderStream(input: {
    req: Request;
    res: Response;
    userId: string;
    youtubeUserId?: string;
    quality: string;
    fallback: PeerPlaybackFallback;
}): Promise<MappedProviderStreamResult> {
    const range =
        typeof input.req.headers.range === "string"
            ? input.req.headers.range
            : undefined;
    try {
        let response = null;
        if (input.fallback.source === "tidal") {
            const { tidalStreamingService } = await import("./tidalStreaming");
            response = await tidalStreamingService.getStreamProxy(
                input.userId,
                input.fallback.tidalTrackId,
                input.quality,
                range,
            );
        } else if (input.fallback.source === "ytmusic") {
            const { ytMusicService } = await import("./youtubeMusic");
            response = await ytMusicService.getStreamProxy(
                input.youtubeUserId ?? "__public__",
                input.fallback.youtubeVideoId,
                input.quality,
                range,
            );
        }
        if (!response) return { status: "unavailable" };
        input.res.status(response.status);
        forwardStreamHeaders(input.res, response.headers);
        await pipeline(response.data, input.res);
        return { status: "served" };
    } catch (error) {
        return {
            status: "failed",
            failure: error,
            responseState: mappedProviderResponseState(input.res),
        };
    }
}

/** Terminates a stream whose HTTP headers were already committed. */
export function terminateCommittedStream(res: Response): void {
    if (res.destroyed || res.writableEnded) return;
    if (typeof res.destroy === "function") {
        res.destroy();
        return;
    }
    res.end();
}

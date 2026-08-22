import type { Request, Response } from "express";
import { proxyFederatedTrackStream } from "../../services/federationStreamProxy";
import { loadPeerPlaybackFallback } from "../../services/peerPlaybackFallback";
import {
    isMappedProviderResponseUnusable,
    mappedProviderResponseState,
    serveMappedProviderStream,
    terminateCommittedStream,
} from "../../services/mappedProviderStream";
import { normalizeStreamingQuality } from "../../utils/libraryAudioInfo";
import { TRACK_VISIBLE_WHERE } from "../../utils/librarySorting";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { sendRouteError } from "../routeErrorResponse";

const log = logger.child("LibraryPeerStream");

interface LibraryPeerStreamInput {
    req: Request<{ id: string }>;
    res: Response;
    peer: {
        id: string;
        baseUrl: string;
        outboundToken: string;
    };
    remoteId: string;
    trackId: string;
    sourceModified: Date;
    sourceMime: string | null;
    requestedQuality: string;
}

/** Proxies the peer stream and reports whether a response was completed. */
export async function proxyLibraryPeerStream(
    input: LibraryPeerStreamInput,
): Promise<boolean> {
    try {
        await proxyFederatedTrackStream({
            req: input.req,
            res: input.res,
            peer: input.peer,
            remoteId: input.remoteId,
            trackId: input.trackId,
            sourceModified: input.sourceModified,
            sourceMime: input.sourceMime,
            quality:
                normalizeStreamingQuality(input.requestedQuality) ?? "medium",
        });
        return true;
    } catch (error) {
        log.warn("Federated stream proxy failed", { error });
        const state = mappedProviderResponseState(input.res);
        if (!isMappedProviderResponseUnusable(state)) return false;
        if (!state.destroyed && !state.writableEnded) {
            terminateCommittedStream(input.res);
        }
        return true;
    }
}

/** Applies the peer fallback policy, serving providers or returning a local twin. */
export async function applyLibraryPeerFallback(input: {
    req: Request<{ id: string }>;
    res: Response;
    userId: string;
    trackId: string;
    quality: string;
}) {
    const fallbacks = await loadPeerPlaybackFallback(input.trackId);
    let youtubeUserId: string | undefined;
    for (let index = 0; index < 3; index += 1) {
        const fallback = fallbacks[index];
        if (!fallback) break;
        if (fallback.source === "library") {
            const track = await prisma.track.findUnique({
                where: { id: fallback.trackId, ...TRACK_VISIBLE_WHERE },
            });
            if (track) return track;
            continue;
        }
        if (fallback.source === "ytmusic" && youtubeUserId === undefined) {
            youtubeUserId = await import("../youtubeMusic").then((mod) =>
                mod.getUserIdOrPublic(input.userId),
            );
        }
        const result = await serveMappedProviderStream({
            ...input,
            youtubeUserId,
            fallback,
        });
        if (result.status === "served") return null;
        if (result.status !== "failed") continue;
        log.warn("Mapped peer fallback failed", { error: result.failure });
        if (isMappedProviderResponseUnusable(result.responseState)) {
            if (
                !result.responseState.destroyed &&
                !result.responseState.writableEnded
            ) {
                terminateCommittedStream(input.res);
            }
            return null;
        }
    }
    const state = mappedProviderResponseState(input.res);
    if (!isMappedProviderResponseUnusable(state)) sendPeerOffline(input.res);
    return null;
}

function sendPeerOffline(res: Response): void {
    sendRouteError(res, 503, "Federation peer is offline", {
        code: "PEER_OFFLINE",
    });
}

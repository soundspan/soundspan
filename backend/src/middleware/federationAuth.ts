import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sendRouteError } from "../routes/routeErrorResponse";
import {
    parseFederationScopes,
    type FederationScope,
} from "../utils/federationScopes";
import { hashApiKey } from "../utils/apiKeyHash";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const authLogger = logger.child("FederationAuth");
const LAST_SEEN_THROTTLE_MS = 60_000;
const RAW_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

declare global {
    namespace Express {
        interface Request {
            federationPeer?: {
                id: string;
                name: string;
                scopes: string[];
                maxConcurrentStreams: number | null;
                maxStreamKbps: number | null;
            };
        }
    }
}

type AuthPeer = {
    id: string;
    name: string;
    direction: string;
    scopes: FederationScope[];
    inboundStatus: string | null;
    lastSeenAt: Date | null;
    maxConcurrentStreams: number | null;
    maxStreamKbps: number | null;
};

function bearerToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice(7);
    return RAW_TOKEN_PATTERN.test(token) ? token : null;
}

async function resolvePeer(token: string): Promise<AuthPeer | null> {
    const peer = await prisma.federationPeer.findUnique({
        where: { credentialHash: hashApiKey(token) },
        select: {
            id: true,
            name: true,
            direction: true,
            scopes: true,
            inboundStatus: true,
            lastSeenAt: true,
            maxConcurrentStreams: true,
            maxStreamKbps: true,
        },
    });
    if (!peer) return null;
    const scopes = parseFederationScopes(peer.scopes);
    return scopes ? { ...peer, scopes } : null;
}

async function updateLastSeen(peer: AuthPeer, now: Date): Promise<void> {
    const staleBefore = new Date(now.getTime() - LAST_SEEN_THROTTLE_MS);
    if (peer.lastSeenAt && peer.lastSeenAt >= staleBefore) return;
    try {
        await prisma.federationPeer.updateMany({
            where: {
                id: peer.id,
                OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: staleBefore } }],
            },
            data: { lastSeenAt: now },
        });
    } catch (error: unknown) {
        authLogger.debug("Failed to update federation peer lastSeenAt", error);
    }
}

function hasScopes(peer: AuthPeer, required: FederationScope[]): boolean {
    return required.every((scope) => peer.scopes.includes(scope));
}

/** Authenticates an active peer and enforces every requested federation scope. */
export function requireFederationPeer(
    ...requiredScopes: FederationScope[]
): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
        const token = bearerToken(req);
        const peer = token ? await resolvePeer(token) : null;
        if (
            !peer ||
            !["HOST", "BOTH"].includes(peer.direction) ||
            peer.inboundStatus !== "ACTIVE"
        ) {
            return sendRouteError(
                res,
                401,
                "Federation peer authentication required",
            );
        }
        if (!hasScopes(peer, requiredScopes)) {
            return sendRouteError(res, 403, "Federation peer scope required");
        }
        req.federationPeer = {
            id: peer.id,
            name: peer.name,
            scopes: peer.scopes,
            maxConcurrentStreams: peer.maxConcurrentStreams,
            maxStreamKbps: peer.maxStreamKbps,
        };
        await updateLastSeen(peer, new Date());
        return next();
    };
}

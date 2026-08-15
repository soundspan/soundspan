import { createFederationClient } from "../../services/federationClient";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";

const log = logger.child("FederationHealthProcessor");
const MAX_CONSUMER_PEERS = 500;

interface HealthCounts {
    checked: number;
    online: number;
    offline: number;
}

async function markPeerActive(peer: {
    id: string;
    status: string;
}): Promise<void> {
    await prisma.federationPeer.updateMany({
        where: { id: peer.id, status: { not: "REVOKED" } },
        data: { status: "ACTIVE", lastSeenAt: new Date() },
    });
    if (peer.status !== "ACTIVE") {
        log.info(`peerId=${peer.id} status=ACTIVE previous=${peer.status}`);
    }
}

async function markPeerOffline(peer: {
    id: string;
    status: string;
}): Promise<void> {
    await prisma.federationPeer.updateMany({
        where: { id: peer.id, status: { not: "REVOKED" } },
        data: { status: "OFFLINE" },
    });
    if (peer.status !== "OFFLINE") {
        log.info(`peerId=${peer.id} status=OFFLINE previous=${peer.status}`);
    }
}

/** Pings every bounded consumer peer and records only status transitions. */
export async function processFederationHealth(): Promise<HealthCounts> {
    const peers = await prisma.federationPeer.findMany({
        where: {
            direction: { in: ["CONSUMER", "BOTH"] },
            status: { not: "REVOKED" },
            baseUrl: { not: null },
            outboundToken: { not: null },
        },
        take: MAX_CONSUMER_PEERS,
        orderBy: { id: "asc" },
        select: {
            id: true,
            baseUrl: true,
            outboundToken: true,
            status: true,
        },
    });
    const counts: HealthCounts = { checked: 0, online: 0, offline: 0 };
    for (let index = 0; index < MAX_CONSUMER_PEERS; index += 1) {
        const peer = peers[index];
        if (!peer) break;
        counts.checked += 1;
        try {
            await createFederationClient(peer).getManifest();
            await markPeerActive(peer);
            counts.online += 1;
        } catch (_error: unknown) {
            await markPeerOffline(peer);
            counts.offline += 1;
        }
    }
    return counts;
}

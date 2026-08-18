import { createFederationClient } from "../../services/federationClient";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";

const log = logger.child("FederationHealthProcessor");
const MAX_CONSUMER_PEERS = 500;

interface HealthCounts {
    checked: number;
    online: number;
    offline: number;
}

async function markPeerActive(
    peer: {
        id: string;
        outboundStatus: string | null;
    },
    capabilities: readonly string[],
): Promise<void> {
    await prisma.federationPeer.updateMany({
        where: { id: peer.id, outboundStatus: { not: "REVOKED" } },
        data: {
            outboundStatus: "ACTIVE",
            lastSeenAt: new Date(),
            capabilities: [...capabilities],
        },
    });
    if (peer.outboundStatus !== "ACTIVE") {
        log.info(
            `peerId=${peer.id} status=ACTIVE previous=${peer.outboundStatus}`,
        );
    }
}

async function markPeerOffline(peer: {
    id: string;
    outboundStatus: string | null;
}): Promise<void> {
    await prisma.federationPeer.updateMany({
        where: { id: peer.id, outboundStatus: { not: "REVOKED" } },
        data: { outboundStatus: "OFFLINE" },
    });
    if (peer.outboundStatus !== "OFFLINE") {
        log.info(
            `peerId=${peer.id} status=OFFLINE previous=${peer.outboundStatus}`,
        );
    }
}

/** Pings every bounded consumer peer and records only status transitions. */
export async function processFederationHealth(): Promise<HealthCounts> {
    const peers = await prisma.federationPeer.findMany({
        where: {
            direction: { in: ["CONSUMER", "BOTH"] },
            outboundStatus: { not: "REVOKED" },
            baseUrl: { not: null },
            outboundToken: { not: null },
        },
        take: MAX_CONSUMER_PEERS,
        orderBy: { id: "asc" },
        select: {
            id: true,
            baseUrl: true,
            outboundToken: true,
            outboundStatus: true,
        },
    });
    const counts: HealthCounts = { checked: 0, online: 0, offline: 0 };
    for (let index = 0; index < MAX_CONSUMER_PEERS; index += 1) {
        const peer = peers[index];
        if (!peer) break;
        counts.checked += 1;
        try {
            const manifest = await createFederationClient(peer, {
                allowPrivatePeers: config.federation.allowPrivatePeers,
            }).getManifest();
            await markPeerActive(peer, manifest.capabilities);
            counts.online += 1;
        } catch (_error: unknown) {
            await markPeerOffline(peer);
            counts.offline += 1;
        }
    }
    return counts;
}

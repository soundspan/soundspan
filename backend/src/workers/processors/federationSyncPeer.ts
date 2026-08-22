import { prisma } from "../../utils/db";

/** Loads one usable persisted peer for a consumer-owned sync pass. */
export async function getAvailableFederationConsumerPeer(peerId: string) {
    const peer = await prisma.federationPeer.findUnique({
        where: { id: peerId },
    });
    if (
        !peer ||
        !["CONSUMER", "BOTH"].includes(peer.direction) ||
        peer.outboundStatus === "REVOKED" ||
        !peer.baseUrl ||
        !peer.outboundToken
    ) {
        throw new Error("Federation consumer peer is unavailable");
    }
    return peer;
}

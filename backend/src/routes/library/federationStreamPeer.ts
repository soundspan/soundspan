/**
 * Loads a federation peer eligible for outbound stream proxying.
 *
 * Extracted from tracks.ts (its only caller) to keep that route module
 * inside its file-size baseline.
 */

import { prisma } from "../../utils/db";

export async function loadActiveFederationStreamPeer(peerId: string | null) {
    if (!peerId) return null;
    const peer = await prisma.federationPeer.findUnique({
        where: { id: peerId },
        select: {
            id: true,
            name: true,
            baseUrl: true,
            outboundToken: true,
            outboundStatus: true,
        },
    });
    if (
        !peer ||
        peer.outboundStatus !== "ACTIVE" ||
        !peer.baseUrl ||
        !peer.outboundToken
    ) {
        return null;
    }
    return {
        ...peer,
        baseUrl: peer.baseUrl,
        outboundToken: peer.outboundToken,
    };
}

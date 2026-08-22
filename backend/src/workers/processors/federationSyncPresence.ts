import { config } from "../../config";
import { recordFederationPresenceFetch } from "../../metrics";
import { storeFederationPeerPresenceSnapshot } from "../../services/federationPresence";
import type { FederationPresence } from "../../utils/federationPresenceSchemas";
import { logger } from "../../utils/logger";

const log = logger.child("FederationSyncPresence");
const PRESENCE_DEADLINE_MS = 15_000;

interface PresencePeer {
    id: string;
    name: string;
    scopes: string[];
}

interface PresenceClient {
    getPresence(): Promise<FederationPresence>;
}

async function getPresenceBeforeDeadline(
    client: PresenceClient,
): Promise<FederationPresence> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error("Federation presence fetch timed out")),
            PRESENCE_DEADLINE_MS,
        );
    });
    try {
        return await Promise.race([client.getPresence(), deadline]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** Best-effort presence refresh after a successful peer catalog pass. */
export async function refreshFederationPresence(
    peer: PresencePeer,
    client: PresenceClient,
): Promise<void> {
    if (!peer.scopes.includes("social:read")) return;
    try {
        const presence = await getPresenceBeforeDeadline(client);
        const ttlSeconds = Math.max(
            1,
            Math.floor(config.workers.federationSyncIntervalMinutes * 3 * 60),
        );
        await storeFederationPeerPresenceSnapshot(
            {
                peerId: peer.id,
                peerName: peer.name,
                users: presence.users,
                fetchedAt: new Date().toISOString(),
            },
            ttlSeconds,
        );
        recordFederationPresenceFetch(peer.id, "success");
    } catch (cause) {
        recordFederationPresenceFetch(peer.id, "failure");
        log.debug("Federation peer presence fetch failed", {
            peerId: peer.id,
            cause,
        });
    }
}

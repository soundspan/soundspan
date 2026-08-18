import { prisma } from "../utils/db";
import { isV2Envelope } from "../utils/encryptedColumns";
import { logger } from "../utils/logger";
import { encryptFederationOutboundToken } from "./federationCredentialCipher";

const MAX_FEDERATION_CREDENTIAL_ROWS = 10_000;
const log = logger.child("FederationCredentials");

interface FederationCredentialCandidate {
    id: string;
    outboundToken: string | null;
}

/** Persistence seam used by the bounded startup credential backfill. */
export interface FederationCredentialBackfillStore {
    loadCandidates(limit: number): Promise<FederationCredentialCandidate[]>;
    replaceIfUnchanged(
        id: string,
        previous: string,
        replacement: string,
    ): Promise<boolean>;
}

const prismaBackfillStore: FederationCredentialBackfillStore = {
    async loadCandidates(limit) {
        return prisma.federationPeer.findMany({
            where: { outboundToken: { not: null } },
            orderBy: { id: "asc" },
            take: limit,
            select: { id: true, outboundToken: true },
        });
    },
    async replaceIfUnchanged(id, previous, replacement) {
        const result = await prisma.federationPeer.updateMany({
            where: { id, outboundToken: previous },
            data: { outboundToken: replacement },
        });
        return result.count === 1;
    },
};

async function migrateCandidate(
    store: FederationCredentialBackfillStore,
    candidate: FederationCredentialCandidate,
): Promise<boolean> {
    const token = candidate.outboundToken;
    if (!token || isV2Envelope(token)) return false;
    return store.replaceIfUnchanged(
        candidate.id,
        token,
        encryptFederationOutboundToken(token),
    );
}

function reportBackfillCount(migratedCount: number): void {
    log.info("Federation outbound token encryption backfill complete", {
        migratedCount,
    });
}

/** Encrypts every legacy plaintext peer token before the process is ready. */
export async function backfillFederationOutboundTokens(
    store: FederationCredentialBackfillStore = prismaBackfillStore,
    report: (migratedCount: number) => void = reportBackfillCount,
): Promise<number> {
    const candidates = await store.loadCandidates(
        MAX_FEDERATION_CREDENTIAL_ROWS + 1,
    );
    if (candidates.length > MAX_FEDERATION_CREDENTIAL_ROWS) {
        throw new Error("Federation credential backfill row limit exceeded");
    }
    let migratedCount = 0;
    for (let index = 0; index < MAX_FEDERATION_CREDENTIAL_ROWS; index += 1) {
        const candidate = candidates[index];
        if (!candidate) break;
        if (await migrateCandidate(store, candidate)) migratedCount += 1;
    }
    report(migratedCount);
    return migratedCount;
}

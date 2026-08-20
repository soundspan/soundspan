import { Prisma, type DiscoverStatus } from "@prisma/client";

/** Discovery identity used to resolve its catalog album without stale fallback. */
export interface DiscoveryCatalogIdentity {
    id: string;
    catalogAlbumId?: string | null;
    rgMbid: string;
    albumTitle: string;
    artistName: string;
}

/** Catalog album shape shared by discovery ownership workflows. */
export type DiscoveryCatalogAlbum = Prisma.AlbumGetPayload<{
    include: { artist: true };
}>;

/** A discovery row protected by the catalog resolver's ordered row locks. */
export interface LockedDiscoveryCatalogRow {
    id: string;
    catalogAlbumId: string | null;
    status: DiscoverStatus;
}

/** Catalog resolution plus the discovery rows protected by its transaction. */
export interface DiscoveryCatalogResolution {
    catalogAlbum: DiscoveryCatalogAlbum | null;
    discoveryRows: LockedDiscoveryCatalogRow[];
}

/** Signals that an unlocked discovery assumption changed before row locking. */
export class DiscoveryCatalogResolutionError extends Error {}

/** Signals that catalog resolution must restart in a fresh transaction. */
export class DiscoveryLinkDriftError extends DiscoveryCatalogResolutionError {}

const DISCOVERY_LINK_DRIFT_MAX_ATTEMPTS = 3;
const RETRYABLE_TRANSACTION_ABORT_CODES = new Set(["P2034", "40001", "40P01"]);

function isRetryableTransactionAbort(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const record = error as Record<string, unknown>;
    const meta =
        typeof record.meta === "object" && record.meta !== null
            ? (record.meta as Record<string, unknown>)
            : null;
    const adapter =
        typeof meta?.driverAdapterError === "object" &&
        meta.driverAdapterError !== null
            ? (meta.driverAdapterError as Record<string, unknown>)
            : null;
    const cause =
        typeof adapter?.cause === "object" && adapter.cause !== null
            ? (adapter.cause as Record<string, unknown>)
            : null;
    return [record, meta, cause].some(
        (candidate) =>
            typeof candidate?.code === "string" &&
            RETRYABLE_TRANSACTION_ABORT_CODES.has(candidate.code),
    );
}

function isRetryableDiscoveryTransactionError(error: unknown): boolean {
    if (error instanceof DiscoveryLinkDriftError) return true;
    return isRetryableTransactionAbort(error);
}

/** Retries a catalog operation after link drift or a retryable DB abort. */
export async function retryDiscoveryLinkDrift<T>(
    operation: () => Promise<T>,
): Promise<T> {
    for (
        let attempt = 1;
        attempt <= DISCOVERY_LINK_DRIFT_MAX_ATTEMPTS;
        attempt += 1
    ) {
        try {
            return await operation();
        } catch (error: unknown) {
            const exhausted = attempt === DISCOVERY_LINK_DRIFT_MAX_ATTEMPTS;
            if (!isRetryableDiscoveryTransactionError(error) || exhausted) {
                throw error;
            }
        }
    }
    throw new Error("Discovery link retry bound was not enforced");
}

/** Post-lock status and discovery-row scope required by a resolver caller. */
export interface DiscoveryCatalogResolutionOptions {
    expectedStatuses?: readonly DiscoverStatus[];
    lockAllLinkedRows?: boolean;
}

interface DiscoveryCatalogLinkSnapshot {
    catalogAlbumId: string | null;
}

type DiscoveryFallbackMatch = "rgMbid" | "titleArtist";

interface DiscoveryFallbackCandidate {
    catalogAlbum: DiscoveryCatalogAlbum;
    match: DiscoveryFallbackMatch;
}

async function findFallbackCatalogAlbum(
    transaction: Prisma.TransactionClient,
    discoveryAlbum: DiscoveryCatalogIdentity,
): Promise<DiscoveryFallbackCandidate | null> {
    const exactMbid = await transaction.album.findFirst({
        where: { rgMbid: discoveryAlbum.rgMbid },
        include: { artist: true },
    });
    if (exactMbid) return { catalogAlbum: exactMbid, match: "rgMbid" };
    const titleArtist = await transaction.album.findFirst({
        where: {
            title: {
                equals: discoveryAlbum.albumTitle,
                mode: "insensitive",
            },
            artist: {
                name: {
                    equals: discoveryAlbum.artistName,
                    mode: "insensitive",
                },
            },
        },
        include: { artist: true },
    });
    return titleArtist
        ? { catalogAlbum: titleArtist, match: "titleArtist" }
        : null;
}

async function findCatalogAlbumById(
    transaction: Prisma.TransactionClient,
    catalogAlbumId: string | null,
): Promise<DiscoveryCatalogAlbum | null> {
    if (!catalogAlbumId) return null;
    return transaction.album.findUnique({
        where: { id: catalogAlbumId },
        include: { artist: true },
    });
}

async function readCatalogCandidate(
    transaction: Prisma.TransactionClient,
    discoveryAlbum: DiscoveryCatalogIdentity,
): Promise<{
    snapshot: DiscoveryCatalogLinkSnapshot;
    catalogAlbum: DiscoveryCatalogAlbum | null;
    fallbackMatch: DiscoveryFallbackMatch | null;
} | null> {
    const snapshot = await transaction.discoveryAlbum.findUnique({
        where: { id: discoveryAlbum.id },
        select: { catalogAlbumId: true },
    });
    if (!snapshot) return null;
    const normalizedSnapshot = {
        catalogAlbumId: snapshot.catalogAlbumId ?? null,
    };
    if (normalizedSnapshot.catalogAlbumId) {
        const catalogAlbum = await findCatalogAlbumById(
            transaction,
            normalizedSnapshot.catalogAlbumId,
        );
        return {
            snapshot: normalizedSnapshot,
            catalogAlbum,
            fallbackMatch: null,
        };
    }
    const fallback = await findFallbackCatalogAlbum(
        transaction,
        discoveryAlbum,
    );
    return {
        snapshot: normalizedSnapshot,
        catalogAlbum: fallback?.catalogAlbum ?? null,
        fallbackMatch: fallback?.match ?? null,
    };
}

async function lockCatalogAlbum(
    transaction: Prisma.TransactionClient,
    catalogAlbumId: string,
): Promise<{ artistId: string } | null> {
    const rows = await transaction.$queryRaw<Array<{ artistId: string }>>(
        Prisma.sql`
        SELECT "artistId"
        FROM "Album"
        WHERE "id" = ${catalogAlbumId}
        FOR UPDATE
    `,
    );
    return rows.length === 1 ? rows[0] : null;
}

async function lockCatalogArtist(
    transaction: Prisma.TransactionClient,
    artistId: string,
): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "Artist"
        WHERE "id" = ${artistId}
        FOR UPDATE
    `);
    return rows.length === 1;
}

async function exactMbidSupersedesFallback(
    transaction: Prisma.TransactionClient,
    discoveryAlbum: DiscoveryCatalogIdentity,
    catalogAlbumId: string,
): Promise<boolean> {
    const exactMbid = await transaction.album.findFirst({
        where: { rgMbid: discoveryAlbum.rgMbid },
        include: { artist: true },
    });
    return exactMbid !== null && exactMbid.id !== catalogAlbumId;
}

function fallbackStillMatches(
    catalogAlbum: DiscoveryCatalogAlbum,
    discoveryAlbum: DiscoveryCatalogIdentity,
    match: DiscoveryFallbackMatch,
): boolean {
    if (match === "rgMbid") {
        return catalogAlbum.rgMbid === discoveryAlbum.rgMbid;
    }
    return (
        catalogAlbum.title.toLowerCase() ===
            discoveryAlbum.albumTitle.toLowerCase() &&
        catalogAlbum.artist.name.toLowerCase() ===
            discoveryAlbum.artistName.toLowerCase()
    );
}

async function readLockedCatalogAlbum(
    transaction: Prisma.TransactionClient,
    discoveryAlbum: DiscoveryCatalogIdentity,
    candidate: DiscoveryCatalogAlbum,
    fallbackMatch: DiscoveryFallbackMatch | null,
): Promise<DiscoveryCatalogAlbum | null> {
    const lockedAlbum = await lockCatalogAlbum(transaction, candidate.id);
    if (!lockedAlbum) return null;
    if (fallbackMatch === "titleArtist") {
        const artistLocked = await lockCatalogArtist(
            transaction,
            lockedAlbum.artistId,
        );
        if (!artistLocked) {
            throw new DiscoveryLinkDriftError(
                "Fallback catalog artist changed during resolution",
            );
        }
        if (
            await exactMbidSupersedesFallback(
                transaction,
                discoveryAlbum,
                candidate.id,
            )
        ) {
            throw new DiscoveryLinkDriftError(
                "Exact catalog match appeared during resolution",
            );
        }
    }
    const catalogAlbum = await findCatalogAlbumById(transaction, candidate.id);
    if (!catalogAlbum) {
        throw new DiscoveryLinkDriftError(
            "Catalog album changed during resolution",
        );
    }
    if (
        fallbackMatch &&
        !fallbackStillMatches(catalogAlbum, discoveryAlbum, fallbackMatch)
    ) {
        throw new DiscoveryLinkDriftError(
            "Fallback catalog match changed during resolution",
        );
    }
    return catalogAlbum;
}

async function lockDiscoveryRows(
    transaction: Prisma.TransactionClient,
    discoveryAlbumId: string,
    catalogAlbumId: string | null,
    lockAllLinkedRows: boolean,
): Promise<LockedDiscoveryCatalogRow[]> {
    if (lockAllLinkedRows && catalogAlbumId) {
        return transaction.$queryRaw<LockedDiscoveryCatalogRow[]>(Prisma.sql`
            SELECT "id", "catalogAlbumId", "status"
            FROM "DiscoveryAlbum"
            WHERE "id" = ${discoveryAlbumId}
               OR "catalogAlbumId" = ${catalogAlbumId}
            ORDER BY "id"
            FOR UPDATE
        `);
    }
    return transaction.$queryRaw<LockedDiscoveryCatalogRow[]>(Prisma.sql`
        SELECT "id", "catalogAlbumId", "status"
        FROM "DiscoveryAlbum"
        WHERE "id" = ${discoveryAlbumId}
        ORDER BY "id"
        FOR UPDATE
    `);
}

function validateLockedDiscoveryRow(
    discoveryAlbumId: string,
    snapshot: DiscoveryCatalogLinkSnapshot,
    rows: readonly LockedDiscoveryCatalogRow[],
    expectedStatuses: readonly DiscoverStatus[] | undefined,
): LockedDiscoveryCatalogRow {
    const locked = rows.find((row) => row.id === discoveryAlbumId);
    if (!locked || locked.catalogAlbumId !== snapshot.catalogAlbumId) {
        throw new DiscoveryLinkDriftError(
            "Discovery catalog link changed during resolution",
        );
    }
    if (expectedStatuses && !expectedStatuses.includes(locked.status)) {
        throw new DiscoveryCatalogResolutionError(
            "Discovery status changed during resolution",
        );
    }
    return locked;
}

async function persistFallbackLink(
    transaction: Prisma.TransactionClient,
    locked: LockedDiscoveryCatalogRow,
    catalogAlbumId: string,
): Promise<void> {
    if (locked.catalogAlbumId) return;
    const linked = await transaction.discoveryAlbum.updateMany({
        where: { id: locked.id, catalogAlbumId: null },
        data: { catalogAlbumId },
    });
    if (linked.count !== 1) {
        throw new DiscoveryCatalogResolutionError(
            "Discovery catalog link claim failed",
        );
    }
    locked.catalogAlbumId = catalogAlbumId;
}

/**
 * Resolves a catalog candidate without locks, then locks the Album, its Artist
 * for title/artist fallback, and all requested DiscoveryAlbum rows in order.
 */
export async function resolveDiscoveryCatalogAlbum(
    transaction: Prisma.TransactionClient,
    discoveryAlbum: DiscoveryCatalogIdentity,
    options: DiscoveryCatalogResolutionOptions = {},
): Promise<DiscoveryCatalogResolution | null> {
    const candidate = await readCatalogCandidate(transaction, discoveryAlbum);
    if (!candidate) return null;

    const catalogAlbum = candidate.catalogAlbum
        ? await readLockedCatalogAlbum(
              transaction,
              discoveryAlbum,
              candidate.catalogAlbum,
              candidate.fallbackMatch,
          )
        : null;
    const rows = await lockDiscoveryRows(
        transaction,
        discoveryAlbum.id,
        catalogAlbum?.id ?? candidate.snapshot.catalogAlbumId,
        options.lockAllLinkedRows ?? false,
    );
    const lockedDiscovery = validateLockedDiscoveryRow(
        discoveryAlbum.id,
        candidate.snapshot,
        rows,
        options.expectedStatuses,
    );
    if (catalogAlbum) {
        await persistFallbackLink(
            transaction,
            lockedDiscovery,
            catalogAlbum.id,
        );
    }
    return { catalogAlbum, discoveryRows: rows };
}

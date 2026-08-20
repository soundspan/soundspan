import type { Prisma } from "@prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default grace period for stale provider tracks and their recent plays. */
export const DEFAULT_PROVIDER_TRACK_RETENTION_DAYS = 30;
const MAX_PROVIDER_TRACK_RETENTION_DAYS = 3650;

/** Mapping state needed by the pure provider-track retention decision. */
export interface ProviderTrackRetentionMapping {
    stale: boolean;
    staleAt: Date | null;
}

/** Provider-row state needed by the pure retention decision. */
export interface ProviderTrackRetentionInput {
    createdAt: Date;
    mappings: readonly ProviderTrackRetentionMapping[];
    hasLikedReference: boolean;
    hasPlaylistReference: boolean;
    latestPlayedAt: Date | null;
}

export type ProviderTrackRetentionState = "live" | "collectable";

type ProviderTrackWhereInput = Prisma.TrackTidalWhereInput &
    Prisma.TrackYtMusicWhereInput;

function mappingIsRetained(
    mapping: ProviderTrackRetentionMapping,
    cutoff: Date,
): boolean {
    if (!mapping.stale) return true;
    if (mapping.staleAt === null) return true;
    return mapping.staleAt.getTime() >= cutoff.getTime();
}

/** Classifies one provider row without I/O or ambient clock access. */
export function classifyProviderTrackRetention(
    input: ProviderTrackRetentionInput,
    cutoff: Date,
): ProviderTrackRetentionState {
    if (input.hasLikedReference || input.hasPlaylistReference) return "live";
    if (
        input.latestPlayedAt !== null &&
        input.latestPlayedAt.getTime() >= cutoff.getTime()
    ) {
        return "live";
    }
    if (input.createdAt.getTime() >= cutoff.getTime()) return "live";
    return input.mappings.some((mapping) => mappingIsRetained(mapping, cutoff))
        ? "live"
        : "collectable";
}

/** Computes the UTC retention cutoff for a validated positive day count. */
export function providerTrackRetentionCutoff(
    now: Date,
    retentionDays: number,
): Date {
    if (
        !Number.isSafeInteger(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > MAX_PROVIDER_TRACK_RETENTION_DAYS
    ) {
        throw new Error(
            "Provider track retention days must be from 1 through 3650",
        );
    }
    return new Date(now.getTime() - retentionDays * DAY_MS);
}

/** Prisma predicate selecting rows that are safe to collect at the cutoff. */
export function providerTrackCollectableWhere(
    cutoff: Date,
): ProviderTrackWhereInput {
    return {
        createdAt: { lt: cutoff },
        mappings: {
            none: {
                OR: [
                    { stale: false },
                    { staleAt: null },
                    { staleAt: { gte: cutoff } },
                ],
            },
        },
        likedBy: { none: {} },
        playlistItems: { none: {} },
        plays: { none: { playedAt: { gte: cutoff } } },
    };
}

/** Prisma predicate selecting provider rows retained by the GC policy. */
export function providerTrackLiveWhere(cutoff: Date): ProviderTrackWhereInput {
    return { NOT: providerTrackCollectableWhere(cutoff) };
}

/** Parent-relation guards that ignore provider rows classified as collectable. */
export function parentHasNoLiveProviderTracksWhere(cutoff: Date) {
    const live = providerTrackLiveWhere(cutoff);
    return {
        tracksTidal: { none: live },
        tracksYtMusic: { none: live },
    } satisfies Pick<Prisma.AlbumWhereInput, "tracksTidal" | "tracksYtMusic">;
}

/** Guards an album against collection when provider or user-owned state remains. */
export function albumOrphanRetentionGuardWhere(
    cutoff: Date,
): Prisma.AlbumWhereInput {
    return {
        hasUserOverrides: false,
        ownedBy: { none: {} },
        ...parentHasNoLiveProviderTracksWhere(cutoff),
    } as Prisma.AlbumWhereInput;
}

/** Loads legacy LIKED release groups that an old replica did not link. */
export async function findUnlinkedLikedDiscoveryRgMbids(
    transaction: Prisma.TransactionClient,
): Promise<string[]> {
    const rows = await transaction.discoveryAlbum.findMany({
        where: { status: "LIKED", catalogAlbumId: null },
        distinct: ["rgMbid"],
        select: { rgMbid: true },
    });
    return rows.map((row) => row.rgMbid);
}

/**
 * Discovery cleanup must never collect an album promoted into the library.
 * Like-promotion writes location and ownership atomically, so this scope is
 * defense in depth on top of the ownership guard.
 */
export function discoveryAlbumOrphanRetentionGuardWhere(
    cutoff: Date,
    unlinkedLikedRgMbids: readonly string[] = [],
): Prisma.AlbumWhereInput {
    // Uses the NOT key (not `location`) so spreading this guard next to a
    // caller's explicit `location` filter cannot clobber it.
    return {
        ...albumOrphanRetentionGuardWhere(cutoff),
        NOT: {
            OR: [
                { location: "LIBRARY" },
                { rgMbid: { in: [...unlinkedLikedRgMbids] } },
            ],
        },
        discoveryRecords: { none: { status: "LIKED" } },
    } as Prisma.AlbumWhereInput;
}

/** Guards child-track deletion with the current album retention state. */
export function albumTracksOrphanRetentionGuardWhere(
    albumId: string,
    cutoff: Date,
): Prisma.TrackWhereInput {
    return {
        albumId,
        album: albumOrphanRetentionGuardWhere(cutoff),
    };
}

/** Guards discovery-scoped track deletion with discovery retention state. */
export function discoveryAlbumTracksOrphanRetentionGuardWhere(
    albumId: string,
    cutoff: Date,
    unlinkedLikedRgMbids: readonly string[] = [],
): Prisma.TrackWhereInput {
    return {
        albumId,
        album: discoveryAlbumOrphanRetentionGuardWhere(
            cutoff,
            unlinkedLikedRgMbids,
        ),
    };
}

/** Guards an artist against collection when provider or user-owned state remains. */
export function artistOrphanRetentionGuardWhere(
    cutoff: Date,
): Prisma.ArtistWhereInput {
    return {
        hasUserOverrides: false,
        ownedAlbums: { none: {} },
        ...parentHasNoLiveProviderTracksWhere(cutoff),
    };
}

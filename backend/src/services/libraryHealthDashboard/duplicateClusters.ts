import { prisma } from "../../utils/db";
import type { TrackIdentityTier } from "../trackIdentityMatcher";
import {
    normalizePagination,
    type LibraryHealthPagination,
} from "./pagination";
import { VISIBLE_LOCAL_TRACK_WHERE } from "./predicates";

/** Duplicate tiers reused from the durable track identity matcher. */
export type DuplicateClusterTier = Extract<
    TrackIdentityTier,
    "audioHash" | "recordingMbid" | "isrc"
>;

const DUPLICATE_CLUSTER_KEY_LIMIT = 10_000;
const DUPLICATE_MEMBER_LIMIT = 100_000;

interface DuplicateTrackRow {
    id: string;
    title: string;
    filePath: string | null;
    fileSize: number;
    mime: string | null;
    audioHash: string | null;
    recordingMbid: string | null;
    isrc: string | null;
    album: { title: string; artist: { name: string } };
}

export interface DuplicateCluster {
    tier: DuplicateClusterTier;
    identity: string;
    memberCount: number;
    totalFileSize: number;
    members: Array<{
        id: string;
        title: string;
        albumTitle: string;
        artistName: string;
        filePath: string | null;
        fileSize: number;
        mime: string | null;
    }>;
}

export interface DuplicateClusterCatalog {
    clusters: DuplicateCluster[];
    total: number;
    byTier: Record<DuplicateClusterTier, number>;
    isTruncated: boolean;
}

function clusterMember(row: DuplicateTrackRow) {
    return {
        id: row.id,
        title: row.title,
        albumTitle: row.album.title,
        artistName: row.album.artist.name,
        filePath: row.filePath,
        fileSize: row.fileSize,
        mime: row.mime,
    };
}

function addTierClusters(
    rows: readonly DuplicateTrackRow[],
    tier: DuplicateClusterTier,
    keys: ReadonlySet<string>,
    claimed: Set<string>,
): DuplicateCluster[] {
    const groups = new Map<string, DuplicateTrackRow[]>();
    for (const row of rows) {
        const identity = row[tier];
        if (!identity || !keys.has(identity) || claimed.has(row.id)) continue;
        const members = groups.get(identity) ?? [];
        members.push(row);
        groups.set(identity, members);
    }
    const clusters: DuplicateCluster[] = [];
    for (const [identity, members] of groups) {
        if (members.length < 2) continue;
        members.forEach((member) => claimed.add(member.id));
        clusters.push({
            tier,
            identity,
            memberCount: members.length,
            totalFileSize: members.reduce(
                (sum, member) => sum + member.fileSize,
                0,
            ),
            members: members.map(clusterMember),
        });
    }
    return clusters.sort((left, right) =>
        left.identity.localeCompare(right.identity),
    );
}

async function loadDuplicateKeys() {
    return Promise.all([
        prisma.track.groupBy({
            by: ["audioHash"],
            where: { ...VISIBLE_LOCAL_TRACK_WHERE, audioHash: { not: null } },
            _count: { _all: true },
            having: { audioHash: { _count: { gt: 1 } } },
            orderBy: { audioHash: "asc" },
            take: DUPLICATE_CLUSTER_KEY_LIMIT + 1,
        }),
        prisma.track.groupBy({
            by: ["recordingMbid"],
            where: {
                ...VISIBLE_LOCAL_TRACK_WHERE,
                recordingMbid: { not: null },
            },
            _count: { _all: true },
            having: { recordingMbid: { _count: { gt: 1 } } },
            orderBy: { recordingMbid: "asc" },
            take: DUPLICATE_CLUSTER_KEY_LIMIT + 1,
        }),
        prisma.track.groupBy({
            by: ["isrc"],
            where: { ...VISIBLE_LOCAL_TRACK_WHERE, isrc: { not: null } },
            _count: { _all: true },
            having: { isrc: { _count: { gt: 1 } } },
            orderBy: { isrc: "asc" },
            take: DUPLICATE_CLUSTER_KEY_LIMIT + 1,
        }),
    ]);
}

function keySet(values: ReadonlyArray<string | null>): Set<string> {
    return new Set(
        values
            .slice(0, DUPLICATE_CLUSTER_KEY_LIMIT)
            .filter((value): value is string => typeof value === "string"),
    );
}

async function loadDuplicateMembers(
    audioHashes: ReadonlySet<string>,
    recordingMbids: ReadonlySet<string>,
    isrcs: ReadonlySet<string>,
) {
    const or = [
        audioHashes.size > 0 ? { audioHash: { in: [...audioHashes] } } : null,
        recordingMbids.size > 0
            ? { recordingMbid: { in: [...recordingMbids] } }
            : null,
        isrcs.size > 0 ? { isrc: { in: [...isrcs] } } : null,
    ].filter((value): value is NonNullable<typeof value> => value !== null);
    if (or.length === 0) return [];
    return prisma.track.findMany({
        where: { ...VISIBLE_LOCAL_TRACK_WHERE, OR: or },
        select: {
            id: true,
            title: true,
            filePath: true,
            fileSize: true,
            mime: true,
            audioHash: true,
            recordingMbid: true,
            isrc: true,
            album: {
                select: { title: true, artist: { select: { name: true } } },
            },
        },
        orderBy: { id: "asc" },
        take: DUPLICATE_MEMBER_LIMIT + 1,
    });
}

/** Loads bounded duplicate clusters with strict highest-tier precedence. */
export async function loadDuplicateClusterCatalog(): Promise<DuplicateClusterCatalog> {
    const [audioRows, recordingRows, isrcRows] = await loadDuplicateKeys();
    const audioHashes = keySet(audioRows.map((row) => row.audioHash));
    const recordingMbids = keySet(
        recordingRows.map((row) => row.recordingMbid),
    );
    const isrcs = keySet(isrcRows.map((row) => row.isrc));
    const loadedMembers = await loadDuplicateMembers(
        audioHashes,
        recordingMbids,
        isrcs,
    );
    const members = loadedMembers.slice(0, DUPLICATE_MEMBER_LIMIT);
    const claimed = new Set<string>();
    const clusters = [
        ...addTierClusters(members, "audioHash", audioHashes, claimed),
        ...addTierClusters(members, "recordingMbid", recordingMbids, claimed),
        ...addTierClusters(members, "isrc", isrcs, claimed),
    ];
    const byTier = { audioHash: 0, recordingMbid: 0, isrc: 0 };
    clusters.forEach((cluster) => {
        byTier[cluster.tier] += 1;
    });
    return {
        clusters,
        total: clusters.length,
        byTier,
        isTruncated:
            loadedMembers.length > DUPLICATE_MEMBER_LIMIT ||
            [audioRows, recordingRows, isrcRows].some(
                (rows) => rows.length > DUPLICATE_CLUSTER_KEY_LIMIT,
            ),
    };
}

/** Returns one bounded duplicate-cluster page from the cached catalog. */
export function listDuplicateClusters(
    catalog: DuplicateClusterCatalog,
    pagination: LibraryHealthPagination,
) {
    const page = normalizePagination(pagination, 50);
    return {
        clusters: catalog.clusters.slice(page.offset, page.offset + page.limit),
        total: catalog.total,
        byTier: catalog.byTier,
        isTruncated: catalog.isTruncated,
        ...page,
    };
}

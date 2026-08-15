import { Prisma } from "@prisma/client";
import type { LibraryOriginFilter } from "./librarySorting";

const RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX = "2.1b6-enhanced-v3";

/** SQL predicate for user-facing radio pools backed by the Track alias `t`. */
export const VISIBLE_TRACK_SQL = Prisma.sql`t."removedAt" IS NULL`;

/** SQL predicate for tracks physically owned by this instance (Track alias `t`). */
export const LOCAL_TRACK_SQL = Prisma.sql`t.origin = ${"LOCAL"}::"TrackOrigin"`;

type TrackSqlAlias = "t" | "candidate_track" | "source_track";

function federatedBrowseSql(trackAlias: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`${trackAlias}.origin = ${"FEDERATED"}::"TrackOrigin"
        AND (
            ${trackAlias}."dedupOfTrackId" IS NULL
            OR EXISTS (
                SELECT 1 FROM "FederationPeer" dedup_peer
                WHERE dedup_peer.id = ${trackAlias}."peerId"
                  AND dedup_peer."showDedupedCopies" = true
            )
            OR EXISTS (
                SELECT 1 FROM "Track" dedup_winner
                WHERE dedup_winner.id = ${trackAlias}."dedupOfTrackId"
                  AND dedup_winner."removedAt" IS NOT NULL
            )
        )`;
}

/** Builds the browse origin/dedup predicate for a code-owned Track alias. */
export function trackBrowseSql(
    alias: TrackSqlAlias = "t",
    origin: LibraryOriginFilter = "all",
): Prisma.Sql {
    const trackAlias = Prisma.raw(alias);
    const federatedVisible = federatedBrowseSql(trackAlias);
    if (origin === "local") {
        return Prisma.sql`${trackAlias}.origin = ${"LOCAL"}::"TrackOrigin"`;
    }
    if (origin === "peers") return federatedVisible;
    return Prisma.sql`(
        ${trackAlias}.origin = ${"LOCAL"}::"TrackOrigin"
        OR (${federatedVisible})
    )`;
}

/** SQL origin/dedup predicate for first-class library pools using alias `t`. */
export const TRACK_BROWSE_SQL = trackBrowseSql();

/** Builds the parameterized SQL predicate for a library-radio mood pool. */
export const moodPoolCondition = (moodValue: string): Prisma.Sql => {
    switch (moodValue) {
        case "high-energy":
            return Prisma.sql`t."analysisStatus" = ${"completed"} AND t.energy >= ${0.7} AND t.bpm >= ${120}`;
        case "chill":
            return Prisma.sql`t."analysisStatus" = ${"completed"} AND (t.energy <= ${0.4} OR t.arousal <= ${0.4})`;
        case "happy":
            return Prisma.sql`t."analysisStatus" = ${"completed"} AND t.valence >= ${0.6} AND t.energy >= ${0.5}`;
        case "melancholy":
            return Prisma.sql`t."analysisStatus" = ${"completed"} AND (t.valence <= ${0.4} OR t."keyScale" = ${"minor"})`;
        case "dance":
            return Prisma.sql`t."analysisStatus" = ${"completed"} AND t.danceability >= ${0.7}`;
        case "acoustic":
            return Prisma.sql`t."analysisStatus" = ${"completed"} AND t.acousticness >= ${0.6}`;
        case "instrumental":
            return Prisma.sql`t."analysisStatus" = ${"completed"} AND t.instrumentalness >= ${0.7}`;
        default:
            return Prisma.sql`${moodValue} = ANY(t."lastfmTags")`;
    }
};

/** Identifies enhanced-analysis data produced by the reliable model version. */
export const hasReliableEnhancedAnalysis = (
    analysisMode: string | null | undefined,
    analysisVersion: string | null | undefined,
): boolean =>
    analysisMode === "enhanced" &&
    typeof analysisVersion === "string" &&
    analysisVersion.startsWith(RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX);

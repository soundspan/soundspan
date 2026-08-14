import { Prisma } from "@prisma/client";

const RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX = "2.1b6-enhanced-v3";

/** SQL predicate for user-facing radio pools backed by the Track alias `t`. */
export const VISIBLE_TRACK_SQL = Prisma.sql`t."removedAt" IS NULL`;

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

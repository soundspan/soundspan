import type { Prisma } from "@prisma/client";
import { LOCAL_TRACK_WHERE } from "../utils/librarySorting";

/** Shared eligibility predicate for local audio-embedding work and coverage. */
export function vibeEmbeddingEligibleTrackWhere(): Prisma.TrackWhereInput {
    return {
        ...LOCAL_TRACK_WHERE,
        removedAt: null,
        filePath: { not: null },
    };
}

/** Target-space gate shared by embedding selection and atomic job claims. */
export function vibeEmbeddingTargetGateWhere(
    targetSpaceId: string,
): Prisma.TrackWhereInput {
    return {
        embeddings: { none: { spaceId: targetSpaceId } },
        OR: [
            { vibeAnalysisStatus: null },
            { vibeAnalysisStatus: "pending" },
            { vibeAnalysisStatus: "completed" },
        ],
    };
}

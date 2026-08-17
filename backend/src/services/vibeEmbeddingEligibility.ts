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
        OR: [
            { vibeAnalysisStatus: "pending" },
            {
                vibeAnalysisStatus: null,
                embeddings: { none: { spaceId: targetSpaceId } },
            },
            {
                vibeAnalysisStatus: "completed",
                embeddings: { none: { spaceId: targetSpaceId } },
            },
        ],
    };
}

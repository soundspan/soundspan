import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const CACHE_TTL_MS = 60_000;
const log = logger.child("EmbeddingSpaces");

/** Identity and vector contract for the embedding space serving requests. */
export interface ActiveEmbeddingSpace {
    id: string;
    family: string;
    checkpointHash: string;
    dim: number;
    preprocessing: Prisma.JsonValue;
}

/** Raised when the registry has no space available to serve vibe requests. */
export class NoActiveEmbeddingSpaceError extends Error {
    readonly code = "NO_ACTIVE_EMBEDDING_SPACE";

    constructor() {
        super("No active embedding space is configured");
        this.name = "NoActiveEmbeddingSpaceError";
    }
}

let cachedSpace: ActiveEmbeddingSpace | null = null;
let cacheExpiresAt = 0;
let inFlightLoad: Promise<ActiveEmbeddingSpace> | null = null;

function toActiveSpace(
    row: ActiveEmbeddingSpace & { createdAt: Date },
): ActiveEmbeddingSpace {
    return {
        id: row.id,
        family: row.family,
        checkpointHash: row.checkpointHash,
        dim: row.dim,
        preprocessing: row.preprocessing,
    };
}

async function loadActiveSpace(): Promise<ActiveEmbeddingSpace> {
    const rows = await prisma.embeddingSpace.findMany({
        where: { status: "active" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 2,
        select: {
            id: true,
            family: true,
            checkpointHash: true,
            dim: true,
            preprocessing: true,
            createdAt: true,
        },
    });
    if (rows.length === 0) throw new NoActiveEmbeddingSpaceError();
    if (rows.length > 1) {
        log.error(
            "Multiple active embedding spaces violate the registry invariant; using the oldest",
            { activeSpaceIds: rows.map((row) => row.id) },
        );
    }
    return toActiveSpace(rows[0]);
}

/**
 * Resolve the oldest active embedding space with a 60-second local cache.
 * Single-flight: concurrent callers share one load, and a load started
 * before an invalidation never repopulates the cache afterwards.
 */
export async function getActiveSpace(): Promise<ActiveEmbeddingSpace> {
    if (cachedSpace && Date.now() < cacheExpiresAt) return cachedSpace;
    if (inFlightLoad) return inFlightLoad;

    const load = loadActiveSpace().then(
        (activeSpace) => {
            if (inFlightLoad === load) {
                cachedSpace = activeSpace;
                cacheExpiresAt = Date.now() + CACHE_TTL_MS;
                inFlightLoad = null;
            }
            return activeSpace;
        },
        (error: unknown) => {
            if (inFlightLoad === load) inFlightLoad = null;
            throw error;
        },
    );
    inFlightLoad = load;
    return load;
}

/** Clear the process-local active-space cache for cutover and test control. */
export function invalidateActiveSpaceCache(): void {
    cachedSpace = null;
    cacheExpiresAt = 0;
    inFlightLoad = null;
}

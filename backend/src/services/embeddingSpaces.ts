import type { Prisma } from "@prisma/client";
import { recordVibeProviderConfigError } from "../metrics";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const CACHE_TTL_MS = 60_000;
const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("EmbeddingSpaces")
        : logger;

/** Identity and vector contract for the embedding space serving requests. */
export interface ActiveEmbeddingSpace {
    id: string;
    family: string;
    checkpointHash: string;
    dim: number;
    preprocessing: Prisma.JsonValue;
    hadVectors: boolean;
}

/** Registry row used by provider migration and lifecycle orchestration. */
export interface ResolvedEmbeddingSpace extends ActiveEmbeddingSpace {
    status: "active" | "migrating" | "retired";
    retiredAt: Date | null;
    createdAt: Date;
}

/** Active or migrating registry row that a provider worker may target. */
export type UsableEmbeddingSpace = Omit<ResolvedEmbeddingSpace, "status"> & {
    status: "active" | "migrating";
};

/** Provider identity fields required to resolve or register a vector space. */
export interface ProviderEmbeddingSpaceIdentity {
    family: string;
    checkpointHash: string;
    dim: number;
    preprocessing: Prisma.InputJsonValue;
}

/** Result of resolving the configured provider against the registry. */
export interface ProviderSpaceResolution {
    space: UsableEmbeddingSpace;
    registered: boolean;
}

/** Raised when the registry has no space available to serve vibe requests. */
export class NoActiveEmbeddingSpaceError extends Error {
    readonly code = "NO_ACTIVE_EMBEDDING_SPACE";

    constructor() {
        super("No active embedding space is configured");
        this.name = "NoActiveEmbeddingSpaceError";
    }
}

/** Raised when an operator points the worker at a retired provider space. */
export class RetiredEmbeddingSpaceError extends Error {
    readonly code = "RETIRED_EMBEDDING_SPACE";

    constructor(public readonly spaceId: string) {
        super(`Embedding space ${spaceId} is retired`);
        this.name = "RetiredEmbeddingSpaceError";
    }
}

/** Raised when a registered provider tuple changes its vector dimension. */
export class EmbeddingSpaceDimensionMismatchError extends Error {
    readonly code = "EMBEDDING_SPACE_DIMENSION_MISMATCH";

    constructor(
        public readonly spaceId: string,
        public readonly registeredDim: number,
        public readonly providerDim: number,
    ) {
        super(
            `Embedding space ${spaceId} has dimension ${registeredDim}, provider reports ${providerDim}`,
        );
        this.name = "EmbeddingSpaceDimensionMismatchError";
    }
}

/** Raised when a provider tuple reuses incompatible preprocessing. */
export class EmbeddingSpacePreprocessingMismatchError extends Error {
    readonly code = "EMBEDDING_SPACE_PREPROCESSING_MISMATCH";

    constructor(public readonly spaceId: string) {
        super(
            `Embedding space ${spaceId} has different registered preprocessing`,
        );
        this.name = "EmbeddingSpacePreprocessingMismatchError";
    }
}

let cachedSpace: ActiveEmbeddingSpace | null = null;
let cacheExpiresAt = 0;
let inFlightLoad: Promise<ActiveEmbeddingSpace> | null = null;
let workerTargetSpaceId: string | null = null;

const providerSpaceSelect = {
    id: true,
    family: true,
    checkpointHash: true,
    dim: true,
    preprocessing: true,
    hadVectors: true,
    status: true,
    retiredAt: true,
    createdAt: true,
} as const;

function toActiveSpace(
    row: ActiveEmbeddingSpace & { createdAt: Date },
): ActiveEmbeddingSpace {
    return {
        id: row.id,
        family: row.family,
        checkpointHash: row.checkpointHash,
        dim: row.dim,
        preprocessing: row.preprocessing,
        hadVectors: row.hadVectors,
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
            hadVectors: true,
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

function assertUsableProviderSpace(
    space: ResolvedEmbeddingSpace,
): UsableEmbeddingSpace {
    if (space.status === "retired") {
        throw new RetiredEmbeddingSpaceError(space.id);
    }
    return { ...space, status: space.status };
}

function resolveRegisteredProviderSpace(
    space: ResolvedEmbeddingSpace,
    providerSpace: ProviderEmbeddingSpaceIdentity,
): UsableEmbeddingSpace {
    if (space.dim !== providerSpace.dim) {
        throw new EmbeddingSpaceDimensionMismatchError(
            space.id,
            space.dim,
            providerSpace.dim,
        );
    }
    if (
        !embeddingPreprocessingMatches(
            space.preprocessing,
            providerSpace.preprocessing,
        )
    ) {
        log.error(
            "Embedding-space provider preprocessing does not match the registered tuple",
            { spaceId: space.id },
        );
        recordVibeProviderConfigError("preprocessing_mismatch");
        throw new EmbeddingSpacePreprocessingMismatchError(space.id);
    }
    return assertUsableProviderSpace(space);
}

function canonicalJson(
    value: Prisma.JsonValue | Prisma.InputJsonValue,
): string {
    return JSON.stringify(value, (_key, nestedValue: unknown) => {
        if (
            nestedValue === null ||
            typeof nestedValue !== "object" ||
            Array.isArray(nestedValue)
        ) {
            return nestedValue;
        }
        return Object.fromEntries(
            Object.entries(nestedValue).sort(([left], [right]) =>
                left.localeCompare(right),
            ),
        );
    });
}

/** Compare preprocessing documents without depending on JSON object key order. */
export function embeddingPreprocessingMatches(
    registered: Prisma.JsonValue,
    provider: Prisma.InputJsonValue,
): boolean {
    return canonicalJson(registered) === canonicalJson(provider);
}

function isUniqueConstraintError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
    );
}

async function loadProviderSpaceAfterConflict(
    providerSpace: ProviderEmbeddingSpaceIdentity,
): Promise<ResolvedEmbeddingSpace> {
    const row = await prisma.embeddingSpace.findUnique({
        where: {
            family_checkpointHash: {
                family: providerSpace.family,
                checkpointHash: providerSpace.checkpointHash,
            },
        },
        select: providerSpaceSelect,
    });
    if (!row) throw new Error("Embedding-space registration conflict vanished");
    return row;
}

/** Look up a provider tuple without registering an unknown embedding space. */
export async function findRegisteredProviderEmbeddingSpace(
    providerSpace: ProviderEmbeddingSpaceIdentity,
): Promise<UsableEmbeddingSpace | null> {
    const existing = await prisma.embeddingSpace.findUnique({
        where: {
            family_checkpointHash: {
                family: providerSpace.family,
                checkpointHash: providerSpace.checkpointHash,
            },
        },
        select: providerSpaceSelect,
    });
    if (!existing) return null;
    return resolveRegisteredProviderSpace(existing, providerSpace);
}

/** Resolve a provider tuple, registering an unseen tuple as migrating. */
export async function resolveProviderEmbeddingSpace(
    providerSpace: ProviderEmbeddingSpaceIdentity,
): Promise<ProviderSpaceResolution> {
    const where = {
        family_checkpointHash: {
            family: providerSpace.family,
            checkpointHash: providerSpace.checkpointHash,
        },
    };
    const existing = await prisma.embeddingSpace.findUnique({
        where,
        select: providerSpaceSelect,
    });
    if (existing) {
        return {
            space: resolveRegisteredProviderSpace(existing, providerSpace),
            registered: false,
        };
    }

    try {
        const created = await prisma.embeddingSpace.create({
            data: {
                family: providerSpace.family,
                checkpointHash: providerSpace.checkpointHash,
                dim: providerSpace.dim,
                preprocessing: providerSpace.preprocessing,
                status: "migrating",
            },
            select: providerSpaceSelect,
        });
        return {
            space: resolveRegisteredProviderSpace(created, providerSpace),
            registered: true,
        };
    } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const raced = await loadProviderSpaceAfterConflict(providerSpace);
        return {
            space: resolveRegisteredProviderSpace(raced, providerSpace),
            registered: false,
        };
    }
}

/** Set the worker process's current backfill target after provider resolution. */
export function setVibeEmbeddingTargetSpaceId(spaceId: string): void {
    workerTargetSpaceId = spaceId;
}

/** Clear the worker target during shutdown and test isolation. */
export function clearVibeEmbeddingTargetSpaceId(): void {
    workerTargetSpaceId = null;
}

/** Return the resolved worker target, or the active space before resolution. */
export async function getVibeEmbeddingTargetSpaceId(): Promise<string> {
    return workerTargetSpaceId ?? (await getActiveSpace()).id;
}

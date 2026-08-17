import type { Prisma } from "@prisma/client";
import { embeddingPreprocessingHash } from "./embeddingSpaces";

/** Embedding-space identity transmitted once on a federation vector page. */
export interface FederationEmbeddingSpaceIdentity {
    family: string;
    checkpointHash: string;
    dim: number;
    preprocessingHash?: string;
}

/** Parsed page identity; null marks a malformed tuple without failing sync. */
export type ParsedFederationEmbeddingSpaceIdentity =
    FederationEmbeddingSpaceIdentity | null;

/** Local identity fields needed to decide whether peer vectors are compatible. */
export interface LocalFederationEmbeddingSpace extends FederationEmbeddingSpaceIdentity {
    id: string;
    preprocessing: Prisma.JsonValue;
}

/** Bounded outcomes for one federation page carrying peer vectors. */
export type FederationEmbeddingPageOutcome =
    | "stored"
    | "skipped_mismatch"
    | "skipped_legacy_strict";

/** Bounded outcomes for exporter-side embedding compatibility guards. */
export type FederationEmbeddingExportOutcome = "suppressed_legacy_peer";

const SEEDED_CANONICAL_SPACE_ID = "space_clap_music_audioset_v1";

/** Decide whether a peer may receive vectors from the active export space. */
export function canExportFederationEmbeddings(
    acceptsEmbeddingSpace: boolean,
    activeSpace: Pick<LocalFederationEmbeddingSpace, "id">,
): boolean {
    return (
        acceptsEmbeddingSpace || activeSpace.id === SEEDED_CANONICAL_SPACE_ID
    );
}

/** Select only the stable cross-peer identity fields from a local space. */
export function federationEmbeddingSpaceIdentity(
    space: FederationEmbeddingSpaceIdentity & {
        preprocessing: Prisma.JsonValue;
    },
): FederationEmbeddingSpaceIdentity {
    return {
        family: space.family,
        checkpointHash: space.checkpointHash,
        dim: space.dim,
        preprocessingHash: embeddingPreprocessingHash(space.preprocessing),
    };
}

/** Decide whether all peer vectors on one page may enter the active index. */
export function decideFederationEmbeddingPage(
    pageTuple: ParsedFederationEmbeddingSpaceIdentity | undefined,
    localSpace: LocalFederationEmbeddingSpace,
): FederationEmbeddingPageOutcome {
    if (pageTuple === undefined) {
        // Legacy peers predate identity tuples and can only carry vectors from
        // the seeded canonical space. The id check retires this window at cutover.
        return localSpace.id === SEEDED_CANONICAL_SPACE_ID
            ? "stored"
            : "skipped_legacy_strict";
    }
    if (pageTuple === null) return "skipped_mismatch";
    const baseMatches =
        pageTuple.family === localSpace.family &&
        pageTuple.checkpointHash === localSpace.checkpointHash &&
        pageTuple.dim === localSpace.dim;
    if (!baseMatches) return "skipped_mismatch";
    if (pageTuple.preprocessingHash === undefined) return "skipped_mismatch";
    return pageTuple.preprocessingHash ===
        embeddingPreprocessingHash(localSpace.preprocessing)
        ? "stored"
        : "skipped_mismatch";
}

/** Mutable once-per-sync warning latches owned by the caller's sync context. */
export interface FederationEmbeddingWarningLatches {
    embeddingWarningEmitted: boolean;
}

export interface ScopedEmbeddingPageInput {
    scopes: readonly string[];
    peerId: string;
    localEmbeddingSpace: LocalFederationEmbeddingSpace | null;
    warnings: FederationEmbeddingWarningLatches;
    pageCarriesEmbeddings: boolean;
    pageTuple: ParsedFederationEmbeddingSpaceIdentity | undefined;
    warn(message: string, details: Record<string, unknown>): void;
}

/**
 * Decide one synced page's embedding outcome and emit each per-sync warning at
 * most once when a page's space does not match the local active space.
 */
export function decideScopedEmbeddingPage(
    input: ScopedEmbeddingPageInput,
): FederationEmbeddingPageOutcome | null {
    if (!input.scopes.includes("embeddings:read")) return null;
    if (!input.pageCarriesEmbeddings) return null;
    if (!input.localEmbeddingSpace) return "skipped_mismatch";
    const outcome = decideFederationEmbeddingPage(
        input.pageTuple,
        input.localEmbeddingSpace,
    );
    if (outcome === "stored" || input.warnings.embeddingWarningEmitted) {
        return outcome;
    }
    input.warnings.embeddingWarningEmitted = true;
    input.warn(
        "Skipping federation embeddings because the page space does not match the local active space",
        {
            peerId: input.peerId,
            outcome,
            remoteEmbeddingSpace:
                input.pageTuple === undefined
                    ? "legacy-absent"
                    : input.pageTuple,
            localEmbeddingSpace: federationEmbeddingSpaceIdentity(
                input.localEmbeddingSpace,
            ),
        },
    );
    return outcome;
}

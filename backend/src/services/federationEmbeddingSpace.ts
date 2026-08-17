/** Embedding-space identity transmitted once on a federation vector page. */
export interface FederationEmbeddingSpaceIdentity {
    family: string;
    checkpointHash: string;
    dim: number;
}

/** Parsed page identity; null marks a malformed tuple without failing sync. */
export type ParsedFederationEmbeddingSpaceIdentity =
    FederationEmbeddingSpaceIdentity | null;

/** Local identity fields needed to decide whether peer vectors are compatible. */
export interface LocalFederationEmbeddingSpace extends FederationEmbeddingSpaceIdentity {
    id: string;
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
    space: FederationEmbeddingSpaceIdentity,
): FederationEmbeddingSpaceIdentity {
    return {
        family: space.family,
        checkpointHash: space.checkpointHash,
        dim: space.dim,
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
    return pageTuple.family === localSpace.family &&
        pageTuple.checkpointHash === localSpace.checkpointHash &&
        pageTuple.dim === localSpace.dim
        ? "stored"
        : "skipped_mismatch";
}

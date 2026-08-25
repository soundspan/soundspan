import type { ActiveEmbeddingSpace } from "../../services/embeddingSpaces";
import {
    decideScopedEmbeddingPage,
    type ParsedFederationEmbeddingSpaceIdentity,
} from "../../services/federationEmbeddingSpace";
import type { FederationEmbeddingPageOutcome } from "../../services/federationMetricsTypes";

/** Per-peer embedding result persisted after one completed sync. */
export type FederationEmbeddingOutcome = "active" | "skipped_mismatch" | null;

interface FederationEmbeddingDecisionContext {
    scopes: string[];
    peerId: string;
    localEmbeddingSpace: ActiveEmbeddingSpace | null;
    embeddingWarningEmitted: boolean;
}

/** Applies the existing scope and space guard for one embedding page. */
export function decideFederationSyncEmbeddingPage(
    context: FederationEmbeddingDecisionContext,
    pageCarriesEmbeddings: boolean,
    pageTuple: ParsedFederationEmbeddingSpaceIdentity | undefined,
    warn: (message: string, details: Record<string, unknown>) => void,
): FederationEmbeddingPageOutcome | null {
    return decideScopedEmbeddingPage({
        scopes: context.scopes,
        peerId: context.peerId,
        localEmbeddingSpace: context.localEmbeddingSpace,
        warnings: context,
        pageCarriesEmbeddings,
        pageTuple,
        warn,
    });
}

/** Merges page outcomes while retaining any mismatch observed in the sync. */
export function mergeFederationEmbeddingOutcome(
    current: FederationEmbeddingOutcome,
    page: FederationEmbeddingPageOutcome | null,
): FederationEmbeddingOutcome {
    if (page === null) return current;
    if (page !== "stored") return "skipped_mismatch";
    return current ?? "active";
}

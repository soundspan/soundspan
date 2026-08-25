import { recordFederationEmbeddingPageOutcome } from "../../metrics";
import type { FederationEmbeddingPageOutcome } from "../../services/federationMetricsTypes";
import type { TrackEnvelope } from "./federationSyncPage";

/** Record a page outcome only when its corresponding vector action occurred. */
export function recordAppliedFederationEmbeddingOutcome(
    outcome: FederationEmbeddingPageOutcome | null,
    appliedTracks: readonly TrackEnvelope[],
): void {
    if (!outcome) return;
    const storedAny = appliedTracks.some(
        (item) => item.attributes.embedding !== undefined,
    );
    if (outcome === "stored" && !storedAny) return;
    recordFederationEmbeddingPageOutcome(outcome);
}

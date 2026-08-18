import {
    FEDERATION_CAPABILITY_VALUES,
    type FederationCapability,
} from "@soundspan/media-metadata-contract";
import { z } from "zod";

const MAX_CAPABILITIES = 64;

function isKnownFederationCapability(
    value: string,
): value is FederationCapability {
    return FEDERATION_CAPABILITY_VALUES.some((known) => known === value);
}

/** Parses a bounded peer advertisement and ignores capabilities unknown locally. */
export const federationCapabilitiesSchema = z
    .array(z.string().min(1).max(128))
    .max(MAX_CAPABILITIES)
    .optional()
    .default([])
    .transform((values) => [
        ...new Set(values.filter(isKnownFederationCapability)),
    ]);

export { FEDERATION_CAPABILITY_VALUES };
export type { FederationCapability };

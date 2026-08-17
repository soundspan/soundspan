import { z } from "zod";
import type {
    FederationEmbeddingSpaceIdentity,
    ParsedFederationEmbeddingSpaceIdentity,
} from "./federationEmbeddingSpace";

/** Skew-safe federation response header carrying an embedding-space identity. */
export const FEDERATION_EMBEDDING_SPACE_HEADER = "X-Soundspan-Embedding-Space";

const embeddingSpaceHeaderSchema = z
    .looseObject({
        family: z.string().min(1).max(200),
        checkpointHash: z.string().min(1).max(256),
        dim: z.number().int().positive().max(65_536),
    })
    .transform(({ family, checkpointHash, dim }) => ({
        family,
        checkpointHash,
        dim,
    }));

/**
 * Encode the stable tuple as the JSON response-header value. Non-ASCII is
 * escaped to \uXXXX: header values must stay Latin-1-safe or setHeader
 * throws ERR_INVALID_CHAR, turning every embeddings-scoped request into a
 * 500 if a registry value ever carries such characters.
 */
export function encodeFederationEmbeddingSpaceHeader(
    identity: FederationEmbeddingSpaceIdentity,
): string {
    return JSON.stringify(identity).replace(
        /[\u0080-\uffff]/g,
        (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

/** Parse a peer header without rejecting future additive tuple fields. */
export function parseFederationEmbeddingSpaceHeader(
    value: unknown,
): ParsedFederationEmbeddingSpaceIdentity | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return null;
    try {
        const parsed: unknown = JSON.parse(value);
        const result = embeddingSpaceHeaderSchema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch (_error: unknown) {
        return null;
    }
}

import { z } from "zod";
import type {
    FederationEmbeddingSpaceIdentity,
    ParsedFederationEmbeddingSpaceIdentity,
} from "./federationEmbeddingSpace";

/** Skew-safe federation response header carrying an embedding-space identity. */
export const FEDERATION_EMBEDDING_SPACE_HEADER = "X-Soundspan-Embedding-Space";
/** Request header advertising that the consumer validates embedding-space identity. */
export const FEDERATION_EMBEDDING_SPACE_ACCEPT_HEADER =
    "X-Soundspan-Embedding-Space-Accept";
/** Current embedding-space negotiation capability value. */
export const FEDERATION_EMBEDDING_SPACE_ACCEPT_VALUE = "1";

const embeddingSpaceHeaderSchema = z
    .looseObject({
        family: z.string().min(1).max(200),
        checkpointHash: z.string().min(1).max(256),
        dim: z.number().int().positive().max(65_536),
        preprocessingHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
    })
    .transform(({ family, checkpointHash, dim, preprocessingHash }) => ({
        family,
        checkpointHash,
        dim,
        ...(preprocessingHash ? { preprocessingHash } : {}),
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

/** Parse the additive tuple; preprocessingHash is optional for older 2.3 peers. */
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

/** Accept only the explicitly advertised embedding-space capability version. */
export function acceptsFederationEmbeddingSpace(value: unknown): boolean {
    return value === FEDERATION_EMBEDDING_SPACE_ACCEPT_VALUE;
}

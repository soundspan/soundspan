export type SubsonicEntityType = "artist" | "album" | "track" | "playlist";

const ENTITY_PREFIX: Record<SubsonicEntityType, string> = {
    artist: "ar",
    album: "al",
    track: "tr",
    playlist: "pl",
};

const PREFIX_ENTITY = new Map(
    Object.entries(ENTITY_PREFIX).map(([entity, prefix]) => [
        prefix,
        entity as SubsonicEntityType,
    ]),
);

export class SubsonicIdError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SubsonicIdError";
    }
}

export function toSubsonicId(type: SubsonicEntityType, id: string): string {
    return `${ENTITY_PREFIX[type]}-${id}`;
}

/**
 * Backward-compatible policy:
 * - Preferred: prefixed IDs (ar-, al-, tr-, pl-)
 * - Accepted: raw internal IDs when an expected type is provided
 */
export function parseSubsonicId(
    rawId: string,
    expectedType?: SubsonicEntityType,
): { type: SubsonicEntityType; id: string } {
    const trimmed = rawId.trim();
    if (!trimmed) {
        throw new SubsonicIdError("ID is empty");
    }

    const firstDash = trimmed.indexOf("-");
    if (firstDash > 0) {
        const prefix = trimmed.slice(0, firstDash);
        const entityType = PREFIX_ENTITY.get(prefix);
        if (entityType) {
            const id = trimmed.slice(firstDash + 1);
            if (!id) {
                throw new SubsonicIdError("ID payload is empty");
            }

            if (expectedType && entityType !== expectedType) {
                throw new SubsonicIdError(
                    `ID type mismatch: expected ${expectedType}, got ${entityType}`,
                );
            }

            return { type: entityType, id };
        }
    }

    if (!expectedType) {
        throw new SubsonicIdError("Unprefixed ID requires expected entity type");
    }

    return { type: expectedType, id: trimmed };
}

/** Scopes recognized by the v1 host federation API. */
export const FEDERATION_SCOPE_VALUES = [
    "library:read",
    "stream:read",
    "embeddings:read",
    "social:read",
] as const;

/** One authorization capability granted to a federation peer. */
export type FederationScope = (typeof FEDERATION_SCOPE_VALUES)[number];

const FEDERATION_SCOPE_SET = new Set<string>(FEDERATION_SCOPE_VALUES);

/** Validates persisted or otherwise untyped federation scope values. */
export function parseFederationScopes(
    value: unknown,
): FederationScope[] | null {
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > FEDERATION_SCOPE_VALUES.length
    ) {
        return null;
    }
    const scopes: FederationScope[] = [];
    for (let index = 0; index < FEDERATION_SCOPE_VALUES.length; index += 1) {
        if (index >= value.length) break;
        const scope = value[index];
        if (typeof scope !== "string" || !FEDERATION_SCOPE_SET.has(scope)) {
            return null;
        }
        scopes.push(scope as FederationScope);
    }
    if (new Set(scopes).size !== scopes.length) return null;
    if (
        scopes.includes("embeddings:read") &&
        !scopes.includes("library:read")
    ) {
        return null;
    }
    if (scopes.includes("social:read") && !scopes.includes("library:read")) {
        return null;
    }
    return scopes;
}

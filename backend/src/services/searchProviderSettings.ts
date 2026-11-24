import { z } from "zod";

/** Catalog search providers behind Search's Discover results. */
export const SEARCH_PROVIDER_VALUES = [
    "lastfm",
    "deezer",
    "tidal",
    "youtube",
] as const;

/** One configurable catalog search provider. */
export type SearchProvider = (typeof SEARCH_PROVIDER_VALUES)[number];

/** Persisted default priority: every provider, Last.fm first. */
export const DEFAULT_SEARCH_PROVIDER_ORDER_VALUE =
    SEARCH_PROVIDER_VALUES.join(",");

/**
 * Persisted default enabled set. TIDAL and YouTube Music search through their
 * sidecars, so an admin turns them on deliberately.
 */
export const DEFAULT_ENABLED_SEARCH_PROVIDERS_VALUE = "lastfm,deezer";

const PROVIDER_SET = new Set<string>(SEARCH_PROVIDER_VALUES);

function isSearchProvider(value: string): value is SearchProvider {
    return PROVIDER_SET.has(value);
}

function splitList(value: string): string[] {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/**
 * Parses a stored priority order. Unknown and repeated entries are dropped and
 * providers the value does not list keep their default place at the end.
 */
export function parseSearchProviderOrder(value: unknown): SearchProvider[] {
    const stored =
        typeof value === "string"
            ? splitList(value).filter(isSearchProvider)
            : [];
    const order = [...new Set(stored)];
    for (const provider of SEARCH_PROVIDER_VALUES) {
        if (!order.includes(provider)) order.push(provider);
    }
    return order;
}

/** Parses the stored enabled providers, ignoring unknown entries. */
export function parseEnabledSearchProviders(
    value: unknown,
): Set<SearchProvider> {
    const stored =
        typeof value === "string"
            ? value
            : DEFAULT_ENABLED_SEARCH_PROVIDERS_VALUE;
    return new Set(splitList(stored).filter(isSearchProvider));
}

/** Returns true only for a complete, duplicate-free provider permutation. */
export function isSearchProviderOrder(value: string): boolean {
    const entries = splitList(value);
    return (
        entries.length === SEARCH_PROVIDER_VALUES.length &&
        entries.every(isSearchProvider) &&
        new Set(entries).size === entries.length
    );
}

/** Returns true for a duplicate-free list of known providers (may be empty). */
export function isEnabledSearchProviderList(value: string): boolean {
    const entries = splitList(value);
    return (
        entries.every(isSearchProvider) &&
        new Set(entries).size === entries.length
    );
}

/** Enabled providers in the admin's priority order. */
export function resolveSearchProviders(settings: {
    searchProviderOrder?: unknown;
    searchProvidersEnabled?: unknown;
}): SearchProvider[] {
    const enabled = parseEnabledSearchProviders(
        settings.searchProvidersEnabled,
    );
    return parseSearchProviderOrder(settings.searchProviderOrder).filter(
        (provider) => enabled.has(provider),
    );
}

/** System-settings API fields for the search provider order and enabled set. */
export const searchProviderFields = {
    searchProviderOrder: z
        .string()
        .refine(isSearchProviderOrder, "Invalid search provider order")
        .optional(),
    searchProvidersEnabled: z
        .string()
        .refine(isEnabledSearchProviderList, "Invalid search providers")
        .optional(),
};

import type { DiscoverResult } from "./types";

export interface DiscoverySelectionInput {
    discoverResults: DiscoverResult[];
    query: string;
    aliasCanonical?: string | null;
    libraryTopName?: string | null;
    showDiscover: boolean;
}

export interface DiscoverySelection {
    /** The external artist to offer as the top result, if any. */
    topArtist: DiscoverResult | undefined;
    /** True when the external artist should beat the library artist. */
    preferDiscovery: boolean;
    /** True when TopResult will actually display the external artist. */
    discoveryShownAsTop: boolean;
    /** External artists for the Artists section (top excluded only when shown). */
    secondaryArtists: DiscoverResult[];
    /** External track matches. */
    tracks: DiscoverResult[];
}

/**
 * Normalizes an artist name for exact-match comparison: trims, lowercases,
 * and strips diacritics so a corrected "bjork" query matches "Björk".
 */
export function normalizeArtistName(value: string): string {
    return value.trim().toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
}

/**
 * Derives which external search results to surface and whether an
 * exact-name external match should beat a fuzzy library match, honoring
 * the active source filter and the backend's alias correction.
 */
export function deriveDiscoverySelection({
    discoverResults,
    query,
    aliasCanonical,
    libraryTopName,
    showDiscover,
}: DiscoverySelectionInput): DiscoverySelection {
    // Nothing external is selectable when the active filter hides discovery.
    if (!showDiscover) {
        return {
            topArtist: undefined,
            preferDiscovery: false,
            discoveryShownAsTop: false,
            secondaryArtists: [],
            tracks: [],
        };
    }

    const artists = discoverResults.filter((r) => r.type === "music");
    const tracks = discoverResults.filter((r) => r.type === "track");

    const exactTargets = [query, aliasCanonical ?? ""]
        .map((value) => normalizeArtistName(value))
        .filter(Boolean);

    const matchesExactly = (name: string) =>
        exactTargets.includes(normalizeArtistName(name));

    const exactArtist = artists.find((artist) => matchesExactly(artist.name));
    const libraryTopIsExact =
        !!libraryTopName && matchesExactly(libraryTopName);

    const topArtist = exactArtist ?? artists[0];
    const preferDiscovery = !!exactArtist && !libraryTopIsExact;
    const discoveryShownAsTop =
        !!topArtist && (preferDiscovery || !libraryTopName);

    const secondaryArtists = discoveryShownAsTop
        ? artists.filter((artist) => artist !== topArtist)
        : artists;

    return {
        topArtist,
        preferDiscovery,
        discoveryShownAsTop,
        secondaryArtists,
        tracks,
    };
}

import {
    normalizeForExactKey,
    normalizeForFuzzyMatch,
    stripAlbumEdition,
} from "../utils/artistNormalization";

/** Requested artist and album title used to verify provider search results. */
export interface AlbumMatchRequest {
    artistName: string;
    albumTitle: string;
}

/** Provider candidate fields required by the album-match policy. */
export interface AlbumMatchCandidate {
    artistName: string;
    albumTitle: string;
}

type TitleMatchTier = "exact" | "edition" | "folded";

const TITLE_MATCH_TIERS = [
    "exact",
    "edition",
    "folded",
] as const satisfies readonly TitleMatchTier[];

const SYMBOL_FOLDS = new Map<string, string>([
    ["×", "x"],
    ["✕", "x"],
    ["✖", "x"],
    ["⨯", "x"],
    ["‐", "-"],
    ["‑", "-"],
    ["‒", "-"],
    ["–", "-"],
    ["—", "-"],
    ["―", "-"],
    ["−", "-"],
    ["﹣", "-"],
    ["⁄", "/"],
    ["∕", "/"],
    ["∗", "*"],
    ["‘", "'"],
    ["’", "'"],
    ["“", '"'],
    ["”", '"'],
]);

/** Fold common typographic and mathematical look-alikes to keyboard symbols. */
export function foldAlbumSymbols(value: string): string {
    return Array.from(
        value.normalize("NFKC"),
        (character) => SYMBOL_FOLDS.get(character) ?? character,
    ).join("");
}

function normalizedSymbolKey(value: string): string {
    return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

function normalizedFoldedSymbolKey(value: string): string | null {
    if (!value.trim()) return null;
    return normalizedSymbolKey(foldAlbumSymbols(value)) || null;
}

function normalizedComparisonKey(value: string): string | null {
    if (!value.trim()) return null;
    return normalizeForExactKey(value) || normalizedSymbolKey(value) || null;
}

function normalizedArtistTokens(value: string): string {
    return normalizeForFuzzyMatch(value.replace(/\p{P}+/gu, " "));
}

function withoutLeadingArticle(value: string): string {
    if (value === "the") return "";
    return value.startsWith("the ") ? value.slice(4) : value;
}

function containsRequestedArtist(
    requestedTokens: string,
    candidateTokens: string,
): boolean {
    return (
        requestedTokens.length >= 3 &&
        ` ${candidateTokens} `.includes(` ${requestedTokens} `)
    );
}

function comparisonKeysMatch(
    requestedValue: string,
    candidateValue: string,
): boolean {
    const requestedKey = normalizedComparisonKey(requestedValue);
    const candidateKey = normalizedComparisonKey(candidateValue);
    return requestedKey !== null && requestedKey === candidateKey;
}

function titleMatchTier(
    requestedTitle: string,
    candidateTitle: string,
): TitleMatchTier | null {
    if (comparisonKeysMatch(requestedTitle, candidateTitle)) return "exact";
    if (
        comparisonKeysMatch(
            stripAlbumEdition(requestedTitle),
            stripAlbumEdition(candidateTitle),
        )
    ) {
        return "edition";
    }

    const foldedRequest = foldAlbumSymbols(requestedTitle);
    const foldedCandidate = foldAlbumSymbols(candidateTitle);
    if (comparisonKeysMatch(foldedRequest, foldedCandidate)) return "folded";
    return comparisonKeysMatch(
        stripAlbumEdition(foldedRequest),
        stripAlbumEdition(foldedCandidate),
    )
        ? "folded"
        : null;
}

function artistMatches(
    requestedArtist: string,
    candidateArtist: string,
): boolean {
    if (!requestedArtist.trim() || !candidateArtist.trim()) return false;
    const requestedExact = normalizeForExactKey(requestedArtist);
    const candidateExact = normalizeForExactKey(candidateArtist);
    if (!requestedExact || !candidateExact) {
        const requestedSymbol = normalizedFoldedSymbolKey(requestedArtist);
        const candidateSymbol = normalizedFoldedSymbolKey(candidateArtist);
        return requestedSymbol !== null && requestedSymbol === candidateSymbol;
    }
    if (candidateExact === requestedExact) return true;

    const requestedTokens = normalizedArtistTokens(requestedArtist);
    const candidateTokens = normalizedArtistTokens(candidateArtist);
    if (containsRequestedArtist(requestedTokens, candidateTokens)) return true;

    return containsRequestedArtist(
        withoutLeadingArticle(requestedTokens),
        withoutLeadingArticle(candidateTokens),
    );
}

/**
 * Verify that a provider candidate matches both the requested artist and title.
 * Empty or non-normalizable fields are rejected.
 */
export function isAcceptableAlbumMatch(
    request: AlbumMatchRequest,
    candidate: AlbumMatchCandidate,
): boolean {
    return (
        titleMatchTier(request.albumTitle, candidate.albumTitle) !== null &&
        artistMatches(request.artistName, candidate.artistName)
    );
}

function findInTier<T>(
    request: AlbumMatchRequest,
    candidates: T[],
    read: (candidate: T) => AlbumMatchCandidate,
    tier: TitleMatchTier,
): T | null {
    return (
        candidates.find((candidate) => {
            const fields = read(candidate);
            return (
                titleMatchTier(request.albumTitle, fields.albumTitle) ===
                    tier && artistMatches(request.artistName, fields.artistName)
            );
        }) ?? null
    );
}

/**
 * Pick the first acceptable provider candidate in the strongest title tier.
 * Exact and edition-stripped matches take precedence over folded matches.
 * Provider order is retained within each tier.
 */
export function pickBestAlbumMatch<T>(
    request: AlbumMatchRequest,
    candidates: T[],
    read: (candidate: T) => AlbumMatchCandidate,
): T | null {
    if (!normalizedComparisonKey(request.artistName)) return null;
    if (!normalizedComparisonKey(request.albumTitle)) return null;

    for (const tier of TITLE_MATCH_TIERS) {
        const match = findInTier(request, candidates, read, tier);
        if (match) return match;
    }
    return null;
}

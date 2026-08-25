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

type TitleMatchTier = "exact" | "edition";

function normalizedExact(value: string): string | null {
    if (!value.trim()) return null;
    return normalizeForExactKey(value) || null;
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

function titleMatchTier(
    requestedTitle: string,
    candidateTitle: string,
): TitleMatchTier | null {
    const requestedExact = normalizedExact(requestedTitle);
    const candidateExact = normalizedExact(candidateTitle);
    if (!requestedExact || !candidateExact) return null;
    if (candidateExact === requestedExact) return "exact";

    const requestedBase = normalizedExact(stripAlbumEdition(requestedTitle));
    const candidateBase = normalizedExact(stripAlbumEdition(candidateTitle));
    if (!requestedBase || !candidateBase) return null;
    return candidateBase === requestedBase ? "edition" : null;
}

function artistMatches(
    requestedArtist: string,
    candidateArtist: string,
): boolean {
    const requestedExact = normalizedExact(requestedArtist);
    const candidateExact = normalizedExact(candidateArtist);
    if (!requestedExact || !candidateExact) return false;
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
 * Exact-title matches take precedence over edition-stripped matches while
 * provider order is retained within each tier.
 */
export function pickBestAlbumMatch<T>(
    request: AlbumMatchRequest,
    candidates: T[],
    read: (candidate: T) => AlbumMatchCandidate,
): T | null {
    if (!normalizedExact(request.artistName)) return null;
    if (!normalizedExact(request.albumTitle)) return null;

    const exact = findInTier(request, candidates, read, "exact");
    if (exact) return exact;
    return findInTier(request, candidates, read, "edition");
}

type SoulseekSearchTermKind = "artist" | "title";

/**
 * Normalize an artist or title for Soulseek result ranking.
 * Artist terms omit a leading "the"; title terms omit a leading track number.
 */
export function normalizeSoulseekSearchTerm(
    term: string,
    kind: SoulseekSearchTermKind,
): string {
    let normalized = term.toLowerCase();
    if (kind === "artist") {
        normalized = normalized.replace(/^the\s+/, "");
    }
    normalized = normalized.replace(/&/g, " and ");
    normalized = normalized.replace(/[^a-z0-9\s]/g, "");
    if (kind === "title") {
        normalized = normalized.replace(/^\d+\s*[-.]?\s*/, "");
    }
    return normalized.replace(/\s+/g, " ").trim();
}

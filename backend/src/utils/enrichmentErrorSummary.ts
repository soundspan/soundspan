const URL_TOKEN_PATTERN =
    /^([a-z][a-z\d+.-]*:\/\/)(?:[^/?#@]*@)?([^/?#@]+)([/?#]\S*)?$/i;
const DRIVE_PATH_TOKEN_PATTERN = /^[A-Za-z]:[\\/]/;
const COLON_PAYLOAD_TOKEN_PATTERN = /^[A-Za-z\d+.-]*:\S/;
const LEADING_PUNCTUATION_PATTERN = /^[("'[{<`,;]+/;
const TRAILING_PUNCTUATION_PATTERN = /[)"'\]}>`.,;:!?]+$/;

function sanitizeToken(token: string): string {
    // Sensitive payloads often arrive wrapped in quotes or brackets; strip the
    // wrapping before classifying so punctuation cannot defeat redaction, but
    // rewrite the WHOLE token when the core matches.
    const leading = LEADING_PUNCTUATION_PATTERN.exec(token)?.[0] ?? "";
    const withoutLeading = token.slice(leading.length);
    const trailing =
        TRAILING_PUNCTUATION_PATTERN.exec(withoutLeading)?.[0] ?? "";
    const core = withoutLeading.slice(
        0,
        withoutLeading.length - trailing.length,
    );
    const urlParts = URL_TOKEN_PATTERN.exec(core);
    if (urlParts) {
        const [, scheme, host, suffix] = urlParts;
        return `${leading}${scheme}${host}${suffix ? "/[...]" : ""}${trailing}`;
    }
    if (
        DRIVE_PATH_TOKEN_PATTERN.test(core) ||
        core.includes("/") ||
        core.includes("\\")
    ) {
        return "[path]";
    }
    if (COLON_PAYLOAD_TOKEN_PATTERN.test(core)) return "[redacted]";
    return token;
}

/**
 * Return a bounded client-safe summary of an internal enrichment error.
 * A directory word surrounded by spaces can remain when that token contains
 * no path separator, such as the middle word in "Artist Name Two".
 * Pure so route tests that mock the failure service keep the real sanitizer.
 */
export function sanitizeEnrichmentErrorSummary(
    message: string | null,
): string | null {
    if (message === null) return null;
    const collapsed = message.replace(/\s+/g, " ");
    const sanitized = collapsed
        .split(" ")
        .map((token) => sanitizeToken(token))
        .join(" ")
        .trim();
    return Array.from(sanitized).slice(0, 200).join("");
}

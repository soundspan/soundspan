/**
 * Normalize typographic quotes/apostrophes to ASCII equivalents.
 */
export function normalizeQuotes(str: string): string {
    return str
        .replace(/[\u2018\u2019\u02BC\u02BB]/g, "'")
        .replace(/[\u201C\u201D]/g, '"');
}

/**
 * Normalize fullwidth Unicode characters to ASCII equivalents.
 * Example: ＧＨＯＳＴ -> GHOST
 */
export function normalizeFullwidth(str: string): string {
    return str
        .replace(/[\uFF01-\uFF5E]/g, (char) =>
            String.fromCharCode(char.charCodeAt(0) - 0xFEE0)
        )
        .replace(/\u3000/g, " ")
        .trim();
}

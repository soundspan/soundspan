/**
 * Decode a dynamic route segment that may be percent-encoded.
 *
 * Next.js usually decodes params, but ids containing encoded separators can
 * arrive still-encoded; malformed sequences fall back to the raw value so a
 * bad URL renders a not-found state instead of throwing.
 */
export function decodeRouteId(id: string): string {
    try {
        return decodeURIComponent(id);
    } catch {
        return id;
    }
}

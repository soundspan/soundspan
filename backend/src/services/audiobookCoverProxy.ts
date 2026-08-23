/**
 * Strict allowlist confining a caller/DB-supplied Audiobookshelf cover path to
 * the ABS `items/` resource namespace (e.g. `items/<id>/cover`,
 * `items/covers/<file>.jpg`). The percent sign is deliberately excluded so a
 * double-encoded traversal (`%2e%2e`) fails the pattern rather than slipping
 * past the literal `..` check below.
 */
const AUDIOBOOK_COVER_PATH_RE = /^items\/[A-Za-z0-9_\-./]+$/;
const SAFE_COVER_FILENAME_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Builds a cache filename only for conservative, non-hidden audiobook IDs.
 * Slash, backslash, percent-encoded traversal prefixes, and leading dots are
 * rejected so normalization cannot alias another audiobook's cover file.
 */
export function safeCoverFilename(audiobookId: string): string | null {
    return SAFE_COVER_FILENAME_ID_RE.test(audiobookId)
        ? `${audiobookId}.jpg`
        : null;
}

/**
 * Returns true only when `coverPath` stays within the confined Audiobookshelf
 * cover/items namespace. Traversal (`..`), backslashes, and leading slashes are
 * rejected before the allowlist test so a caller- or DB-supplied segment cannot
 * escape `/api/items/...` into an arbitrary ABS admin-API path (e.g. `/api/me`,
 * `/api/users`) once WHATWG URL normalization collapses `..` segments.
 */
export function isSafeAudiobookCoverPath(coverPath: string): boolean {
    if (
        !coverPath ||
        coverPath.includes("..") ||
        coverPath.includes("\\") ||
        coverPath.startsWith("/")
    ) {
        return false;
    }
    return AUDIOBOOK_COVER_PATH_RE.test(coverPath);
}

/**
 * Validates a caller- or DB-supplied Audiobookshelf cover path against the
 * strict allowlist and builds the confined `${baseUrl}/api/<path>` URL. Returns
 * the URL, or `null` when the path is unsafe. The ABS base host itself is
 * operator-configured (commonly an internal/LAN address) and is intentionally
 * not subjected to the outbound private-host SSRF policy: the caller controls
 * only the path segment, which this allowlist confines to the `items/`
 * namespace, so no host-pivot SSRF surface remains.
 */
export function buildSafeAudiobookCoverUrl(
    coverPath: string,
    audiobookshelfBaseUrl: string,
): string | null {
    if (!isSafeAudiobookCoverPath(coverPath)) {
        return null;
    }
    return `${audiobookshelfBaseUrl}/api/${coverPath}`;
}

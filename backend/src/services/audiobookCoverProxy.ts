import { resolveSafeOutboundUrl } from "./outboundUrlSafety";

/** Strict allowlist for the Audiobookshelf cover endpoint path shape:
 * `items/<id>/cover`. Item ids are ABS-assigned (`[A-Za-z0-9_-]+`; UUIDs or
 * legacy `li_...`). */
const AUDIOBOOK_COVER_PATH_RE = /^items\/[A-Za-z0-9_-]+\/cover$/;

/**
 * Returns true only for the confined Audiobookshelf cover-endpoint path shape
 * (`items/<id>/cover`). Traversal (`..`), backslashes, and leading slashes are
 * rejected before the allowlist test so a caller- or DB-supplied segment cannot
 * escape the cover endpoint into an arbitrary ABS admin-API path once WHATWG URL
 * normalization collapses `..` segments.
 */
export function isSafeAudiobookCoverPath(coverPath: string): boolean {
    if (
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
 * strict allowlist, builds the confined `${baseUrl}/api/<path>` URL, and runs it
 * through the shared DNS-resolving outbound SSRF policy (which also validates the
 * ABS base host). Returns the safe absolute URL, or `null` when the path is
 * unsafe or the host resolves to a private/loopback/link-local address. The
 * outbound safety check is skipped for unsafe paths so no lookup is performed on
 * a rejected request.
 */
export async function resolveSafeAudiobookCoverUrl(
    coverPath: string,
    audiobookshelfBaseUrl: string,
): Promise<string | null> {
    if (!isSafeAudiobookCoverPath(coverPath)) {
        return null;
    }
    const candidate = `${audiobookshelfBaseUrl}/api/${coverPath}`;
    return resolveSafeOutboundUrl(candidate);
}

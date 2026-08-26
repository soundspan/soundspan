import type { ScrobblingStatus } from "@/lib/api/scrobbling";

/** Names the server value(s) the operator still needs to set. */
export function missingLastFmValues(
    status: ScrobblingStatus["lastfm"],
): string {
    const missing = [
        !status.apiKeyConfigured && "LASTFM_API_KEY",
        !status.sharedSecretConfigured && "LASTFM_SHARED_SECRET",
    ].filter(Boolean);
    return missing.length > 0
        ? missing.join(" and ")
        : "LASTFM_API_KEY and LASTFM_SHARED_SECRET";
}

/** Row description for the Last.fm scrobbling settings entry. */
export function lastFmDescription(status: ScrobblingStatus["lastfm"]): string {
    if (!status.serverConfigured) {
        const missing = missingLastFmValues(status);
        return status.connected
            ? `This server is missing ${missing}; existing scrobbling may fail. You can still disconnect.`
            : `Last.fm scrobbling is unavailable: this server is missing ${missing}. Ask your server admin to set it.`;
    }
    return "Sign in with your Last.fm account to scrobble plays";
}

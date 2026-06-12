const IPV4_PRIVATE_172_RE = /^172\.(1[6-9]|2[0-9]|3[0-1])\./;
const IPV6_LINK_LOCAL_RE = /^fe[89ab]/i;

function stripIpv6Brackets(hostname: string): string {
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
        return hostname.slice(1, -1);
    }

    return hostname;
}

function isBlockedIpv4Hostname(hostname: string): boolean {
    return (
        hostname === "127.0.0.1" ||
        hostname === "0.0.0.0" ||
        hostname.startsWith("10.") ||
        hostname.startsWith("192.168.") ||
        hostname.startsWith("169.254.") ||
        IPV4_PRIVATE_172_RE.test(hostname)
    );
}

function isBlockedIpv6Hostname(hostname: string): boolean {
    const normalized = stripIpv6Brackets(hostname).toLowerCase();

    if (normalized === "::1" || normalized === "::") {
        return true;
    }

    if (normalized.startsWith("::ffff:")) {
        return isBlockedIpv4Hostname(normalized.slice("::ffff:".length));
    }

    return (
        IPV6_LINK_LOCAL_RE.test(normalized) ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd")
    );
}

function isBlockedHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase();

    return (
        normalized === "localhost" ||
        normalized.endsWith(".localhost") ||
        normalized.endsWith(".local") ||
        normalized.endsWith(".internal") ||
        isBlockedIpv4Hostname(normalized) ||
        isBlockedIpv6Hostname(normalized)
    );
}

/**
 * Normalizes an outbound URL and rejects private, loopback, link-local, and
 * non-HTTP(S) destinations so backend routes can share one SSRF policy.
 */
export function normalizeSafeOutboundUrl(rawUrl: string): string | null {
    try {
        const parsedUrl = new URL(rawUrl);

        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            return null;
        }

        if (isBlockedHostname(parsedUrl.hostname)) {
            return null;
        }

        return parsedUrl.toString();
    } catch {
        return null;
    }
}

/**
 * Resolves a redirect target against the current outbound URL and re-applies
 * the shared outbound safety policy to the resolved destination.
 */
export function normalizeSafeOutboundRedirectTarget(
    redirectTarget: string,
    currentUrl: string
): string | null {
    try {
        return normalizeSafeOutboundUrl(
            new URL(redirectTarget, currentUrl).toString()
        );
    } catch {
        return null;
    }
}

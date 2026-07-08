import { lookup } from "dns/promises";

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
        // Whole ranges, not just the canonical literals: 127.0.0.2,
        // 127.0.0.53 (systemd-resolved), 0.1.2.3 etc. are equally loopback/
        // "this network" targets, and this predicate also range-checks
        // DNS-RESOLVED addresses, where any 127/8 answer is an SSRF vector.
        hostname.startsWith("127.") ||
        hostname.startsWith("0.") ||
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

/**
 * Validate that the hostname's RESOLVED address(es) are all public. The
 * string-only `normalizeSafeOutboundUrl` is bypassed by alternate IP encodings
 * (decimal `2130706433`, hex `0x7f000001`, octal, `127.1`) and by DNS names that
 * point at an internal address; resolving via getaddrinfo normalizes those
 * encodings and exposes the real target IPs, which are then range-checked.
 * Returns true only if every resolved address is public.
 *
 * Note: this checks at resolve time; a DNS-rebinding attacker could in theory
 * return a different address to the subsequent fetch. Pinning the resolved IP
 * into the request agent would close that and is a larger follow-up.
 */
async function hasOnlyPublicResolvedAddresses(
    hostname: string
): Promise<boolean> {
    const host = stripIpv6Brackets(hostname);
    try {
        const addresses = await lookup(host, { all: true });
        if (addresses.length === 0) {
            return false;
        }
        return addresses.every(
            ({ address }) =>
                !isBlockedIpv4Hostname(address) &&
                !isBlockedIpv6Hostname(address)
        );
    } catch {
        return false;
    }
}

/**
 * Like `normalizeSafeOutboundUrl`, but additionally resolves the hostname via
 * DNS and rejects the URL if any resolved address is private/loopback/link-local
 * (closing the alternate-encoding and DNS-to-internal SSRF bypasses). Async;
 * apply at the point an outbound request is actually made.
 */
export async function resolveSafeOutboundUrl(
    rawUrl: string
): Promise<string | null> {
    const normalized = normalizeSafeOutboundUrl(rawUrl);
    if (!normalized) {
        return null;
    }
    const { hostname } = new URL(normalized);
    return (await hasOnlyPublicResolvedAddresses(hostname))
        ? normalized
        : null;
}

/**
 * DNS-resolving variant of `normalizeSafeOutboundRedirectTarget` for following
 * redirects safely (each hop is re-resolved and range-checked).
 */
export async function resolveSafeOutboundRedirectTarget(
    redirectTarget: string,
    currentUrl: string
): Promise<string | null> {
    let absolute: string;
    try {
        absolute = new URL(redirectTarget, currentUrl).toString();
    } catch {
        return null;
    }
    return resolveSafeOutboundUrl(absolute);
}

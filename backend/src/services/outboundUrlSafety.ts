import dns = require("dns");
import { lookup } from "dns/promises";

const IPV4_PRIVATE_172_RE = /^172\.(1[6-9]|2[0-9]|3[0-1])\./;
const IPV4_DOTTED_QUAD_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_LINK_LOCAL_RE = /^fe[89ab]/i;
const VETTED_HOSTNAME_TTL_MS = 30_000;
const MAX_VETTED_HOSTNAMES = 256;
const vettedHostnames = new Map<string, number>();
let originalLookup: typeof dns.lookup | null = null;
let baseLookupOverride: typeof dns.lookup | null = null;

function stripIpv6Brackets(hostname: string): string {
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
        return hostname.slice(1, -1);
    }

    return hostname;
}

function parseIpv4Octets(
    hostname: string,
): [number, number, number, number] | null {
    const match = IPV4_DOTTED_QUAD_RE.exec(hostname);
    if (!match) {
        return null;
    }
    const first = Number(match[1]);
    const second = Number(match[2]);
    const third = Number(match[3]);
    const fourth = Number(match[4]);
    if (first > 255 || second > 255 || third > 255 || fourth > 255) {
        return null;
    }
    return [first, second, third, fourth];
}

function isBlockedReservedIpv4Hostname(hostname: string): boolean {
    const octets = parseIpv4Octets(hostname);
    if (!octets) {
        return false;
    }
    const [first, second] = octets;
    return (
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 198 && second >= 18 && second <= 19)
    );
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
        IPV4_PRIVATE_172_RE.test(hostname) ||
        isBlockedReservedIpv4Hostname(hostname)
    );
}

function decodeMappedIpv4Hostname(hostname: string): string {
    const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
    if (!match) {
        return hostname;
    }
    const high = Number.parseInt(match[1], 16);
    const low = Number.parseInt(match[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isBlockedIpv6Hostname(hostname: string): boolean {
    const normalized = stripIpv6Brackets(hostname).toLowerCase();

    if (normalized === "::1" || normalized === "::") {
        return true;
    }

    if (normalized.startsWith("::ffff:")) {
        const mappedHostname = normalized.slice("::ffff:".length);
        return isBlockedIpv4Hostname(
            decodeMappedIpv4Hostname(mappedHostname),
        );
    }

    return (
        IPV6_LINK_LOCAL_RE.test(normalized) ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd")
    );
}

/**
 * Returns whether an IP address is denied by the shared outbound SSRF policy.
 */
export function isBlockedAddress(address: string): boolean {
    return (
        isBlockedIpv4Hostname(address) || isBlockedIpv6Hostname(address)
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
    currentUrl: string,
): string | null {
    try {
        return normalizeSafeOutboundUrl(
            new URL(redirectTarget, currentUrl).toString(),
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
 * Returns true only if every resolved address is public. Successful validation
 * also enables a short-lived connect-time lookup check using this same policy,
 * closing the DNS-rebinding gap while the vetted-hostname entry remains live.
 */
async function hasOnlyPublicResolvedAddresses(
    hostname: string,
): Promise<boolean> {
    const host = stripIpv6Brackets(hostname);
    try {
        const addresses = await lookup(host, { all: true });
        if (addresses.length === 0) {
            return false;
        }
        return addresses.every(({ address }) => !isBlockedAddress(address));
    } catch {
        return false;
    }
}

function normalizeHostname(hostname: string): string {
    return stripIpv6Brackets(hostname).toLowerCase();
}

function registerVettedHostname(hostname: string): void {
    const normalized = normalizeHostname(hostname);
    vettedHostnames.delete(normalized);
    if (vettedHostnames.size >= MAX_VETTED_HOSTNAMES) {
        const oldest = vettedHostnames.keys().next().value;
        if (oldest !== undefined) {
            vettedHostnames.delete(oldest);
        }
    }
    vettedHostnames.set(normalized, Date.now() + VETTED_HOSTNAME_TTL_MS);
}

function isVettedHostname(hostname: string): boolean {
    const normalized = normalizeHostname(hostname);
    const expiry = vettedHostnames.get(normalized);
    if (expiry === undefined) {
        return false;
    }
    if (expiry <= Date.now()) {
        // Expiry and eviction intentionally fail open to pre-pinning behavior.
        vettedHostnames.delete(normalized);
        return false;
    }
    return true;
}

function createBlockedLookupError(hostname: string): NodeJS.ErrnoException {
    const error = new Error(
        `Outbound request blocked: connect-time DNS for ${hostname} returned a private, loopback, or link-local address`,
    ) as NodeJS.ErrnoException;
    error.code = "EOUTBOUNDBLOCKED";
    return error;
}

function hasBlockedLookupResult(result: unknown): boolean {
    if (Array.isArray(result)) {
        return result.some(
            (entry: dns.LookupAddress) => isBlockedAddress(entry.address),
        );
    }
    return typeof result === "string" && isBlockedAddress(result);
}

function guardedLookup(hostname: string, ...args: unknown[]): void {
    const delegate = baseLookupOverride ?? originalLookup;
    if (!delegate) {
        throw new Error("Outbound DNS lookup guard is not installed");
    }
    const callback = args.at(-1);
    if (!isVettedHostname(hostname) || typeof callback !== "function") {
        Reflect.apply(delegate, dns, [hostname, ...args]);
        return;
    }
    const guardedCallback = (...callbackArgs: unknown[]) => {
        if (!callbackArgs[0] && hasBlockedLookupResult(callbackArgs[1])) {
            callback(createBlockedLookupError(hostname));
            return;
        }
        callback(...callbackArgs);
    };
    Reflect.apply(delegate, dns, [hostname, ...args.slice(0, -1), guardedCallback]);
}

function installLookupGuard(): void {
    if (originalLookup) {
        return;
    }
    originalLookup = dns.lookup;
    (dns as { lookup: typeof dns.lookup }).lookup =
        guardedLookup as unknown as typeof dns.lookup;
}

/**
 * Test-only controls for resetting global guard state and supplying deterministic
 * callback-style DNS lookup behavior without using the host network.
 */
export const __testHooks = {
    resetRegistry(): void {
        vettedHostnames.clear();
    },
    setBaseLookup(baseLookup: typeof dns.lookup): void {
        baseLookupOverride = baseLookup;
    },
    uninstall(): void {
        if (originalLookup) {
            (dns as { lookup: typeof dns.lookup }).lookup = originalLookup;
        }
        originalLookup = null;
        baseLookupOverride = null;
    },
};

/**
 * Like `normalizeSafeOutboundUrl`, but additionally resolves the hostname via
 * DNS and rejects the URL if any resolved address is private/loopback/link-local
 * (closing the alternate-encoding and DNS-to-internal SSRF bypasses). Async;
 * apply at the point an outbound request is actually made.
 */
export async function resolveSafeOutboundUrl(
    rawUrl: string,
): Promise<string | null> {
    const normalized = normalizeSafeOutboundUrl(rawUrl);
    if (!normalized) {
        return null;
    }
    const { hostname } = new URL(normalized);
    if (!(await hasOnlyPublicResolvedAddresses(hostname))) {
        return null;
    }
    installLookupGuard();
    registerVettedHostname(hostname);
    return normalized;
}

/**
 * DNS-resolving variant of `normalizeSafeOutboundRedirectTarget` for following
 * redirects safely (each hop is re-resolved and range-checked).
 */
export async function resolveSafeOutboundRedirectTarget(
    redirectTarget: string,
    currentUrl: string,
): Promise<string | null> {
    let absolute: string;
    try {
        absolute = new URL(redirectTarget, currentUrl).toString();
    } catch {
        return null;
    }
    return resolveSafeOutboundUrl(absolute);
}

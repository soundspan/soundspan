const mockLookup = jest.fn();
jest.mock("dns/promises", () => ({
    lookup: (...args: unknown[]) => mockLookup(...args),
}));

import {
    normalizeSafeOutboundRedirectTarget,
    normalizeSafeOutboundUrl,
    resolveSafeOutboundUrl,
    resolveSafeOutboundRedirectTarget,
} from "../outboundUrlSafety";

describe("outboundUrlSafety", () => {
    beforeEach(() => {
        mockLookup.mockReset();
    });

    describe("resolveSafeOutboundUrl (DNS-resolving guard)", () => {
        it("allows a host that resolves to a public address", async () => {
            mockLookup.mockResolvedValue([
                { address: "93.184.216.34", family: 4 },
            ]);
            expect(
                await resolveSafeOutboundUrl("https://example.com/feed.xml")
            ).toBe("https://example.com/feed.xml");
        });

        it("rejects a host that resolves to a private/loopback address", async () => {
            mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
            expect(
                await resolveSafeOutboundUrl("https://internal.example.com")
            ).toBeNull();
        });

        it("rejects when ANY resolved address is private (DNS multi-record)", async () => {
            mockLookup.mockResolvedValue([
                { address: "93.184.216.34", family: 4 },
                { address: "127.0.0.1", family: 4 },
            ]);
            expect(
                await resolveSafeOutboundUrl("https://example.com")
            ).toBeNull();
        });

        it("closes the alternate-encoding bypass (decimal IP -> 127.0.0.1)", async () => {
            // getaddrinfo normalizes 2130706433 to 127.0.0.1 at runtime; here the
            // mock simulates that, and the resolved IP is range-checked.
            mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
            expect(await resolveSafeOutboundUrl("http://2130706433/")).toBeNull();
        });

        it("rejects an unresolvable host (and never resolves blocked literals)", async () => {
            mockLookup.mockRejectedValue(
                Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })
            );
            expect(
                await resolveSafeOutboundUrl("https://does-not-exist.invalid")
            ).toBeNull();

            // A host blocked by the sync pre-check never reaches DNS resolution.
            expect(await resolveSafeOutboundUrl("http://localhost")).toBeNull();
            expect(mockLookup).toHaveBeenCalledTimes(1);
        });

        it("rejects when DNS returns no addresses", async () => {
            mockLookup.mockResolvedValue([]);
            expect(await resolveSafeOutboundUrl("https://example.com")).toBeNull();
        });

        it("blocks ALL of 127.0.0.0/8 and 0.0.0.0/8, not just the canonical literals", async () => {
            // String pre-check: non-canonical loopback literals never reach DNS.
            expect(normalizeSafeOutboundUrl("http://127.0.0.2/")).toBeNull();
            expect(normalizeSafeOutboundUrl("http://127.255.0.1/")).toBeNull();
            expect(normalizeSafeOutboundUrl("http://0.1.2.3/")).toBeNull();
            expect(mockLookup).not.toHaveBeenCalled();

            // Resolved-IP check: a DNS name pointing anywhere in 127/8 (e.g.
            // systemd-resolved's 127.0.0.53) is rejected — previously only the
            // exact string "127.0.0.1" was range-checked, so this was a full
            // guard bypass without needing DNS rebinding.
            mockLookup.mockResolvedValue([
                { address: "127.0.0.53", family: 4 },
            ]);
            expect(
                await resolveSafeOutboundUrl("https://rebind.example.com/")
            ).toBeNull();
        });

        it("still allows public IPs that merely contain a blocked octet elsewhere", () => {
            // Prefix checks must anchor at the start of the address.
            expect(normalizeSafeOutboundUrl("http://8.127.0.1/")).toBe(
                "http://8.127.0.1/"
            );
            expect(normalizeSafeOutboundUrl("http://110.1.2.3/")).toBe(
                "http://110.1.2.3/"
            );
        });
    });

    describe("resolveSafeOutboundRedirectTarget", () => {
        it("resolves a relative redirect and re-validates the resolved IP", async () => {
            mockLookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
            expect(
                await resolveSafeOutboundRedirectTarget(
                    "/internal",
                    "https://evil.example.com/start"
                )
            ).toBeNull();
        });
    });

    describe("normalizeSafeOutboundUrl", () => {
        it("allows public http and https urls", () => {
            expect(
                normalizeSafeOutboundUrl("https://example.com/feed.xml")
            ).toBe("https://example.com/feed.xml");
            expect(normalizeSafeOutboundUrl("http://example.com/api")).toBe(
                "http://example.com/api"
            );
        });

        it("rejects invalid or unsupported urls", () => {
            expect(normalizeSafeOutboundUrl("file:///etc/passwd")).toBeNull();
            expect(normalizeSafeOutboundUrl("not-a-url")).toBeNull();
        });

        it("rejects loopback and private ipv4 destinations", () => {
            expect(normalizeSafeOutboundUrl("http://127.0.0.1/feed")).toBeNull();
            expect(normalizeSafeOutboundUrl("http://10.0.0.8/feed")).toBeNull();
            expect(normalizeSafeOutboundUrl("http://172.16.0.5/feed")).toBeNull();
            expect(normalizeSafeOutboundUrl("http://192.168.1.9/feed")).toBeNull();
        });

        it("rejects link-local and ipv6 local destinations", () => {
            expect(normalizeSafeOutboundUrl("http://169.254.1.5/feed")).toBeNull();
            expect(normalizeSafeOutboundUrl("http://[::1]/feed")).toBeNull();
            expect(normalizeSafeOutboundUrl("http://[fe80::1]/feed")).toBeNull();
            expect(normalizeSafeOutboundUrl("http://[fd00::1]/feed")).toBeNull();
        });

        it("rejects localhost and internal hostnames", () => {
            expect(normalizeSafeOutboundUrl("http://localhost/feed")).toBeNull();
            expect(normalizeSafeOutboundUrl("http://service.local/feed")).toBeNull();
            expect(normalizeSafeOutboundUrl("http://api.internal/feed")).toBeNull();
        });
    });

    describe("normalizeSafeOutboundRedirectTarget", () => {
        it("resolves safe relative redirect targets", () => {
            expect(
                normalizeSafeOutboundRedirectTarget(
                    "/next/feed.xml",
                    "https://example.com/start/feed.xml"
                )
            ).toBe("https://example.com/next/feed.xml");
        });

        it("rejects redirect targets that resolve to blocked destinations", () => {
            expect(
                normalizeSafeOutboundRedirectTarget(
                    "http://127.0.0.1/private",
                    "https://example.com/start/feed.xml"
                )
            ).toBeNull();
        });
    });
});

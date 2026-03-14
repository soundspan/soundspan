import {
    normalizeSafeOutboundRedirectTarget,
    normalizeSafeOutboundUrl,
} from "../outboundUrlSafety";

describe("outboundUrlSafety", () => {
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

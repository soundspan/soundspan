import * as dns from "dns";
import * as http from "http";

const mockLookup = jest.fn();
jest.mock("dns/promises", () => ({
    lookup: (...args: unknown[]) => mockLookup(...args),
}));

import {
    __testHooks,
    normalizeSafeOutboundRedirectTarget,
    normalizeSafeOutboundUrl,
    resolveSafeOutboundUrl,
    resolveSafeOutboundRedirectTarget,
} from "../outboundUrlSafety";

type LookupResult = dns.LookupAddress | dns.LookupAddress[];

function createBaseLookup(
    resolveAddress: (hostname: string) => dns.LookupAddress[],
): typeof dns.lookup {
    return ((
        hostname: string,
        optionsOrCallback: dns.LookupOptions | number | Function,
        possibleCallback?: Function,
    ) => {
        const callback =
            typeof optionsOrCallback === "function"
                ? optionsOrCallback
                : possibleCallback;
        const all =
            typeof optionsOrCallback === "object" &&
            optionsOrCallback.all === true;
        const addresses = resolveAddress(hostname);
        if (all) {
            callback?.(null, addresses);
            return;
        }
        callback?.(null, addresses[0].address, addresses[0].family);
    }) as unknown as typeof dns.lookup;
}

function lookupAll(hostname: string): Promise<dns.LookupAddress[]> {
    return new Promise((resolve, reject) => {
        dns.lookup(hostname, { all: true }, (error, addresses) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(addresses);
        });
    });
}

function lookupOne(hostname: string, family?: number): Promise<LookupResult> {
    return new Promise((resolve, reject) => {
        const callback = (
            error: NodeJS.ErrnoException | null,
            address: string,
            resultFamily: number,
        ) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ address, family: resultFamily });
        };
        if (family === undefined) {
            dns.lookup(hostname, callback);
            return;
        }
        dns.lookup(hostname, family, callback);
    });
}

async function startLocalServer(): Promise<http.Server> {
    const server = http.createServer((_request, response) => {
        response.end("local response");
    });
    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    return server;
}

function serverPort(server: http.Server): number {
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected local TCP server address");
    }
    return address.port;
}

async function closeServer(server: http.Server | null): Promise<void> {
    if (!server) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

describe("outboundUrlSafety", () => {
    let localServer: http.Server | null = null;

    beforeEach(() => {
        mockLookup.mockReset();
        __testHooks.uninstall();
        __testHooks.resetRegistry();
        jest.useRealTimers();
    });

    afterEach(async () => {
        __testHooks.uninstall();
        __testHooks.resetRegistry();
        jest.useRealTimers();
        await closeServer(localServer);
        localServer = null;
    });

    describe("resolveSafeOutboundUrl (DNS-resolving guard)", () => {
        it("allows a host that resolves to a public address", async () => {
            mockLookup.mockResolvedValue([
                { address: "93.184.216.34", family: 4 },
            ]);
            expect(
                await resolveSafeOutboundUrl("https://example.com/feed.xml"),
            ).toBe("https://example.com/feed.xml");
        });

        it("rejects a host that resolves to a private/loopback address", async () => {
            mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
            expect(
                await resolveSafeOutboundUrl("https://internal.example.com"),
            ).toBeNull();
        });

        it.each(["100.64.1.2", "198.18.5.5"])(
            "rejects a host that resolves to reserved address %s",
            async (address) => {
                mockLookup.mockResolvedValue([{ address, family: 4 }]);
                expect(
                    await resolveSafeOutboundUrl(
                        "https://reserved.example.com",
                    ),
                ).toBeNull();
            },
        );

        it("rejects when ANY resolved address is private (DNS multi-record)", async () => {
            mockLookup.mockResolvedValue([
                { address: "93.184.216.34", family: 4 },
                { address: "127.0.0.1", family: 4 },
            ]);
            expect(
                await resolveSafeOutboundUrl("https://example.com"),
            ).toBeNull();
        });

        it("closes the alternate-encoding bypass (decimal IP -> 127.0.0.1)", async () => {
            // getaddrinfo normalizes 2130706433 to 127.0.0.1 at runtime; here the
            // mock simulates that, and the resolved IP is range-checked.
            mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
            expect(
                await resolveSafeOutboundUrl("http://2130706433/"),
            ).toBeNull();
        });

        it("rejects an unresolvable host (and never resolves blocked literals)", async () => {
            mockLookup.mockRejectedValue(
                Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
            );
            expect(
                await resolveSafeOutboundUrl("https://does-not-exist.invalid"),
            ).toBeNull();

            // A host blocked by the sync pre-check never reaches DNS resolution.
            expect(await resolveSafeOutboundUrl("http://localhost")).toBeNull();
            expect(mockLookup).toHaveBeenCalledTimes(1);
        });

        it("rejects when DNS returns no addresses", async () => {
            mockLookup.mockResolvedValue([]);
            expect(
                await resolveSafeOutboundUrl("https://example.com"),
            ).toBeNull();
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
                await resolveSafeOutboundUrl("https://rebind.example.com/"),
            ).toBeNull();
        });

        it("still allows public IPs that merely contain a blocked octet elsewhere", () => {
            // Prefix checks must anchor at the start of the address.
            expect(normalizeSafeOutboundUrl("http://8.127.0.1/")).toBe(
                "http://8.127.0.1/",
            );
            expect(normalizeSafeOutboundUrl("http://110.1.2.3/")).toBe(
                "http://110.1.2.3/",
            );
        });

        it("blocks a private address returned by connect-time DNS rebinding", async () => {
            localServer = await startLocalServer();
            mockLookup.mockResolvedValue([
                { address: "93.184.216.34", family: 4 },
            ]);
            __testHooks.setBaseLookup(
                createBaseLookup(() => [{ address: "127.0.0.1", family: 4 }]),
            );
            const vettedUrl = await resolveSafeOutboundUrl(
                `http://rebind.test:${serverPort(localServer)}/`,
            );

            expect(vettedUrl).not.toBeNull();
            await expect(fetch(vettedUrl!)).rejects.toMatchObject({
                cause: { code: "EOUTBOUNDBLOCKED" },
            });
        });

        it("passes public connect-time addresses through unchanged", async () => {
            const publicAddress = { address: "93.184.216.34", family: 4 };
            mockLookup.mockResolvedValue([publicAddress]);
            __testHooks.setBaseLookup(createBaseLookup(() => [publicAddress]));
            await resolveSafeOutboundUrl("https://public.test/");

            await expect(lookupAll("public.test")).resolves.toEqual([
                publicAddress,
            ]);
            await expect(lookupOne("public.test")).resolves.toEqual(
                publicAddress,
            );
            await expect(lookupOne("public.test", 4)).resolves.toEqual(
                publicAddress,
            );
        });

        it("leaves unregistered private-host traffic untouched", async () => {
            localServer = await startLocalServer();
            mockLookup.mockResolvedValue([
                { address: "93.184.216.34", family: 4 },
            ]);
            __testHooks.setBaseLookup(
                createBaseLookup(() => [{ address: "127.0.0.1", family: 4 }]),
            );
            await resolveSafeOutboundUrl("https://vetted.test/");

            const response = await fetch(
                `http://internal-service.test:${serverPort(localServer)}/`,
            );
            expect(response.status).toBe(200);
            await expect(response.text()).resolves.toBe("local response");
        });

        it("fails open after the vetted-host TTL expires", async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date("2026-08-10T00:00:00Z"));
            mockLookup.mockResolvedValue([
                { address: "93.184.216.34", family: 4 },
            ]);
            __testHooks.setBaseLookup(
                createBaseLookup(() => [{ address: "127.0.0.1", family: 4 }]),
            );
            await resolveSafeOutboundUrl("https://expiring.test/");

            jest.advanceTimersByTime(30_001);

            await expect(lookupOne("expiring.test")).resolves.toEqual({
                address: "127.0.0.1",
                family: 4,
            });
        });

        it("blocks when any connect-time address is private", async () => {
            mockLookup.mockResolvedValue([
                { address: "93.184.216.34", family: 4 },
            ]);
            __testHooks.setBaseLookup(
                createBaseLookup(() => [
                    { address: "93.184.216.34", family: 4 },
                    { address: "10.0.0.5", family: 4 },
                ]),
            );
            await resolveSafeOutboundUrl("https://mixed.test/");

            await expect(lookupAll("mixed.test")).rejects.toMatchObject({
                code: "EOUTBOUNDBLOCKED",
            });
        });
    });

    describe("resolveSafeOutboundRedirectTarget", () => {
        it("resolves a relative redirect and re-validates the resolved IP", async () => {
            mockLookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
            expect(
                await resolveSafeOutboundRedirectTarget(
                    "/internal",
                    "https://evil.example.com/start",
                ),
            ).toBeNull();
        });
    });

    describe("normalizeSafeOutboundUrl", () => {
        it("allows public http and https urls", () => {
            expect(
                normalizeSafeOutboundUrl("https://example.com/feed.xml"),
            ).toBe("https://example.com/feed.xml");
            expect(normalizeSafeOutboundUrl("http://example.com/api")).toBe(
                "http://example.com/api",
            );
        });

        it("rejects invalid or unsupported urls", () => {
            expect(normalizeSafeOutboundUrl("file:///etc/passwd")).toBeNull();
            expect(normalizeSafeOutboundUrl("not-a-url")).toBeNull();
        });

        it("rejects loopback and private ipv4 destinations", () => {
            expect(
                normalizeSafeOutboundUrl("http://127.0.0.1/feed"),
            ).toBeNull();
            expect(normalizeSafeOutboundUrl("http://10.0.0.8/feed")).toBeNull();
            expect(
                normalizeSafeOutboundUrl("http://172.16.0.5/feed"),
            ).toBeNull();
            expect(
                normalizeSafeOutboundUrl("http://192.168.1.9/feed"),
            ).toBeNull();
        });

        it.each([
            "http://100.64.1.2/x",
            "http://100.127.255.255/",
            "http://198.18.0.1/",
            "http://198.19.255.254/",
        ])("rejects reserved ipv4 destination %s", (url) => {
            expect(normalizeSafeOutboundUrl(url)).toBeNull();
        });

        it.each([
            "http://100.63.255.255/",
            "http://100.128.0.0/",
            "http://198.17.255.255/",
            "http://198.20.0.1/",
        ])("allows public address outside reserved boundaries %s", (url) => {
            expect(normalizeSafeOutboundUrl(url)).toBe(url);
        });

        it.each(["http://100.64.1.2.example/", "http://198.18.example/"])(
            "does not parse malformed dotted-quad hostname %s",
            (url) => {
                expect(normalizeSafeOutboundUrl(url)).toBe(url);
            },
        );

        it("rejects an ipv4-mapped ipv6 reserved destination", () => {
            expect(
                normalizeSafeOutboundUrl("http://[::ffff:100.64.1.2]/"),
            ).toBeNull();
        });

        it("rejects link-local and ipv6 local destinations", () => {
            expect(
                normalizeSafeOutboundUrl("http://169.254.1.5/feed"),
            ).toBeNull();
            expect(normalizeSafeOutboundUrl("http://[::1]/feed")).toBeNull();
            expect(
                normalizeSafeOutboundUrl("http://[fe80::1]/feed"),
            ).toBeNull();
            expect(
                normalizeSafeOutboundUrl("http://[fd00::1]/feed"),
            ).toBeNull();
        });

        it("rejects localhost and internal hostnames", () => {
            expect(
                normalizeSafeOutboundUrl("http://localhost/feed"),
            ).toBeNull();
            expect(
                normalizeSafeOutboundUrl("http://service.local/feed"),
            ).toBeNull();
            expect(
                normalizeSafeOutboundUrl("http://api.internal/feed"),
            ).toBeNull();
        });
    });

    describe("normalizeSafeOutboundRedirectTarget", () => {
        it("resolves safe relative redirect targets", () => {
            expect(
                normalizeSafeOutboundRedirectTarget(
                    "/next/feed.xml",
                    "https://example.com/start/feed.xml",
                ),
            ).toBe("https://example.com/next/feed.xml");
        });

        it("rejects redirect targets that resolve to blocked destinations", () => {
            expect(
                normalizeSafeOutboundRedirectTarget(
                    "http://127.0.0.1/private",
                    "https://example.com/start/feed.xml",
                ),
            ).toBeNull();
        });
    });
});

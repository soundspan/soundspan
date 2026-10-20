import { FileAttribute, SlskClient } from "slsk-client";
import {
    createSoulseekClient,
    loginSoulseekClient,
    normalizeSearchResult,
    normalizeSearchResults,
    testSoulseekCredentials,
} from "../slskSession";

const mockSessionWarn = jest.fn();

jest.mock("../../../utils/logger", () => ({
    logger: {
        child: () => ({
            warn: (...args: unknown[]) => mockSessionWarn(...args),
        }),
    },
}));

jest.mock("slsk-client", () => ({
    ...jest.requireActual("slsk-client"),
    SlskClient: jest.fn(),
}));

const MockedSlskClient = jest.mocked(SlskClient);

function makeClient() {
    return {
        login: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn(),
    };
}

describe("Soulseek session adapter", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("constructs a v2 client with soundspan-owned reconnect policy", () => {
        const client = makeClient();
        MockedSlskClient.mockImplementationOnce(
            () => client as unknown as SlskClient,
        );

        expect(createSoulseekClient()).toBe(client);
        expect(MockedSlskClient).toHaveBeenCalledWith({
            host: "server.slsknet.org",
            port: 2242,
            timeout: 10_000,
            reconnect: false,
        });
    });

    it("logs in with valid credentials", async () => {
        const client = makeClient();

        await expect(
            loginSoulseekClient(
                client as unknown as SlskClient,
                "listener",
                "secret",
            ),
        ).resolves.toBeUndefined();

        expect(client.login).toHaveBeenCalledWith("listener", "secret");
        expect(client.destroy).not.toHaveBeenCalled();
    });

    it("destroys the client and rethrows the original login error", async () => {
        const loginError = new Error("login refused");
        const client = makeClient();
        client.login.mockRejectedValueOnce(loginError);

        await expect(
            loginSoulseekClient(
                client as unknown as SlskClient,
                "listener",
                "bad-secret",
            ),
        ).rejects.toBe(loginError);

        expect(client.destroy).toHaveBeenCalledTimes(1);
    });

    it("preserves the login error when destroying the failed client throws", async () => {
        const loginError = new Error("login refused");
        const client = makeClient();
        client.login.mockRejectedValueOnce(loginError);
        client.destroy.mockImplementationOnce(() => {
            throw new Error("destroy failed");
        });

        await expect(
            loginSoulseekClient(
                client as unknown as SlskClient,
                "listener",
                "bad-secret",
            ),
        ).rejects.toBe(loginError);

        expect(client.destroy).toHaveBeenCalledTimes(1);
        expect(mockSessionWarn).toHaveBeenCalledWith(
            "Failed to destroy Soulseek client",
            expect.objectContaining({ error: expect.any(Error) }),
        );
    });

    it.each([
        ["missing username", "", "secret"],
        ["missing password", "listener", ""],
        ["non-string username", 12, "secret"],
        ["non-string password", "listener", null],
    ])(
        "rejects %s without calling login",
        async (_case, username, password) => {
            const client = makeClient();

            await expect(
                loginSoulseekClient(
                    client as unknown as SlskClient,
                    username as string,
                    password as string,
                ),
            ).rejects.toThrow("Soulseek username and password are required");

            expect(client.login).not.toHaveBeenCalled();
            expect(client.destroy).toHaveBeenCalledTimes(1);
        },
    );

    it("destroys a credential-test client after success", async () => {
        const client = makeClient();
        MockedSlskClient.mockImplementationOnce(
            () => client as unknown as SlskClient,
        );

        await expect(
            testSoulseekCredentials("listener", "secret"),
        ).resolves.toBeUndefined();

        expect(client.login).toHaveBeenCalledWith("listener", "secret");
        expect(client.destroy).toHaveBeenCalledTimes(1);
    });

    it("destroys a credential-test client after failure", async () => {
        const client = makeClient();
        client.login.mockRejectedValueOnce(new Error("login refused"));
        MockedSlskClient.mockImplementationOnce(
            () => client as unknown as SlskClient,
        );

        await expect(
            testSoulseekCredentials("listener", "bad-secret"),
        ).rejects.toThrow("login refused");

        expect(client.destroy).toHaveBeenCalledTimes(1);
    });

    it("normalizes v2 search results and reads bitrate attributes", () => {
        expect(
            normalizeSearchResult({
                user: "peer",
                file: "Music/track.mp3",
                size: 123,
                slots: true,
                attribs: { [FileAttribute.Bitrate]: 320 },
                speed: 456,
                queueLength: 2,
            }),
        ).toEqual({
            user: "peer",
            file: "Music/track.mp3",
            size: 123,
            slots: true,
            bitrate: 320,
            speed: 456,
        });
    });

    it.each([
        ["missing attributes", undefined],
        ["empty attributes", {}],
        ["non-finite bitrate", { [FileAttribute.Bitrate]: Infinity }],
        ["zero bitrate", { [FileAttribute.Bitrate]: 0 }],
        ["negative bitrate", { [FileAttribute.Bitrate]: -1 }],
    ])("omits bitrate for %s", (_case, attribs) => {
        expect(
            normalizeSearchResult({
                user: "peer",
                file: "Music/track.mp3",
                size: 123,
                slots: true,
                attribs,
                speed: 456,
            }),
        ).toEqual({
            user: "peer",
            file: "Music/track.mp3",
            size: 123,
            slots: true,
            speed: 456,
        });
    });

    it.each([
        ["missing user", { file: "track.mp3", size: 1 }],
        ["empty user", { user: "", file: "track.mp3", size: 1 }],
        ["missing file", { user: "peer", size: 1 }],
        ["empty file", { user: "peer", file: "", size: 1 }],
        ["negative size", { user: "peer", file: "track.mp3", size: -1 }],
        [
            "non-finite size",
            { user: "peer", file: "track.mp3", size: Number.NaN },
        ],
    ])("drops a result with %s", (_case, raw) => {
        expect(normalizeSearchResult(raw)).toBeNull();
    });

    it("coerces slots and invalid speed values", () => {
        expect(
            normalizeSearchResult({
                user: "peer",
                file: "track.flac",
                size: 0,
                slots: 1,
                attribs: {},
                speed: -2,
            }),
        ).toEqual({
            user: "peer",
            file: "track.flac",
            size: 0,
            slots: false,
            speed: 0,
        });
    });

    it("returns no results for a non-array input", () => {
        expect(normalizeSearchResults({ results: [] })).toEqual([]);
    });
});

describe("slsk-client v2 package contract", () => {
    it("exposes the constructor, enum, and required client methods", () => {
        const actual =
            jest.requireActual<typeof import("slsk-client")>("slsk-client");
        const client = new actual.SlskClient({ reconnect: false });

        try {
            expect(actual.SlskClient).toEqual(expect.any(Function));
            expect(actual.FileAttribute.Bitrate).toBe(0);
            expect(actual).not.toHaveProperty("connect");
            for (const method of [
                "login",
                "search",
                "download",
                "destroy",
                "on",
                "removeAllListeners",
            ]) {
                expect(client[method as keyof typeof client]).toEqual(
                    expect.any(Function),
                );
            }
            expect(
                normalizeSearchResult({
                    user: "contract-peer",
                    file: "Music/contract.mp3",
                    size: 10,
                    slots: true,
                    attribs: { [actual.FileAttribute.Bitrate]: 320 },
                    speed: 20,
                }),
            ).toEqual({
                user: "contract-peer",
                file: "Music/contract.mp3",
                size: 10,
                slots: true,
                bitrate: 320,
                speed: 20,
            });
            const wireFile = {
                user: "contract-peer",
                file: "Music/contract.mp3",
                size: 10,
                attribs: { [actual.FileAttribute.Bitrate]: 320 },
            };
            const wireResult = {
                currentToken: "search-token",
                files: [wireFile],
                slots: 1,
                speed: 20,
                queueLength: 0,
            };
            expect(
                normalizeSearchResult(
                    actual.toSearchResult(wireFile, wireResult),
                ),
            ).toEqual({
                user: "contract-peer",
                file: "Music/contract.mp3",
                size: 10,
                slots: true,
                bitrate: 320,
                speed: 20,
            });
        } finally {
            client.destroy();
        }
    });
});

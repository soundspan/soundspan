const get = jest.fn();
const post = jest.fn();
const upsert = jest.fn();
const findMany = jest.fn();
const findUnique = jest.fn();
const updateMany = jest.fn();
const encrypt = jest.fn((value: string) => `encrypted:${value}`);
const decrypt = jest.fn((value: string) => value.replace("encrypted:", ""));
const getSystemSettings = jest.fn();
const lastFmConfig = { apiKey: "api-key", sharedSecret: "shared-secret" };

jest.mock("axios", () => ({
    __esModule: true,
    default: { get, post, isAxiosError: jest.fn(() => false) },
}));
jest.mock("../../../utils/db", () => ({
    prisma: {
        scrobbleConnection: { upsert, findMany, findUnique, updateMany },
    },
}));
jest.mock("../../../utils/encryption", () => ({ encrypt, decrypt }));
jest.mock("../../../config", () => ({
    config: { lastfm: lastFmConfig },
}));
jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings,
}));

import {
    InvalidListenBrainzTokenError,
    LastFmAuthStateError,
    LastFmCredentialsRejectedError,
    ScrobbleProviderRequestError,
    completeLastFmAuth,
    getScrobblingStatus,
    saveListenBrainzToken,
    startLastFmAuth,
} from "../../scrobbleConnections";

beforeEach(() => {
    jest.clearAllMocks();
    getSystemSettings.mockResolvedValue(null);
    lastFmConfig.apiKey = "api-key";
    lastFmConfig.sharedSecret = "shared-secret";
});

describe("saveListenBrainzToken", () => {
    it("validates the token before storing an encrypted value", async () => {
        get.mockResolvedValue({ data: { valid: true, user_name: "listener" } });
        upsert.mockResolvedValue({ id: "connection-1" });

        await saveListenBrainzToken("user-1", "secret-token");

        expect(get).toHaveBeenCalledWith(
            "https://api.listenbrainz.org/1/validate-token",
            {
                headers: { Authorization: "Token secret-token" },
                timeout: 8_000,
            },
        );
        expect(upsert).toHaveBeenCalledWith({
            where: {
                userId_service: {
                    userId: "user-1",
                    service: "listenbrainz",
                },
            },
            create: expect.objectContaining({
                userId: "user-1",
                service: "listenbrainz",
                encryptedCredential: "encrypted:secret-token",
                enabled: true,
            }),
            update: expect.objectContaining({
                encryptedCredential: "encrypted:secret-token",
                enabled: true,
            }),
        });
    });

    it("rejects an invalid token without storing it", async () => {
        get.mockResolvedValue({ data: { valid: false } });

        await expect(
            saveListenBrainzToken("user-1", "bad-token"),
        ).rejects.toBeInstanceOf(InvalidListenBrainzTokenError);
        expect(upsert).not.toHaveBeenCalled();
    });

    it("maps persisted rows to a secret-free status shape", async () => {
        findMany.mockResolvedValue([
            {
                service: "lastfm",
                encryptedCredential: "encrypted:session-key",
                enabled: true,
                username: "listener",
            },
            {
                service: "listenbrainz",
                encryptedCredential: "encrypted:user-token",
                enabled: false,
                username: "brainz-user",
            },
        ]);

        const result = await getScrobblingStatus("user-1");

        expect(result).toEqual({
            lastfm: {
                connected: true,
                enabled: true,
                username: "listener",
                serverConfigured: true,
                apiKeyConfigured: true,
                sharedSecretConfigured: true,
            },
            listenbrainz: { connected: true, enabled: false },
        });
        expect(JSON.stringify(result)).not.toMatch(/encrypted|token|session/i);
    });

    it("reports each missing Last.fm server credential separately", async () => {
        findMany.mockResolvedValue([]);
        lastFmConfig.apiKey = "";
        lastFmConfig.sharedSecret = "";

        const result = await getScrobblingStatus("user-1");

        expect(result.lastfm).toEqual({
            connected: false,
            enabled: false,
            username: null,
            serverConfigured: false,
            apiKeyConfigured: false,
            sharedSecretConfigured: false,
        });
    });

    it("signs Last.fm token requests and stores the pending token encrypted", async () => {
        get.mockResolvedValue({
            status: 200,
            data: { token: "request-token" },
        });
        upsert.mockResolvedValue({ id: "connection-1" });

        const approvalUrl = await startLastFmAuth("user-1");

        expect(get).toHaveBeenCalledWith("https://ws.audioscrobbler.com/2.0/", {
            params: {
                method: "auth.getToken",
                api_key: "api-key",
                api_sig: "ce05f5b24c2b9c91934cdacb782a6677", // gitleaks:allow — md5 test vector
                format: "json",
            },
            timeout: 8_000,
            validateStatus: expect.any(Function),
        });
        expect(upsert).toHaveBeenCalledWith({
            where: {
                userId_service: { userId: "user-1", service: "lastfm" },
            },
            create: {
                userId: "user-1",
                service: "lastfm",
                encryptedPendingToken: "encrypted:request-token",
                enabled: true,
            },
            update: {
                encryptedPendingToken: "encrypted:request-token",
            },
        });
        expect(approvalUrl).toBe(
            "https://www.last.fm/api/auth/?api_key=api-key&token=request-token",
        );
    });

    it.each([4, 10, 13, 26])(
        "classifies Last.fm credential error %i during start-auth",
        async (errorCode) => {
            get.mockResolvedValue({
                status: 403,
                data: { error: errorCode, message: "Credentials rejected" },
            });

            await expect(startLastFmAuth("user-1")).rejects.toEqual(
                new LastFmCredentialsRejectedError(),
            );
            expect(upsert).not.toHaveBeenCalled();
        },
    );

    it.each([14, 15])(
        "keeps the pending token for Last.fm auth-state error %i",
        async (errorCode) => {
            findUnique.mockResolvedValue({
                encryptedPendingToken: "encrypted:request-token",
            });
            post.mockResolvedValue({
                status: 403,
                data: { error: errorCode, message: "Token is not usable" },
            });

            await expect(completeLastFmAuth("user-1")).rejects.toEqual(
                new LastFmAuthStateError(
                    "Approve access in the Last.fm tab, then try again",
                ),
            );
            expect(updateMany).not.toHaveBeenCalled();
            expect(post).toHaveBeenCalledWith(
                "https://ws.audioscrobbler.com/2.0/",
                expect.any(URLSearchParams),
                {
                    timeout: 8_000,
                    validateStatus: expect.any(Function),
                },
            );
        },
    );

    it("classifies Last.fm network failures as provider request errors", async () => {
        get.mockRejectedValue(new Error("network unavailable"));

        await expect(startLastFmAuth("user-1")).rejects.toBeInstanceOf(
            ScrobbleProviderRequestError,
        );
        expect(upsert).not.toHaveBeenCalled();
    });

    it("classifies unknown Last.fm error codes as provider request errors", async () => {
        get.mockResolvedValue({
            status: 403,
            data: { error: 99, message: "Unexpected provider error" },
        });

        await expect(startLastFmAuth("user-1")).rejects.toBeInstanceOf(
            ScrobbleProviderRequestError,
        );
        expect(upsert).not.toHaveBeenCalled();
    });

    it("classifies an unexpected successful Last.fm token body as a provider request error", async () => {
        get.mockResolvedValue({ status: 200, data: {} });

        await expect(startLastFmAuth("user-1")).rejects.toBeInstanceOf(
            ScrobbleProviderRequestError,
        );
        expect(upsert).not.toHaveBeenCalled();
    });

    it("classifies an empty successful Last.fm token body as a provider request error", async () => {
        get.mockResolvedValue({ status: 200, data: "" });

        await expect(startLastFmAuth("user-1")).rejects.toBeInstanceOf(
            ScrobbleProviderRequestError,
        );
        expect(upsert).not.toHaveBeenCalled();
    });

    it("classifies an HTML successful Last.fm session body as a provider request error", async () => {
        findUnique.mockResolvedValue({
            encryptedPendingToken: "encrypted:request-token",
        });
        post.mockResolvedValue({
            status: 200,
            data: "<!doctype html><title>Last.fm unavailable</title>",
        });

        await expect(completeLastFmAuth("user-1")).rejects.toBeInstanceOf(
            ScrobbleProviderRequestError,
        );
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("rejects completion when a newer pending Last.fm token wins the race", async () => {
        let pendingToken: string | null = null;
        let releaseExchange!: () => void;
        let markExchangeStarted!: () => void;
        const exchangeStarted = new Promise<void>((resolve) => {
            markExchangeStarted = resolve;
        });
        const exchangeReleased = new Promise<void>((resolve) => {
            releaseExchange = resolve;
        });
        get.mockResolvedValueOnce({
            status: 200,
            data: { token: "request-token-a" },
        });
        get.mockResolvedValueOnce({
            status: 200,
            data: { token: "request-token-b" },
        });
        upsert.mockImplementation(async (operation) => {
            pendingToken = operation.create.encryptedPendingToken;
            return { id: "connection-1" };
        });
        findUnique.mockImplementation(async () => ({
            encryptedPendingToken: pendingToken,
        }));
        post.mockImplementation(async () => {
            markExchangeStarted();
            await exchangeReleased;
            return {
                status: 200,
                data: { session: { key: "session-a", name: "alice" } },
            };
        });
        updateMany.mockImplementation(async (operation) => {
            if (pendingToken !== operation.where.encryptedPendingToken) {
                return { count: 0 };
            }
            pendingToken = operation.data.encryptedPendingToken;
            return { count: 1 };
        });

        await startLastFmAuth("user-1");
        const firstCompletion = completeLastFmAuth("user-1");
        await exchangeStarted;
        await startLastFmAuth("user-1");
        releaseExchange();

        await expect(firstCompletion).rejects.toBeInstanceOf(
            LastFmAuthStateError,
        );
        expect(pendingToken).toBe("encrypted:request-token-b");
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                service: "lastfm",
                encryptedPendingToken: "encrypted:request-token-a",
            },
            data: {
                encryptedCredential: "encrypted:session-a",
                encryptedPendingToken: null,
                username: "alice",
                enabled: true,
            },
        });
    });
});

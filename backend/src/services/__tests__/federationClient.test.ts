process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY || "federation-client-test-key-123456";

const axiosRequest = jest.fn();

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        request: (...args: unknown[]) => axiosRequest(...args),
        isAxiosError: (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "isAxiosError" in error,
    },
}));

jest.mock("../../utils/encryption", () => ({
    decrypt: jest.fn((value: string) => value.replace(/^enc:/, "")),
}));

import {
    createFederationClient,
    FederationHttpError,
    FederationResponseError,
    pairFederationPeer,
} from "../federationClient";

const peer = {
    id: "peer-1",
    baseUrl: "https://peer.example/",
    outboundToken: "enc:secret-token",
};

const manifest = {
    instanceId: "instance-1",
    name: "Peer One",
    version: "2.0.2",
    catalogEpoch: "epoch-1",
    mediaTypes: ["artist", "album", "track"],
    counts: { artists: 1, albums: 2, tracks: 3 },
    embeddingsAvailable: false,
};

describe("federation HTTP client", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("applies the default timeout and decrypts the bearer token", async () => {
        axiosRequest.mockResolvedValueOnce({ status: 200, data: manifest });

        await expect(
            createFederationClient(peer).getManifest(),
        ).resolves.toEqual(manifest);

        expect(axiosRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://peer.example/api/federation/v1/manifest",
                timeout: 15_000,
                maxRedirects: 0,
                headers: expect.objectContaining({
                    Authorization: "Bearer secret-token",
                }),
            }),
        );
    });

    it("retries transient 5xx responses only and stops after three attempts", async () => {
        axiosRequest
            .mockResolvedValueOnce({ status: 503, data: {} })
            .mockResolvedValueOnce({ status: 502, data: {} })
            .mockResolvedValueOnce({ status: 200, data: manifest });

        await expect(
            createFederationClient(peer, { retryDelayMs: 0 }).getManifest(),
        ).resolves.toEqual(manifest);
        expect(axiosRequest).toHaveBeenCalledTimes(3);

        axiosRequest.mockReset();
        axiosRequest.mockResolvedValue({ status: 503, data: {} });
        await expect(
            createFederationClient(peer, { retryDelayMs: 0 }).getManifest(),
        ).rejects.toBeInstanceOf(FederationHttpError);
        expect(axiosRequest).toHaveBeenCalledTimes(3);
    });

    it("does not retry a non-transient peer response", async () => {
        axiosRequest.mockResolvedValueOnce({ status: 401, data: {} });

        await expect(
            createFederationClient(peer, { retryDelayMs: 0 }).getManifest(),
        ).rejects.toMatchObject({ status: 401 });
        expect(axiosRequest).toHaveBeenCalledTimes(1);
    });

    it("rejects malformed manifest, catalog, and delta success bodies", async () => {
        const client = createFederationClient(peer, { retryDelayMs: 0 });
        axiosRequest.mockResolvedValue({ status: 200, data: { nope: true } });

        await expect(client.getManifest()).rejects.toBeInstanceOf(
            FederationResponseError,
        );
        await expect(client.getCatalogItems("artist")).rejects.toBeInstanceOf(
            FederationResponseError,
        );
        await expect(
            client.getCatalogDelta({ since: new Date(), epoch: "epoch-1" }),
        ).rejects.toBeInstanceOf(FederationResponseError);
    });

    it("retries transient network failures but not aborted requests", async () => {
        const networkError = Object.assign(new Error("reset"), {
            isAxiosError: true,
            code: "ECONNRESET",
        });
        axiosRequest
            .mockRejectedValueOnce(networkError)
            .mockResolvedValueOnce({ status: 200, data: manifest });

        await expect(
            createFederationClient(peer, { retryDelayMs: 0 }).getManifest(),
        ).resolves.toEqual(manifest);
        expect(axiosRequest).toHaveBeenCalledTimes(2);

        axiosRequest.mockReset();
        axiosRequest.mockRejectedValueOnce(
            Object.assign(new Error("aborted"), {
                isAxiosError: true,
                code: "ERR_CANCELED",
            }),
        );
        await expect(
            createFederationClient(peer, { retryDelayMs: 0 }).getManifest(),
        ).rejects.toThrow("aborted");
        expect(axiosRequest).toHaveBeenCalledTimes(1);
    });

    it("rejects a malformed pairing response at the public trust boundary", async () => {
        axiosRequest.mockResolvedValueOnce({
            status: 201,
            data: { token: "secret-without-peer" },
        });

        await expect(
            pairFederationPeer({
                baseUrl: "https://peer.example",
                code: "ABCDEFGH",
                name: "Consumer",
                consumerBaseUrl: "https://consumer.example",
                options: { retryDelayMs: 0 },
            }),
        ).rejects.toBeInstanceOf(FederationResponseError);
    });
});

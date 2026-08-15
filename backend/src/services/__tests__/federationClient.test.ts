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
    FederationStaleCursorError,
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
    serverTime: "2026-08-15T12:00:00.000Z",
};

const artistEnvelope = {
    id: "artist-1",
    mediaType: "artist",
    updatedAt: "2026-08-15T12:00:00.000Z",
    attributes: {
        name: "Artist",
        mbid: "mbid-1",
        normalizedName: "artist",
    },
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
                maxContentLength: 8 * 1024 * 1024,
                maxBodyLength: 8 * 1024 * 1024,
                headers: expect.objectContaining({
                    Authorization: "Bearer secret-token",
                }),
            }),
        );
    });

    it("fetches one catalog item by type and encoded id", async () => {
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: artistEnvelope,
        });

        await expect(
            createFederationClient(peer).getCatalogItem("artist", "artist/id"),
        ).resolves.toEqual(artistEnvelope);
        expect(axiosRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://peer.example/api/federation/v1/catalog/items/artist/artist%2Fid",
            }),
        );
    });

    it("skips invalid catalog page items and reports their count", async () => {
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                items: [artistEnvelope, { invalid: true }],
                nextCursor: null,
            },
        });

        await expect(
            createFederationClient(peer).getCatalogItems("artist"),
        ).resolves.toEqual({
            items: [artistEnvelope],
            nextCursor: null,
            skippedInvalid: 1,
        });
    });

    it("skips invalid delta changes but rejects malformed tombstones", async () => {
        const validTombstone = {
            entityType: "artist",
            entityId: "artist-removed",
            deletedAt: "2026-08-15T12:01:00.000Z",
        };
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                kind: "ok",
                changes: [artistEnvelope, { invalid: true }],
                tombstones: [validTombstone],
                nextCursor: null,
                nextSince: "2026-08-15T12:02:00.000Z",
            },
        });

        await expect(
            createFederationClient(peer).getCatalogDelta({
                since: new Date("2026-08-15T12:00:00.000Z"),
                epoch: "epoch-1",
            }),
        ).resolves.toMatchObject({
            changes: [artistEnvelope],
            tombstones: [validTombstone],
            skippedInvalid: 1,
        });

        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                kind: "ok",
                changes: [],
                tombstones: [{ entityType: "artist" }],
                nextCursor: null,
                nextSince: "2026-08-15T12:02:00.000Z",
            },
        });

        await expect(
            createFederationClient(peer).getCatalogDelta({
                since: new Date("2026-08-15T12:00:00.000Z"),
                epoch: "epoch-1",
            }),
        ).rejects.toBeInstanceOf(FederationResponseError);
    });

    it("treats a stale cursor response as a full-resync signal", async () => {
        axiosRequest.mockResolvedValueOnce({
            status: 409,
            data: {
                code: "FEDERATION_STALE_CURSOR",
                currentEpoch: "epoch-1",
            },
        });

        await expect(
            createFederationClient(peer).getCatalogDelta({
                since: new Date("2026-01-01T00:00:00.000Z"),
                epoch: "epoch-1",
            }),
        ).rejects.toBeInstanceOf(FederationStaleCursorError);
    });

    it("destroys stream bodies before retrying or rejecting", async () => {
        const retryBody = { destroy: jest.fn() };
        const rejectedBody = { destroy: jest.fn() };
        axiosRequest
            .mockResolvedValueOnce({ status: 503, data: retryBody })
            .mockResolvedValueOnce({
                status: 200,
                data: { destroy: jest.fn() },
            });
        await createFederationClient(peer, { retryDelayMs: 0 }).getStream({
            remoteId: "track-1",
            quality: "original",
        });
        expect(retryBody.destroy).toHaveBeenCalledTimes(1);

        axiosRequest.mockReset();
        axiosRequest.mockResolvedValueOnce({ status: 404, data: rejectedBody });
        await expect(
            createFederationClient(peer, { attempts: 1 }).getStream({
                remoteId: "track-1",
                quality: "original",
            }),
        ).rejects.toBeInstanceOf(FederationHttpError);
        expect(rejectedBody.destroy).toHaveBeenCalledTimes(1);

        axiosRequest.mockReset();
        const coverBody = { destroy: jest.fn() };
        axiosRequest.mockResolvedValueOnce({ status: 401, data: coverBody });
        await expect(
            createFederationClient(peer, { attempts: 1 }).getCover("album-1"),
        ).rejects.toBeInstanceOf(FederationHttpError);
        expect(coverBody.destroy).toHaveBeenCalledTimes(1);
    });

    it("rejects an oversized JSON response at the transport boundary", async () => {
        const oversized = Object.assign(
            new Error("maxContentLength size of 8388608 exceeded"),
            { isAxiosError: true, code: "ERR_BAD_RESPONSE" },
        );
        axiosRequest.mockRejectedValueOnce(oversized);

        await expect(createFederationClient(peer).getManifest()).rejects.toBe(
            oversized,
        );
        expect(axiosRequest).toHaveBeenCalledTimes(1);
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

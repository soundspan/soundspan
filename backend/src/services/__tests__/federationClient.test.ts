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

const trackEnvelope = {
    id: "track-1",
    mediaType: "track",
    updatedAt: "2026-08-15T12:00:00.000Z",
    parentRef: "album-1",
    attributes: {
        title: "Track",
        discNo: 1,
        trackNo: 1,
        duration: 180,
        mime: "audio/flac",
        fileSize: 1234,
        recordingMbid: null,
        isrc: null,
        audioHash: "sha256:track-1",
        bpm: 120.5,
        beatsCount: 360,
        key: "A",
        keyScale: "minor",
        keyStrength: 0.8,
        energy: 0.7,
        loudness: -9.5,
        dynamicRange: 8.1,
        danceability: 0.6,
        valence: 0.4,
        arousal: 0.65,
        instrumentalness: 0.2,
        acousticness: 0.3,
        speechiness: 0.05,
        moodHappy: 0.4,
        moodSad: 0.2,
        moodRelaxed: 0.3,
        moodAggressive: 0.1,
        moodParty: 0.5,
        moodAcoustic: 0.25,
        moodElectronic: 0.75,
        danceabilityMl: 0.62,
        moodTags: ["focused"],
        essentiaGenres: ["electronic"],
        lastfmTags: ["synthwave"],
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

    it("accepts additive manifest media types and count keys", async () => {
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                ...manifest,
                mediaTypes: [...manifest.mediaTypes, "video"],
                counts: { ...manifest.counts, videos: 7 },
                futureCapability: true,
            },
        });

        await expect(
            createFederationClient(peer).getManifest(),
        ).resolves.toMatchObject({
            mediaTypes: ["artist", "album", "track"],
            counts: { artists: 1, albums: 2, tracks: 3 },
        });
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

    it("parses a loose page embedding header and downgrades malformed values", async () => {
        const embeddingSpace = {
            family: "clap-music-audioset",
            checkpointHash: "checkpoint-hash",
            dim: 512,
        };
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                items: [trackEnvelope],
                nextCursor: null,
            },
            headers: {
                "x-soundspan-embedding-space": JSON.stringify({
                    ...embeddingSpace,
                    futureField: "ignored",
                }),
            },
        });

        const page =
            await createFederationClient(peer).getCatalogItems("track");
        expect(page.embeddingSpace).toEqual(embeddingSpace);

        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                items: [trackEnvelope],
                nextCursor: null,
            },
            headers: {
                "x-soundspan-embedding-space": "{not-json",
            },
        });

        await expect(
            createFederationClient(peer).getCatalogItems("track"),
        ).resolves.toMatchObject({
            items: [trackEnvelope],
            embeddingSpace: null,
        });

        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                items: [trackEnvelope],
                nextCursor: null,
            },
            headers: {
                "x-soundspan-embedding-space": JSON.stringify({
                    family: "clap-music-audioset",
                    checkpointHash: 42,
                    dim: "512",
                }),
            },
        });

        await expect(
            createFederationClient(peer).getCatalogItems("track"),
        ).resolves.toMatchObject({
            items: [trackEnvelope],
            embeddingSpace: null,
        });
    });

    it("rejects the retired embedding tuple body field", async () => {
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                items: [trackEnvelope],
                nextCursor: null,
                embeddingSpace: {
                    family: "clap-music-audioset",
                    checkpointHash: "checkpoint-hash",
                    dim: 512,
                },
            },
        });

        await expect(
            createFederationClient(peer).getCatalogItems("track"),
        ).rejects.toBeInstanceOf(FederationResponseError);
    });

    it("validates podcast and audiobook envelopes", async () => {
        const items = [
            {
                id: "podcast-1",
                mediaType: "podcast",
                updatedAt: "2026-08-15T12:00:00.000Z",
                attributes: {
                    feedUrl: "https://feeds.example/show.xml",
                    title: "Peer Podcast",
                    author: null,
                    description: null,
                    imageUrl: null,
                    itunesId: null,
                },
            },
            {
                id: "audiobook-1",
                mediaType: "audiobook",
                updatedAt: "2026-08-15T12:00:00.000Z",
                attributes: {
                    title: "Peer Audiobook",
                    author: null,
                    narrator: null,
                    duration: 600,
                    description: null,
                    asin: null,
                    isbn: null,
                    coverUrl: true,
                },
            },
        ];
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: { items, nextCursor: null },
        });

        await expect(
            createFederationClient(peer).getCatalogItems("podcast"),
        ).resolves.toMatchObject({ items, skippedInvalid: 0 });
    });

    it("accepts bounded audio features and tolerates their absence", async () => {
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: { items: [trackEnvelope], nextCursor: null },
        });
        await expect(
            createFederationClient(peer).getCatalogItems("track"),
        ).resolves.toMatchObject({ items: [trackEnvelope], skippedInvalid: 0 });

        const attributesWithoutFeatures = {
            title: "Old Host Track",
            discNo: 1,
            trackNo: 2,
            duration: 181,
            mime: null,
            fileSize: 5678,
            recordingMbid: null,
            isrc: null,
            audioHash: null,
        };
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                items: [
                    { ...trackEnvelope, attributes: attributesWithoutFeatures },
                ],
                nextCursor: null,
            },
        });
        await expect(
            createFederationClient(peer).getCatalogItems("track"),
        ).resolves.toMatchObject({
            items: [
                expect.objectContaining({
                    attributes: attributesWithoutFeatures,
                }),
            ],
            skippedInvalid: 0,
        });
    });

    it.each([
        ["non-finite number", { energy: Number.POSITIVE_INFINITY }],
        ["oversized feature array", { moodTags: Array(65).fill("mood") }],
        ["oversized feature array entry", { lastfmTags: ["x".repeat(201)] }],
    ])("rejects a track with a %s", async (_case, invalidFeature) => {
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                items: [
                    {
                        ...trackEnvelope,
                        attributes: {
                            ...trackEnvelope.attributes,
                            ...invalidFeature,
                        },
                    },
                ],
                nextCursor: null,
            },
        });

        await expect(
            createFederationClient(peer).getCatalogItems("track"),
        ).resolves.toMatchObject({ items: [], skippedInvalid: 1 });
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

    it("propagates the embedding tuple from a delta response header", async () => {
        const embeddingSpace = {
            family: "clap-music-audioset",
            checkpointHash: "checkpoint-hash",
            dim: 512,
        };
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                kind: "ok",
                changes: [trackEnvelope],
                tombstones: [],
                nextCursor: null,
                nextSince: "2026-08-15T12:02:00.000Z",
            },
            headers: {
                "x-soundspan-embedding-space": JSON.stringify(embeddingSpace),
            },
        });

        await expect(
            createFederationClient(peer).getCatalogDelta({
                since: new Date("2026-08-15T12:00:00.000Z"),
                epoch: "epoch-1",
            }),
        ).resolves.toMatchObject({ embeddingSpace });
    });

    it("rejects the retired delta embedding tuple body field", async () => {
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                kind: "ok",
                changes: [],
                tombstones: [],
                nextCursor: null,
                nextSince: "2026-08-15T12:02:00.000Z",
                embeddingSpace: {
                    family: "clap-music-audioset",
                    checkpointHash: "checkpoint-hash",
                    dim: 512,
                },
            },
        });

        await expect(
            createFederationClient(peer).getCatalogDelta({
                since: new Date("2026-08-15T12:00:00.000Z"),
                epoch: "epoch-1",
            }),
        ).rejects.toBeInstanceOf(FederationResponseError);
    });

    it("skips bounded unknown tombstone types without weakening known tombstones", async () => {
        axiosRequest.mockResolvedValueOnce({
            status: 200,
            data: {
                kind: "ok",
                changes: [],
                tombstones: [
                    {
                        entityType: "video",
                        entityId: "video-1",
                        deletedAt: "2026-08-15T12:01:00.000Z",
                    },
                ],
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
            tombstones: [],
            skippedUnknownTombstones: 1,
        });
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

    it("requests audiobook streams through the typed endpoint with Range", async () => {
        const body = { destroy: jest.fn() };
        axiosRequest.mockResolvedValueOnce({
            status: 206,
            data: body,
            headers: { "content-range": "bytes 0-9/100" },
        });

        await createFederationClient(peer).getAudiobookStream({
            remoteId: "book/id",
            range: "bytes=0-9",
        });

        expect(axiosRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://peer.example/api/federation/v1/stream/audiobook/book%2Fid",
                headers: expect.objectContaining({ Range: "bytes=0-9" }),
                responseType: "stream",
            }),
        );
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

    it("sends and validates reciprocal pairing fields", async () => {
        axiosRequest.mockResolvedValueOnce({
            status: 201,
            data: {
                peer: {
                    id: "peer-2",
                    name: "Peer Two",
                    direction: "BOTH",
                    baseUrl: "https://consumer.example",
                    scopes: ["library:read", "stream:read"],
                    inboundStatus: "ACTIVE",
                    outboundStatus: "ACTIVE",
                    lastSeenAt: null,
                    lastSyncCursor: null,
                    catalogEpoch: null,
                    createdAt: "2026-08-15T12:00:00.000Z",
                    updatedAt: "2026-08-15T12:00:00.000Z",
                },
                token: "paired-token",
                reciprocalPeerId: "peer-3",
            },
        });

        await expect(
            pairFederationPeer({
                baseUrl: "https://peer.example",
                code: "ABCDEFGH",
                name: "Consumer",
                consumerBaseUrl: "https://consumer.example",
                reciprocalPairingCode: "HGFEDCBA",
                reciprocalScopes: ["library:read", "stream:read"],
                options: { retryDelayMs: 0 },
            }),
        ).resolves.toEqual(
            expect.objectContaining({ reciprocalPeerId: "peer-3" }),
        );
        expect(axiosRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    reciprocalPairingCode: "HGFEDCBA",
                    reciprocalScopes: ["library:read", "stream:read"],
                }),
            }),
        );
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

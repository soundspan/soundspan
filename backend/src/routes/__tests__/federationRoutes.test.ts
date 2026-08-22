import type { NextFunction, Request, Response } from "express";
import { Readable } from "node:stream";
import request from "supertest";

const catalog = {
    getFederationManifest: jest.fn(),
    getFederationCatalogItems: jest.fn(),
    getFederationCatalogItem: jest.fn(),
    getFederationCatalogDelta: jest.fn(),
    findExportedFederationAlbum: jest.fn(),
    findExportedFederationTrack: jest.fn(),
    findExportedFederationAudiobook: jest.fn(),
    decodeFederationDeltaCursor: jest.fn(),
};
const peers = { consumeFederationPairingRequest: jest.fn() };
const streamFileWithRangeSupport = jest.fn();
const getStreamFilePath = jest.fn();
const destroy = jest.fn();
const handleGetCoverArt = jest.fn((_req, res) => res.status(200).send("cover"));
const handleAudiobookCover = jest.fn((_req, res) =>
    res.status(200).send("book-cover"),
);
const streamAudiobook = jest.fn();
const redisEval = jest.fn();

jest.mock("../../services/federationCatalog", () => catalog);
jest.mock("../../services/federationPeers", () => ({
    ...peers,
    FEDERATION_SCOPE_VALUES: ["library:read", "stream:read", "embeddings:read"],
}));
jest.mock("../../middleware/federationAuth", () => ({
    requireFederationPeer:
        (...scopes: string[]) =>
        (req: Request, res: Response, next: NextFunction) => {
            const granted = String(req.headers["x-test-scopes"] || "").split(
                ",",
            );
            if (req.headers.authorization !== "Bearer valid") {
                return res
                    .status(401)
                    .json({ error: "Federation peer authentication required" });
            }
            if (!scopes.every((scope) => granted.includes(scope))) {
                return res
                    .status(403)
                    .json({ error: "Federation peer scope required" });
            }
            req.federationPeer = {
                id: "peer-1",
                name: "Peer",
                scopes: granted,
                capabilities: ["track-attrs-loudness"],
                maxConcurrentStreams: req.headers["x-test-max-concurrent"]
                    ? Number(req.headers["x-test-max-concurrent"])
                    : null,
                maxStreamKbps: req.headers["x-test-max-kbps"]
                    ? Number(req.headers["x-test-max-kbps"])
                    : null,
            };
            next();
        },
}));
jest.mock("../../middleware/rateLimiter", () => ({
    federationPeerLimiter: (
        _req: Request,
        _res: Response,
        next: NextFunction,
    ) => next(),
    federationPairingLimiter: (
        _req: Request,
        _res: Response,
        next: NextFunction,
    ) => next(),
}));
jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn(() => ({
        getStreamFilePath,
        streamFileWithRangeSupport,
        destroy,
    })),
}));
jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));
jest.mock("../../utils/safeResolvePath", () => ({
    safeResolvePath: jest.fn(() => "/music/file.flac"),
}));
jest.mock("../library/coverArt", () => ({
    handleGetCoverArt,
}));
jest.mock("../audiobooks", () => ({ handleAudiobookCover }));
jest.mock("../../services/audiobookshelf", () => ({
    audiobookshelfService: { streamAudiobook },
}));
jest.mock("../../utils/redis", () => ({
    redisClient: { eval: redisEval },
}));

import router from "../federation";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/federation/v1", router);
const embeddingSpaceHeaderValue = JSON.stringify({
    family: "clap-music-audioset",
    checkpointHash: "checkpoint-hash",
    dim: 512,
});

describe("federation host routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        catalog.getFederationManifest.mockResolvedValue({
            instanceId: "instance-1",
        });
        catalog.getFederationCatalogItems.mockResolvedValue({
            body: { items: [], nextCursor: null },
        });
        catalog.getFederationCatalogItem.mockResolvedValue(null);
        catalog.getFederationCatalogDelta.mockResolvedValue({
            body: {
                kind: "ok",
                changes: [],
                tombstones: [],
                nextCursor: null,
                nextSince: new Date("2026-08-15T12:00:00.000Z"),
            },
        });
        catalog.decodeFederationDeltaCursor.mockReturnValue(undefined);
        getStreamFilePath.mockResolvedValue({
            filePath: "/music/file.flac",
            mimeType: "audio/flac",
        });
        redisEval.mockResolvedValue(1);
    });

    it.each([
        [undefined, 401],
        ["wrong", 403],
        ["library:read", 200],
    ])("enforces manifest scope matrix for %s", async (scopes, status) => {
        let call = request(app).get("/api/federation/v1/manifest");
        if (scopes !== undefined)
            call = call
                .set("Authorization", "Bearer valid")
                .set("x-test-scopes", scopes);
        const response = await call;
        expect(response.status).toBe(status);
    });

    it.each([
        [undefined, 401],
        ["wrong", 403],
        ["library:read", 200],
    ])("enforces single-item scope matrix for %s", async (scopes, status) => {
        // Queue the once-value only when the request reaches the service —
        // rejected requests would leave it stale for later tests
        // (clearAllMocks does not drain once-queues).
        if (status === 200) {
            catalog.getFederationCatalogItem.mockResolvedValueOnce({
                body: { id: "artist-1", mediaType: "artist" },
            });
        }
        let call = request(app).get(
            "/api/federation/v1/catalog/items/artist/artist-1",
        );
        if (scopes !== undefined) {
            call = call
                .set("Authorization", "Bearer valid")
                .set("x-test-scopes", scopes);
        }
        const response = await call;
        expect(response.status).toBe(status);
    });

    it("validates bounded keyset catalog input", async () => {
        const response = await request(app)
            .get(
                "/api/federation/v1/catalog/items?type=track&cursor=track-1&limit=500",
            )
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read,embeddings:read");

        expect(response.status).toBe(200);
        expect(catalog.getFederationCatalogItems).toHaveBeenCalledWith({
            mediaType: "track",
            cursor: "track-1",
            limit: 500,
            includeEmbeddings: true,
            peerId: "peer-1",
            peerCapabilities: ["track-attrs-loudness"],
            acceptsEmbeddingSpace: false,
        });

        const invalid = await request(app)
            .get("/api/federation/v1/catalog/items?type=video&limit=501")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read");
        expect(invalid.status).toBe(400);
    });

    it("returns one directly addressed catalog item", async () => {
        catalog.getFederationCatalogItem.mockResolvedValueOnce({
            body: { id: "artist-1", mediaType: "artist" },
        });
        const response = await request(app)
            .get("/api/federation/v1/catalog/items/artist/artist-1")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read");

        expect(response.status).toBe(200);
        expect(catalog.getFederationCatalogItem).toHaveBeenCalledWith({
            mediaType: "artist",
            id: "artist-1",
            includeEmbeddings: false,
            peerId: "peer-1",
            peerCapabilities: ["track-attrs-loudness"],
            acceptsEmbeddingSpace: false,
        });
    });

    it("passes embedding-space capability negotiation to catalog exports", async () => {
        const response = await request(app)
            .get("/api/federation/v1/catalog/items?type=track")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read,embeddings:read")
            .set("X-Soundspan-Embedding-Space-Accept", "1");

        expect(response.status).toBe(200);
        expect(catalog.getFederationCatalogItems).toHaveBeenCalledWith(
            expect.objectContaining({
                includeEmbeddings: true,
                peerId: "peer-1",
                acceptsEmbeddingSpace: true,
            }),
        );
    });

    it("emits embedding-space headers without changing catalog bodies", async () => {
        catalog.getFederationCatalogItems.mockResolvedValueOnce({
            body: {
                items: [{ id: "track-1", attributes: { embedding: [0.1] } }],
                nextCursor: null,
            },
            embeddingSpaceHeaderValue,
        });
        catalog.getFederationCatalogItem.mockResolvedValueOnce({
            body: { id: "track-1", attributes: { embedding: [0.1] } },
            embeddingSpaceHeaderValue,
        });
        catalog.getFederationCatalogDelta.mockResolvedValueOnce({
            body: {
                kind: "ok",
                changes: [{ id: "track-1", attributes: { embedding: [0.1] } }],
                tombstones: [],
                nextCursor: null,
                nextSince: new Date("2026-08-15T12:00:00.000Z"),
            },
            embeddingSpaceHeaderValue,
        });

        const headers = {
            Authorization: "Bearer valid",
            "x-test-scopes": "library:read,embeddings:read",
        };
        const page = await request(app)
            .get("/api/federation/v1/catalog/items?type=track")
            .set(headers);
        const item = await request(app)
            .get("/api/federation/v1/catalog/items/track/track-1")
            .set(headers);
        const delta = await request(app)
            .get(
                "/api/federation/v1/catalog/delta?since=2026-08-15T11:00:00.000Z&epoch=epoch-1",
            )
            .set(headers);

        for (const response of [page, item, delta]) {
            expect(response.headers["x-soundspan-embedding-space"]).toBe(
                embeddingSpaceHeaderValue,
            );
            expect(response.body).not.toHaveProperty("body");
            expect(response.body).not.toHaveProperty("embeddingSpace");
        }
    });

    it("omits embedding-space headers when track and delta embeddings are excluded", async () => {
        const headers = {
            Authorization: "Bearer valid",
            "x-test-scopes": "library:read",
        };
        const page = await request(app)
            .get("/api/federation/v1/catalog/items?type=track")
            .set(headers);
        const delta = await request(app)
            .get(
                "/api/federation/v1/catalog/delta?since=2026-08-15T11:00:00.000Z&epoch=epoch-1",
            )
            .set(headers);

        expect(page.headers).not.toHaveProperty("x-soundspan-embedding-space");
        expect(delta.headers).not.toHaveProperty("x-soundspan-embedding-space");
        expect(page.status).toBe(200);
        expect(delta.status).toBe(200);
        expect(page.body).toEqual({ items: [], nextCursor: null });
        expect(delta.body).toMatchObject({ kind: "ok", changes: [] });
    });

    it("returns a typed 409 for a catalog epoch mismatch", async () => {
        catalog.getFederationCatalogDelta.mockResolvedValueOnce({
            body: { kind: "epochMismatch", currentEpoch: "epoch-2" },
        });
        const response = await request(app)
            .get(
                "/api/federation/v1/catalog/delta?since=2026-08-15T11:00:00.000Z&epoch=epoch-1",
            )
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read");

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            error: "Federation catalog epoch mismatch",
            code: "FEDERATION_EPOCH_MISMATCH",
            currentEpoch: "epoch-2",
        });
    });

    it("returns a typed 409 for a stale catalog cursor", async () => {
        catalog.getFederationCatalogDelta.mockResolvedValueOnce({
            body: { kind: "staleCursor", currentEpoch: "epoch-1" },
        });
        const response = await request(app)
            .get(
                "/api/federation/v1/catalog/delta?since=2026-01-01T00:00:00.000Z&epoch=epoch-1",
            )
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read");

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            error: "Federation catalog cursor is stale",
            code: "FEDERATION_STALE_CURSOR",
            currentEpoch: "epoch-1",
        });
    });

    it("consumes validated pairing input without peer authentication", async () => {
        peers.consumeFederationPairingRequest.mockResolvedValueOnce({
            ok: true,
            peer: { id: "peer-1" },
            token: "token-once",
        });
        const response = await request(app)
            .post("/api/federation/v1/pair")
            .send({
                code: "ABCDEFGH",
                name: "Peer",
                baseUrl: "https://peer.example",
                capabilities: ["track-attrs-loudness", "future-capability"],
            });

        expect(response.status).toBe(201);
        expect(response.body).toEqual({
            peer: { id: "peer-1" },
            token: "token-once",
            capabilities: ["track-attrs-loudness"],
        });
        expect(peers.consumeFederationPairingRequest).toHaveBeenCalledWith({
            code: "ABCDEFGH",
            name: "Peer",
            baseUrl: "https://peer.example",
            capabilities: ["track-attrs-loudness"],
        });
    });

    it("accepts legacy reciprocal fields without coupling them", async () => {
        peers.consumeFederationPairingRequest.mockResolvedValueOnce({
            ok: true,
            peer: { id: "peer-1", direction: "HOST" },
            token: "token-once",
        });

        const response = await request(app)
            .post("/api/federation/v1/pair")
            .send({
                code: "ABCDEFGH",
                name: "Peer",
                baseUrl: "https://peer.example",
                reciprocalPairingCode: "HGFEDCBA",
            });

        expect(response.status).toBe(201);
        expect(peers.consumeFederationPairingRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                reciprocalPairingCode: "HGFEDCBA",
            }),
        );
        expect(response.body.peer.direction).toBe("HOST");
    });

    it.each([
        ["used", 400, "FEDERATION_CODE_USED"],
        ["expired", 400, "FEDERATION_CODE_EXPIRED"],
        ["scope_mismatch", 400, "FEDERATION_SCOPE_MISMATCH"],
    ])(
        "maps %s pairing failures to a public code",
        async (reason, status, code) => {
            peers.consumeFederationPairingRequest.mockResolvedValueOnce({
                ok: false,
                reason,
            });

            const response = await request(app)
                .post("/api/federation/v1/pair")
                .send({ code: "ABCDEFGH", name: "Peer" });

            expect(response.status).toBe(status);
            expect(response.body.code).toBe(code);
        },
    );

    it.each(["not_found", "invalid"])(
        "keeps %s pairing failures generic",
        async (reason) => {
            peers.consumeFederationPairingRequest.mockResolvedValueOnce({
                ok: false,
                reason,
            });

            const response = await request(app)
                .post("/api/federation/v1/pair")
                .send({ code: "ABCDEFGH", name: "Peer" });

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                error: "Invalid or expired pairing code",
            });
        },
    );

    it("serves only exported covers and rejects URL overrides", async () => {
        catalog.findExportedFederationAlbum.mockResolvedValue(true);
        const response = await request(app)
            .get("/api/federation/v1/cover/album-1")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read");

        expect(response.status).toBe(200);
        expect(handleGetCoverArt).toHaveBeenCalledTimes(1);
        expect(handleGetCoverArt.mock.calls[0][0].params.id).toBe("album-1");

        const override = await request(app)
            .get(
                "/api/federation/v1/cover/album-1?url=https://private.example/cover.jpg",
            )
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read");
        expect(override.status).toBe(400);
        expect(handleGetCoverArt).toHaveBeenCalledTimes(1);

        catalog.findExportedFederationAlbum.mockResolvedValueOnce(false);
        const hidden = await request(app)
            .get("/api/federation/v1/cover/hidden-album")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read");
        expect(hidden.status).toBe(404);
        expect(handleGetCoverArt).toHaveBeenCalledTimes(1);
    });

    it("re-checks audiobook export eligibility before serving a cover", async () => {
        catalog.findExportedFederationAudiobook.mockResolvedValueOnce({
            id: "audiobook-1",
        });
        const response = await request(app)
            .get("/api/federation/v1/cover/audiobook/audiobook-1")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read");

        expect(response.status).toBe(200);
        expect(handleAudiobookCover.mock.calls[0][0].params.id).toBe(
            "audiobook-1",
        );

        catalog.findExportedFederationAudiobook.mockResolvedValueOnce(null);
        const hidden = await request(app)
            .get("/api/federation/v1/cover/audiobook/hidden")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read");
        expect(hidden.status).toBe(404);
        expect(handleAudiobookCover).toHaveBeenCalledTimes(1);
    });

    it("streams an exported local track with Range support and no Play write", async () => {
        catalog.findExportedFederationTrack.mockResolvedValueOnce({
            id: "track-1",
            filePath: "Artist/Album/file.flac",
            fileModified: new Date("2026-08-15T12:00:00.000Z"),
            mime: "audio/flac",
        });
        streamFileWithRangeSupport.mockImplementationOnce(async (_req, res) => {
            res.status(206)
                .set("Content-Range", "bytes 0-9/100")
                .send("0123456789");
        });

        const response = await request(app)
            .get("/api/federation/v1/stream/track-1?quality=original")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "stream:read")
            .set("Range", "bytes=0-9");

        expect(response.status).toBe(206);
        expect(response.headers["content-range"]).toBe("bytes 0-9/100");
        expect(streamFileWithRangeSupport.mock.calls[0][0].headers.range).toBe(
            "bytes=0-9",
        );
        expect(streamFileWithRangeSupport.mock.calls[0][4]).toBeUndefined();
        expect(redisEval).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledTimes(1);

        const hidden = await request(app)
            .get("/api/federation/v1/stream/hidden-track")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "stream:read");
        expect(hidden.status).toBe(404);
        expect(getStreamFilePath).toHaveBeenCalledTimes(1);
    });

    it("double-proxies only exported audiobooks with Range passthrough", async () => {
        catalog.findExportedFederationAudiobook.mockResolvedValueOnce({
            id: "audiobook-1",
        });
        streamAudiobook.mockResolvedValueOnce({
            stream: Readable.from(Buffer.from("audio")),
            headers: {
                "content-type": "audio/mpeg",
                "content-range": "bytes 0-4/5",
                "content-length": "5",
                "accept-ranges": "bytes",
            },
            status: 206,
        });

        const response = await request(app)
            .get("/api/federation/v1/stream/audiobook/audiobook-1")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "stream:read")
            .set("Range", "bytes=0-4");

        expect(response.status).toBe(206);
        expect(response.headers["content-range"]).toBe("bytes 0-4/5");
        expect(streamAudiobook).toHaveBeenCalledWith(
            "audiobook-1",
            "bytes=0-4",
            expect.objectContaining({ request: expect.any(Object) }),
        );
        expect(redisEval).not.toHaveBeenCalled();

        catalog.findExportedFederationAudiobook.mockResolvedValueOnce(null);
        const hidden = await request(app)
            .get("/api/federation/v1/stream/audiobook/hidden")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "stream:read");
        expect(hidden.status).toBe(404);
        expect(streamAudiobook).toHaveBeenCalledTimes(1);
    });

    it.each([
        "/api/federation/v1/stream/track-1",
        "/api/federation/v1/stream/audiobook/audiobook-1",
    ])(
        "enforces the authenticated peer concurrency cap on %s",
        async (path) => {
            redisEval.mockResolvedValueOnce(0);

            const response = await request(app)
                .get(path)
                .set("Authorization", "Bearer valid")
                .set("x-test-scopes", "stream:read")
                .set("x-test-max-concurrent", "1");

            expect(response.status).toBe(429);
            expect(response.headers["retry-after"]).toBe("1");
            expect(response.body).toEqual({
                error: "Federation peer stream limit exceeded",
                code: "FEDERATION_STREAM_LIMIT",
                retryAfterSeconds: 1,
            });
        },
    );

    it("passes a pacing transform to a capped track stream", async () => {
        catalog.findExportedFederationTrack.mockResolvedValueOnce({
            id: "track-1",
            filePath: "Artist/Album/file.flac",
            fileModified: new Date("2026-08-15T12:00:00.000Z"),
        });
        streamFileWithRangeSupport.mockImplementationOnce(async (_req, res) => {
            res.status(200).send("audio");
        });

        const response = await request(app)
            .get("/api/federation/v1/stream/track-1")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "stream:read")
            .set("x-test-max-kbps", "64");

        expect(response.status).toBe(200);
        expect(streamFileWithRangeSupport.mock.calls[0][4]).toEqual(
            expect.objectContaining({ _readableState: expect.any(Object) }),
        );
    });
});

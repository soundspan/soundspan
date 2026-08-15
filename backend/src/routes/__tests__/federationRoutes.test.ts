import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const catalog = {
    getFederationManifest: jest.fn(),
    getFederationCatalogItems: jest.fn(),
    getFederationCatalogItem: jest.fn(),
    getFederationCatalogDelta: jest.fn(),
    findExportedFederationAlbum: jest.fn(),
    findExportedFederationTrack: jest.fn(),
    decodeFederationDeltaCursor: jest.fn(),
};
const peers = { consumePairingCode: jest.fn() };
const streamFileWithRangeSupport = jest.fn();
const getStreamFilePath = jest.fn();
const destroy = jest.fn();
const handleGetCoverArt = jest.fn((_req, res) => res.status(200).send("cover"));

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

import router from "../federation";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/federation/v1", router);

describe("federation host routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        catalog.getFederationManifest.mockResolvedValue({
            instanceId: "instance-1",
        });
        catalog.getFederationCatalogItems.mockResolvedValue({
            items: [],
            nextCursor: null,
        });
        catalog.getFederationCatalogItem.mockResolvedValue(null);
        catalog.getFederationCatalogDelta.mockResolvedValue({
            kind: "ok",
            changes: [],
            tombstones: [],
            nextCursor: null,
            nextSince: new Date("2026-08-15T12:00:00.000Z"),
        });
        catalog.decodeFederationDeltaCursor.mockReturnValue(undefined);
        getStreamFilePath.mockResolvedValue({
            filePath: "/music/file.flac",
            mimeType: "audio/flac",
        });
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
        });

        const invalid = await request(app)
            .get("/api/federation/v1/catalog/items?type=podcast&limit=501")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "library:read");
        expect(invalid.status).toBe(400);
    });

    it("returns one directly addressed catalog item", async () => {
        catalog.getFederationCatalogItem.mockResolvedValueOnce({
            id: "artist-1",
            mediaType: "artist",
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
        });
    });

    it("returns a typed 409 for a catalog epoch mismatch", async () => {
        catalog.getFederationCatalogDelta.mockResolvedValueOnce({
            kind: "epochMismatch",
            currentEpoch: "epoch-2",
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
            kind: "staleCursor",
            currentEpoch: "epoch-1",
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
        peers.consumePairingCode.mockResolvedValueOnce({
            peer: { id: "peer-1" },
            token: "token-once",
        });
        const response = await request(app)
            .post("/api/federation/v1/pair")
            .send({
                code: "ABCDEFGH",
                name: "Peer",
                baseUrl: "https://peer.example",
            });

        expect(response.status).toBe(201);
        expect(response.body).toEqual({
            peer: { id: "peer-1" },
            token: "token-once",
        });
    });

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
        expect(destroy).toHaveBeenCalledTimes(1);

        const hidden = await request(app)
            .get("/api/federation/v1/stream/hidden-track")
            .set("Authorization", "Bearer valid")
            .set("x-test-scopes", "stream:read");
        expect(hidden.status).toBe(404);
        expect(getStreamFilePath).toHaveBeenCalledTimes(1);
    });
});

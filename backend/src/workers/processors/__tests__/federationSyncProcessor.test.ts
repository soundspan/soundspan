process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY || "federation-sync-test-key-12345678";

class MockEpochMismatchError extends Error {
    constructor(public readonly currentEpoch: string) {
        super("epoch mismatch");
    }
}
class MockStaleCursorError extends Error {
    constructor(public readonly currentEpoch: string) {
        super("stale cursor");
    }
}
class MockFederationHttpError extends Error {
    constructor(
        public readonly status: number | null,
        public readonly transient = false,
    ) {
        super(`http ${status}`);
    }
}

const client = {
    getManifest: jest.fn(),
    getCatalogItems: jest.fn(),
    getCatalogDelta: jest.fn(),
    getCatalogItem: jest.fn(),
};
const createFederationClient = jest.fn(() => client);
const createMapping = jest.fn();
const upsertTrackEmbedding = jest.fn();
const backfillAllArtistCounts = jest.fn();

const mockLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLog.child.mockReturnValue(mockLog);

const prisma = {
    federationPeer: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
    artist: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    album: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    track: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
};

jest.mock("../../../utils/db", () => ({ prisma }));
jest.mock("../../../utils/logger", () => {
    return { logger: mockLog };
});
jest.mock("../../../services/federationClient", () => ({
    createFederationClient,
    FederationEpochMismatchError: MockEpochMismatchError,
    FederationStaleCursorError: MockStaleCursorError,
    FederationHttpError: MockFederationHttpError,
}));
jest.mock("../../../services/trackMappingService", () => ({
    trackMappingService: { createMapping },
}));
jest.mock("../../../services/trackEmbeddings", () => ({
    upsertTrackEmbedding,
}));
jest.mock("../../../services/artistCountsService", () => ({
    backfillAllArtistCounts,
}));

import { processFederationSync } from "../federationSyncProcessor";

const peer = {
    id: "peer-1",
    direction: "CONSUMER",
    baseUrl: "https://peer.example",
    outboundToken: "encrypted-token",
    scopes: ["library:read", "stream:read", "embeddings:read"],
    status: "ACTIVE",
    lastSyncCursor: null as string | null,
    catalogEpoch: "epoch-1",
};

const manifest = {
    instanceId: "instance-1",
    name: "Peer One",
    version: "2.0.2",
    catalogEpoch: "epoch-1",
    mediaTypes: ["artist", "album", "track"],
    counts: { artists: 1, albums: 1, tracks: 1 },
    embeddingsAvailable: true,
    serverTime: "2026-08-15T11:59:59.000Z",
};

const artist = {
    id: "remote-artist-1",
    mediaType: "artist",
    updatedAt: "2026-08-15T12:00:00.000Z",
    attributes: {
        name: "Artist One",
        mbid: "artist-mbid-1",
        normalizedName: "artist one",
    },
};
const album = {
    id: "remote-album-1",
    mediaType: "album",
    updatedAt: "2026-08-15T12:00:01.000Z",
    parentRef: "remote-artist-1",
    attributes: {
        title: "Album One",
        rgMbid: "release-group-1",
        year: 2026,
        primaryType: "Album",
    },
};
const track = {
    id: "remote-track-1",
    mediaType: "track",
    updatedAt: "2026-08-15T12:00:02.000Z",
    parentRef: "remote-album-1",
    attributes: {
        title: "Track One",
        discNo: 1,
        trackNo: 2,
        duration: 180,
        mime: "audio/flac",
        fileSize: 1234,
        recordingMbid: null,
        isrc: null,
        audioHash: "sha256:abc",
        embedding: Array.from({ length: 512 }, () => 0.25),
    },
};

function job() {
    return { data: { peerId: "peer-1" } } as never;
}

function catalogPageFor(type: string) {
    if (type === "artist")
        return { items: [artist], nextCursor: null, skippedInvalid: 0 };
    if (type === "album")
        return { items: [album], nextCursor: null, skippedInvalid: 0 };
    return { items: [track], nextCursor: null, skippedInvalid: 0 };
}

describe("federation sync processor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.federationPeer.findUnique.mockResolvedValue({ ...peer });
        prisma.federationPeer.update.mockResolvedValue({});
        client.getManifest.mockResolvedValue(manifest);
        client.getCatalogItems.mockImplementation((type: string) =>
            Promise.resolve(catalogPageFor(type)),
        );
        client.getCatalogItem.mockResolvedValue(artist);
        prisma.artist.findUnique.mockResolvedValue({ id: "artist-local-row" });
        prisma.artist.findFirst.mockResolvedValue(null);
        prisma.artist.upsert.mockResolvedValue({ id: "artist-local-row" });
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.artist.deleteMany.mockResolvedValue({ count: 0 });
        prisma.album.findUnique.mockResolvedValue({
            id: "album-local-row",
            rgMbid: "release-group-1",
        });
        prisma.album.findFirst.mockResolvedValue(null);
        prisma.album.upsert.mockResolvedValue({
            id: "album-local-row",
            rgMbid: "release-group-1",
        });
        prisma.album.findMany.mockResolvedValue([]);
        prisma.album.deleteMany.mockResolvedValue({ count: 0 });
        prisma.track.findUnique.mockResolvedValue({ id: "fed-track-row" });
        prisma.track.findFirst.mockResolvedValue(null);
        prisma.track.upsert.mockResolvedValue({ id: "fed-track-row" });
        prisma.track.update.mockResolvedValue({});
        prisma.track.findMany.mockResolvedValue([]);
        prisma.track.deleteMany.mockResolvedValue({ count: 0 });
        createMapping.mockResolvedValue({ id: "mapping-1" });
        upsertTrackEmbedding.mockResolvedValue(undefined);
        backfillAllArtistCounts.mockResolvedValue({ processed: 1, errors: 0 });
    });

    it("imports a full catalog in parent order and persists the final cursor", async () => {
        const result = await processFederationSync(job());

        expect(
            client.getCatalogItems.mock.calls.map((call) => call[0]),
        ).toEqual(["artist", "album", "track"]);
        expect(prisma.artist.upsert.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.album.upsert.mock.invocationCallOrder[0],
        );
        expect(prisma.album.upsert.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.track.upsert.mock.invocationCallOrder[0],
        );
        expect(prisma.album.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    artistId: "artist-local-row",
                }),
            }),
        );
        expect(prisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    albumId: "album-local-row",
                    origin: "FEDERATED",
                    filePath: null,
                    removedAt: null,
                }),
                update: expect.objectContaining({
                    origin: "FEDERATED",
                    filePath: null,
                    removedAt: null,
                }),
            }),
        );
        expect(prisma.federationPeer.update).toHaveBeenCalledWith({
            where: { id: "peer-1" },
            data: expect.objectContaining({
                status: "ACTIVE",
                catalogEpoch: "epoch-1",
                lastSyncCursor: "2026-08-15T11:59:59.000Z",
                lastSeenAt: expect.any(Date),
            }),
        });
        expect(result).toMatchObject({
            mode: "full",
            artists: 1,
            albums: 1,
            tracks: 1,
            skippedInvalid: 0,
        });
    });

    it("warns when an older host manifest lacks serverTime", async () => {
        client.getManifest.mockResolvedValueOnce({
            ...manifest,
            serverTime: undefined,
        });

        await processFederationSync(job());

        expect(mockLog.warn).toHaveBeenCalledWith(
            "Federation manifest lacks serverTime; using the local clock",
        );
    });

    it("fetches and applies a missing parent before an incremental child", async () => {
        prisma.federationPeer.findUnique.mockResolvedValueOnce({
            ...peer,
            lastSyncCursor: "2026-08-15T12:10:00.000Z",
        });
        prisma.artist.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "artist-local-row" });
        client.getCatalogDelta.mockResolvedValueOnce({
            kind: "ok",
            changes: [album],
            tombstones: [],
            nextCursor: null,
            nextSince: "2026-08-15T12:12:00.000Z",
            skippedInvalid: 0,
        });

        await processFederationSync(job());

        expect(client.getCatalogItem).toHaveBeenCalledWith(
            "artist",
            "remote-artist-1",
        );
        expect(prisma.artist.upsert).toHaveBeenCalled();
        expect(mockLog.warn).toHaveBeenCalledWith(
            expect.stringContaining("missing parent"),
        );
    });

    it("fetches a missing album hierarchy before an incremental track", async () => {
        prisma.federationPeer.findUnique.mockResolvedValueOnce({
            ...peer,
            lastSyncCursor: "2026-08-15T12:10:00.000Z",
        });
        prisma.album.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "album-local-row",
                rgMbid: "release-group-1",
            });
        client.getCatalogItem.mockResolvedValueOnce(album);
        client.getCatalogDelta.mockResolvedValueOnce({
            kind: "ok",
            changes: [track],
            tombstones: [],
            nextCursor: null,
            nextSince: "2026-08-15T12:12:00.000Z",
            skippedInvalid: 0,
        });

        await processFederationSync(job());

        expect(client.getCatalogItem).toHaveBeenCalledWith(
            "album",
            "remote-album-1",
        );
        expect(prisma.album.upsert).toHaveBeenCalled();
        expect(prisma.track.upsert).toHaveBeenCalled();
    });

    it("retains a full-sync hierarchy recovered from a track parent", async () => {
        client.getCatalogItems.mockImplementation((type: string) =>
            Promise.resolve({
                items: type === "track" ? [track] : [],
                nextCursor: null,
                skippedInvalid: 0,
            }),
        );
        client.getCatalogItem.mockImplementation((type: string) =>
            Promise.resolve(type === "album" ? album : artist),
        );
        prisma.artist.findUnique
            .mockReset()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "artist-local-row" });
        prisma.album.findUnique
            .mockReset()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "album-local-row",
                rgMbid: "release-group-1",
            });
        prisma.track.findMany
            .mockResolvedValueOnce([
                { id: "fed-track-row", remoteId: "remote-track-1" },
            ])
            .mockResolvedValueOnce([]);
        prisma.album.findMany
            .mockResolvedValueOnce([
                { id: "album-local-row", remoteId: "remote-album-1" },
            ])
            .mockResolvedValueOnce([]);
        prisma.artist.findMany
            .mockResolvedValueOnce([
                { id: "artist-local-row", remoteId: "remote-artist-1" },
            ])
            .mockResolvedValueOnce([]);

        await processFederationSync(job());

        expect(client.getCatalogItem.mock.calls).toEqual([
            ["album", "remote-album-1"],
            ["artist", "remote-artist-1"],
        ]);
        expect(prisma.track.deleteMany).not.toHaveBeenCalled();
        expect(prisma.album.deleteMany).not.toHaveBeenCalled();
        expect(prisma.artist.deleteMany).not.toHaveBeenCalled();
    });

    it("skips descendants when a recovered artist is not exported", async () => {
        client.getCatalogItems.mockImplementation((type: string) =>
            Promise.resolve({
                items:
                    type === "album"
                        ? [album]
                        : type === "track"
                          ? [track]
                          : [],
                nextCursor: null,
                skippedInvalid: 0,
            }),
        );
        client.getCatalogItem.mockImplementation((type: string) => {
            if (type === "artist") {
                return Promise.reject(new MockFederationHttpError(404));
            }
            return Promise.resolve(album);
        });
        prisma.artist.findUnique.mockResolvedValue(null);
        prisma.album.findUnique.mockResolvedValue(null);

        await expect(processFederationSync(job())).resolves.toMatchObject({
            mode: "full",
            artists: 0,
            albums: 0,
            tracks: 0,
            skippedInvalid: 2,
        });
        expect(prisma.album.upsert).not.toHaveBeenCalled();
        expect(prisma.track.upsert).not.toHaveBeenCalled();
        expect(mockLog.warn).toHaveBeenCalledWith(
            expect.stringContaining("missing parent artist=remote-artist-1"),
        );
        expect(mockLog.warn).toHaveBeenCalledWith(
            expect.stringContaining("missing parent album=remote-album-1"),
        );
    });

    it("skips a track when its recovered album is not exported", async () => {
        client.getCatalogItems.mockImplementation((type: string) =>
            Promise.resolve({
                items: type === "track" ? [track] : [],
                nextCursor: null,
                skippedInvalid: 0,
            }),
        );
        client.getCatalogItem.mockRejectedValueOnce(
            new MockFederationHttpError(404),
        );
        prisma.album.findUnique.mockResolvedValue(null);

        await expect(processFederationSync(job())).resolves.toMatchObject({
            mode: "full",
            tracks: 0,
            skippedInvalid: 1,
        });
        expect(prisma.track.upsert).not.toHaveBeenCalled();
        expect(mockLog.warn).toHaveBeenCalledTimes(1);
        expect(mockLog.warn).toHaveBeenCalledWith(
            expect.stringContaining("missing parent album=remote-album-1"),
        );
    });

    it("does not mutate catalog rows when a validated page request fails", async () => {
        client.getCatalogItems.mockRejectedValueOnce(
            new Error("malformed federation page"),
        );

        await expect(processFederationSync(job())).rejects.toThrow(
            "malformed federation page",
        );

        expect(prisma.artist.upsert).not.toHaveBeenCalled();
        expect(prisma.album.upsert).not.toHaveBeenCalled();
        expect(prisma.track.upsert).not.toHaveBeenCalled();
    });

    it("replays a full sync idempotently through the same upsert keys", async () => {
        await processFederationSync(job());
        await processFederationSync(job());

        const trackKeys = prisma.track.upsert.mock.calls.map(
            (call) => call[0].where,
        );
        expect(trackKeys).toEqual([
            {
                peerId_remoteId: {
                    peerId: "peer-1",
                    remoteId: "remote-track-1",
                },
            },
            {
                peerId_remoteId: {
                    peerId: "peer-1",
                    remoteId: "remote-track-1",
                },
            },
        ]);
    });

    it("rebinds a stable federated identity when the remote track id changes", async () => {
        prisma.track.findUnique.mockResolvedValueOnce(null);
        prisma.track.findFirst.mockResolvedValueOnce({ id: "prior-fed-row" });

        await processFederationSync(job());

        expect(prisma.track.update).toHaveBeenCalledWith({
            where: { id: "prior-fed-row" },
            data: { remoteId: "remote-track-1" },
        });
        expect(prisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    peerId_remoteId: {
                        peerId: "peer-1",
                        remoteId: "remote-track-1",
                    },
                },
            }),
        );
    });

    it("deletes unseen full-sync rows in bounded child-first batches", async () => {
        prisma.track.findMany
            .mockResolvedValueOnce([
                { id: "stale-track", remoteId: "old-track" },
            ])
            .mockResolvedValueOnce([]);
        prisma.album.findMany
            .mockResolvedValueOnce([
                { id: "stale-album", remoteId: "old-album" },
            ])
            .mockResolvedValueOnce([]);
        prisma.artist.findMany
            .mockResolvedValueOnce([
                { id: "stale-artist", remoteId: "old-artist" },
            ])
            .mockResolvedValueOnce([]);

        await processFederationSync(job());

        expect(prisma.track.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["stale-track"] }, peerId: "peer-1" },
        });
        expect(
            prisma.track.deleteMany.mock.invocationCallOrder[0],
        ).toBeLessThan(prisma.album.deleteMany.mock.invocationCallOrder[0]);
        expect(
            prisma.album.deleteMany.mock.invocationCallOrder[0],
        ).toBeLessThan(prisma.artist.deleteMany.mock.invocationCallOrder[0]);
    });

    it("applies incremental changes with five-minute overlap and tombstones", async () => {
        prisma.federationPeer.findUnique.mockResolvedValueOnce({
            ...peer,
            lastSyncCursor: "2026-08-15T12:10:00.000Z",
        });
        client.getCatalogDelta.mockResolvedValueOnce({
            kind: "ok",
            changes: [],
            tombstones: [
                {
                    entityType: "track",
                    entityId: "removed-track",
                    deletedAt: "2026-08-15T12:11:00.000Z",
                },
            ],
            nextCursor: null,
            nextSince: "2026-08-15T12:12:00.000Z",
            skippedInvalid: 0,
        });

        const result = await processFederationSync(job());

        expect(client.getCatalogDelta).toHaveBeenCalledWith(
            expect.objectContaining({
                since: new Date("2026-08-15T12:05:00.000Z"),
                epoch: "epoch-1",
            }),
        );
        expect(prisma.track.deleteMany).toHaveBeenCalledWith({
            where: {
                peerId: "peer-1",
                remoteId: { in: ["removed-track"] },
            },
        });
        expect(result.mode).toBe("incremental");
    });

    it("falls back to full sync after a typed epoch 409", async () => {
        prisma.federationPeer.findUnique.mockResolvedValueOnce({
            ...peer,
            lastSyncCursor: "2026-08-15T12:10:00.000Z",
        });
        client.getCatalogDelta.mockRejectedValueOnce(
            new MockEpochMismatchError("epoch-2"),
        );
        client.getManifest
            .mockResolvedValueOnce(manifest)
            .mockResolvedValueOnce({ ...manifest, catalogEpoch: "epoch-2" });

        const result = await processFederationSync(job());

        expect(result.mode).toBe("full");
        expect(client.getCatalogDelta).toHaveBeenCalledTimes(1);
        expect(prisma.federationPeer.update).toHaveBeenLastCalledWith({
            where: { id: "peer-1" },
            data: expect.objectContaining({ catalogEpoch: "epoch-2" }),
        });
    });

    it("falls back to full sync after a typed stale-cursor 409", async () => {
        prisma.federationPeer.findUnique.mockResolvedValueOnce({
            ...peer,
            lastSyncCursor: "2026-01-01T00:00:00.000Z",
        });
        client.getCatalogDelta.mockRejectedValueOnce(
            new MockStaleCursorError("epoch-1"),
        );

        await expect(processFederationSync(job())).resolves.toMatchObject({
            mode: "full",
        });
        expect(prisma.federationPeer.update).toHaveBeenCalledWith({
            where: { id: "peer-1" },
            data: { lastSyncCursor: null, catalogEpoch: "epoch-1" },
        });
    });

    it("does not advance the cursor when a later incremental page fails", async () => {
        prisma.federationPeer.findUnique.mockResolvedValueOnce({
            ...peer,
            lastSyncCursor: "2026-08-15T12:10:00.000Z",
        });
        client.getCatalogDelta
            .mockResolvedValueOnce({
                kind: "ok",
                changes: [],
                tombstones: [],
                nextCursor: "page-2",
                nextSince: "2026-08-15T12:11:00.000Z",
                skippedInvalid: 0,
            })
            .mockRejectedValueOnce(new Error("page two failed"));

        await expect(processFederationSync(job())).rejects.toThrow(
            "page two failed",
        );
        expect(prisma.federationPeer.update).not.toHaveBeenCalled();
    });

    it("reports invalid items skipped by the client", async () => {
        client.getCatalogItems.mockImplementation((type: string) =>
            Promise.resolve({
                ...catalogPageFor(type),
                skippedInvalid: type === "track" ? 1 : 0,
            }),
        );

        await expect(processFederationSync(job())).resolves.toMatchObject({
            skippedInvalid: 1,
        });
        expect(mockLog.info).toHaveBeenCalledWith(
            expect.stringContaining("skippedInvalid=1"),
        );
    });

    it.each([
        [
            "audioHash",
            { audioHash: "sha256:abc", recordingMbid: null, isrc: null },
            1,
        ],
        [
            "recordingMbid",
            { audioHash: null, recordingMbid: "recording-1", isrc: null },
            0.95,
        ],
        [
            "isrc",
            { audioHash: null, recordingMbid: null, isrc: "US-AAA-26-00001" },
            0.9,
        ],
        [
            "albumPosition",
            { audioHash: null, recordingMbid: null, isrc: null },
            0.8,
        ],
    ])(
        "records %s local-wins dedup through TrackMapping",
        async (_tier, identity, confidence) => {
            const local = { id: "local-track-1" };
            prisma.track.findFirst.mockImplementation(async ({ where }) => {
                if (
                    identity.audioHash &&
                    where.audioHash === identity.audioHash
                )
                    return local;
                if (
                    identity.recordingMbid &&
                    where.recordingMbid === identity.recordingMbid
                )
                    return local;
                if (identity.isrc && where.isrc === identity.isrc) return local;
                if (
                    !identity.audioHash &&
                    !identity.recordingMbid &&
                    !identity.isrc &&
                    where.album
                )
                    return local;
                return null;
            });
            client.getCatalogItems.mockImplementation((type: string) => {
                if (type !== "track")
                    return Promise.resolve(catalogPageFor(type));
                return Promise.resolve({
                    items: [
                        {
                            ...track,
                            attributes: { ...track.attributes, ...identity },
                        },
                    ],
                    nextCursor: null,
                });
            });

            await processFederationSync(job());

            expect(prisma.track.update).toHaveBeenCalledWith({
                where: { id: "fed-track-row" },
                data: { dedupOfTrackId: "local-track-1" },
            });
            expect(createMapping).toHaveBeenCalledWith({
                trackId: "local-track-1",
                confidence,
                source: "federation",
            });
        },
    );

    it("imports embeddings only when the persisted peer scope permits it", async () => {
        await processFederationSync(job());
        expect(upsertTrackEmbedding).toHaveBeenCalledWith(
            "fed-track-row",
            track.attributes.embedding,
        );

        jest.clearAllMocks();
        prisma.federationPeer.findUnique.mockResolvedValue({
            ...peer,
            scopes: ["library:read", "stream:read"],
        });
        client.getManifest.mockResolvedValue(manifest);
        client.getCatalogItems.mockImplementation((type: string) =>
            Promise.resolve(catalogPageFor(type)),
        );
        prisma.artist.findUnique.mockResolvedValue({ id: "artist-local-row" });
        prisma.artist.findFirst.mockResolvedValue(null);
        prisma.artist.upsert.mockResolvedValue({ id: "artist-local-row" });
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.album.findUnique.mockResolvedValue({
            id: "album-local-row",
            rgMbid: "release-group-1",
        });
        prisma.album.findFirst.mockResolvedValue(null);
        prisma.album.upsert.mockResolvedValue({
            id: "album-local-row",
            rgMbid: "release-group-1",
        });
        prisma.album.findMany.mockResolvedValue([]);
        prisma.track.findUnique.mockResolvedValue({ id: "fed-track-row" });
        prisma.track.findFirst.mockResolvedValue(null);
        prisma.track.upsert.mockResolvedValue({ id: "fed-track-row" });
        prisma.track.findMany.mockResolvedValue([]);
        backfillAllArtistCounts.mockResolvedValue({ processed: 1, errors: 0 });

        await processFederationSync(job());
        expect(upsertTrackEmbedding).not.toHaveBeenCalled();
    });
});

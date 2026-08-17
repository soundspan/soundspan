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
class MockNoActiveEmbeddingSpaceError extends Error {}

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
const updateArtistCountsInBatches = jest.fn();
const clearTrackTranscodeCache = jest.fn();
const getActiveSpace = jest.fn();
const recordFederationEmbeddingPageOutcome = jest.fn();

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
        updateMany: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    federationPodcastListing: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
    audiobook: {
        upsert: jest.fn(),
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
    MAX_PAGE_ITEMS: 500,
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
jest.mock("../../../services/embeddingSpaces", () => ({
    getActiveSpace,
    NoActiveEmbeddingSpaceError: MockNoActiveEmbeddingSpaceError,
}));
jest.mock("../../../metrics", () => ({
    recordFederationEmbeddingPageOutcome,
}));
jest.mock("../../../services/artistCountsService", () => ({
    backfillAllArtistCounts,
    updateArtistCountsInBatches,
}));
jest.mock("../../../services/trackReplacement", () => ({
    clearTrackTranscodeCache,
}));

import { processFederationSync } from "../federationSyncProcessor";

const peer = {
    id: "peer-1",
    direction: "CONSUMER",
    baseUrl: "https://peer.example",
    outboundToken: "encrypted-token",
    scopes: ["library:read", "stream:read", "embeddings:read"],
    inboundStatus: null,
    outboundStatus: "ACTIVE",
    lastSyncCursor: null as string | null,
    catalogEpoch: "epoch-1",
};

const manifest = {
    instanceId: "instance-1",
    name: "Peer One",
    version: "2.0.2",
    catalogEpoch: "epoch-1",
    mediaTypes: ["artist", "album", "track", "podcast", "audiobook"],
    counts: { artists: 1, albums: 1, tracks: 1, podcasts: 1, audiobooks: 1 },
    embeddingsAvailable: true,
    serverTime: "2026-08-15T11:59:59.000Z",
};
const embeddingSpace = {
    family: "clap-music-audioset",
    checkpointHash: "checkpoint-hash",
    dim: 512,
};
const activeSpace = {
    id: "space_clap_music_audioset_v1",
    ...embeddingSpace,
    preprocessing: {},
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
        bpm: 122.5,
        beatsCount: 367,
        key: "F#",
        keyScale: "minor",
        keyStrength: 0.77,
        energy: 0.71,
        loudness: -8.2,
        dynamicRange: 10.4,
        danceability: 0.69,
        valence: 0.48,
        arousal: 0.74,
        instrumentalness: 0.12,
        acousticness: 0.24,
        speechiness: 0.03,
        moodHappy: 0.58,
        moodSad: 0.14,
        moodRelaxed: 0.31,
        moodAggressive: 0.09,
        moodParty: 0.52,
        moodAcoustic: 0.2,
        moodElectronic: 0.8,
        danceabilityMl: 0.72,
        moodTags: ["focused"],
        essentiaGenres: ["electronic"],
        lastfmTags: ["synthwave"],
        embedding: Array.from({ length: 512 }, () => 0.25),
    },
};
const podcast = {
    id: "remote-podcast-1",
    mediaType: "podcast",
    updatedAt: "2026-08-15T12:00:03.000Z",
    attributes: {
        feedUrl: "https://feeds.example/show.xml",
        title: "Peer Podcast",
        author: "Podcast Author",
        description: "Listing-only metadata",
        imageUrl: "https://images.example/show.jpg",
        itunesId: "12345",
    },
};
const audiobook = {
    id: "remote-audiobook-1",
    mediaType: "audiobook",
    updatedAt: "2026-08-15T12:00:04.000Z",
    attributes: {
        title: "Peer Audiobook",
        author: "Book Author",
        narrator: "Book Narrator",
        duration: 3_600,
        description: "Mirrored metadata",
        asin: "ASIN-1",
        isbn: "ISBN-1",
        coverUrl: true,
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
    if (type === "track")
        return {
            items: [track],
            nextCursor: null,
            skippedInvalid: 0,
            embeddingSpace,
        };
    if (type === "podcast")
        return { items: [podcast], nextCursor: null, skippedInvalid: 0 };
    return { items: [audiobook], nextCursor: null, skippedInvalid: 0 };
}

function legacyCatalogPageFor(type: string) {
    const page = catalogPageFor(type);
    return type === "track"
        ? {
              items: page.items,
              nextCursor: page.nextCursor,
              skippedInvalid: page.skippedInvalid,
          }
        : page;
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
        prisma.artist.upsert.mockResolvedValue({
            id: "artist-local-row",
            remoteId: "remote-artist-1",
            mbid: "artist-mbid-1",
        });
        prisma.artist.findMany.mockImplementation(async ({ where }) =>
            where?.OR
                ? [
                      {
                          id: "artist-local-row",
                          peerId: "peer-1",
                          remoteId: "remote-artist-1",
                          mbid: "artist-mbid-1",
                      },
                  ]
                : [],
        );
        prisma.artist.deleteMany.mockResolvedValue({ count: 0 });
        prisma.album.findUnique.mockResolvedValue({
            id: "album-local-row",
            rgMbid: "release-group-1",
        });
        prisma.album.findFirst.mockResolvedValue(null);
        prisma.album.upsert.mockResolvedValue({
            id: "album-local-row",
            remoteId: "remote-album-1",
            rgMbid: "release-group-1",
            artistId: "artist-local-row",
        });
        prisma.album.findMany.mockImplementation(async ({ where }) =>
            where?.OR
                ? [
                      {
                          id: "album-local-row",
                          peerId: "peer-1",
                          remoteId: "remote-album-1",
                          rgMbid: "release-group-1",
                          artistId: "artist-local-row",
                      },
                  ]
                : [],
        );
        prisma.album.deleteMany.mockResolvedValue({ count: 0 });
        prisma.track.findUnique.mockResolvedValue({ id: "fed-track-row" });
        prisma.track.findFirst.mockResolvedValue(null);
        prisma.track.upsert.mockResolvedValue({
            id: "fed-track-row",
        });
        prisma.track.update.mockResolvedValue({});
        prisma.track.updateMany.mockResolvedValue({ count: 1 });
        prisma.track.findMany.mockImplementation(async ({ where }) =>
            where?.peerId === "peer-1" && where?.remoteId
                ? [
                      {
                          id: "fed-track-row",
                          remoteId: "remote-track-1",
                          audioHash: "sha256:abc",
                          album: { artistId: "artist-local-row" },
                      },
                  ]
                : [],
        );
        prisma.track.deleteMany.mockResolvedValue({ count: 0 });
        prisma.federationPodcastListing.upsert.mockResolvedValue({
            id: "podcast-listing-row",
        });
        prisma.federationPodcastListing.findMany.mockResolvedValue([]);
        prisma.federationPodcastListing.deleteMany.mockResolvedValue({
            count: 0,
        });
        prisma.audiobook.upsert.mockResolvedValue({ id: "fed:audiobook-row" });
        prisma.audiobook.findMany.mockResolvedValue([]);
        prisma.audiobook.deleteMany.mockResolvedValue({ count: 0 });
        createMapping.mockResolvedValue({ id: "mapping-1" });
        upsertTrackEmbedding.mockResolvedValue(undefined);
        backfillAllArtistCounts.mockResolvedValue({ processed: 1, errors: 0 });
        updateArtistCountsInBatches.mockResolvedValue({
            updated: 1,
            errors: 0,
        });
        clearTrackTranscodeCache.mockResolvedValue(undefined);
        getActiveSpace.mockResolvedValue(activeSpace);
    });

    it("imports a full catalog in parent order and persists the final cursor", async () => {
        const result = await processFederationSync(job());

        expect(
            client.getCatalogItems.mock.calls.map((call) => call[0]),
        ).toEqual(["artist", "album", "track", "podcast", "audiobook"]);
        expect(prisma.artist.upsert.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.album.upsert.mock.invocationCallOrder[0],
        );
        expect(prisma.album.upsert.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.track.upsert.mock.invocationCallOrder[0],
        );
        expect(prisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    bpm: 122.5,
                    beatsCount: 367,
                    energy: 0.71,
                    moodTags: ["focused"],
                    essentiaGenres: ["electronic"],
                    lastfmTags: ["synthwave"],
                }),
                update: expect.objectContaining({
                    bpm: 122.5,
                    beatsCount: 367,
                    energy: 0.71,
                    moodTags: ["focused"],
                    essentiaGenres: ["electronic"],
                    lastfmTags: ["synthwave"],
                }),
            }),
        );
        expect(prisma.federationPodcastListing.upsert).toHaveBeenCalledWith({
            where: {
                peerId_remoteId: {
                    peerId: "peer-1",
                    remoteId: "remote-podcast-1",
                },
            },
            create: expect.objectContaining({
                peerId: "peer-1",
                remoteId: "remote-podcast-1",
                feedUrl: "https://feeds.example/show.xml",
            }),
            update: expect.objectContaining({
                title: "Peer Podcast",
            }),
        });
        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    peerId_remoteId: {
                        peerId: "peer-1",
                        remoteId: "remote-audiobook-1",
                    },
                },
                create: expect.objectContaining({
                    id: expect.stringMatching(
                        /^fed:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                    ),
                    peerId: "peer-1",
                    remoteId: "remote-audiobook-1",
                    title: "Peer Audiobook",
                    asin: "ASIN-1",
                    audioUrl: "remote-audiobook-1",
                }),
                update: expect.objectContaining({
                    title: "Peer Audiobook",
                    isbn: "ISBN-1",
                }),
            }),
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
        expect(prisma.federationPeer.update).toHaveBeenLastCalledWith({
            where: { id: "peer-1" },
            data: expect.objectContaining({
                outboundStatus: "ACTIVE",
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
            podcasts: 1,
            audiobooks: 1,
            skippedInvalid: 0,
        });
    });

    it.each([
        ["CONSUMER", "ACTIVE", true],
        ["BOTH", "OFFLINE", true],
        ["HOST", null, false],
    ])(
        "enforces %s/%s outbound sync capability",
        async (direction, outboundStatus, allowed) => {
            prisma.federationPeer.findUnique.mockResolvedValue({
                ...peer,
                direction,
                outboundStatus,
            });
            const run = processFederationSync(job());
            if (allowed)
                await expect(run).resolves.toMatchObject({ mode: "full" });
            else
                await expect(run).rejects.toThrow(
                    "Federation consumer peer is unavailable",
                );
        },
    );

    it("invalidates cached streams when a federated audio hash changes", async () => {
        prisma.track.findMany.mockImplementation(async ({ where }) =>
            where?.peerId === "peer-1" && where?.remoteId
                ? [
                      {
                          id: "fed-track-row",
                          remoteId: "remote-track-1",
                          audioHash: "sha256:old",
                          album: { artistId: "artist-local-row" },
                      },
                  ]
                : [],
        );

        await processFederationSync(job());

        expect(clearTrackTranscodeCache).toHaveBeenCalledWith("fed-track-row");
    });

    it("keeps cached streams when the federated audio hash is unchanged", async () => {
        await processFederationSync(job());

        expect(clearTrackTranscodeCache).not.toHaveBeenCalled();
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
        prisma.artist.findMany.mockResolvedValue([]);
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
        prisma.album.findMany.mockResolvedValue([]);
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
        prisma.track.findMany.mockImplementation(async ({ where }) =>
            where?.peerId === "peer-1" && !where?.remoteId && !where?.id
                ? [{ id: "fed-track-row", remoteId: "remote-track-1" }]
                : [],
        );
        prisma.album.findMany.mockImplementation(async ({ where }) =>
            where?.OR
                ? []
                : where?.id
                  ? []
                  : [
                        {
                            id: "album-local-row",
                            remoteId: "remote-album-1",
                        },
                    ],
        );
        prisma.artist.findMany.mockImplementation(async ({ where }) =>
            where?.OR
                ? []
                : where?.id
                  ? []
                  : [
                        {
                            id: "artist-local-row",
                            remoteId: "remote-artist-1",
                        },
                    ],
        );

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
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.album.findMany.mockResolvedValue([]);

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
                ...(type === "track" ? { embeddingSpace } : {}),
            }),
        );
        client.getCatalogItem.mockRejectedValueOnce(
            new MockFederationHttpError(404),
        );
        prisma.album.findMany.mockResolvedValue([]);

        await expect(processFederationSync(job())).resolves.toMatchObject({
            mode: "full",
            tracks: 0,
            skippedInvalid: 1,
        });
        expect(prisma.track.upsert).not.toHaveBeenCalled();
        expect(recordFederationEmbeddingPageOutcome).not.toHaveBeenCalled();
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
        prisma.track.findMany.mockImplementation(async ({ where }) => {
            if (where?.origin === "FEDERATED") {
                return [
                    {
                        id: "prior-fed-row",
                        remoteId: "old-remote-track",
                        audioHash: "sha256:abc",
                        recordingMbid: null,
                        isrc: null,
                        albumId: "album-local-row",
                        discNo: 1,
                        trackNo: 2,
                    },
                ];
            }
            return [];
        });

        await processFederationSync(job());

        expect(prisma.track.findFirst).not.toHaveBeenCalled();
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
        prisma.audiobook.findMany.mockImplementation(async ({ where }) =>
            where?.id
                ? []
                : [{ id: "stale-audiobook", remoteId: "old-audiobook" }],
        );
        prisma.federationPodcastListing.findMany.mockImplementation(
            async ({ where }) =>
                where?.id
                    ? []
                    : [{ id: "stale-podcast", remoteId: "old-podcast" }],
        );
        prisma.track.findMany.mockImplementation(async ({ where }) =>
            where?.peerId === "peer-1" && !where?.remoteId && !where?.id
                ? [{ id: "stale-track", remoteId: "old-track" }]
                : [],
        );
        prisma.album.findMany.mockImplementation(async ({ where }) =>
            where?.OR
                ? [
                      {
                          id: "album-local-row",
                          peerId: "peer-1",
                          remoteId: "remote-album-1",
                          rgMbid: "release-group-1",
                          artistId: "artist-local-row",
                      },
                  ]
                : where?.id
                  ? []
                  : [{ id: "stale-album", remoteId: "old-album" }],
        );
        prisma.artist.findMany.mockImplementation(async ({ where }) =>
            where?.OR
                ? [
                      {
                          id: "artist-local-row",
                          peerId: "peer-1",
                          remoteId: "remote-artist-1",
                          mbid: "artist-mbid-1",
                      },
                  ]
                : where?.id
                  ? []
                  : [{ id: "stale-artist", remoteId: "old-artist" }],
        );

        await processFederationSync(job());

        expect(prisma.audiobook.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["stale-audiobook"] }, peerId: "peer-1" },
        });
        expect(prisma.federationPodcastListing.deleteMany).toHaveBeenCalledWith(
            {
                where: { id: { in: ["stale-podcast"] }, peerId: "peer-1" },
            },
        );
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
                {
                    entityType: "podcast",
                    entityId: "removed-podcast",
                    deletedAt: "2026-08-15T12:11:00.000Z",
                },
                {
                    entityType: "audiobook",
                    entityId: "removed-audiobook",
                    deletedAt: "2026-08-15T12:11:00.000Z",
                },
            ],
            nextCursor: null,
            nextSince: "2026-08-15T12:12:00.000Z",
            skippedInvalid: 0,
            skippedUnknownTombstones: 1,
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
        expect(prisma.federationPodcastListing.deleteMany).toHaveBeenCalledWith(
            {
                where: {
                    peerId: "peer-1",
                    remoteId: { in: ["removed-podcast"] },
                },
            },
        );
        expect(prisma.audiobook.deleteMany).toHaveBeenCalledWith({
            where: {
                peerId: "peer-1",
                remoteId: { in: ["removed-audiobook"] },
            },
        });
        expect(result).toMatchObject({
            mode: "incremental",
            tombstones: 3,
            skippedUnknownTombstones: 1,
        });
        expect(mockLog.info).toHaveBeenCalledWith(
            expect.stringContaining("skippedUnknownTombstones=1"),
        );
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
            prisma.track.findMany.mockImplementation(async ({ where }) => {
                if (where.peerId === "peer-1" && where.remoteId) {
                    return [
                        {
                            id: "fed-track-row",
                            remoteId: "remote-track-1",
                            audioHash: "sha256:abc",
                            album: { artistId: "artist-local-row" },
                        },
                    ];
                }
                if (
                    identity.audioHash &&
                    where.audioHash?.in?.includes(identity.audioHash)
                )
                    return [{ ...local, audioHash: identity.audioHash }];
                if (
                    identity.recordingMbid &&
                    where.recordingMbid?.in?.includes(identity.recordingMbid)
                )
                    return [
                        {
                            ...local,
                            recordingMbid: identity.recordingMbid,
                        },
                    ];
                if (identity.isrc && where.isrc?.in?.includes(identity.isrc)) {
                    return [{ ...local, isrc: identity.isrc }];
                }
                if (
                    !identity.audioHash &&
                    !identity.recordingMbid &&
                    !identity.isrc &&
                    where.OR
                )
                    return [
                        {
                            ...local,
                            discNo: 1,
                            trackNo: 2,
                            album: { rgMbid: "release-group-1" },
                        },
                    ];
                return [];
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

            expect(prisma.track.updateMany).toHaveBeenCalledWith({
                where: { id: "fed-track-row", dedupPinned: false },
                data: { dedupOfTrackId: "local-track-1" },
            });
            expect(createMapping).toHaveBeenCalledWith({
                trackId: "local-track-1",
                confidence,
                source: "federation",
            });
        },
    );

    it("preserves a pinned arbitration decision through a full resync", async () => {
        prisma.track.upsert.mockResolvedValueOnce({
            id: "fed-track-row",
        });
        prisma.track.updateMany.mockResolvedValueOnce({ count: 0 });

        await processFederationSync(job());

        expect(prisma.track.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.not.objectContaining({
                    dedupPinned: expect.anything(),
                    dedupOfTrackId: expect.anything(),
                }),
                select: { id: true },
            }),
        );
        expect(prisma.track.updateMany).toHaveBeenCalledWith({
            where: { id: "fed-track-row", dedupPinned: false },
            data: { dedupOfTrackId: null },
        });
        expect(createMapping).not.toHaveBeenCalled();
    });

    it("batches one mixed page and preserves the lowest-id dedup tie winner", async () => {
        const secondTrack = {
            ...track,
            id: "remote-track-2",
            attributes: {
                ...track.attributes,
                title: "Track Two",
                trackNo: 3,
                recordingMbid: "recording-2",
                isrc: "US-AAA-26-00002",
            },
        };
        prisma.federationPeer.findUnique.mockResolvedValue({
            ...peer,
            lastSyncCursor: "2026-08-15T12:10:00.000Z",
        });
        client.getCatalogDelta.mockResolvedValue({
            kind: "ok",
            changes: [artist, album, track, secondTrack],
            tombstones: [],
            nextCursor: null,
            nextSince: "2026-08-15T12:12:00.000Z",
            skippedInvalid: 0,
        });
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.album.findMany.mockResolvedValue([]);
        prisma.track.findMany.mockImplementation(async ({ where }) => {
            if (where.peerId === "peer-1") return [];
            if (where.audioHash) {
                return [
                    { id: "local-a", audioHash: "sha256:abc" },
                    { id: "local-b", audioHash: "sha256:abc" },
                ];
            }
            return [];
        });
        prisma.track.upsert
            .mockResolvedValueOnce({ id: "fed-track-1" })
            .mockResolvedValueOnce({ id: "fed-track-2" });

        await processFederationSync(job());

        expect(prisma.artist.findMany).toHaveBeenCalledTimes(1);
        expect(prisma.album.findMany).toHaveBeenCalledTimes(1);
        expect(
            prisma.track.findMany.mock.calls.filter(
                ([args]) =>
                    args.where.peerId === "peer-1" && args.where.remoteId,
            ),
        ).toHaveLength(1);
        expect(
            prisma.track.findMany.mock.calls.filter(([args]) =>
                Boolean(args.where.audioHash),
            ),
        ).toHaveLength(1);
        const localDedupQueries = prisma.track.findMany.mock.calls.filter(
            ([args]) => args.where.origin === "LOCAL",
        );
        expect(localDedupQueries.length).toBeGreaterThan(0);
        for (const [args] of localDedupQueries) {
            expect(args.orderBy).toEqual({ id: "asc" });
        }
        expect(prisma.track.findFirst).not.toHaveBeenCalled();
        expect(
            prisma.track.findMany.mock.calls.filter(
                ([args]) => args.where.origin === "FEDERATED",
            ),
        ).toHaveLength(1);
        expect(
            prisma.track.updateMany.mock.calls.filter(
                ([args]) => args.data.dedupOfTrackId === "local-a",
            ),
        ).toHaveLength(2);
    });

    it("rejects a page that exceeds the shared federation item bound", async () => {
        prisma.federationPeer.findUnique.mockResolvedValue({
            ...peer,
            lastSyncCursor: "2026-08-15T12:10:00.000Z",
        });
        client.getCatalogDelta.mockResolvedValue({
            kind: "ok",
            changes: Array.from({ length: 501 }, (_, index) => ({
                ...artist,
                id: `remote-artist-${index}`,
                attributes: {
                    ...artist.attributes,
                    mbid: `artist-mbid-${index}`,
                },
            })),
            tombstones: [],
            nextCursor: null,
            nextSince: "2026-08-15T12:12:00.000Z",
            skippedInvalid: 0,
        });

        await expect(processFederationSync(job())).rejects.toThrow(
            "Federation page exceeded the item bound",
        );
        expect(prisma.artist.upsert).not.toHaveBeenCalled();
    });

    it("recomputes only artists touched by an incremental page", async () => {
        prisma.federationPeer.findUnique.mockResolvedValue({
            ...peer,
            lastSyncCursor: "2026-08-15T12:10:00.000Z",
        });
        client.getCatalogDelta.mockResolvedValue({
            kind: "ok",
            changes: [artist],
            tombstones: [],
            nextCursor: null,
            nextSince: "2026-08-15T12:12:00.000Z",
            skippedInvalid: 0,
        });

        await processFederationSync(job());

        expect(updateArtistCountsInBatches).toHaveBeenCalledWith([
            "artist-local-row",
        ]);
        expect(backfillAllArtistCounts).not.toHaveBeenCalled();
    });

    it("persists the next full page cursor before a later page fails", async () => {
        client.getCatalogItems.mockImplementation(
            (type: string, cursor?: string) => {
                if (type === "track" && cursor === "track-page-2") {
                    return Promise.reject(new Error("track page failed"));
                }
                const page = catalogPageFor(type);
                return Promise.resolve({
                    ...page,
                    nextCursor:
                        type === "track" ? "track-page-2" : page.nextCursor,
                });
            },
        );

        await expect(processFederationSync(job())).rejects.toThrow(
            "track page failed",
        );

        const progressWrites = prisma.federationPeer.update.mock.calls
            .map(([args]) => args.data.lastSyncCursor)
            .filter(
                (value) => typeof value === "string" && value.startsWith("{"),
            )
            .map((value) => JSON.parse(value));
        expect(progressWrites).toContainEqual({
            phase: "full",
            mediaType: "track",
            cursor: "track-page-2",
            serverTime: "2026-08-15T11:59:59.000Z",
            epoch: "epoch-1",
        });
    });

    it("discards full resume state when the manifest epoch changes", async () => {
        prisma.federationPeer.findUnique.mockResolvedValue({
            ...peer,
            catalogEpoch: "epoch-old",
            lastSyncCursor: JSON.stringify({
                phase: "full",
                mediaType: "track",
                cursor: "old-track-page",
                serverTime: "2026-08-15T10:00:00.000Z",
                epoch: "epoch-old",
            }),
        });

        await processFederationSync(job());

        expect(client.getCatalogItems).toHaveBeenNthCalledWith(
            1,
            "artist",
            undefined,
        );
        expect(client.getCatalogItems).not.toHaveBeenCalledWith(
            "track",
            "old-track-page",
        );
        expect(prisma.federationPeer.update).toHaveBeenLastCalledWith({
            where: { id: "peer-1" },
            data: expect.objectContaining({
                catalogEpoch: "epoch-1",
                lastSyncCursor: "2026-08-15T11:59:59.000Z",
            }),
        });
    });

    it("routes a corrupt saved cursor through epoch recovery into a full resync", async () => {
        prisma.federationPeer.findUnique.mockResolvedValue({
            ...peer,
            lastSyncCursor: "{corrupt",
        });
        client.getManifest
            .mockResolvedValueOnce(manifest)
            .mockResolvedValueOnce(manifest);

        await expect(processFederationSync(job())).resolves.toMatchObject({
            mode: "full",
        });

        expect(client.getCatalogDelta).not.toHaveBeenCalled();
        expect(prisma.federationPeer.update).toHaveBeenCalledWith({
            where: { id: "peer-1" },
            data: { lastSyncCursor: null, catalogEpoch: "epoch-1" },
        });
        expect(client.getManifest).toHaveBeenCalledTimes(2);
        expect(client.getCatalogItems).toHaveBeenNthCalledWith(
            1,
            "artist",
            undefined,
        );
    });

    it("resumes a saved page and converges to uninterrupted cleanup", async () => {
        const cleanupRows = {
            artist: [
                { id: "artist-local-row", remoteId: "remote-artist-1" },
                { id: "stale-artist", remoteId: "stale-artist" },
            ],
            album: [
                { id: "album-local-row", remoteId: "remote-album-1" },
                { id: "stale-album", remoteId: "stale-album" },
            ],
            track: [
                { id: "fed-track-row", remoteId: "remote-track-1" },
                { id: "stale-track", remoteId: "stale-track" },
            ],
        };
        prisma.artist.findMany.mockImplementation(async ({ where }) =>
            where?.OR
                ? [
                      {
                          id: "artist-local-row",
                          peerId: "peer-1",
                          remoteId: "remote-artist-1",
                          mbid: "artist-mbid-1",
                      },
                  ]
                : where?.id
                  ? []
                  : cleanupRows.artist,
        );
        prisma.album.findMany.mockImplementation(async ({ where }) =>
            where?.OR
                ? [
                      {
                          id: "album-local-row",
                          peerId: "peer-1",
                          remoteId: "remote-album-1",
                          rgMbid: "release-group-1",
                          artistId: "artist-local-row",
                      },
                  ]
                : where?.id
                  ? []
                  : cleanupRows.album,
        );
        prisma.track.findMany.mockImplementation(async ({ where }) =>
            where?.peerId && !where?.remoteId
                ? where?.id
                    ? []
                    : cleanupRows.track
                : [],
        );
        await processFederationSync(job());
        const uninterrupted = [
            ...prisma.track.deleteMany.mock.calls,
            ...prisma.album.deleteMany.mock.calls,
            ...prisma.artist.deleteMany.mock.calls,
        ].map(([args]) => args.where.id.in);

        prisma.track.deleteMany.mockClear();
        prisma.album.deleteMany.mockClear();
        prisma.artist.deleteMany.mockClear();
        client.getCatalogItems.mockClear();
        prisma.federationPeer.findUnique.mockResolvedValue({
            ...peer,
            lastSyncCursor: JSON.stringify({
                phase: "full",
                mediaType: "track",
                cursor: "resume-track-page",
                serverTime: "2026-08-15T11:59:59.000Z",
                epoch: "epoch-1",
            }),
        });

        await processFederationSync(job());
        expect(client.getCatalogItems).toHaveBeenNthCalledWith(
            1,
            "track",
            "resume-track-page",
        );
        const resumed = [
            ...prisma.track.deleteMany.mock.calls,
            ...prisma.album.deleteMany.mock.calls,
            ...prisma.artist.deleteMany.mock.calls,
        ].map(([args]) => args.where.id.in);

        expect(resumed).toEqual(uninterrupted);
        expect(resumed).toEqual([
            ["stale-track"],
            ["stale-album"],
            ["stale-artist"],
        ]);
    });

    it("resumes through podcast and audiobook full-sync phases", async () => {
        prisma.federationPeer.findUnique.mockResolvedValue({
            ...peer,
            lastSyncCursor: JSON.stringify({
                phase: "full",
                mediaType: "podcast",
                cursor: "resume-podcast-page",
                serverTime: "2026-08-15T11:59:59.000Z",
                epoch: "epoch-1",
            }),
        });

        await processFederationSync(job());

        expect(client.getCatalogItems).toHaveBeenNthCalledWith(
            1,
            "podcast",
            "resume-podcast-page",
        );
        expect(client.getCatalogItems).toHaveBeenNthCalledWith(
            2,
            "audiobook",
            undefined,
        );
        expect(prisma.federationPodcastListing.upsert).toHaveBeenCalled();
        expect(prisma.audiobook.upsert).toHaveBeenCalled();
    });

    it("skips full-sync types omitted from the parsed host manifest", async () => {
        prisma.federationPeer.findUnique.mockResolvedValue({
            ...peer,
            lastSyncCursor: JSON.stringify({
                phase: "full",
                mediaType: "artist",
                cursor: null,
                serverTime: "2026-08-15T11:59:59.000Z",
                epoch: "epoch-1",
            }),
        });
        client.getManifest.mockResolvedValue({
            ...manifest,
            mediaTypes: ["artist", "album", "track"],
        });

        await expect(processFederationSync(job())).resolves.toMatchObject({
            mode: "full",
            podcasts: 0,
            audiobooks: 0,
        });

        expect(
            client.getCatalogItems.mock.calls.map((call) => call[0]),
        ).toEqual(["artist", "album", "track", "artist", "album", "track"]);
        expect(prisma.federationPodcastListing.upsert).not.toHaveBeenCalled();
        expect(prisma.audiobook.upsert).not.toHaveBeenCalled();
        expect(mockLog.info).toHaveBeenCalledWith(
            "peerId=peer-1 skipping unadvertised media types: podcast,audiobook",
        );
    });

    it("stores embeddings from a matching page tuple", async () => {
        await processFederationSync(job());

        expect(upsertTrackEmbedding).toHaveBeenCalledWith(
            "fed-track-row",
            track.attributes.embedding,
            activeSpace.id,
        );
        expect(getActiveSpace).toHaveBeenCalledTimes(1);
        expect(recordFederationEmbeddingPageOutcome).toHaveBeenCalledWith(
            "stored",
        );
    });

    it("applies the parsed delta header tuple to incremental embeddings", async () => {
        prisma.federationPeer.findUnique.mockResolvedValueOnce({
            ...peer,
            lastSyncCursor: "2026-08-15T12:10:00.000Z",
        });
        client.getCatalogDelta.mockResolvedValueOnce({
            kind: "ok",
            changes: [track],
            tombstones: [],
            nextCursor: null,
            nextSince: "2026-08-15T12:12:00.000Z",
            skippedInvalid: 0,
            skippedUnknownTombstones: 0,
            embeddingSpace: {
                ...embeddingSpace,
                checkpointHash: "other-checkpoint",
            },
        });

        await processFederationSync(job());

        expect(prisma.track.upsert).toHaveBeenCalled();
        expect(upsertTrackEmbedding).not.toHaveBeenCalled();
        expect(recordFederationEmbeddingPageOutcome).toHaveBeenCalledWith(
            "skipped_mismatch",
        );
    });

    it("skips a mismatched embedding page without skipping track metadata", async () => {
        const secondTrack = {
            ...track,
            id: "remote-track-2",
            attributes: {
                ...track.attributes,
                title: "Track Two",
                audioHash: "sha256:def",
            },
        };
        client.getCatalogItems.mockImplementation((type: string) =>
            Promise.resolve(
                type === "track"
                    ? {
                          ...catalogPageFor(type),
                          items: [track, secondTrack],
                          embeddingSpace: {
                              ...embeddingSpace,
                              checkpointHash: "other-checkpoint",
                          },
                      }
                    : catalogPageFor(type),
            ),
        );

        await expect(processFederationSync(job())).resolves.toMatchObject({
            tracks: 2,
        });

        expect(prisma.track.upsert).toHaveBeenCalledTimes(2);
        expect(upsertTrackEmbedding).not.toHaveBeenCalled();
        expect(mockLog.warn).toHaveBeenCalledTimes(1);
        expect(mockLog.warn).toHaveBeenCalledWith(
            "Skipping federation embeddings because the page space does not match the local active space",
            {
                peerId: "peer-1",
                outcome: "skipped_mismatch",
                remoteEmbeddingSpace: {
                    ...embeddingSpace,
                    checkpointHash: "other-checkpoint",
                },
                localEmbeddingSpace: embeddingSpace,
            },
        );
        expect(recordFederationEmbeddingPageOutcome).toHaveBeenCalledWith(
            "skipped_mismatch",
        );
        expect(recordFederationEmbeddingPageOutcome).toHaveBeenCalledTimes(1);
    });

    it("stores a legacy page only while the canonical space is active", async () => {
        client.getCatalogItems.mockImplementation((type: string) =>
            Promise.resolve(legacyCatalogPageFor(type)),
        );

        await processFederationSync(job());

        expect(upsertTrackEmbedding).toHaveBeenCalledWith(
            "fed-track-row",
            track.attributes.embedding,
            activeSpace.id,
        );
        expect(recordFederationEmbeddingPageOutcome).toHaveBeenCalledWith(
            "stored",
        );
    });

    it("skips a legacy page after the local active-space cutover", async () => {
        getActiveSpace.mockResolvedValueOnce({
            ...activeSpace,
            id: "space-next",
        });
        client.getCatalogItems.mockImplementation((type: string) =>
            Promise.resolve(legacyCatalogPageFor(type)),
        );

        await expect(processFederationSync(job())).resolves.toMatchObject({
            tracks: 1,
        });

        expect(upsertTrackEmbedding).not.toHaveBeenCalled();
        expect(recordFederationEmbeddingPageOutcome).toHaveBeenCalledWith(
            "skipped_legacy_strict",
        );
    });

    it("treats a parsed malformed header as an embedding mismatch", async () => {
        client.getCatalogItems.mockImplementation((type: string) =>
            Promise.resolve(
                type === "track"
                    ? { ...catalogPageFor(type), embeddingSpace: null }
                    : catalogPageFor(type),
            ),
        );

        await expect(processFederationSync(job())).resolves.toMatchObject({
            tracks: 1,
        });

        expect(upsertTrackEmbedding).not.toHaveBeenCalled();
        expect(recordFederationEmbeddingPageOutcome).toHaveBeenCalledWith(
            "skipped_mismatch",
        );
    });

    it("completes metadata sync when no local embedding space is active", async () => {
        getActiveSpace.mockRejectedValueOnce(
            new MockNoActiveEmbeddingSpaceError(),
        );

        await expect(processFederationSync(job())).resolves.toMatchObject({
            tracks: 1,
        });

        expect(prisma.track.upsert).toHaveBeenCalled();
        expect(upsertTrackEmbedding).not.toHaveBeenCalled();
        expect(mockLog.warn).toHaveBeenCalledTimes(1);
        expect(mockLog.warn).toHaveBeenCalledWith(
            "Skipping federation embeddings because no local embedding space is active",
            { peerId: "peer-1" },
        );
        expect(recordFederationEmbeddingPageOutcome).toHaveBeenCalledWith(
            "skipped_mismatch",
        );
    });

    it("imports embeddings only when the persisted peer scope permits it", async () => {
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
        prisma.artist.upsert.mockResolvedValue({
            id: "artist-local-row",
            remoteId: "remote-artist-1",
            mbid: "artist-mbid-1",
        });
        prisma.artist.findMany.mockImplementation(async ({ where }) =>
            where?.OR
                ? [
                      {
                          id: "artist-local-row",
                          peerId: "peer-1",
                          remoteId: "remote-artist-1",
                          mbid: "artist-mbid-1",
                      },
                  ]
                : [],
        );
        prisma.album.findUnique.mockResolvedValue({
            id: "album-local-row",
            rgMbid: "release-group-1",
        });
        prisma.album.findFirst.mockResolvedValue(null);
        prisma.album.upsert.mockResolvedValue({
            id: "album-local-row",
            remoteId: "remote-album-1",
            rgMbid: "release-group-1",
            artistId: "artist-local-row",
        });
        prisma.album.findMany.mockImplementation(async ({ where }) =>
            where?.OR
                ? [
                      {
                          id: "album-local-row",
                          peerId: "peer-1",
                          remoteId: "remote-album-1",
                          rgMbid: "release-group-1",
                          artistId: "artist-local-row",
                      },
                  ]
                : [],
        );
        prisma.track.findUnique.mockResolvedValue({ id: "fed-track-row" });
        prisma.track.findFirst.mockResolvedValue(null);
        prisma.track.upsert.mockResolvedValue({ id: "fed-track-row" });
        prisma.track.findMany.mockImplementation(async ({ where }) =>
            where?.peerId === "peer-1" && where?.remoteId
                ? [
                      {
                          id: "fed-track-row",
                          remoteId: "remote-track-1",
                          audioHash: "sha256:abc",
                          album: { artistId: "artist-local-row" },
                      },
                  ]
                : [],
        );
        backfillAllArtistCounts.mockResolvedValue({ processed: 1, errors: 0 });

        await processFederationSync(job());
        expect(upsertTrackEmbedding).not.toHaveBeenCalled();
    });
});

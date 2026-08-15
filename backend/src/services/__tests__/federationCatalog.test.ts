const prisma = {
    systemSettings: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
    },
    artist: { count: jest.fn(), findMany: jest.fn() },
    album: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    track: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    podcast: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    audiobook: {
        count: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
    },
    federationTombstone: { findMany: jest.fn() },
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../trackEmbeddings", () => ({
    fetchEmbeddingsByTrackIds: jest.fn(),
}));
jest.mock("../../config", () => ({
    config: {
        appVersion: "2.0.2-test",
        federation: { instanceName: "soundspan-host" },
        workers: { federationTombstoneRetentionDays: 90 },
    },
}));

import { fetchEmbeddingsByTrackIds } from "../trackEmbeddings";
import {
    decodeFederationDeltaCursor,
    getFederationCatalogDelta,
    getFederationCatalogItem,
    getFederationCatalogItems,
    getFederationManifest,
} from "../federationCatalog";

const at = new Date("2026-08-15T12:00:00.000Z");

function artist(id: string) {
    return {
        id,
        name: `Artist ${id}`,
        mbid: `mbid-${id}`,
        normalizedName: `artist ${id}`,
        lastSynced: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: at,
    };
}

function album(id: string) {
    return {
        id,
        artistId: "artist-1",
        title: `Album ${id}`,
        rgMbid: `rg-${id}`,
        year: 2026,
        primaryType: "Album",
        lastSynced: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: at,
    };
}

function track(id: string) {
    return {
        id,
        albumId: "album-1",
        title: `Track ${id}`,
        discNo: 1,
        trackNo: 2,
        duration: 180,
        mime: "audio/flac",
        fileSize: 1234,
        recordingMbid: `recording-${id}`,
        isrc: `ISRC${id}`,
        audioHash: `sha256:${id}`,
        bpm: 123.5,
        beatsCount: 456,
        key: "C#",
        keyScale: "minor",
        keyStrength: 0.81,
        energy: 0.72,
        loudness: -8.4,
        dynamicRange: 9.2,
        danceability: 0.67,
        valence: 0.44,
        arousal: 0.73,
        instrumentalness: 0.15,
        acousticness: 0.22,
        speechiness: 0.04,
        moodHappy: 0.61,
        moodSad: 0.12,
        moodRelaxed: 0.33,
        moodAggressive: 0.08,
        moodParty: 0.55,
        moodAcoustic: 0.21,
        moodElectronic: 0.79,
        danceabilityMl: 0.7,
        moodTags: ["focused", "night"],
        essentiaGenres: ["electronic"],
        lastfmTags: ["synthwave"],
        updatedAt: at,
    };
}

function podcast(id: string) {
    return {
        id,
        feedUrl: `https://feeds.example/${id}.xml`,
        title: `Podcast ${id}`,
        author: "Host Author",
        description: "Host description",
        imageUrl: `https://images.example/${id}.jpg`,
        itunesId: `itunes-${id}`,
        updatedAt: at,
    };
}

function audiobook(id: string) {
    return {
        id,
        title: `Audiobook ${id}`,
        author: "Book Author",
        narrator: "Book Narrator",
        duration: 3_600,
        description: "Book description",
        asin: `ASIN-${id}`,
        isbn: `ISBN-${id}`,
        coverUrl: "items/book/cover",
        localCoverPath: null,
        updatedAt: at,
    };
}

describe("federation catalog exports", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.systemSettings.upsert.mockResolvedValue({});
        prisma.systemSettings.updateMany.mockResolvedValue({ count: 0 });
        prisma.systemSettings.findUnique.mockResolvedValue({
            federationInstanceId: "instance-1",
            catalogEpoch: "epoch-1",
        });
        (fetchEmbeddingsByTrackIds as jest.Mock).mockResolvedValue([]);
    });

    it("builds a manifest from visible local library counts", async () => {
        prisma.artist.count.mockResolvedValue(2);
        prisma.album.count.mockResolvedValue(3);
        prisma.track.count.mockResolvedValue(4);
        prisma.podcast.count.mockResolvedValue(5);
        prisma.audiobook.count.mockResolvedValue(6);

        await expect(getFederationManifest(true, at)).resolves.toEqual({
            instanceId: "instance-1",
            name: "soundspan-host",
            version: "2.0.2-test",
            catalogEpoch: "epoch-1",
            mediaTypes: ["artist", "album", "track", "podcast", "audiobook"],
            counts: {
                artists: 2,
                albums: 3,
                tracks: 4,
                podcasts: 5,
                audiobooks: 6,
            },
            embeddingsAvailable: true,
            serverTime: at,
        });
        expect(prisma.track.count).toHaveBeenCalledWith({
            where: expect.objectContaining({
                origin: "LOCAL",
                peerId: null,
                removedAt: null,
                album: expect.objectContaining({
                    location: "LIBRARY",
                    peerId: null,
                }),
            }),
        });
    });

    it("exports podcast listings and local-only audiobook mirrors", async () => {
        prisma.podcast.findMany.mockResolvedValue([podcast("podcast-1")]);
        prisma.audiobook.findMany.mockResolvedValue([audiobook("audiobook-1")]);

        const podcasts = await getFederationCatalogItems({
            mediaType: "podcast",
            limit: 10,
            includeEmbeddings: false,
        });
        const audiobooks = await getFederationCatalogItems({
            mediaType: "audiobook",
            limit: 10,
            includeEmbeddings: false,
        });

        expect(podcasts.items[0]).toEqual({
            id: "podcast-1",
            mediaType: "podcast",
            updatedAt: at,
            attributes: expect.objectContaining({
                feedUrl: "https://feeds.example/podcast-1.xml",
                description: "Host description",
            }),
        });
        expect(audiobooks.items[0]).toEqual({
            id: "audiobook-1",
            mediaType: "audiobook",
            updatedAt: at,
            attributes: expect.objectContaining({
                title: "Audiobook audiobook-1",
                coverUrl: true,
            }),
        });
        expect(prisma.podcast.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: {} }),
        );
        expect(prisma.audiobook.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { peerId: null } }),
        );
    });

    it("returns one exported item by type and id", async () => {
        prisma.album.findFirst.mockResolvedValue(album("album-1"));

        await expect(
            getFederationCatalogItem({
                mediaType: "album",
                id: "album-1",
                includeEmbeddings: false,
            }),
        ).resolves.toEqual(
            expect.objectContaining({
                id: "album-1",
                mediaType: "album",
                updatedAt: at,
            }),
        );
    });

    it("keyset-pages generic artist envelopes at the requested boundary", async () => {
        prisma.artist.findMany.mockResolvedValue([
            artist("a1"),
            artist("a2"),
            artist("a3"),
        ]);

        const result = await getFederationCatalogItems({
            mediaType: "artist",
            cursor: "a0",
            limit: 2,
            includeEmbeddings: false,
        });

        expect(prisma.artist.findMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ id: { gt: "a0" }, peerId: null }),
            orderBy: { id: "asc" },
            take: 3,
            select: expect.any(Object),
        });
        expect(result).toEqual({
            items: [
                {
                    id: "a1",
                    mediaType: "artist",
                    updatedAt: at,
                    attributes: {
                        name: "Artist a1",
                        mbid: "mbid-a1",
                        normalizedName: "artist a1",
                    },
                },
                {
                    id: "a2",
                    mediaType: "artist",
                    updatedAt: at,
                    attributes: {
                        name: "Artist a2",
                        mbid: "mbid-a2",
                        normalizedName: "artist a2",
                    },
                },
            ],
            nextCursor: "a2",
        });
    });

    it("emits album and track parent refs and gates embeddings by scope", async () => {
        prisma.album.findMany.mockResolvedValue([album("album-1")]);
        prisma.track.findMany.mockResolvedValue([track("track-1")]);
        (fetchEmbeddingsByTrackIds as jest.Mock).mockResolvedValue([
            { trackId: "track-1", embedding: [0.1, 0.2] },
        ]);

        const albumResult = await getFederationCatalogItems({
            mediaType: "album",
            limit: 200,
            includeEmbeddings: false,
        });
        const trackWithout = await getFederationCatalogItems({
            mediaType: "track",
            limit: 200,
            includeEmbeddings: false,
        });
        const trackWith = await getFederationCatalogItems({
            mediaType: "track",
            limit: 200,
            includeEmbeddings: true,
        });

        expect(albumResult.items[0]).toEqual(
            expect.objectContaining({ parentRef: "artist-1" }),
        );
        expect(trackWithout.items[0]).toEqual(
            expect.objectContaining({ parentRef: "album-1" }),
        );
        expect(trackWithout.items[0].attributes).not.toHaveProperty(
            "embedding",
        );
        expect(trackWith.items[0].attributes).toEqual(
            expect.objectContaining({
                bpm: 123.5,
                beatsCount: 456,
                key: "C#",
                keyScale: "minor",
                keyStrength: 0.81,
                energy: 0.72,
                loudness: -8.4,
                dynamicRange: 9.2,
                danceability: 0.67,
                valence: 0.44,
                arousal: 0.73,
                instrumentalness: 0.15,
                acousticness: 0.22,
                speechiness: 0.04,
                moodHappy: 0.61,
                moodSad: 0.12,
                moodRelaxed: 0.33,
                moodAggressive: 0.08,
                moodParty: 0.55,
                moodAcoustic: 0.21,
                moodElectronic: 0.79,
                danceabilityMl: 0.7,
                moodTags: ["focused", "night"],
                essentiaGenres: ["electronic"],
                lastfmTags: ["synthwave"],
                embedding: [0.1, 0.2],
            }),
        );
        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    origin: "LOCAL",
                    peerId: null,
                    removedAt: null,
                    album: expect.objectContaining({
                        location: "LIBRARY",
                        peerId: null,
                    }),
                }),
            }),
        );
    });

    it("expresses non-transitive export filters for every catalog type", async () => {
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.album.findMany.mockResolvedValue([]);
        prisma.track.findMany.mockResolvedValue([]);
        prisma.podcast.findMany.mockResolvedValue([]);
        prisma.audiobook.findMany.mockResolvedValue([]);

        await getFederationCatalogItems({
            mediaType: "artist",
            limit: 10,
            includeEmbeddings: false,
        });
        await getFederationCatalogItems({
            mediaType: "album",
            limit: 10,
            includeEmbeddings: false,
        });
        await getFederationCatalogItems({
            mediaType: "track",
            limit: 10,
            includeEmbeddings: false,
        });
        await getFederationCatalogItems({
            mediaType: "podcast",
            limit: 10,
            includeEmbeddings: false,
        });
        await getFederationCatalogItems({
            mediaType: "audiobook",
            limit: 10,
            includeEmbeddings: false,
        });

        expect(prisma.artist.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    peerId: null,
                    albums: { some: { location: "LIBRARY", peerId: null } },
                },
            }),
        );
        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    location: "LIBRARY",
                    peerId: null,
                    artist: { peerId: null },
                },
            }),
        );
        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    origin: "LOCAL",
                    peerId: null,
                    removedAt: null,
                    album: {
                        location: "LIBRARY",
                        peerId: null,
                        artist: { peerId: null },
                    },
                },
            }),
        );
        expect(prisma.podcast.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: {} }),
        );
        expect(prisma.audiobook.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { peerId: null } }),
        );
    });

    it("returns a typed epoch mismatch without querying catalog rows", async () => {
        const result = await getFederationCatalogDelta({
            since: new Date("2026-08-15T11:00:00.000Z"),
            epoch: "old-epoch",
            limit: 200,
            includeEmbeddings: false,
            now: at,
        });

        expect(result).toEqual({
            kind: "epochMismatch",
            currentEpoch: "epoch-1",
        });
        expect(prisma.artist.findMany).not.toHaveBeenCalled();
    });

    it("returns a typed stale cursor before querying catalog rows", async () => {
        const result = await getFederationCatalogDelta({
            since: new Date("2026-05-01T00:00:00.000Z"),
            epoch: "epoch-1",
            limit: 200,
            includeEmbeddings: false,
            now: at,
        });

        expect(result).toEqual({
            kind: "staleCursor",
            currentEpoch: "epoch-1",
        });
        expect(prisma.artist.findMany).not.toHaveBeenCalled();
    });

    it("bounds and keyset-pages merged delta changes and tombstones", async () => {
        prisma.artist.findMany.mockResolvedValue([artist("a1")]);
        prisma.album.findMany.mockResolvedValue([album("b1")]);
        prisma.track.findMany.mockResolvedValue([track("c1")]);
        prisma.podcast.findMany.mockResolvedValue([podcast("e1")]);
        prisma.audiobook.findMany.mockResolvedValue([audiobook("f1")]);
        prisma.federationTombstone.findMany.mockResolvedValue([
            {
                id: "d1",
                entityType: "track",
                entityId: "deleted-1",
                deletedAt: at,
            },
        ]);

        const result = await getFederationCatalogDelta({
            since: new Date("2026-08-15T11:00:00.000Z"),
            epoch: "epoch-1",
            limit: 2,
            includeEmbeddings: false,
            now: new Date("2026-08-15T12:01:00.000Z"),
        });

        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") throw new Error("expected delta payload");
        expect(result.changes.length + result.tombstones.length).toBe(2);
        expect(result.nextCursor).toEqual(expect.any(String));
        expect(decodeFederationDeltaCursor(result.nextCursor!)).toEqual({
            updatedAt: at,
            id: "b1",
        });
        expect(result.nextSince).toEqual(new Date("2026-08-15T12:01:00.000Z"));
        expect(prisma.artist.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    AND: expect.arrayContaining([
                        { updatedAt: expect.any(Object) },
                    ]),
                }),
                orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            }),
        );
        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            }),
        );
    });
});

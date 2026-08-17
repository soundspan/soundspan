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
class MockNoActiveEmbeddingSpaceError extends Error {}
const mockLog = { warn: jest.fn() };
const mockRecordFederationEmbeddingExportOutcome = jest.fn();

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../trackEmbeddings", () => ({
    fetchEmbeddingsByTrackIds: jest.fn(),
}));
jest.mock("../embeddingSpaces", () => ({
    getActiveSpace: jest.fn(),
    NoActiveEmbeddingSpaceError: MockNoActiveEmbeddingSpaceError,
    embeddingPreprocessingHash: jest.fn(
        () =>
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    ),
}));
jest.mock("../../utils/logger", () => ({
    logger: { child: jest.fn(() => mockLog) },
}));
jest.mock("../../metrics", () => ({
    recordFederationEmbeddingExportOutcome:
        mockRecordFederationEmbeddingExportOutcome,
}));
jest.mock("../../config", () => ({
    config: {
        appVersion: "2.0.2-test",
        federation: { instanceName: "soundspan-host" },
        workers: { federationTombstoneRetentionDays: 90 },
    },
}));

import { fetchEmbeddingsByTrackIds } from "../trackEmbeddings";
import { getActiveSpace } from "../embeddingSpaces";
import {
    decodeFederationDeltaCursor,
    getFederationCatalogDelta,
    getFederationCatalogItem,
    getFederationCatalogItems,
    getFederationManifest,
} from "../federationCatalog";

const at = new Date("2026-08-15T12:00:00.000Z");
const activeSpace = {
    id: "space_clap_music_audioset_v1",
    family: "clap-music-audioset",
    checkpointHash: "checkpoint-hash",
    dim: 512,
    preprocessing: {},
};

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
        (getActiveSpace as jest.Mock).mockResolvedValue(activeSpace);
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

        expect(podcasts.body.items[0]).toEqual({
            id: "podcast-1",
            mediaType: "podcast",
            updatedAt: at,
            attributes: expect.objectContaining({
                feedUrl: "https://feeds.example/podcast-1.xml",
                description: "Host description",
            }),
        });
        expect(audiobooks.body.items[0]).toEqual({
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
                body: expect.objectContaining({
                    id: "album-1",
                    mediaType: "album",
                    updatedAt: at,
                }),
            }),
        );
    });

    it("tags a single exported track response when it carries an embedding", async () => {
        prisma.track.findFirst.mockResolvedValue(track("track-1"));
        (fetchEmbeddingsByTrackIds as jest.Mock).mockResolvedValue([
            { trackId: "track-1", embedding: [0.1, 0.2] },
        ]);

        const result = await getFederationCatalogItem({
            mediaType: "track",
            id: "track-1",
            includeEmbeddings: true,
        });

        expect(result?.body.attributes).toHaveProperty("embedding", [0.1, 0.2]);
        expect(result?.embeddingSpaceHeaderValue).toBe(
            '{"family":"clap-music-audioset","checkpointHash":"checkpoint-hash","dim":512,"preprocessingHash":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"}',
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
            body: {
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
            },
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

        expect(albumResult.body.items[0]).toEqual(
            expect.objectContaining({ parentRef: "artist-1" }),
        );
        expect(trackWithout.body.items[0]).toEqual(
            expect.objectContaining({ parentRef: "album-1" }),
        );
        expect(trackWithout.body.items[0].attributes).not.toHaveProperty(
            "embedding",
        );
        expect(trackWithout).not.toHaveProperty("embeddingSpaceHeaderValue");
        expect(trackWithout.body).not.toHaveProperty("embeddingSpace");
        expect(trackWith.embeddingSpaceHeaderValue).toBe(
            '{"family":"clap-music-audioset","checkpointHash":"checkpoint-hash","dim":512,"preprocessingHash":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"}',
        );
        expect(trackWith.body).not.toHaveProperty("embeddingSpace");
        expect(trackWith.body.items[0].attributes).toEqual(
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

    it("serves embeddings to a headerless peer while the teacher space is active", async () => {
        prisma.track.findMany.mockResolvedValue([track("teacher-track")]);
        (fetchEmbeddingsByTrackIds as jest.Mock).mockResolvedValue([
            { trackId: "teacher-track", embedding: [0.1, 0.2] },
        ]);
        const input = {
            mediaType: "track" as const,
            limit: 200,
            includeEmbeddings: true,
            peerId: "legacy-teacher-peer",
            acceptsEmbeddingSpace: false,
        };

        const result = await getFederationCatalogItems(input);

        expect(result.body.items[0].attributes).toHaveProperty("embedding");
        expect(result).toHaveProperty("embeddingSpaceHeaderValue");
        expect(
            mockRecordFederationEmbeddingExportOutcome,
        ).not.toHaveBeenCalled();
    });

    it("suppresses post-cutover embeddings for a headerless peer and records the decision", async () => {
        prisma.track.findMany.mockResolvedValue([track("student-track")]);
        (getActiveSpace as jest.Mock).mockResolvedValue({
            ...activeSpace,
            id: "space_dclap_student_v1",
        });
        (fetchEmbeddingsByTrackIds as jest.Mock).mockResolvedValue([
            { trackId: "student-track", embedding: [0.1, 0.2] },
        ]);
        const input = {
            mediaType: "track" as const,
            limit: 200,
            includeEmbeddings: true,
            peerId: "legacy-student-peer",
            acceptsEmbeddingSpace: false,
        };

        const first = await getFederationCatalogItems(input);
        const second = await getFederationCatalogItems(input);

        expect(first.body.items[0].attributes).not.toHaveProperty("embedding");
        expect(first).not.toHaveProperty("embeddingSpaceHeaderValue");
        expect(second.body.items[0].attributes).not.toHaveProperty("embedding");
        expect(fetchEmbeddingsByTrackIds).not.toHaveBeenCalled();
        expect(
            mockRecordFederationEmbeddingExportOutcome,
        ).toHaveBeenCalledTimes(2);
        expect(mockRecordFederationEmbeddingExportOutcome).toHaveBeenCalledWith(
            "suppressed_legacy_peer",
        );
        expect(mockLog.warn).toHaveBeenCalledTimes(1);
        expect(mockLog.warn).toHaveBeenCalledWith(
            "Suppressing federation embeddings for a peer without embedding-space support",
            {
                peerId: "legacy-student-peer",
                activeSpaceId: "space_dclap_student_v1",
            },
        );
    });

    it("serves post-cutover embeddings to a capability-aware peer", async () => {
        prisma.track.findMany.mockResolvedValue([track("student-track")]);
        (getActiveSpace as jest.Mock).mockResolvedValueOnce({
            ...activeSpace,
            id: "space_dclap_student_v1",
        });
        (fetchEmbeddingsByTrackIds as jest.Mock).mockResolvedValue([
            { trackId: "student-track", embedding: [0.1, 0.2] },
        ]);
        const input = {
            mediaType: "track" as const,
            limit: 200,
            includeEmbeddings: true,
            peerId: "space-aware-peer",
            acceptsEmbeddingSpace: true,
        };

        const result = await getFederationCatalogItems(input);

        expect(result.body.items[0].attributes).toHaveProperty("embedding");
        expect(result.embeddingSpaceHeaderValue).toBe(
            '{"family":"clap-music-audioset","checkpointHash":"checkpoint-hash","dim":512,"preprocessingHash":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"}',
        );
        expect(fetchEmbeddingsByTrackIds).toHaveBeenCalledWith(
            ["student-track"],
            "space_dclap_student_v1",
        );
        expect(
            mockRecordFederationEmbeddingExportOutcome,
        ).not.toHaveBeenCalled();
    });

    it("keeps the resolved header space and vector query space consistent across cutover", async () => {
        prisma.track.findMany.mockResolvedValue([track("cutover-track")]);
        let resolutionCount = 0;
        (getActiveSpace as jest.Mock).mockImplementation(async () => {
            resolutionCount += 1;
            return resolutionCount === 1
                ? activeSpace
                : { ...activeSpace, id: "space-after-cutover" };
        });
        (fetchEmbeddingsByTrackIds as jest.Mock).mockResolvedValue([
            { trackId: "cutover-track", embedding: [0.1, 0.2] },
        ]);

        const result = await getFederationCatalogItems({
            mediaType: "track",
            limit: 200,
            includeEmbeddings: true,
            acceptsEmbeddingSpace: true,
        });

        expect(getActiveSpace).toHaveBeenCalledTimes(1);
        expect(fetchEmbeddingsByTrackIds).toHaveBeenCalledWith(
            ["cutover-track"],
            activeSpace.id,
        );
        expect(result.embeddingSpaceHeaderValue).toContain(
            '"checkpointHash":"checkpoint-hash"',
        );
    });

    it.each(["active-space lookup", "embedding fetch"])(
        "degrades an embedding page when %s reports no active space",
        async (failurePoint) => {
            prisma.track.findMany.mockResolvedValue([track("track-1")]);
            if (failurePoint === "active-space lookup") {
                (getActiveSpace as jest.Mock).mockRejectedValueOnce(
                    new MockNoActiveEmbeddingSpaceError(),
                );
            } else {
                (fetchEmbeddingsByTrackIds as jest.Mock).mockRejectedValueOnce(
                    new MockNoActiveEmbeddingSpaceError(),
                );
            }

            const result = await getFederationCatalogItems({
                mediaType: "track",
                limit: 200,
                includeEmbeddings: true,
            });

            expect(result.body.items[0].attributes).not.toHaveProperty(
                "embedding",
            );
            expect(result).not.toHaveProperty("embeddingSpaceHeaderValue");
            expect(result.body).not.toHaveProperty("embeddingSpace");
            expect(mockLog.warn).toHaveBeenCalledTimes(1);
        },
    );

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
            body: {
                kind: "epochMismatch",
                currentEpoch: "epoch-1",
            },
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
            body: {
                kind: "staleCursor",
                currentEpoch: "epoch-1",
            },
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
        (fetchEmbeddingsByTrackIds as jest.Mock).mockResolvedValue([
            { trackId: "c1", embedding: [0.1, 0.2] },
        ]);

        const result = await getFederationCatalogDelta({
            since: new Date("2026-08-15T11:00:00.000Z"),
            epoch: "epoch-1",
            limit: 3,
            includeEmbeddings: true,
            now: new Date("2026-08-15T12:01:00.000Z"),
        });

        expect(result.body.kind).toBe("ok");
        if (result.body.kind !== "ok")
            throw new Error("expected delta payload");
        expect(result.body.changes.length + result.body.tombstones.length).toBe(
            3,
        );
        expect(result.body.nextCursor).toEqual(expect.any(String));
        expect(decodeFederationDeltaCursor(result.body.nextCursor!)).toEqual({
            updatedAt: at,
            id: "c1",
        });
        expect(result.body.nextSince).toEqual(
            new Date("2026-08-15T12:01:00.000Z"),
        );
        expect(result.embeddingSpaceHeaderValue).toBe(
            '{"family":"clap-music-audioset","checkpointHash":"checkpoint-hash","dim":512,"preprocessingHash":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"}',
        );
        expect(result.body).not.toHaveProperty("embeddingSpace");
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

    it("omits the delta header when embeddings are excluded", async () => {
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.album.findMany.mockResolvedValue([]);
        prisma.track.findMany.mockResolvedValue([track("track-1")]);
        prisma.podcast.findMany.mockResolvedValue([]);
        prisma.audiobook.findMany.mockResolvedValue([]);
        prisma.federationTombstone.findMany.mockResolvedValue([]);

        const result = await getFederationCatalogDelta({
            since: new Date("2026-08-15T11:00:00.000Z"),
            epoch: "epoch-1",
            limit: 200,
            includeEmbeddings: false,
            now: at,
        });

        expect(result.body.kind).toBe("ok");
        if (result.body.kind !== "ok")
            throw new Error("expected delta payload");
        expect(result.body.changes[0].attributes).not.toHaveProperty(
            "embedding",
        );
        expect(result).not.toHaveProperty("embeddingSpaceHeaderValue");
    });
});

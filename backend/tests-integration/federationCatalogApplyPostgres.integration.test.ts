import { Client } from "pg";
import type { FederationEnvelope } from "../src/services/federationClient";
import type {
    AlbumEnvelope,
    ArtistEnvelope,
    TrackEnvelope,
} from "../src/workers/processors/federationSyncPage";
import {
    upsertFederationAlbumPage,
    upsertFederationArtistPage,
    upsertFederationTrackPage,
} from "../src/workers/processors/federationSyncPersistence";
import { processFederationSync } from "../src/workers/processors/federationSyncProcessor";
import { prisma } from "../src/utils/db";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

interface ProcessorClient {
    getManifest: jest.Mock;
    getCatalogItems: jest.Mock;
    getCatalogDelta: jest.Mock;
    getCatalogItem: jest.Mock;
    getPresence: jest.Mock;
}

const mockProcessorClients = new Map<string, ProcessorClient>();
const mockCreateFederationClient = jest.fn((peer: { id: string }) => {
    const client = mockProcessorClients.get(peer.id);
    if (!client) throw new Error(`Missing test client for ${peer.id}`);
    return client;
});

jest.mock("../src/services/federationClient", () => {
    class FederationCursorError extends Error {
        constructor(readonly currentEpoch: string) {
            super("federation cursor changed");
        }
    }
    class FederationHttpError extends Error {
        constructor(readonly status: number) {
            super(`federation HTTP ${status}`);
        }
    }
    return {
        createFederationClient: (peer: { id: string }) =>
            mockCreateFederationClient(peer),
        MAX_PAGE_ITEMS: 500,
        FederationEpochMismatchError: FederationCursorError,
        FederationStaleCursorError: FederationCursorError,
        FederationHttpError,
    };
});

jest.mock("../src/services/embeddingSpaces", () => {
    class NoActiveEmbeddingSpaceError extends Error {}
    return {
        getActiveSpace: jest.fn(async () => null),
        NoActiveEmbeddingSpaceError,
    };
});

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;

const peerId = "federation-apply-peer";
const processorEpoch = "processor-epoch";
const initialCursor = "2026-08-20T11:00:00.000Z";
const nextSince = "2026-08-20T14:00:00.000Z";

function processorClient(
    getCatalogDelta: ProcessorClient["getCatalogDelta"],
    getCatalogItem: ProcessorClient["getCatalogItem"] = jest.fn(),
): ProcessorClient {
    return {
        getManifest: jest.fn(async () => ({
            catalogEpoch: processorEpoch,
            mediaTypes: ["artist", "album", "track"],
            serverTime: nextSince,
        })),
        getCatalogItems: jest.fn(),
        getCatalogDelta,
        getCatalogItem,
        getPresence: jest.fn(async () => ({ users: [] })),
    };
}

function deltaPage(
    changes: readonly FederationEnvelope[],
    nextCursor: string | null = null,
) {
    return {
        kind: "ok" as const,
        changes,
        tombstones: [],
        nextCursor,
        nextSince,
        skippedInvalid: 0,
        skippedUnknownTombstones: 0,
    };
}

async function seedProcessorPeer(id: string): Promise<void> {
    await prisma.federationPeer.create({
        data: {
            id,
            name: id,
            direction: "CONSUMER",
            baseUrl: "https://peer.example",
            outboundToken: "test-token",
            scopes: ["library:read"],
            outboundStatus: "ACTIVE",
            lastSyncCursor: initialCursor,
            catalogEpoch: processorEpoch,
            createdById: "federation-apply-user",
        },
    });
}

function processorJob(id: string) {
    return { data: { peerId: id } } as Parameters<
        typeof processFederationSync
    >[0];
}

const artist = {
    id: "remote-artist",
    mediaType: "artist",
    updatedAt: "2026-08-20T12:00:00.000Z",
    attributes: {
        name: "Remote Artist",
        mbid: "remote-artist-mbid",
        normalizedName: "remote artist",
    },
} satisfies ArtistEnvelope;

const album = {
    id: "remote-album",
    mediaType: "album",
    updatedAt: "2026-08-20T12:01:00.000Z",
    parentRef: artist.id,
    attributes: {
        title: "Remote Album",
        rgMbid: "remote-album-rg-mbid",
        year: 2026,
        primaryType: "Album",
    },
} satisfies AlbumEnvelope;

const track = {
    id: "remote-track",
    mediaType: "track",
    updatedAt: "2026-08-20T12:02:00.000Z",
    parentRef: album.id,
    attributes: {
        title: "Remote Track",
        discNo: 1,
        trackNo: 2,
        duration: 183,
        mime: "audio/flac",
        fileSize: 1024,
        recordingMbid: "remote-recording-mbid",
        isrc: "USAAA2600001",
        audioHash: "sha256:remote",
        bpm: 123.5,
        energy: 0.75,
        loudnessLufs: -14.2,
        moodTags: ["focused"],
        essentiaGenres: ["electronic"],
        lastfmTags: ["synthwave"],
    },
} satisfies TrackEnvelope;

function trackEnvelope(
    id: string,
    parentRef: string,
    audioHash: string,
    fileSize = 1_024,
): TrackEnvelope {
    return {
        ...track,
        id,
        parentRef,
        attributes: {
            ...track.attributes,
            title: id,
            trackNo: id.endsWith("2") ? 2 : 1,
            recordingMbid: `${id}-recording`,
            isrc: `${id}-isrc`,
            audioHash,
            fileSize,
        },
    };
}

async function seedLocalDedupTargets(): Promise<void> {
    await prisma.artist.create({
        data: {
            id: "dedup-local-artist",
            mbid: "dedup-local-artist-mbid",
            name: "Dedup Local Artist",
            normalizedName: "dedup local artist",
        },
    });
    await prisma.album.create({
        data: {
            id: "dedup-local-album",
            rgMbid: "dedup-local-album-mbid",
            artistId: "dedup-local-artist",
            title: "Dedup Local Album",
            primaryType: "Album",
            location: "LIBRARY",
        },
    });
    for (const suffix of ["a", "b"] as const) {
        await prisma.track.create({
            data: {
                id: `dedup-local-${suffix}`,
                albumId: "dedup-local-album",
                title: `Dedup Local ${suffix}`,
                trackNo: suffix === "a" ? 1 : 2,
                discNo: 1,
                duration: 180,
                fileModified: new Date("2026-08-20T10:00:00.000Z"),
                fileSize: 1_024,
                audioHash: `dedup-hash-${suffix}`,
            },
        });
    }
}

async function seedRemoteDedupFixture(peerIdValue: string): Promise<void> {
    const remoteArtistId = `${peerIdValue}-artist-row`;
    const remoteAlbumId = `${peerIdValue}-album-row`;
    await prisma.artist.create({
        data: {
            id: remoteArtistId,
            peerId: peerIdValue,
            remoteId: "dedup-remote-artist",
            mbid: `${peerIdValue}-artist-mbid`,
            name: "Remote Dedup Artist",
            normalizedName: "remote dedup artist",
        },
    });
    await prisma.album.create({
        data: {
            id: remoteAlbumId,
            peerId: peerIdValue,
            remoteId: "dedup-remote-album",
            artistId: remoteArtistId,
            rgMbid: `${peerIdValue}-album-mbid`,
            title: "Remote Dedup Album",
            primaryType: "Album",
            location: "FEDERATED",
        },
    });
    for (const suffix of ["1", "2"] as const) {
        await prisma.track.create({
            data: {
                id: `${peerIdValue}-track-${suffix}`,
                peerId: peerIdValue,
                remoteId: `dedup-remote-track-${suffix}`,
                albumId: remoteAlbumId,
                title: `Remote Dedup Track ${suffix}`,
                trackNo: Number(suffix),
                discNo: 1,
                duration: 180,
                fileModified: new Date("2026-08-20T10:00:00.000Z"),
                fileSize: 1_024,
                origin: "FEDERATED",
                audioHash: "dedup-hash-a",
                dedupOfTrackId: "dedup-local-a",
            },
        });
    }
}

async function seedPoisonParentHierarchy(peerIdValue: string): Promise<void> {
    await prisma.artist.create({
        data: {
            id: "poison-parent-artist-row",
            peerId: peerIdValue,
            remoteId: "poison-parent-artist",
            mbid: "poison-parent-artist-mbid",
            name: "Poison Parent Artist",
            normalizedName: "poison parent artist",
        },
    });
    await prisma.album.create({
        data: {
            id: "poison-parent-album-row",
            peerId: peerIdValue,
            remoteId: "poison-parent-album",
            artistId: "poison-parent-artist-row",
            rgMbid: "poison-parent-album-mbid",
            title: "Poison Parent Album",
            primaryType: "Album",
            location: "FEDERATED",
        },
    });
}

function poisonPageFixture() {
    const pageArtist = {
        ...artist,
        id: "poison-page-artist",
        attributes: {
            ...artist.attributes,
            mbid: "poison-page-artist-mbid",
        },
    } satisfies ArtistEnvelope;
    const validTrack = trackEnvelope(
        "poison-track-1",
        "poison-parent-album",
        "poison-hash-1",
    );
    const poisonTrack = trackEnvelope(
        "poison-track-2",
        "poison-parent-album",
        "poison-hash-2",
        2_147_483_648,
    );
    return { pageArtist, validTrack, poisonTrack };
}

async function expectPeerCursor(
    peerIdValue: string,
    expected: string,
): Promise<void> {
    await expect(
        prisma.federationPeer.findUnique({
            where: { id: peerIdValue },
            select: { lastSyncCursor: true },
        }),
    ).resolves.toEqual({ lastSyncCursor: expected });
}

function missingParentFixture() {
    const recoveredArtist = {
        ...artist,
        id: "recovered-artist",
        attributes: { ...artist.attributes, mbid: "recovered-artist-mbid" },
    } satisfies ArtistEnvelope;
    const recoveredAlbum = {
        ...album,
        id: "recovered-album",
        parentRef: recoveredArtist.id,
        attributes: { ...album.attributes, rgMbid: "recovered-album-mbid" },
    } satisfies AlbumEnvelope;
    const recoveredTrack = trackEnvelope(
        "recovered-track",
        recoveredAlbum.id,
        "recovered-track-hash",
    );
    return { recoveredArtist, recoveredAlbum, recoveredTrack };
}

async function expectRecoveredHierarchy(
    peerIdValue: string,
    remoteIds: readonly string[],
): Promise<void> {
    const [artistId, albumId, trackId] = remoteIds;
    const unique = (remoteId: string) => ({
        peerId_remoteId: { peerId: peerIdValue, remoteId },
    });
    await expect(
        prisma.artist.findUnique({
            where: unique(artistId),
            select: { id: true },
        }),
    ).resolves.not.toBeNull();
    await expect(
        prisma.album.findUnique({
            where: unique(albumId),
            select: { id: true },
        }),
    ).resolves.not.toBeNull();
    await expect(
        prisma.track.findUnique({
            where: unique(trackId),
            select: { id: true },
        }),
    ).resolves.not.toBeNull();
}

describeWithPostgres(
    "federation catalog batch apply PostgreSQL behavior",
    () => {
        let admin: Client;

        beforeEach(() => {
            mockProcessorClients.clear();
            mockCreateFederationClient.mockClear();
        });

        beforeAll(async () => {
            admin = await createScaleDatabase(
                integrationDatabaseUrl!,
                databaseName!,
            );
            await applyScaleMigrations(process.env.DATABASE_URL!);
            await prisma.user.create({
                data: {
                    id: "federation-apply-user",
                    username: "federation-apply",
                },
            });
            await prisma.federationPeer.create({
                data: {
                    id: peerId,
                    name: "Batch peer",
                    direction: "CONSUMER",
                    scopes: ["library:read"],
                    createdById: "federation-apply-user",
                },
            });
        });

        afterAll(async () => {
            await prisma.$disconnect();
            if (admin && databaseName)
                await dropScaleDatabase(admin, databaseName);
        });

        it("applies and replays one dependency-ordered page with sequential-equivalent state", async () => {
            const first = await prisma.$transaction(async (transaction) => {
                const [artistRow] = await upsertFederationArtistPage(
                    transaction,
                    peerId,
                    [{ item: artist, mbid: artist.attributes.mbid }],
                );
                const [albumRow] = await upsertFederationAlbumPage(
                    transaction,
                    peerId,
                    [
                        {
                            item: album,
                            artistId: artistRow.id,
                            rgMbid: album.attributes.rgMbid,
                        },
                    ],
                );
                const [trackRow] = await upsertFederationTrackPage(
                    transaction,
                    peerId,
                    [{ item: track, album: albumRow, existing: null }],
                );
                return { artistRow, albumRow, trackRow };
            });

            const replay = {
                ...track,
                updatedAt: "2026-08-20T13:02:00.000Z",
                attributes: {
                    ...track.attributes,
                    title: "Remote Track Updated",
                    bpm: undefined,
                    energy: null,
                },
            } satisfies TrackEnvelope;
            await prisma.$transaction(async (transaction) => {
                await upsertFederationArtistPage(transaction, peerId, [
                    {
                        item: artist,
                        mbid: artist.attributes.mbid,
                        existingId: first.artistRow.id,
                    },
                ]);
                await upsertFederationAlbumPage(transaction, peerId, [
                    {
                        item: album,
                        artistId: first.artistRow.id,
                        rgMbid: album.attributes.rgMbid,
                        existingId: first.albumRow.id,
                    },
                ]);
                await upsertFederationTrackPage(transaction, peerId, [
                    {
                        item: replay,
                        album: first.albumRow,
                        existing: first.trackRow,
                    },
                ]);
            });

            await expect(
                prisma.track.findUnique({
                    where: { id: first.trackRow.id },
                    select: {
                        title: true,
                        origin: true,
                        filePath: true,
                        removedAt: true,
                        bpm: true,
                        energy: true,
                        loudnessLufs: true,
                        moodTags: true,
                    },
                }),
            ).resolves.toEqual({
                title: "Remote Track Updated",
                origin: "FEDERATED",
                filePath: null,
                removedAt: null,
                bpm: 123.5,
                energy: null,
                loudnessLufs: -14.2,
                moodTags: ["focused"],
            });
            await expect(
                prisma.track.count({ where: { peerId, remoteId: track.id } }),
            ).resolves.toBe(1);
        });

        it("rolls back a poison-row page, retains the cursor, and succeeds after correction", async () => {
            const testPeerId = "federation-poison-peer";
            await seedProcessorPeer(testPeerId);
            await seedPoisonParentHierarchy(testPeerId);
            const { pageArtist, validTrack, poisonTrack } = poisonPageFixture();
            const client = processorClient(
                jest.fn(async () =>
                    deltaPage([pageArtist, validTrack, poisonTrack]),
                ),
            );
            mockProcessorClients.set(testPeerId, client);

            await expect(
                processFederationSync(processorJob(testPeerId)),
            ).rejects.toThrow();
            await expect(
                prisma.artist.count({
                    where: { peerId: testPeerId, remoteId: pageArtist.id },
                }),
            ).resolves.toBe(0);
            await expect(
                prisma.track.count({ where: { peerId: testPeerId } }),
            ).resolves.toBe(0);
            await expectPeerCursor(testPeerId, initialCursor);

            const correctedTrack = trackEnvelope(
                poisonTrack.id,
                poisonTrack.parentRef,
                poisonTrack.attributes.audioHash ?? "poison-hash-2",
            );
            client.getCatalogDelta.mockResolvedValue(
                deltaPage([pageArtist, validTrack, correctedTrack]),
            );

            await expect(
                processFederationSync(processorJob(testPeerId)),
            ).resolves.toMatchObject({ artists: 1, tracks: 2 });
            await expect(
                prisma.track.count({ where: { peerId: testPeerId } }),
            ).resolves.toBe(2);
            await expectPeerCursor(testPeerId, nextSince);
        });

        it("matches sequential dedup retargeting when two changes apply in one page", async () => {
            const batchPeerId = "federation-dedup-batch-peer";
            const sequentialPeerId = "federation-dedup-sequential-peer";
            await seedLocalDedupTargets();
            for (const id of [batchPeerId, sequentialPeerId]) {
                await seedProcessorPeer(id);
                await seedRemoteDedupFixture(id);
            }
            const updates = ["1", "2"].map((suffix) =>
                trackEnvelope(
                    `dedup-remote-track-${suffix}`,
                    "dedup-remote-album",
                    "dedup-hash-b",
                ),
            );
            mockProcessorClients.set(
                batchPeerId,
                processorClient(jest.fn(async () => deltaPage(updates))),
            );
            mockProcessorClients.set(
                sequentialPeerId,
                processorClient(
                    jest.fn(async ({ cursor }: { cursor?: string }) =>
                        cursor === "dedup-page-2"
                            ? deltaPage([updates[1]])
                            : deltaPage([updates[0]], "dedup-page-2"),
                    ),
                ),
            );

            await processFederationSync(processorJob(batchPeerId));
            await processFederationSync(processorJob(sequentialPeerId));

            const stateFor = (id: string) =>
                prisma.track.findMany({
                    where: { peerId: id },
                    orderBy: { remoteId: "asc" },
                    select: {
                        remoteId: true,
                        audioHash: true,
                        dedupOfTrackId: true,
                    },
                });
            const batchState = await stateFor(batchPeerId);
            const sequentialState = await stateFor(sequentialPeerId);
            expect(batchState).toEqual(sequentialState);
            expect(batchState).toEqual([
                {
                    remoteId: "dedup-remote-track-1",
                    audioHash: "dedup-hash-b",
                    dedupOfTrackId: "dedup-local-b",
                },
                {
                    remoteId: "dedup-remote-track-2",
                    audioHash: "dedup-hash-b",
                    dedupOfTrackId: "dedup-local-b",
                },
            ]);
        });

        it("persists missing parents fetched at the HTTP boundary before applying the page", async () => {
            const testPeerId = "federation-parent-recovery-peer";
            await seedProcessorPeer(testPeerId);
            const { recoveredArtist, recoveredAlbum, recoveredTrack } =
                missingParentFixture();
            const getCatalogItem = jest.fn(
                async (mediaType: string, remoteId: string) => {
                    if (mediaType === "album" && remoteId === recoveredAlbum.id)
                        return recoveredAlbum;
                    if (
                        mediaType === "artist" &&
                        remoteId === recoveredArtist.id
                    ) {
                        return recoveredArtist;
                    }
                    throw new Error("unexpected parent request");
                },
            );
            const client = processorClient(
                jest.fn(async () => deltaPage([recoveredTrack])),
                getCatalogItem,
            );
            mockProcessorClients.set(testPeerId, client);

            await expect(
                processFederationSync(processorJob(testPeerId)),
            ).resolves.toMatchObject({ tracks: 1 });
            expect(getCatalogItem.mock.calls).toEqual([
                ["album", recoveredAlbum.id],
                ["artist", recoveredArtist.id],
            ]);
            await expectRecoveredHierarchy(testPeerId, [
                recoveredArtist.id,
                recoveredAlbum.id,
                recoveredTrack.id,
            ]);
        });
    },
);

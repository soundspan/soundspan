import type { Prisma } from "@prisma/client";
import { Client } from "pg";
import { collectProviderTracks } from "../src/services/providerTrackGc";
import { cleanupOrphanedLibraryEntities } from "../src/services/libraryOrphanCleanup";
import { deleteDiscoveryAlbumCatalogEntry } from "../src/services/discoveryAlbumCatalogCleanup";
import { albumTracksOrphanRetentionGuardWhere } from "../src/services/providerTrackRetention";
import { updateAlbumMetadataWithOwnership } from "../src/services/albumMetadataPersistence";
import { handleDeleteAlbum } from "../src/routes/library/albums";
import { prisma } from "../src/utils/db";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;

const old = new Date("2026-06-01T00:00:00.000Z");
const firstNow = new Date("2026-08-19T00:00:00.000Z");
const recentStaleAt = new Date("2026-08-10T00:00:00.000Z");
const laterNow = new Date("2026-09-20T00:00:00.000Z");
const userId = "provider-gc-user";
const playlistId = "provider-gc-playlist";

function createResponse() {
    const response = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) {
            response.statusCode = code;
            return response;
        },
        json(payload: unknown) {
            response.body = payload;
            return response;
        },
    };
    return response;
}

async function createArtistAndAlbum(prefix: string): Promise<void> {
    await prisma.artist.create({
        data: {
            id: `${prefix}-artist`,
            mbid: `${prefix}-artist-mbid`,
            name: `${prefix} artist`,
            normalizedName: `${prefix} artist`,
        },
    });
    await prisma.album.create({
        data: {
            id: `${prefix}-album`,
            rgMbid: `${prefix}-album-mbid`,
            artistId: `${prefix}-artist`,
            title: `${prefix} album`,
            primaryType: "Album",
            location: "DISCOVER",
        },
    });
}

async function createTidalTrack(
    prefix: string,
    tidalId: number,
    staleAt: Date | null,
): Promise<string> {
    await createArtistAndAlbum(prefix);
    const track = await prisma.trackTidal.create({
        data: {
            id: `${prefix}-tidal`,
            tidalId,
            title: `${prefix} track`,
            artist: `${prefix} artist`,
            album: `${prefix} album`,
            duration: 180,
            artistId: `${prefix}-artist`,
            albumId: `${prefix}-album`,
            createdAt: old,
        },
    });
    await prisma.trackMapping.create({
        data: {
            trackTidalId: track.id,
            confidence: 1,
            source: "gap-fill",
            stale: staleAt !== null,
            staleAt,
        },
    });
    return track.id;
}

async function createYtMusicTrack(
    prefix: string,
    videoId: string,
    staleAt: Date | null,
): Promise<string> {
    await createArtistAndAlbum(prefix);
    const track = await prisma.trackYtMusic.create({
        data: {
            id: `${prefix}-youtube`,
            videoId,
            title: `${prefix} track`,
            artist: `${prefix} artist`,
            album: `${prefix} album`,
            duration: 180,
            artistId: `${prefix}-artist`,
            albumId: `${prefix}-album`,
            createdAt: old,
        },
    });
    await prisma.trackMapping.create({
        data: {
            trackYtMusicId: track.id,
            confidence: 1,
            source: "gap-fill",
            stale: staleAt !== null,
            staleAt,
        },
    });
    return track.id;
}

async function existingProviderIds(): Promise<{
    tidal: string[];
    youtube: string[];
}> {
    const [tidal, youtube] = await Promise.all([
        prisma.trackTidal.findMany({
            orderBy: { id: "asc" },
            select: { id: true },
        }),
        prisma.trackYtMusic.findMany({
            orderBy: { id: "asc" },
            select: { id: true },
        }),
    ]);
    return {
        tidal: tidal.map((track) => track.id),
        youtube: youtube.map((track) => track.id),
    };
}

describeWithPostgres(
    "provider track garbage collection PostgreSQL behavior",
    () => {
        let admin: Client;

        beforeAll(async () => {
            admin = await createScaleDatabase(
                integrationDatabaseUrl!,
                databaseName!,
            );
            await applyScaleMigrations(process.env.DATABASE_URL!);
            await prisma.user.create({
                data: { id: userId, username: userId },
            });
            await prisma.playlist.create({
                data: { id: playlistId, userId, name: "Provider GC" },
            });
        });

        afterAll(async () => {
            jest.restoreAllMocks();
            await prisma.$disconnect();
            if (admin && databaseName) {
                await dropScaleDatabase(admin, databaseName);
            }
        });

        it("deletes only expired unreferenced rows and rechecks references before deletion", async () => {
            const collectableId = await createTidalTrack(
                "collectable",
                649001,
                old,
            );
            const likedId = await createTidalTrack("liked", 649002, old);
            const recentPlayId = await createTidalTrack(
                "recent-play",
                649003,
                old,
            );
            const playlistIdRef = await createYtMusicTrack(
                "playlist",
                "provider-gc-playlist-video",
                old,
            );
            const activeId = await createYtMusicTrack(
                "active",
                "provider-gc-active-video",
                null,
            );
            const racedId = await createYtMusicTrack(
                "raced",
                "provider-gc-raced-video",
                old,
            );
            const parentId = await createYtMusicTrack(
                "parent-retention",
                "provider-gc-parent-video",
                recentStaleAt,
            );
            const ownedId = await createTidalTrack("owned-parent", 649004, old);

            await prisma.likedRemoteTrack.create({
                data: { userId, trackTidalId: likedId },
            });
            await prisma.playlistItem.create({
                data: {
                    playlistId,
                    trackYtMusicId: playlistIdRef,
                    sort: 0,
                },
            });
            await prisma.play.create({
                data: {
                    userId,
                    trackTidalId: recentPlayId,
                    playedAt: new Date("2026-08-18T00:00:00.000Z"),
                },
            });
            await prisma.ownedAlbum.create({
                data: {
                    artistId: "owned-parent-artist",
                    rgMbid: "owned-parent-album-mbid",
                    source: "discover_liked",
                },
            });

            const findYtMusic = prisma.trackYtMusic.findMany.bind(
                prisma.trackYtMusic,
            ) as unknown as (
                args: Prisma.TrackYtMusicFindManyArgs,
            ) => Promise<Array<{ id: string }>>;
            jest.spyOn(prisma.trackYtMusic, "findMany").mockImplementationOnce(
                (async (args?: Prisma.TrackYtMusicFindManyArgs) => {
                    const candidates = await findYtMusic(args ?? {});
                    await prisma.likedRemoteTrack.create({
                        data: { userId, trackYtMusicId: racedId },
                    });
                    return candidates;
                }) as never,
            );

            const first = await collectProviderTracks({
                now: firstNow,
                retentionDays: 30,
            });

            expect(first.deleted).toEqual({ tidal: 2, youtube: 0 });
            await expect(existingProviderIds()).resolves.toEqual({
                tidal: [likedId, recentPlayId].sort(),
                youtube: [activeId, parentId, playlistIdRef, racedId].sort(),
            });
            await expect(
                prisma.trackTidal.findUnique({ where: { id: collectableId } }),
            ).resolves.toBeNull();
            await expect(
                prisma.trackTidal.findUnique({ where: { id: ownedId } }),
            ).resolves.toBeNull();
            await expect(
                prisma.album.findUnique({
                    where: { id: "owned-parent-album" },
                }),
            ).resolves.not.toBeNull();
            await expect(
                prisma.artist.findUnique({
                    where: { id: "owned-parent-artist" },
                }),
            ).resolves.not.toBeNull();
            await expect(
                prisma.album.findUnique({
                    where: { id: "parent-retention-album" },
                }),
            ).resolves.not.toBeNull();

            await expect(
                cleanupOrphanedLibraryEntities(firstNow),
            ).resolves.toEqual(expect.objectContaining({ albumsDeleted: 0 }));

            const second = await collectProviderTracks({
                now: laterNow,
                retentionDays: 30,
            });

            expect(second.deleted.youtube).toBe(1);
            await expect(
                prisma.trackYtMusic.findUnique({ where: { id: parentId } }),
            ).resolves.toBeNull();
            await expect(
                prisma.album.findUnique({
                    where: { id: "parent-retention-album" },
                }),
            ).resolves.toBeNull();
            await expect(
                prisma.artist.findUnique({
                    where: { id: "parent-retention-artist" },
                }),
            ).resolves.toBeNull();
        });

        it("deletes an explicitly administered album and its liked ownership row", async () => {
            await createArtistAndAlbum("admin-delete");
            await prisma.ownedAlbum.create({
                data: {
                    artistId: "admin-delete-artist",
                    rgMbid: "admin-delete-album-mbid",
                    source: "discovery_liked",
                },
            });
            const response = createResponse();

            await handleDeleteAlbum(
                { params: { id: "admin-delete-album" } } as any,
                response as any,
            );

            expect(response.statusCode).toBe(200);
            await expect(
                prisma.album.findUnique({
                    where: { id: "admin-delete-album" },
                }),
            ).resolves.toBeNull();
            await expect(
                prisma.ownedAlbum.findUnique({
                    where: {
                        artistId_rgMbid: {
                            artistId: "admin-delete-artist",
                            rgMbid: "admin-delete-album-mbid",
                        },
                    },
                }),
            ).resolves.toBeNull();
        });

        it("retains tracks when ownership arrives after orphan selection", async () => {
            await createArtistAndAlbum("ownership-race");
            await prisma.track.create({
                data: {
                    id: "ownership-race-track",
                    albumId: "ownership-race-album",
                    title: "ownership race track",
                    trackNo: 1,
                    duration: 180,
                    fileModified: old,
                    fileSize: 1,
                },
            });
            const cutoff = new Date("2026-07-20T00:00:00.000Z");
            const selected = await prisma.album.findMany({
                where: {
                    id: "ownership-race-album",
                    hasUserOverrides: false,
                    ownedBy: { none: {} },
                },
                select: { id: true },
            });
            expect(selected).toEqual([{ id: "ownership-race-album" }]);

            await prisma.ownedAlbum.create({
                data: {
                    artistId: "ownership-race-artist",
                    rgMbid: "ownership-race-album-mbid",
                    source: "discovery_liked",
                },
            });
            const deleted = await prisma.track.deleteMany({
                where: albumTracksOrphanRetentionGuardWhere(
                    "ownership-race-album",
                    cutoff,
                ),
            });

            expect(deleted.count).toBe(0);
            await expect(
                prisma.track.findUnique({
                    where: { id: "ownership-race-track" },
                }),
            ).resolves.not.toBeNull();
        });

        it("preserves files and discovery links when a like wins the cleanup guard", async () => {
            await createArtistAndAlbum("discovery-like-race");
            await prisma.track.create({
                data: {
                    id: "discovery-like-race-track",
                    albumId: "discovery-like-race-album",
                    title: "discovery like race track",
                    trackNo: 1,
                    duration: 180,
                    fileModified: old,
                    fileSize: 1,
                },
            });
            const discovery = await prisma.discoveryAlbum.create({
                data: {
                    id: "discovery-like-race-link",
                    userId,
                    rgMbid: "discovery-like-race-album-mbid",
                    artistName: "discovery-like-race artist",
                    albumTitle: "discovery-like-race album",
                    weekStartDate: old,
                    status: "ACTIVE",
                },
            });
            await prisma.discoveryTrack.create({
                data: {
                    discoveryAlbumId: discovery.id,
                    trackId: "discovery-like-race-track",
                    fileName: "track.flac",
                    filePath: "/music/discovery/track.flac",
                },
            });
            await prisma.$transaction(async (transaction) => {
                await transaction.discoveryAlbum.update({
                    where: { id: discovery.id },
                    data: { status: "LIKED", likedAt: firstNow },
                });
                await transaction.album.update({
                    where: { id: "discovery-like-race-album" },
                    data: { location: "LIBRARY" },
                });
                await transaction.ownedAlbum.create({
                    data: {
                        artistId: "discovery-like-race-artist",
                        rgMbid: "discovery-like-race-album-mbid",
                        source: "discovery_liked",
                    },
                });
            });

            const deleted = await deleteDiscoveryAlbumCatalogEntry({
                rgMbid: discovery.rgMbid,
            });

            expect(deleted).toBe(false);
            await expect(
                prisma.track.findUnique({
                    where: { id: "discovery-like-race-track" },
                }),
            ).resolves.not.toBeNull();
            await expect(
                prisma.discoveryTrack.findFirst({
                    where: { discoveryAlbumId: discovery.id },
                }),
            ).resolves.not.toBeNull();
            await expect(
                prisma.discoveryAlbum.findUnique({
                    where: { id: discovery.id },
                }),
            ).resolves.toEqual(expect.objectContaining({ status: "LIKED" }));
        });

        it("moves existing ownership but does not recreate unliked ownership after an album rgMbid correction", async () => {
            const oldRgMbid = "11111111-1111-4111-8111-111111111111";
            const newRgMbid = "22222222-2222-4222-8222-222222222222";
            await createArtistAndAlbum("rg-edit");
            await prisma.album.update({
                where: { id: "rg-edit-album" },
                data: { rgMbid: oldRgMbid, location: "LIBRARY" },
            });
            await prisma.ownedAlbum.create({
                data: {
                    artistId: "rg-edit-artist",
                    rgMbid: oldRgMbid,
                    source: "native_scan",
                },
            });
            await updateAlbumMetadataWithOwnership("rg-edit-album", {
                rgMbid: newRgMbid,
            });

            await expect(
                prisma.ownedAlbum.findUnique({
                    where: {
                        artistId_rgMbid: {
                            artistId: "rg-edit-artist",
                            rgMbid: oldRgMbid,
                        },
                    },
                }),
            ).resolves.toBeNull();
            await expect(
                prisma.ownedAlbum.findUnique({
                    where: {
                        artistId_rgMbid: {
                            artistId: "rg-edit-artist",
                            rgMbid: newRgMbid,
                        },
                    },
                }),
            ).resolves.toEqual(
                expect.objectContaining({ source: "native_scan" }),
            );
            await expect(
                prisma.album.findUnique({ where: { id: "rg-edit-album" } }),
            ).resolves.toEqual(expect.objectContaining({ rgMbid: newRgMbid }));

            await createArtistAndAlbum("rg-edit-fresh");
            const freshRgMbid = "33333333-3333-4333-8333-333333333333";
            await prisma.album.update({
                where: { id: "rg-edit-fresh-album" },
                data: { location: "LIBRARY" },
            });
            await prisma.ownedAlbum.create({
                data: {
                    artistId: "rg-edit-fresh-artist",
                    rgMbid: "rg-edit-fresh-album-mbid",
                    source: "discovery_liked",
                },
            });
            await prisma.ownedAlbum.deleteMany({
                where: {
                    artistId: "rg-edit-fresh-artist",
                    source: "discovery_liked",
                },
            });
            await updateAlbumMetadataWithOwnership("rg-edit-fresh-album", {
                rgMbid: freshRgMbid,
            });
            await expect(
                prisma.ownedAlbum.findUnique({
                    where: {
                        artistId_rgMbid: {
                            artistId: "rg-edit-fresh-artist",
                            rgMbid: freshRgMbid,
                        },
                    },
                }),
            ).resolves.toBeNull();
        });
    },
);

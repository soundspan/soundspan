import type { Prisma } from "@prisma/client";
import { Client } from "pg";
import { collectProviderTracks } from "../src/services/providerTrackGc";
import { cleanupOrphanedLibraryEntities } from "../src/services/libraryOrphanCleanup";
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
    },
);

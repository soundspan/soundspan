import type { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { collectProviderTracks } from "../src/services/providerTrackGc";
import { cleanupOrphanedLibraryEntities } from "../src/services/libraryOrphanCleanup";
import { deleteDiscoveryAlbumCatalogEntry } from "../src/services/discoveryAlbumCatalogCleanup";
import { resolveDiscoveryCatalogAlbum } from "../src/services/discoveryCatalogAlbum";
import {
    albumTracksOrphanRetentionGuardWhere,
    discoveryAlbumTracksOrphanRetentionGuardWhere,
} from "../src/services/providerTrackRetention";
import { updateAlbumMetadataWithOwnership } from "../src/services/albumMetadataPersistence";
import { handleDeleteAlbum } from "../src/routes/library/albums";
import { deleteArtistCatalogEntry } from "../src/services/artistCatalogDeletion";
import {
    handleLegacyLike,
    handleLegacyUnlike,
} from "../src/routes/discover/legacy/albumActions";
import { lidarrService } from "../src/services/lidarr";
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
const CLAIM_RACE_TEST_TIMEOUT_MS = 10_000;
const MAX_LOCK_POLLS = 200;
const DATA_FIX_MIGRATION = join(
    __dirname,
    "../prisma/migrations/20260819204000_reconcile_discovery_ownership_sources/migration.sql",
);

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

async function waitForLockBlockedBy(
    observer: Client,
    blockerPid: number,
): Promise<void> {
    for (let poll = 0; poll < MAX_LOCK_POLLS; poll += 1) {
        const result = await observer.query<{ waiting: boolean }>(
            `
                SELECT EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_locks AS waiting_lock
                    WHERE NOT waiting_lock.granted
                      AND $1 = ANY(pg_catalog.pg_blocking_pids(waiting_lock.pid))
                ) AS waiting
            `,
            [blockerPid],
        );
        if (result.rows[0]?.waiting) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the like flow to block on cleanup");
}

async function waitForBlockedFlowCount(
    observer: Client,
    blockerPid: number,
    expectedCount: number,
): Promise<void> {
    for (let poll = 0; poll < MAX_LOCK_POLLS; poll += 1) {
        const result = await observer.query<{ waiting_count: string }>(
            `
                WITH RECURSIVE blocked(pid) AS (
                    SELECT activity.pid
                    FROM pg_catalog.pg_stat_activity AS activity
                    WHERE $1 = ANY(pg_catalog.pg_blocking_pids(activity.pid))
                    UNION
                    SELECT activity.pid
                    FROM pg_catalog.pg_stat_activity AS activity
                    JOIN blocked AS blocker
                      ON blocker.pid = ANY(
                          pg_catalog.pg_blocking_pids(activity.pid)
                      )
                )
                SELECT COUNT(*) AS waiting_count
                FROM blocked
            `,
            [blockerPid],
        );
        if (Number(result.rows[0]?.waiting_count ?? 0) >= expectedCount) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${expectedCount} blocked flows`);
}

async function blockedFlowDiscoveryRowLocks(
    observer: Client,
    blockerPid: number,
): Promise<Array<{ pid: number; mode: string }>> {
    const result = await observer.query<{ pid: number; mode: string }>(
        `
            WITH RECURSIVE blocked(pid) AS (
                SELECT activity.pid
                FROM pg_catalog.pg_stat_activity AS activity
                WHERE $1 = ANY(pg_catalog.pg_blocking_pids(activity.pid))
                UNION
                SELECT activity.pid
                FROM pg_catalog.pg_stat_activity AS activity
                JOIN blocked AS blocker
                  ON blocker.pid = ANY(
                      pg_catalog.pg_blocking_pids(activity.pid)
                  )
            )
            SELECT row_lock.pid, row_lock.mode
            FROM blocked
            JOIN pg_catalog.pg_locks AS row_lock
              ON row_lock.pid = blocked.pid
            WHERE row_lock.granted
              AND row_lock.relation = '"DiscoveryAlbum"'::regclass
              AND (
                  row_lock.locktype = 'tuple'
                  OR row_lock.mode IN ('RowShareLock', 'RowExclusiveLock')
              )
            ORDER BY row_lock.pid, row_lock.mode
        `,
        [blockerPid],
    );
    return result.rows;
}

async function beginCleanupClaim(
    client: Client,
    discoveryId: string,
): Promise<number> {
    await client.query("BEGIN");
    const backend = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
    );
    const claim = await client.query(
        `
            UPDATE "DiscoveryAlbum"
            SET status = 'DELETED'
            WHERE id = $1 AND status IN ('ACTIVE', 'DELETED')
        `,
        [discoveryId],
    );
    expect(claim.rowCount).toBe(1);
    const blockerPid = backend.rows[0]?.pid;
    if (blockerPid === undefined)
        throw new Error("Missing cleanup backend PID");
    return blockerPid;
}

function startObservedLike(rgMbid: string) {
    const response = createResponse();
    let completed = false;
    const promise = handleLegacyLike(
        { user: { id: userId }, body: { albumId: rgMbid } } as any,
        response as any,
    ).finally(() => {
        completed = true;
    });
    return { response, promise, isCompleted: () => completed };
}

async function installCountRefreshFailure(database: Client): Promise<void> {
    await database.query(`
        CREATE FUNCTION fail_provider_count_refresh()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF NEW.id = 'count-refresh-retry-artist' THEN
                RAISE EXCEPTION 'forced count refresh failure';
            END IF;
            RETURN NEW;
        END;
        $$
    `);
    await database.query(`
        CREATE TRIGGER fail_provider_count_refresh
        BEFORE UPDATE ON "Artist"
        FOR EACH ROW
        EXECUTE FUNCTION fail_provider_count_refresh()
    `);
}

async function removeCountRefreshFailure(database: Client): Promise<void> {
    await database.query(
        'DROP TRIGGER IF EXISTS fail_provider_count_refresh ON "Artist"',
    );
    await database.query(
        "DROP FUNCTION IF EXISTS fail_provider_count_refresh()",
    );
}

async function expectProviderCountState(
    trackId: string,
    artistId: string,
    expectedTrack: "present" | "deleted",
    remoteTrackCount: number,
): Promise<void> {
    const trackExpectation = expect(
        prisma.trackTidal.findUnique({ where: { id: trackId } }),
    ).resolves;
    if (expectedTrack === "present") await trackExpectation.not.toBeNull();
    else await trackExpectation.toBeNull();
    await expect(
        prisma.artist.findUnique({
            where: { id: artistId },
            select: { remoteTrackCount: true },
        }),
    ).resolves.toEqual({ remoteTrackCount });
}

describeWithPostgres(
    "provider track garbage collection PostgreSQL behavior",
    () => {
        let admin: Client;
        let database: Client;

        beforeAll(async () => {
            admin = await createScaleDatabase(
                integrationDatabaseUrl!,
                databaseName!,
            );
            await applyScaleMigrations(process.env.DATABASE_URL!);
            database = new Client({
                connectionString: process.env.DATABASE_URL,
            });
            await database.connect();
            await prisma.user.create({
                data: { id: userId, username: userId },
            });
            await prisma.playlist.create({
                data: { id: playlistId, userId, name: "Provider GC" },
            });
        });

        afterAll(async () => {
            jest.restoreAllMocks();
            if (database) await database.end();
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

        it("rolls back provider deletes when count refresh fails and converges on retry", async () => {
            const trackId = await createTidalTrack(
                "count-refresh-retry",
                649099,
                old,
            );
            const artistId = "count-refresh-retry-artist";
            await prisma.artist.update({
                where: { id: artistId },
                data: { hasUserOverrides: true, remoteTrackCount: 1 },
            });
            await installCountRefreshFailure(database);

            try {
                await expect(
                    collectProviderTracks({
                        now: firstNow,
                        retentionDays: 30,
                    }),
                ).rejects.toThrow("forced count refresh failure");
                await expectProviderCountState(trackId, artistId, "present", 1);
            } finally {
                await removeCountRefreshFailure(database);
            }

            await expect(
                collectProviderTracks({ now: firstNow, retentionDays: 30 }),
            ).resolves.toEqual(
                expect.objectContaining({
                    deleted: expect.objectContaining({ tidal: 1 }),
                }),
            );
            await expectProviderCountState(trackId, artistId, "deleted", 0);
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

        it(
            "completes resolver and artist deletion when the resolver already holds the album lock",
            async () => {
                const prefix = "resolver-artist-delete-order";
                await createArtistAndAlbum(prefix);
                await prisma.artist.update({
                    where: { id: `${prefix}-artist` },
                    data: { mbid: `temp-${prefix}` },
                });
                const discovery = await prisma.discoveryAlbum.create({
                    data: {
                        id: `${prefix}-discovery`,
                        userId,
                        rgMbid: `${prefix}-missing-mbid`,
                        artistName: `${prefix} artist`,
                        albumTitle: `${prefix} album`,
                        weekStartDate: old,
                    },
                });
                let releaseResolver: (() => void) | undefined;
                const resolverRelease = new Promise<void>((resolve) => {
                    releaseResolver = resolve;
                });
                let reportAlbumLocked: (() => void) | undefined;
                const albumLocked = new Promise<void>((resolve) => {
                    reportAlbumLocked = resolve;
                });
                let resolverPid: number | undefined;
                let resolverPromise: Promise<unknown> | undefined;
                let deletePromise: Promise<unknown> | undefined;

                try {
                    resolverPromise = prisma.$transaction(async (tx) => {
                        const backend = await tx.$queryRaw<
                            Array<{ pid: number }>
                        >`SELECT pg_backend_pid() AS pid`;
                        resolverPid = backend[0]?.pid;
                        const wrapped = new Proxy(tx, {
                            get(target, property, receiver) {
                                if (property !== "$queryRaw") {
                                    return Reflect.get(
                                        target,
                                        property,
                                        receiver,
                                    );
                                }
                                return async (query: Prisma.Sql) => {
                                    const rows = await tx.$queryRaw(query);
                                    const sql = query.strings.join("");
                                    if (
                                        sql.includes('FROM "Album"') &&
                                        sql.includes("FOR UPDATE")
                                    ) {
                                        reportAlbumLocked?.();
                                        await resolverRelease;
                                    }
                                    return rows;
                                };
                            },
                        });
                        return resolveDiscoveryCatalogAlbum(wrapped, discovery);
                    });
                    await albumLocked;
                    if (resolverPid === undefined) {
                        throw new Error("Missing resolver backend PID");
                    }

                    deletePromise = deleteArtistCatalogEntry(
                        `${prefix}-artist`,
                    );
                    await waitForLockBlockedBy(database, resolverPid);
                    releaseResolver?.();

                    await expect(resolverPromise).resolves.toEqual(
                        expect.objectContaining({
                            catalogAlbum: expect.objectContaining({
                                id: `${prefix}-album`,
                            }),
                        }),
                    );
                    await expect(deletePromise).resolves.toBeUndefined();
                } finally {
                    releaseResolver?.();
                    await Promise.allSettled([
                        ...(resolverPromise ? [resolverPromise] : []),
                        ...(deletePromise ? [deletePromise] : []),
                    ]);
                }

                await expect(
                    prisma.artist.findUnique({
                        where: { id: `${prefix}-artist` },
                    }),
                ).resolves.toBeNull();
                await expect(
                    prisma.album.findUnique({
                        where: { id: `${prefix}-album` },
                    }),
                ).resolves.toBeNull();
            },
            CLAIM_RACE_TEST_TIMEOUT_MS,
        );

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

        it("retains a DISCOVER album when its linked discovery record is LIKED", async () => {
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
            await prisma.discoveryAlbum.update({
                where: { id: discovery.id },
                data: {
                    catalogAlbumId: "discovery-like-race-album",
                    status: "LIKED",
                    likedAt: firstNow,
                },
            });

            const deleted = await deleteDiscoveryAlbumCatalogEntry({
                ...discovery,
                catalogAlbumId: "discovery-like-race-album",
            });

            expect(deleted).toBe("retained");
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

        it("retains catalog content when like commits before cleanup", async () => {
            const prefix = "claim-race-like-wins";
            await createArtistAndAlbum(prefix);
            await prisma.track.create({
                data: {
                    id: `${prefix}-track`,
                    albumId: `${prefix}-album`,
                    title: `${prefix} track`,
                    trackNo: 1,
                    duration: 180,
                    fileModified: old,
                    fileSize: 1,
                },
            });
            const discovery = await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-discovery`,
                    userId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    artistMbid: `${prefix}-artist-mbid`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                },
            });
            jest.spyOn(
                lidarrService,
                "removeDiscoveryTagByMbid",
            ).mockResolvedValueOnce(true);
            const response = createResponse();

            await handleLegacyLike(
                {
                    user: { id: userId },
                    body: { albumId: discovery.rgMbid },
                } as any,
                response as any,
            );
            await expect(
                deleteDiscoveryAlbumCatalogEntry(discovery),
            ).resolves.toBe("retained");

            expect(response.statusCode).toBe(200);
            await expect(
                prisma.album.findUnique({ where: { id: `${prefix}-album` } }),
            ).resolves.not.toBeNull();
            await expect(
                prisma.track.findUnique({ where: { id: `${prefix}-track` } }),
            ).resolves.not.toBeNull();
            await expect(
                prisma.discoveryAlbum.findUnique({
                    where: { id: discovery.id },
                }),
            ).resolves.toEqual(expect.objectContaining({ status: "LIKED" }));
        });

        it("retains a shared album when another linked row is liked", async () => {
            const prefix = "shared-linked-liked";
            const secondUserId = `${prefix}-user`;
            await createArtistAndAlbum(prefix);
            await prisma.user.create({
                data: { id: secondUserId, username: secondUserId },
            });
            await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-liked`,
                    userId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                    status: "LIKED",
                },
            });
            const active = await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-active`,
                    userId: secondUserId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                },
            });

            await expect(
                deleteDiscoveryAlbumCatalogEntry(active),
            ).resolves.toBe("retained");
            await expect(
                prisma.album.findUnique({ where: { id: `${prefix}-album` } }),
            ).resolves.not.toBeNull();
            await expect(
                prisma.discoveryAlbum.findUnique({ where: { id: active.id } }),
            ).resolves.toEqual(expect.objectContaining({ status: "ACTIVE" }));
        });

        it("rolls back every discovery status when a post-claim guard retains the album", async () => {
            const prefix = "retained-claim-rollback";
            const secondUserId = `${prefix}-user`;
            await createArtistAndAlbum(prefix);
            await prisma.album.update({
                where: { id: `${prefix}-album` },
                data: { hasUserOverrides: true },
            });
            await prisma.user.create({
                data: { id: secondUserId, username: secondUserId },
            });
            const active = await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-active`,
                    userId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                    status: "ACTIVE",
                },
            });
            await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-deleted`,
                    userId: secondUserId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                    status: "DELETED",
                },
            });

            await expect(
                deleteDiscoveryAlbumCatalogEntry(active),
            ).resolves.toBe("retained");
            await expect(
                prisma.discoveryAlbum.findMany({
                    where: { catalogAlbumId: `${prefix}-album` },
                    orderBy: { id: "asc" },
                    select: { id: true, status: true },
                }),
            ).resolves.toEqual([
                { id: `${prefix}-active`, status: "ACTIVE" },
                { id: `${prefix}-deleted`, status: "DELETED" },
            ]);
        });

        it(
            "serializes cross-row like and cleanup behind the album lock without deadlock",
            async () => {
                const prefix = "cross-row-lock-order";
                const secondUserId = `${prefix}-user`;
                await createArtistAndAlbum(prefix);
                await prisma.user.create({
                    data: { id: secondUserId, username: secondUserId },
                });
                const liked = await prisma.discoveryAlbum.create({
                    data: {
                        id: `${prefix}-01-like`,
                        userId,
                        catalogAlbumId: `${prefix}-album`,
                        rgMbid: `${prefix}-album-mbid`,
                        artistName: `${prefix} artist`,
                        artistMbid: `${prefix}-artist-mbid`,
                        albumTitle: `${prefix} album`,
                        weekStartDate: old,
                    },
                });
                const cleanup = await prisma.discoveryAlbum.create({
                    data: {
                        id: `${prefix}-02-cleanup`,
                        userId: secondUserId,
                        catalogAlbumId: `${prefix}-album`,
                        rgMbid: `${prefix}-album-mbid`,
                        artistName: `${prefix} artist`,
                        albumTitle: `${prefix} album`,
                        weekStartDate: old,
                    },
                });
                jest.spyOn(
                    lidarrService,
                    "removeDiscoveryTagByMbid",
                ).mockResolvedValueOnce(true);
                const lockHolder = new Client({
                    connectionString: process.env.DATABASE_URL,
                });
                await lockHolder.connect();
                let transactionOpen = false;
                let like: ReturnType<typeof startObservedLike> | undefined;
                let cleanupPromise:
                    | ReturnType<typeof deleteDiscoveryAlbumCatalogEntry>
                    | undefined;
                try {
                    transactionOpen = true;
                    await lockHolder.query("BEGIN");
                    const backend = await lockHolder.query<{ pid: number }>(
                        "SELECT pg_backend_pid() AS pid",
                    );
                    await lockHolder.query(
                        'SELECT id FROM "Album" WHERE id = $1 FOR UPDATE',
                        [`${prefix}-album`],
                    );
                    const blockerPid = backend.rows[0]?.pid;
                    if (blockerPid === undefined)
                        throw new Error("Missing album-lock backend PID");

                    like = startObservedLike(liked.rgMbid);
                    await waitForBlockedFlowCount(database, blockerPid, 1);
                    cleanupPromise = deleteDiscoveryAlbumCatalogEntry(cleanup);
                    await waitForBlockedFlowCount(database, blockerPid, 2);
                    await expect(
                        blockedFlowDiscoveryRowLocks(database, blockerPid),
                    ).resolves.toEqual([]);
                    await lockHolder.query("COMMIT");
                    transactionOpen = false;

                    await expect(like.promise).resolves.toBeUndefined();
                    await expect(cleanupPromise).resolves.toBe("retained");
                } finally {
                    if (transactionOpen) await lockHolder.query("ROLLBACK");
                    await lockHolder.end();
                    await Promise.allSettled([
                        ...(like ? [like.promise] : []),
                        ...(cleanupPromise ? [cleanupPromise] : []),
                    ]);
                }

                expect(like?.response.statusCode).toBe(200);
                await expect(
                    prisma.album.findUnique({
                        where: { id: `${prefix}-album` },
                    }),
                ).resolves.not.toBeNull();
                await expect(
                    prisma.discoveryAlbum.findMany({
                        where: { id: { in: [liked.id, cleanup.id] } },
                        orderBy: { id: "asc" },
                        select: { status: true },
                    }),
                ).resolves.toEqual([{ status: "LIKED" }, { status: "ACTIVE" }]);
            },
            CLAIM_RACE_TEST_TIMEOUT_MS,
        );

        it("claims every eligible row linked to a shared album", async () => {
            const prefix = "shared-linked-eligible";
            const secondUserId = `${prefix}-user`;
            await createArtistAndAlbum(prefix);
            await prisma.user.create({
                data: { id: secondUserId, username: secondUserId },
            });
            const first = await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-first`,
                    userId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                },
            });
            const second = await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-second`,
                    userId: secondUserId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                },
            });
            await prisma.discoveryTrack.createMany({
                data: [
                    {
                        discoveryAlbumId: first.id,
                        fileName: "first.flac",
                        filePath: `/discovery/${prefix}/first.flac`,
                    },
                    {
                        discoveryAlbumId: second.id,
                        fileName: "second.flac",
                        filePath: `/discovery/${prefix}/second.flac`,
                    },
                ],
            });

            await expect(deleteDiscoveryAlbumCatalogEntry(first)).resolves.toBe(
                "deleted",
            );
            await expect(
                prisma.discoveryAlbum.findMany({
                    where: { id: { in: [first.id, second.id] } },
                    orderBy: { id: "asc" },
                    select: { status: true },
                }),
            ).resolves.toEqual([{ status: "DELETED" }, { status: "DELETED" }]);
            await expect(
                prisma.discoveryTrack.count({
                    where: { discoveryAlbumId: { in: [first.id, second.id] } },
                }),
            ).resolves.toBe(0);
        });

        it("rejects like cleanly after cleanup claims and deletes the album", async () => {
            const prefix = "claim-race-cleanup-wins";
            await createArtistAndAlbum(prefix);
            const discovery = await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-discovery`,
                    userId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                },
            });
            const response = createResponse();

            await expect(
                deleteDiscoveryAlbumCatalogEntry(discovery),
            ).resolves.toBe("deleted");
            await handleLegacyLike(
                {
                    user: { id: userId },
                    body: { albumId: discovery.rgMbid },
                } as any,
                response as any,
            );

            expect(response.statusCode).toBe(404);
            expect(response.body).toEqual({
                error: "Album not in active discovery",
            });
            await expect(
                prisma.album.findUnique({ where: { id: `${prefix}-album` } }),
            ).resolves.toBeNull();
            await expect(
                prisma.discoveryAlbum.findUnique({
                    where: { id: discovery.id },
                }),
            ).resolves.toEqual(expect.objectContaining({ status: "DELETED" }));
            await expect(
                prisma.discoveryAlbum.count({
                    where: {
                        id: discovery.id,
                        catalogAlbumId: null,
                        status: "LIKED",
                    },
                }),
            ).resolves.toBe(0);
        });

        it(
            "serializes like behind an in-flight cleanup claim",
            async () => {
                const prefix = "claim-race-serialized";
                await createArtistAndAlbum(prefix);
                const discovery = await prisma.discoveryAlbum.create({
                    data: {
                        id: `${prefix}-discovery`,
                        userId,
                        catalogAlbumId: `${prefix}-album`,
                        rgMbid: `${prefix}-album-mbid`,
                        artistName: `${prefix} artist`,
                        albumTitle: `${prefix} album`,
                        weekStartDate: old,
                    },
                });
                const lockHolder = new Client({
                    connectionString: process.env.DATABASE_URL,
                });
                await lockHolder.connect();
                let transactionOpen = false;
                let like: ReturnType<typeof startObservedLike> | undefined;
                try {
                    transactionOpen = true;
                    const blockerPid = await beginCleanupClaim(
                        lockHolder,
                        discovery.id,
                    );
                    like = startObservedLike(discovery.rgMbid);
                    await waitForLockBlockedBy(database, blockerPid);
                    expect(like.isCompleted()).toBe(false);
                    await lockHolder.query("COMMIT");
                    transactionOpen = false;
                    await like.promise;
                } finally {
                    if (transactionOpen) await lockHolder.query("ROLLBACK");
                    await lockHolder.end();
                    if (like) await Promise.allSettled([like.promise]);
                }

                expect(like?.response.statusCode).toBe(404);
                expect(like?.response.body).toEqual({
                    error: "Album not in active discovery",
                });
                await expect(
                    deleteDiscoveryAlbumCatalogEntry(discovery),
                ).resolves.toBe("deleted");
            },
            CLAIM_RACE_TEST_TIMEOUT_MS,
        );

        it("uses the authoritative catalog link after rgMbid changes", async () => {
            const prefix = "authoritative-link";
            await createArtistAndAlbum(prefix);
            const oldRgMbid = `${prefix}-album-mbid`;
            const newRgMbid = `${prefix}-current-mbid`;
            await prisma.album.update({
                where: { id: `${prefix}-album` },
                data: { rgMbid: newRgMbid },
            });
            await createArtistAndAlbum(`${prefix}-decoy`);
            await prisma.album.update({
                where: { id: `${prefix}-decoy-album` },
                data: { rgMbid: oldRgMbid },
            });
            const discovery = await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-discovery`,
                    userId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: oldRgMbid,
                    artistName: `${prefix} artist`,
                    artistMbid: `${prefix}-artist-mbid`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                },
            });
            jest.spyOn(
                lidarrService,
                "removeDiscoveryTagByMbid",
            ).mockResolvedValueOnce(true);
            const response = createResponse();

            await handleLegacyLike(
                { user: { id: userId }, body: { albumId: oldRgMbid } } as any,
                response as any,
            );

            expect(response.statusCode).toBe(200);
            await expect(
                prisma.album.findUnique({ where: { id: `${prefix}-album` } }),
            ).resolves.toEqual(
                expect.objectContaining({ location: "LIBRARY" }),
            );
            await expect(
                prisma.album.findUnique({
                    where: { id: `${prefix}-decoy-album` },
                }),
            ).resolves.toEqual(
                expect.objectContaining({ location: "DISCOVER" }),
            );
            await expect(
                prisma.discoveryAlbum.findUnique({
                    where: { id: discovery.id },
                }),
            ).resolves.toEqual(
                expect.objectContaining({ catalogAlbumId: `${prefix}-album` }),
            );
        });

        it(
            "returns the authoritative album when a catalog-link race commits first",
            async () => {
                const prefix = "authoritative-link-race";
                await createArtistAndAlbum(prefix);
                await createArtistAndAlbum(`${prefix}-fallback`);
                const discovery = await prisma.discoveryAlbum.create({
                    data: {
                        id: `${prefix}-discovery`,
                        userId,
                        rgMbid: `${prefix}-fallback-album-mbid`,
                        artistName: `${prefix}-fallback artist`,
                        albumTitle: `${prefix}-fallback album`,
                        weekStartDate: old,
                    },
                });
                const linkWriter = new Client({
                    connectionString: process.env.DATABASE_URL,
                });
                await linkWriter.connect();
                let transactionOpen = false;
                let like: ReturnType<typeof startObservedLike> | undefined;
                try {
                    transactionOpen = true;
                    await linkWriter.query("BEGIN");
                    const backend = await linkWriter.query<{ pid: number }>(
                        "SELECT pg_backend_pid() AS pid",
                    );
                    await linkWriter.query(
                        'UPDATE "DiscoveryAlbum" SET "catalogAlbumId" = $1 WHERE id = $2',
                        [`${prefix}-album`, discovery.id],
                    );
                    jest.spyOn(
                        lidarrService,
                        "removeDiscoveryTagByMbid",
                    ).mockResolvedValueOnce(true);
                    like = startObservedLike(discovery.rgMbid);
                    await waitForLockBlockedBy(database, backend.rows[0]!.pid);
                    await linkWriter.query("COMMIT");
                    transactionOpen = false;
                    await expect(like.promise).resolves.toBeUndefined();
                } finally {
                    if (transactionOpen) await linkWriter.query("ROLLBACK");
                    await linkWriter.end();
                    if (like) await Promise.allSettled([like.promise]);
                }

                expect(like?.response.statusCode).toBe(200);
                expect(like?.response.body).toEqual({ success: true });
                await expect(
                    prisma.discoveryAlbum.findUnique({
                        where: { id: discovery.id },
                        select: { catalogAlbumId: true, status: true },
                    }),
                ).resolves.toEqual({
                    catalogAlbumId: `${prefix}-album`,
                    status: "LIKED",
                });
                await expect(
                    prisma.album.findUnique({
                        where: { id: `${prefix}-album` },
                        select: { location: true },
                    }),
                ).resolves.toEqual({ location: "LIBRARY" });
                await expect(
                    prisma.ownedAlbum.findUnique({
                        where: {
                            artistId_rgMbid: {
                                artistId: `${prefix}-artist`,
                                rgMbid: `${prefix}-album-mbid`,
                            },
                        },
                        select: { source: true },
                    }),
                ).resolves.toEqual({ source: "discovery_liked" });
            },
            CLAIM_RACE_TEST_TIMEOUT_MS,
        );

        it("links an exact MBID match instead of a title and artist decoy", async () => {
            const prefix = "catalog-mbid-precedence";
            await createArtistAndAlbum(prefix);
            await prisma.album.create({
                data: {
                    id: `${prefix}-decoy-album`,
                    rgMbid: `${prefix}-decoy-mbid`,
                    artistId: `${prefix}-artist`,
                    title: `${prefix} album`,
                    primaryType: "Album",
                    location: "DISCOVER",
                },
            });
            const discovery = await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-discovery`,
                    userId,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                },
            });

            await expect(
                prisma.$transaction((transaction) =>
                    resolveDiscoveryCatalogAlbum(transaction, discovery),
                ),
            ).resolves.toEqual(
                expect.objectContaining({
                    catalogAlbum: expect.objectContaining({
                        id: `${prefix}-album`,
                    }),
                }),
            );
            await expect(
                prisma.discoveryAlbum.findUnique({
                    where: { id: discovery.id },
                    select: { catalogAlbumId: true },
                }),
            ).resolves.toEqual({ catalogAlbumId: `${prefix}-album` });
        });

        it("protects an album through an unlinked rolling-deploy LIKED row", async () => {
            const prefix = "unlinked-liked-guard";
            await createArtistAndAlbum(prefix);
            const secondUserId = `${prefix}-user`;
            await prisma.user.create({
                data: { id: secondUserId, username: secondUserId },
            });
            await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-liked`,
                    userId,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                    status: "LIKED",
                },
            });
            const cleanup = await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-active`,
                    userId: secondUserId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                },
            });

            await expect(
                deleteDiscoveryAlbumCatalogEntry(cleanup),
            ).resolves.toBe("retained");
            await expect(
                prisma.album.findUnique({ where: { id: `${prefix}-album` } }),
            ).resolves.not.toBeNull();
        });

        it("reclassifies legacy discovery ownership and keeps it protected", async () => {
            const prefix = "ownership-spelling";
            const likedEnrichment = "ownership-liked-enrichment";
            const noiseEnrichment = "ownership-noise-enrichment";
            await createArtistAndAlbum(prefix);
            await createArtistAndAlbum(likedEnrichment);
            await createArtistAndAlbum(noiseEnrichment);
            await prisma.ownedAlbum.create({
                data: {
                    artistId: `${prefix}-artist`,
                    rgMbid: `${prefix}-album-mbid`,
                    source: "discover_liked",
                },
            });
            await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-liked`,
                    userId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                    status: "LIKED",
                },
            });
            await prisma.ownedAlbum.createMany({
                data: [
                    {
                        artistId: `${likedEnrichment}-artist`,
                        rgMbid: `${likedEnrichment}-album-mbid`,
                        source: "enrichment",
                    },
                    {
                        artistId: `${noiseEnrichment}-artist`,
                        rgMbid: `${noiseEnrichment}-album-mbid`,
                        source: "enrichment",
                    },
                ],
            });
            await prisma.discoveryAlbum.create({
                data: {
                    id: `${likedEnrichment}-liked`,
                    userId,
                    catalogAlbumId: `${likedEnrichment}-album`,
                    rgMbid: `${likedEnrichment}-album-mbid`,
                    artistName: `${likedEnrichment} artist`,
                    albumTitle: `${likedEnrichment} album`,
                    weekStartDate: old,
                    status: "LIKED",
                },
            });

            await database.query(readFileSync(DATA_FIX_MIGRATION, "utf8"));

            await expect(
                prisma.ownedAlbum.findUnique({
                    where: {
                        artistId_rgMbid: {
                            artistId: `${prefix}-artist`,
                            rgMbid: `${prefix}-album-mbid`,
                        },
                    },
                }),
            ).resolves.toEqual(
                expect.objectContaining({ source: "discovery_liked" }),
            );
            await expect(
                prisma.ownedAlbum.findUnique({
                    where: {
                        artistId_rgMbid: {
                            artistId: `${likedEnrichment}-artist`,
                            rgMbid: `${likedEnrichment}-album-mbid`,
                        },
                    },
                }),
            ).resolves.toEqual(
                expect.objectContaining({ source: "discovery_liked" }),
            );
            await expect(
                prisma.ownedAlbum.findUnique({
                    where: {
                        artistId_rgMbid: {
                            artistId: `${noiseEnrichment}-artist`,
                            rgMbid: `${noiseEnrichment}-album-mbid`,
                        },
                    },
                }),
            ).resolves.toBeNull();
            // Earlier cases leave their own collectable leftovers, so assert
            // protection on the reclassified entities instead of global counts.
            await cleanupOrphanedLibraryEntities(firstNow);
            await expect(
                prisma.album.findUnique({
                    where: { id: `${likedEnrichment}-album` },
                    select: { id: true },
                }),
            ).resolves.toEqual({ id: `${likedEnrichment}-album` });
            await expect(
                prisma.artist.findUnique({
                    where: { id: `${likedEnrichment}-artist` },
                    select: { id: true },
                }),
            ).resolves.toEqual({ id: `${likedEnrichment}-artist` });
        });

        it("upgrades enrichment ownership on like so unlike removes it", async () => {
            const prefix = "ownership-live-promotion";
            await createArtistAndAlbum(prefix);
            const discovery = await prisma.discoveryAlbum.create({
                data: {
                    id: `${prefix}-discovery`,
                    userId,
                    catalogAlbumId: `${prefix}-album`,
                    rgMbid: `${prefix}-album-mbid`,
                    artistName: `${prefix} artist`,
                    albumTitle: `${prefix} album`,
                    weekStartDate: old,
                },
            });
            await prisma.ownedAlbum.create({
                data: {
                    artistId: `${prefix}-artist`,
                    rgMbid: `${prefix}-album-mbid`,
                    source: "enrichment",
                },
            });
            jest.spyOn(
                lidarrService,
                "removeDiscoveryTagByMbid",
            ).mockResolvedValueOnce(true);
            const likeResponse = createResponse();
            const unlikeResponse = createResponse();

            await handleLegacyLike(
                {
                    user: { id: userId },
                    body: { albumId: discovery.rgMbid },
                } as any,
                likeResponse as any,
            );
            await expect(
                prisma.ownedAlbum.findUnique({
                    where: {
                        artistId_rgMbid: {
                            artistId: `${prefix}-artist`,
                            rgMbid: `${prefix}-album-mbid`,
                        },
                    },
                }),
            ).resolves.toEqual(
                expect.objectContaining({ source: "discovery_liked" }),
            );

            await handleLegacyUnlike(
                {
                    user: { id: userId },
                    body: { albumId: discovery.rgMbid },
                } as any,
                unlikeResponse as any,
            );

            expect(likeResponse.statusCode).toBe(200);
            expect(unlikeResponse.statusCode).toBe(200);
            await expect(
                prisma.ownedAlbum.findUnique({
                    where: {
                        artistId_rgMbid: {
                            artistId: `${prefix}-artist`,
                            rgMbid: `${prefix}-album-mbid`,
                        },
                    },
                }),
            ).resolves.toBeNull();
        });

        it("blocks discovery track deletion after the album is promoted", async () => {
            await createArtistAndAlbum("discovery-track-promotion");
            await prisma.track.create({
                data: {
                    id: "discovery-track-promotion-track",
                    albumId: "discovery-track-promotion-album",
                    title: "promoted track",
                    trackNo: 1,
                    duration: 180,
                    fileModified: old,
                    fileSize: 1,
                },
            });
            await prisma.album.update({
                where: { id: "discovery-track-promotion-album" },
                data: { location: "LIBRARY" },
            });

            const deleted = await prisma.track.deleteMany({
                where: discoveryAlbumTracksOrphanRetentionGuardWhere(
                    "discovery-track-promotion-album",
                    firstNow,
                ),
            });

            expect(deleted.count).toBe(0);
            await expect(
                prisma.track.findUnique({
                    where: { id: "discovery-track-promotion-track" },
                }),
            ).resolves.not.toBeNull();
        });

        it("unlikes by the current catalog MBID after metadata edits cascade ownership", async () => {
            const staleRgMbid = "44444444-4444-4444-8444-444444444444";
            const currentRgMbid = "55555555-5555-4555-8555-555555555555";
            await createArtistAndAlbum("unlike-after-edit");
            await prisma.album.update({
                where: { id: "unlike-after-edit-album" },
                data: { rgMbid: staleRgMbid, location: "LIBRARY" },
            });
            await prisma.ownedAlbum.create({
                data: {
                    artistId: "unlike-after-edit-artist",
                    rgMbid: staleRgMbid,
                    source: "discovery_liked",
                },
            });
            const discovery = await prisma.discoveryAlbum.create({
                data: {
                    id: "unlike-after-edit-discovery",
                    userId,
                    catalogAlbumId: "unlike-after-edit-album",
                    rgMbid: staleRgMbid,
                    artistName: "unlike-after-edit artist",
                    albumTitle: "unlike-after-edit album",
                    weekStartDate: old,
                    status: "LIKED",
                    likedAt: firstNow,
                },
            });
            await updateAlbumMetadataWithOwnership("unlike-after-edit-album", {
                rgMbid: currentRgMbid,
            });
            const response = createResponse();

            await handleLegacyUnlike(
                {
                    user: { id: userId },
                    body: { albumId: staleRgMbid },
                } as any,
                response as any,
            );

            expect(response.statusCode).toBe(200);
            await expect(
                prisma.ownedAlbum.findUnique({
                    where: {
                        artistId_rgMbid: {
                            artistId: "unlike-after-edit-artist",
                            rgMbid: currentRgMbid,
                        },
                    },
                }),
            ).resolves.toBeNull();
            await expect(
                prisma.discoveryAlbum.findUnique({
                    where: { id: discovery.id },
                }),
            ).resolves.toEqual(
                expect.objectContaining({ status: "ACTIVE", likedAt: null }),
            );
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

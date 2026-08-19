import { Client } from "pg";
import { recomputeAlbumLoudness } from "../src/services/albumLoudness";
import { deleteTrackAndRecomputeAlbum } from "../src/services/trackDeletion";
import { prisma } from "../src/utils/db";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;

function baseDatabaseUrl(databaseUrl: string): string {
    const parsed = new URL(databaseUrl);
    parsed.searchParams.delete("schema");
    return parsed.toString();
}

async function createSchema(database: Client): Promise<void> {
    await database.query(`
        CREATE TABLE "Album" (
            id TEXT PRIMARY KEY,
            "albumLoudnessLufs" DOUBLE PRECISION,
            "albumTruePeakDb" DOUBLE PRECISION
        );
        CREATE TABLE "Track" (
            id TEXT PRIMARY KEY,
            "albumId" TEXT NOT NULL REFERENCES "Album"(id),
            duration INTEGER NOT NULL,
            "removedAt" TIMESTAMP(3),
            "loudnessLufs" DOUBLE PRECISION,
            "truePeakDb" DOUBLE PRECISION
        );
    `);
}

async function resetCatalog(database: Client): Promise<void> {
    await database.query('TRUNCATE "Track", "Album" CASCADE');
    await database.query(`
        INSERT INTO "Album" (id, "albumLoudnessLufs", "albumTruePeakDb")
        VALUES ('album-a', -6, 3), ('album-b', -30, -9);
        INSERT INTO "Track"
            (id, "albumId", duration, "removedAt", "loudnessLufs", "truePeakDb")
        VALUES
            ('track-a', 'album-a', 100, NULL, -10, -1),
            ('track-b', 'album-a', 300, NULL, -20, -2),
            ('track-c', 'album-b', 200, NULL, -30, -9);
    `);
}

async function loadAlbum(database: Client, albumId: string) {
    const result = await database.query<{
        albumLoudnessLufs: number | null;
        albumTruePeakDb: number | null;
    }>(
        `SELECT "albumLoudnessLufs", "albumTruePeakDb"
         FROM "Album" WHERE id = $1`,
        [albumId],
    );
    return result.rows[0];
}

async function waitForBlockedAdvisoryLock(database: Client): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await database.query<{ waiting: boolean }>(`
            SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_locks
                WHERE locktype = 'advisory' AND NOT granted
            ) AS waiting
        `);
        if (result.rows[0]?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Second rollup did not wait for the album advisory lock");
}

describeWithPostgres("loudness integrity PostgreSQL behavior", () => {
    let admin: Client;
    let database: Client;

    beforeAll(async () => {
        if (!/^vibe_x2_\d+_\d+$/.test(databaseName!)) {
            throw new Error("Integration database name is unsafe");
        }
        admin = new Client({
            connectionString: baseDatabaseUrl(integrationDatabaseUrl!),
        });
        await admin.connect();
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        database = new Client({ connectionString: process.env.DATABASE_URL });
        await database.connect();
        await createSchema(database);
    });

    beforeEach(async () => resetCatalog(database));

    afterAll(async () => {
        await prisma.$disconnect();
        await database?.end();
        if (admin && databaseName) {
            await admin.query(
                `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
            );
            await admin.end();
        }
    });

    it("recomputes removal, empty-album, revival, and hard-delete transitions", async () => {
        await prisma.$transaction(async (transaction) => {
            await transaction.$executeRaw`
                UPDATE "Track" SET "removedAt" = NOW() WHERE id = 'track-a'
            `;
            await recomputeAlbumLoudness(transaction, ["album-a"]);
        });
        await expect(loadAlbum(database, "album-a")).resolves.toEqual({
            albumLoudnessLufs: -20,
            albumTruePeakDb: -2,
        });

        await prisma.$transaction(async (transaction) => {
            await transaction.$executeRaw`
                UPDATE "Track" SET "removedAt" = NOW() WHERE id = 'track-b'
            `;
            await recomputeAlbumLoudness(transaction, ["album-a"]);
        });
        await expect(loadAlbum(database, "album-a")).resolves.toEqual({
            albumLoudnessLufs: null,
            albumTruePeakDb: null,
        });

        await prisma.$transaction(async (transaction) => {
            await transaction.$executeRaw`
                UPDATE "Track" SET "removedAt" = NULL WHERE id = 'track-a'
            `;
            await recomputeAlbumLoudness(transaction, ["album-a"]);
        });
        await expect(loadAlbum(database, "album-a")).resolves.toEqual({
            albumLoudnessLufs: -10,
            albumTruePeakDb: -1,
        });

        await deleteTrackAndRecomputeAlbum("track-a", "album-a");
        await expect(loadAlbum(database, "album-a")).resolves.toEqual({
            albumLoudnessLufs: null,
            albumTruePeakDb: null,
        });
    });

    it("serializes concurrent sibling saves so the second sees the first", async () => {
        await database.query(`
            UPDATE "Track" SET "loudnessLufs" = NULL, "truePeakDb" = NULL
            WHERE "albumId" = 'album-a'
        `);
        let releaseFirst!: () => void;
        const holdFirst = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let firstLocked!: () => void;
        const locked = new Promise<void>((resolve) => {
            firstLocked = resolve;
        });
        const first = prisma.$transaction(async (transaction) => {
            await transaction.$executeRaw`
                UPDATE "Track"
                SET "loudnessLufs" = -10, "truePeakDb" = -1
                WHERE id = 'track-a'
            `;
            await recomputeAlbumLoudness(transaction, ["album-a"]);
            firstLocked();
            await holdFirst;
        });
        await locked;
        const second = prisma.$transaction(async (transaction) => {
            await transaction.$executeRaw`
                UPDATE "Track"
                SET "loudnessLufs" = -20, "truePeakDb" = -2
                WHERE id = 'track-b'
            `;
            await recomputeAlbumLoudness(transaction, ["album-a"]);
        });

        try {
            await waitForBlockedAdvisoryLock(database);
        } finally {
            releaseFirst();
        }
        await Promise.all([first, second]);

        const album = await loadAlbum(database, "album-a");
        const expected = 10 * Math.log10((100 * 0.1 + 300 * 0.01) / 400);
        expect(album?.albumLoudnessLufs).toBeCloseTo(expected, 10);
        expect(album?.albumTruePeakDb).toBe(-1);
    });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { prisma } from "../src/utils/db";
import { isForeignKeyViolationOn } from "../src/utils/prismaErrors";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const databaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && databaseName ? describe : describe.skip;

const userId = "audiobook-user-state-fk-user";
const replayAudiobookId = "audiobook-user-state-replay-valid";
const replayValidProgressId = "audiobook-user-state-replay-valid-progress";
const replayOrphanProgressId = "audiobook-user-state-replay-orphan-progress";
const replayDanglingAudiobookId = "audiobook-user-state-replay-dangling";
const replayDeviceId = "audiobook-user-state-replay-device";
const migrationPath = resolve(
    __dirname,
    "../prisma/migrations/20260826210000_link_audiobook_user_state/migration.sql",
);

async function createAudiobook(id: string, peerId?: string): Promise<void> {
    await prisma.audiobook.create({
        data: {
            id,
            title: id,
            audioUrl: id,
            genres: [],
            tags: [],
            ...(peerId ? { peerId, remoteId: `${id}-remote` } : {}),
        },
    });
}

async function createProgress(audiobookId: string): Promise<void> {
    await prisma.audiobookProgress.create({
        data: {
            userId,
            audiobookshelfId: audiobookId,
            title: audiobookId,
            currentTime: 120,
            duration: 600,
        },
    });
}

async function removeAudiobookUserStateLinks(client: Client): Promise<void> {
    await client.query(`
        ALTER TABLE "AudiobookProgress"
            DROP CONSTRAINT "AudiobookProgress_audiobookshelfId_fkey";
        ALTER TABLE "PlaybackState"
            DROP CONSTRAINT "PlaybackState_audiobookId_fkey";
        DROP INDEX "AudiobookProgress_audiobookshelfId_idx";
        DROP INDEX "PlaybackState_audiobookId_idx";
    `);
}

async function insertMigrationReplayRows(client: Client): Promise<void> {
    await client.query(
        `INSERT INTO "AudiobookProgress" (
            "id", "userId", "audiobookshelfId", "title", "currentTime",
            "duration", "updatedAt"
         ) VALUES
            ($1, $2, $3, 'Orphan progress', 41, 500, CURRENT_TIMESTAMP),
            ($4, $2, $5, 'Valid progress', 42, 600, CURRENT_TIMESTAMP)`,
        [
            replayOrphanProgressId,
            userId,
            replayDanglingAudiobookId,
            replayValidProgressId,
            replayAudiobookId,
        ],
    );
    await client.query(
        `INSERT INTO "PlaybackState" (
            "userId", "deviceId", "playbackType", "audiobookId", "queue",
            "currentIndex", "isShuffle", "isPlaying", "currentTime", "updatedAt"
         ) VALUES ($1, $2, 'audiobook', $3, $4::jsonb, 3, true, true, 87,
                   CURRENT_TIMESTAMP)`,
        [
            userId,
            replayDeviceId,
            replayDanglingAudiobookId,
            JSON.stringify([{ id: replayDanglingAudiobookId }]),
        ],
    );
}

async function cleanupMigrationReplayRows(client: Client): Promise<void> {
    await client.query(
        `DELETE FROM "PlaybackState"
         WHERE "userId" = $1 AND "deviceId" = $2`,
        [userId, replayDeviceId],
    );
    await client.query(
        `DELETE FROM "AudiobookProgress" WHERE "id" = ANY($1::text[])`,
        [[replayOrphanProgressId, replayValidProgressId]],
    );
    await client.query(`DELETE FROM "Audiobook" WHERE "id" = $1`, [
        replayAudiobookId,
    ]);
}

async function expectSelectiveProgressCleanup(client: Client): Promise<void> {
    const progress = await client.query<{
        id: string;
        audiobookshelfId: string;
        title: string;
    }>(
        `SELECT "id", "audiobookshelfId", "title"
         FROM "AudiobookProgress"
         WHERE "id" = ANY($1::text[])
         ORDER BY "id"`,
        [[replayOrphanProgressId, replayValidProgressId]],
    );
    expect(progress.rows).toEqual([
        {
            id: replayValidProgressId,
            audiobookshelfId: replayAudiobookId,
            title: "Valid progress",
        },
    ]);
}

async function expectDanglingPlaybackReferenceCleared(
    client: Client,
): Promise<void> {
    const playback = await client.query(
        `SELECT "userId", "deviceId", "playbackType", "audiobookId",
                "queue", "currentIndex", "isShuffle", "isPlaying",
                "currentTime"
         FROM "PlaybackState"
         WHERE "userId" = $1 AND "deviceId" = $2`,
        [userId, replayDeviceId],
    );
    expect(playback.rows).toEqual([
        {
            userId,
            deviceId: replayDeviceId,
            playbackType: "audiobook",
            audiobookId: null,
            queue: [{ id: replayDanglingAudiobookId }],
            currentIndex: 3,
            isShuffle: true,
            isPlaying: true,
            currentTime: 87,
        },
    ]);
}

async function expectForeignKeysRestored(client: Client): Promise<void> {
    const constraints = await client.query<{ constraintName: string }>(
        `SELECT conname AS "constraintName"
         FROM pg_catalog.pg_constraint
         WHERE conname = ANY($1::text[])
         ORDER BY conname`,
        [
            [
                "AudiobookProgress_audiobookshelfId_fkey",
                "PlaybackState_audiobookId_fkey",
            ],
        ],
    );
    expect(constraints.rows.map((row) => row.constraintName)).toEqual([
        "AudiobookProgress_audiobookshelfId_fkey",
        "PlaybackState_audiobookId_fkey",
    ]);
}

describeWithPostgres("audiobook user-state PostgreSQL relations", () => {
    let admin: Client;

    beforeAll(async () => {
        admin = await createScaleDatabase(
            integrationDatabaseUrl!,
            databaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        await prisma.user.create({
            data: { id: userId, username: "audiobook-user-state-fk" },
        });
    });

    afterAll(async () => {
        await prisma.$disconnect();
        if (admin && databaseName) {
            await dropScaleDatabase(admin, databaseName);
        }
    });

    it("cascades progress and nulls the audiobook reference on delete", async () => {
        const audiobookId = "audiobook-user-state-delete";
        await createAudiobook(audiobookId);
        await createProgress(audiobookId);
        await prisma.playbackState.create({
            data: {
                userId,
                deviceId: "audiobook-delete-device",
                playbackType: "audiobook",
                audiobookId,
                queue: [{ id: audiobookId, title: "Queued book" }],
                currentIndex: 2,
                isShuffle: true,
                isPlaying: true,
                currentTime: 120,
            },
        });

        await prisma.audiobook.delete({ where: { id: audiobookId } });

        await expect(
            prisma.audiobookProgress.count({
                where: { audiobookshelfId: audiobookId },
            }),
        ).resolves.toBe(0);
        await expect(
            prisma.playbackState.findUnique({
                where: {
                    userId_deviceId: {
                        userId,
                        deviceId: "audiobook-delete-device",
                    },
                },
            }),
        ).resolves.toEqual(
            expect.objectContaining({
                userId,
                deviceId: "audiobook-delete-device",
                playbackType: "audiobook",
                audiobookId: null,
                queue: [{ id: audiobookId, title: "Queued book" }],
                currentIndex: 2,
                isShuffle: true,
                isPlaying: true,
                currentTime: 120,
            }),
        );
    });

    it("rejects progress for a nonexistent audiobook", async () => {
        let violation: unknown;
        try {
            await createProgress("audiobook-user-state-missing");
        } catch (error: unknown) {
            violation = error;
        }

        expect(violation).toMatchObject({ code: "P2003" });
        expect(
            isForeignKeyViolationOn(
                violation,
                "AudiobookProgress_audiobookshelfId_fkey",
            ),
        ).toBe(true);
    });

    it("accepts federated audiobook progress and cascades it on delete", async () => {
        const peerId = "audiobook-user-state-peer";
        const audiobookId = "fed:audiobook-user-state";
        await prisma.federationPeer.create({
            data: {
                id: peerId,
                name: "Audiobook user-state peer",
                direction: "CONSUMER",
                scopes: ["library:read"],
                createdById: userId,
            },
        });
        await createAudiobook(audiobookId, peerId);

        await expect(createProgress(audiobookId)).resolves.toBeUndefined();
        await prisma.audiobook.delete({ where: { id: audiobookId } });

        await expect(
            prisma.audiobookProgress.count({
                where: { audiobookshelfId: audiobookId },
            }),
        ).resolves.toBe(0);
    });

    it("replays orphan cleanup before restoring the foreign keys", async () => {
        const client = new Client({
            connectionString: process.env.DATABASE_URL,
        });
        let migrationCommitted = false;
        await client.connect();

        try {
            await createAudiobook(replayAudiobookId);
            await removeAudiobookUserStateLinks(client);
            await insertMigrationReplayRows(client);

            const migrationSql = readFileSync(migrationPath, "utf8");
            await client.query(migrationSql);
            migrationCommitted = true;

            await expectSelectiveProgressCleanup(client);
            await expectDanglingPlaybackReferenceCleared(client);
            await expectForeignKeysRestored(client);
        } finally {
            if (!migrationCommitted) {
                await client.query("ROLLBACK");
            }
            try {
                await cleanupMigrationReplayRows(client);
            } finally {
                await client.end();
            }
        }
    });
});

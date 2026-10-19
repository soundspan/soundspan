import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { Client } from "pg";
import { gunzipSync, gzipSync } from "zlib";

jest.mock("../src/utils/redis", () => {
    const values = new Map<string, string>();
    return {
        redisClient: {
            set: jest.fn(async (key: string, value: string) => {
                values.set(key, value);
                return "OK";
            }),
            get: jest.fn(async (key: string) => values.get(key) ?? null),
            getDel: jest.fn(async (key: string) => {
                const value = values.get(key) ?? null;
                values.delete(key);
                return value;
            }),
            del: jest.fn(async (keys: string | string[]) => {
                const entries = Array.isArray(keys) ? keys : [keys];
                let removed = 0;
                for (const key of entries.slice(0, 10_000)) {
                    if (values.delete(key)) removed += 1;
                }
                return removed;
            }),
            exists: jest.fn(async (key: string) => (values.has(key) ? 1 : 0)),
            expire: jest.fn(async () => true),
            clearIntegrationState: () => values.clear(),
        },
    };
});

import { config } from "../src/config";
import {
    readBackupHeader,
    validateBackupArchive,
} from "../src/services/backup/backupArchiveReader";
import { openBackupExport } from "../src/services/backup/backupExport";
import { wrapEncryptionKey } from "../src/services/backup/backupKeyWrap";
import {
    quoteIdent,
    readApplicationTables,
    readOwnedSequences,
} from "../src/services/backup/backupCatalog";
import { loadBackupData } from "../src/services/backup/restoreDataLoad";
import { readImageMigrations } from "../src/services/backup/restoreCompatibility";
import {
    deployCurrentMigrations,
    replayBackupMigrations,
} from "../src/services/backup/restoreMigrationReplay";
import { reencryptRestoredCredentials } from "../src/services/backup/restoreReencrypt";
import { resetApplicationSchema } from "../src/services/backup/restoreSchemaReset";
import { decryptWithKey, encryptWithKey } from "../src/utils/encryption";
import {
    applyScaleMigrations,
    createScaleDatabase,
    dropScaleDatabase,
} from "./scaleTestDatabase";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
const sourceDatabaseName = process.env.VIBE_INTEGRATION_DATABASE;
const describeWithPostgres =
    integrationDatabaseUrl && sourceDatabaseName ? describe : describe.skip;

function databaseUrl(name: string): string {
    const value = new URL(integrationDatabaseUrl!);
    value.pathname = `/${name}`;
    value.searchParams.delete("schema");
    return value.toString();
}

interface DatabaseState {
    tables: Record<string, { count: string; digest: string }>;
    sequences: Awaited<ReturnType<typeof readOwnedSequences>>;
}

async function captureDatabaseState(client: Client): Promise<DatabaseState> {
    const catalog = await readApplicationTables(client);
    const tables: DatabaseState["tables"] = {};
    for (const table of catalog) {
        const tableName = quoteIdent(table.name);
        const result = await client.query<{ count: string; digest: string }>(`
            SELECT count(*)::text AS count,
                   md5(coalesce(string_agg(row_to_json(snapshot)::text, E'\\n'
                       ORDER BY row_to_json(snapshot)::text), '')) AS digest
              FROM public.${tableName} AS snapshot
        `);
        const state = result.rows[0];
        if (!state) throw new Error(`Could not inspect ${table.name}`);
        tables[table.name] = state;
    }
    return { tables, sequences: await readOwnedSequences(client, catalog) };
}

async function seedTypeFamilies(
    client: Client,
    userId: string,
    encryptedSetting: string,
    encryptedPassword: string,
): Promise<void> {
    const timestamp = "2026-01-02T03:04:05.678Z";
    await client.query(
        `INSERT INTO "User" (
             "id", "username", "role", "onboardingComplete",
             "enrichmentSettings", "profilePicture", "moodMixParams", "createdAt"
         ) VALUES ($1, 'backup-user', 'admin', false, $2::jsonb, $3, $4::jsonb, $5)`,
        [
            userId,
            JSON.stringify({ sources: ["library"], threshold: 0.75 }),
            Buffer.from([0, 1, 2, 255]),
            JSON.stringify({ energy: 0.25, tags: ["calm"] }),
            timestamp,
        ],
    );
    await client.query(
        `INSERT INTO "SystemSettings" ("id", "openaiApiKey", "fanartApiKey")
         VALUES ('default', $1, 'v2:broken-value')`,
        [encryptedSetting],
    );
    await client.query(
        `INSERT INTO "AppPassword" ("id", "userId", "displayName", "encryptedSecret")
         VALUES ('backup-app-password', $1, 'Backup', $2)`,
        [userId, encryptedPassword],
    );
    await client.query(
        `INSERT INTO "PlaybackState" (
             "userId", "deviceId", "playbackType", "queue", "isShuffle",
             "isPlaying", "currentTime", "createdAt", "updatedAt"
         ) VALUES ($1, 'backup-device', 'music', $2::jsonb, true, false,
                   'Infinity'::double precision, $3, $3)`,
        [userId, JSON.stringify([{ id: "queued-track", index: 0 }]), timestamp],
    );
    await client.query(
        `INSERT INTO "SyncGroup" (
             "id", "joinCode", "hostUserId", "queue", "currentTime",
             "membershipFence", "stateUpdatedAt", "createdAt", "updatedAt"
         ) VALUES ('backup-sync-group', 'BKP123', $1, $2::jsonb,
                   'NaN'::double precision, 9223372036854775806, $3, $3, $3)`,
        [userId, JSON.stringify([{ id: "queued-track" }]), timestamp],
    );
    await client.query(
        `INSERT INTO "Artist" ("id", "mbid", "name", "genres", "lastSynced", "updatedAt")
         VALUES ('backup-artist', 'backup-artist-mbid', 'Backup Artist',
                 $1::jsonb, $2, $2)`,
        [JSON.stringify(["Ambient", "Electronic"]), timestamp],
    );
    await client.query(
        `INSERT INTO "Album" (
             "id", "rgMbid", "artistId", "title", "primaryType", "location",
             "genres", "lastSynced", "updatedAt"
         ) VALUES ('backup-album', 'backup-release-mbid', 'backup-artist',
                   'Backup Album', 'Album', 'LIBRARY', $1::jsonb, $2, $2)`,
        [JSON.stringify(["Ambient"]), timestamp],
    );
    await client.query(
        `INSERT INTO "Track" (
             "id", "albumId", "title", "trackNo", "duration", "filePath",
             "fileModified", "fileSize", "origin", "bpm", "moodTags",
             "essentiaGenres", "lastfmTags", "updatedAt"
         ) VALUES ('backup-track', 'backup-album', 'Backup Track', 1, 180,
                   '/music/backup.flac', $1, 123456, 'LOCAL', 123.456,
                   ARRAY['calm','focus'], ARRAY['ambient'], ARRAY['electronic'], $1)`,
        [timestamp],
    );
    await client.query(
        `INSERT INTO embedding_spaces (
             "id", "family", "checkpoint_hash", "dim", "preprocessing",
             "status", "created_at", "last_seen_at"
         ) VALUES ('backup-space', 'integration', 'backup-checkpoint', 512,
                   $1::jsonb, 'active', $2, $2)`,
        [JSON.stringify({ normalize: true }), timestamp],
    );
    const vector = `[${Array.from({ length: 512 }, () => "0.125").join(",")}]`;
    await client.query(
        `INSERT INTO track_embeddings ("track_id", "embedding", "space_id", "analyzed_at")
         VALUES ('backup-track', $1::vector, 'backup-space', $2)`,
        [vector, timestamp],
    );
}

type RestoreJobModule = typeof import("../src/services/backup/restoreJob");
let restoreJobModule: RestoreJobModule | null = null;

async function prepareRestoreRuntime(
    targetUrl: string,
    currentKey: string,
): Promise<RestoreJobModule> {
    config.databaseUrl = targetUrl;
    process.env.DATABASE_URL = targetUrl;
    process.env.SETTINGS_ENCRYPTION_KEY = currentKey;
    const { redisClient } = await import("../src/utils/redis");
    (
        redisClient as typeof redisClient & {
            clearIntegrationState: () => void;
        }
    ).clearIntegrationState();
    restoreJobModule ??= await import("../src/services/backup/restoreJob");
    return restoreJobModule;
}

async function waitForRestore(
    restoreJob: RestoreJobModule,
): Promise<Awaited<ReturnType<RestoreJobModule["getRestoreStatus"]>>> {
    for (let attempt = 0; attempt < 240; attempt += 1) {
        const status = await restoreJob.getRestoreStatus();
        if (status.state === "complete" || status.state === "failed") {
            return status;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
        "Restore job did not finish before the integration timeout",
    );
}

describeWithPostgres("data-only backup and restore", () => {
    jest.setTimeout(300_000);
    const backupKey = "backup-source-key-a".repeat(3);
    const currentKey = "restore-target-key-b".repeat(3);
    const userId = "backup-roundtrip-user";
    let sourceAdmin: Client;
    let targetAdmin: Client;
    let source: Client;
    let target: Client;
    let targetName: string;
    let targetUrl: string;
    let directory: string;

    beforeAll(async () => {
        sourceAdmin = await createScaleDatabase(
            integrationDatabaseUrl!,
            sourceDatabaseName!,
        );
        await applyScaleMigrations(process.env.DATABASE_URL!);
        targetName = `vibe_x2_${process.pid}_${Date.now() + 1}`;
        targetAdmin = await createScaleDatabase(
            integrationDatabaseUrl!,
            targetName,
        );
        targetUrl = databaseUrl(targetName);
        await applyScaleMigrations(targetUrl);
        source = new Client({ connectionString: process.env.DATABASE_URL! });
        target = new Client({ connectionString: targetUrl });
        await source.connect();
        await target.connect();
        directory = await fsp.mkdtemp(
            path.join(os.tmpdir(), "backup-integration-"),
        );
    });

    afterAll(async () => {
        if (restoreJobModule) {
            const { prisma } = await import("../src/utils/db");
            await prisma.$disconnect();
        }
        await source?.end();
        await target?.end();
        await fsp.rm(directory, { recursive: true, force: true });
        if (targetAdmin) await dropScaleDatabase(targetAdmin, targetName);
        if (sourceAdmin)
            await dropScaleDatabase(sourceAdmin, sourceDatabaseName!);
    });

    it("round-trips rows, preserves extensions, constraints, triggers, and rotates credentials", async () => {
        const encryptedSetting = encryptWithKey("setting-secret", backupKey);
        const encryptedPassword = encryptWithKey("app-password", backupKey);
        await seedTypeFamilies(
            source,
            userId,
            encryptedSetting,
            encryptedPassword,
        );
        const sourceState = await captureDatabaseState(source);

        const archivePath = path.join(directory, "roundtrip.soundspan-backup");
        const exporter = await openBackupExport({
            wrappedKey: await wrapEncryptionKey(
                backupKey,
                "integration passphrase",
            ),
            appVersion: "integration",
        });
        try {
            await exporter.streamTo(fs.createWriteStream(archivePath));
        } finally {
            await exporter.close();
        }
        const header = await readBackupHeader(archivePath);
        const imageMigrations = await readImageMigrations(
            path.join(__dirname, "../prisma/migrations"),
        );
        expect(header.migrations).toEqual(imageMigrations);

        await resetApplicationSchema(target);
        const extensions = await target.query<{ extname: string }>(
            "SELECT extname FROM pg_extension WHERE extname = ANY($1::text[]) ORDER BY extname",
            [["pg_trgm", "vector"]],
        );
        expect(extensions.rows.map((row) => row.extname)).toEqual([
            "pg_trgm",
            "vector",
        ]);

        await replayBackupMigrations(
            directory,
            header.migrations,
            databaseUrl(targetName),
        );
        await loadBackupData(target, archivePath, header, () => undefined);
        expect(await captureDatabaseState(target)).toEqual(sourceState);
        await deployCurrentMigrations(databaseUrl(targetName));
        const stats = await reencryptRestoredCredentials(
            target,
            backupKey,
            currentKey,
        );
        expect(stats.credentialsReencrypted).toBeGreaterThanOrEqual(2);
        expect(stats.credentialsUndecryptable).toBe(1);

        const restored = await target.query<{
            username: string;
            profilePicture: Buffer;
            encryptedSecret: string;
            openaiApiKey: string;
            fanartApiKey: string;
        }>(
            `SELECT u."username", u."profilePicture", a."encryptedSecret",
                    s."openaiApiKey", s."fanartApiKey"
               FROM "User" u
               JOIN "AppPassword" a ON a."userId" = u."id"
               CROSS JOIN "SystemSettings" s
              WHERE u."id" = $1`,
            [userId],
        );
        expect(restored.rows[0]?.username).toBe("backup-user");
        expect(restored.rows[0]?.profilePicture).toEqual(
            Buffer.from([0, 1, 2, 255]),
        );
        expect(
            decryptWithKey(restored.rows[0]!.encryptedSecret, currentKey),
        ).toBe("app-password");
        expect(decryptWithKey(restored.rows[0]!.openaiApiKey, currentKey)).toBe(
            "setting-secret",
        );
        expect(restored.rows[0]?.fanartApiKey).toBe("v2:broken-value");

        const foreignKey = await target.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pg_constraint
              WHERE conname = 'AppPassword_userId_fkey' AND contype = 'f'`,
        );
        expect(foreignKey.rows[0]?.count).toBe("1");
        const disabledTriggers = await target.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled = 'D'`,
        );
        expect(disabledTriggers.rows[0]?.count).toBe("0");
    });

    it("restores an older migration subset and advances it to the image head", async () => {
        const imageMigrations = await readImageMigrations(
            path.join(__dirname, "../prisma/migrations"),
        );
        const olderMigrations = imageMigrations.slice(0, -10);
        const olderName = `vibe_x2_${process.pid}_${Date.now() + 2}`;
        const olderAdmin = await createScaleDatabase(
            integrationDatabaseUrl!,
            olderName,
        );
        const olderUrl = databaseUrl(olderName);
        const olderClient = new Client({ connectionString: olderUrl });
        const olderDirectory = path.join(directory, "older-source");
        await fsp.mkdir(olderDirectory, { recursive: true });
        try {
            await replayBackupMigrations(
                olderDirectory,
                olderMigrations,
                olderUrl,
            );
            await olderClient.connect();
            await olderClient.query(
                `INSERT INTO "User" ("id", "username") VALUES ('older-user', 'older-user')`,
            );
            await olderClient.query(
                `INSERT INTO "SystemSettings" ("id") VALUES ('default')`,
            );

            const previousUrl = config.databaseUrl;
            config.databaseUrl = olderUrl;
            const olderArchive = path.join(directory, "older.soundspan-backup");
            try {
                const exporter = await openBackupExport({
                    wrappedKey: await wrapEncryptionKey(
                        backupKey,
                        "older integration passphrase",
                    ),
                    appVersion: "older-integration",
                });
                try {
                    await exporter.streamTo(fs.createWriteStream(olderArchive));
                } finally {
                    await exporter.close();
                }
            } finally {
                config.databaseUrl = previousUrl;
            }

            const header = await readBackupHeader(olderArchive);
            expect(header.migrations).toEqual(olderMigrations);
            await resetApplicationSchema(target);
            await replayBackupMigrations(
                path.join(directory, "older-target"),
                header.migrations,
                databaseUrl(targetName),
            );
            await loadBackupData(target, olderArchive, header, () => undefined);
            await deployCurrentMigrations(databaseUrl(targetName));
            const restoredUser = await target.query<{ username: string }>(
                `SELECT "username" FROM "User" WHERE "id" = 'older-user'`,
            );
            expect(restoredUser.rows).toEqual([{ username: "older-user" }]);
            const migrationCount = await target.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM "_prisma_migrations"
                  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
            );
            expect(Number(migrationCount.rows[0]?.count)).toBe(
                imageMigrations.length,
            );

            await resetApplicationSchema(target);
            await deployCurrentMigrations(targetUrl);
            const jobArchive = path.join(
                directory,
                "older-full-job.soundspan-backup",
            );
            await fsp.copyFile(olderArchive, jobArchive);
            const restoreJob = await prepareRestoreRuntime(
                targetUrl,
                currentKey,
            );
            await restoreJob.startRestoreJob({
                uploadId: "integration-older",
                filePath: jobArchive,
                backupKey,
            });
            const status = await waitForRestore(restoreJob);
            expect(status.state).toBe("complete");
            expect(status.summary?.migrationsAppliedAfterLoad).toBe(10);
            const fullyRestored = await target.query<{ username: string }>(
                `SELECT "username" FROM "User" WHERE "id" = 'older-user'`,
            );
            expect(fullyRestored.rows).toEqual([{ username: "older-user" }]);
        } finally {
            await olderClient.end().catch(() => undefined);
            await dropScaleDatabase(olderAdmin, olderName);
        }
    });

    it("cleans up to a fresh install when a corrupted batch fails after reset", async () => {
        const archivePath = path.join(directory, "older.soundspan-backup");
        const records = gunzipSync(await fsp.readFile(archivePath))
            .toString("utf8")
            .trimEnd()
            .split("\n");
        const batchIndex = records.findIndex((line, index) => {
            if (index === 0) return false;
            return (JSON.parse(line) as { type?: string }).type === "rows";
        });
        if (batchIndex === -1) {
            throw new Error("Row batch missing from integration backup");
        }
        const batch = JSON.parse(records[batchIndex]!) as {
            type: "rows";
            rows: string;
        };
        batch.rows = "[]";
        records[batchIndex] = JSON.stringify(batch);
        const corrupted = path.join(directory, "corrupted.soundspan-backup");
        await fsp.writeFile(corrupted, gzipSync(`${records.join("\n")}\n`));

        await expect(validateBackupArchive(corrupted)).resolves.toBeDefined();
        await resetApplicationSchema(target);
        await deployCurrentMigrations(targetUrl);
        const restoreJob = await prepareRestoreRuntime(targetUrl, currentKey);
        await restoreJob.startRestoreJob({
            uploadId: "integration-corrupt",
            filePath: corrupted,
            backupKey,
        });
        const status = await waitForRestore(restoreJob);
        expect(status.state).toBe("failed");
        expect(status.error?.code).toBe("BACKUP_ROW_COUNT_MISMATCH");
        const users = await target.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM "User"`,
        );
        expect(users.rows[0]?.count).toBe("0");
        const extensions = await target.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pg_extension
              WHERE extname = ANY($1::text[])`,
            [["pg_trgm", "vector"]],
        );
        expect(extensions.rows[0]?.count).toBe("2");
    });

    it("detects the bigint advisory lock through pg_locks", async () => {
        const { isRestoreLockHeld, RESTORE_ADVISORY_LOCK } =
            await import("../src/services/backup/restoreLock");
        await target.query("SELECT pg_advisory_lock($1)", [
            RESTORE_ADVISORY_LOCK,
        ]);
        try {
            await expect(isRestoreLockHeld()).resolves.toBe(true);
            const lock = await target.query<{
                classid: string;
                objid: string;
                objsubid: number;
            }>(
                `SELECT classid::text, objid::text, objsubid
                   FROM pg_locks
                  WHERE locktype = 'advisory'
                    AND granted
                    AND classid = $1::oid
                    AND objid = $2::oid
                    AND objsubid = 1`,
                [1, 1_036_033_706],
            );
            expect(lock.rows).toEqual([
                { classid: "1", objid: "1036033706", objsubid: 1 },
            ]);
        } finally {
            await target.query("SELECT pg_advisory_unlock($1)", [
                RESTORE_ADVISORY_LOCK,
            ]);
        }
    });
});

import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { Client } from "pg";
import { gunzipSync, gzipSync } from "zlib";

jest.mock("../src/utils/redis", () => {
    const values = new Map<string, string>();
    return {
        redisClient: {
            isReady: true,
            set: jest.fn(async (key: string, value: string) => {
                values.set(key, value);
                return "OK";
            }),
            get: jest.fn(async (key: string) => values.get(key) ?? null),
            sendCommand: jest.fn(async (args: readonly string[]) => {
                if (args[0] !== "GET") return null;
                return values.get(args[1]!) ?? null;
            }),
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

function databaseUrlWithOptions(value: string, options: string): string {
    const url = new URL(value);
    url.searchParams.set("options", options);
    return url.toString();
}

async function waitForBackendToDisappear(
    observer: Client,
    backendPid: number | null,
): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const session = await observer.query<{ present: boolean }>(
            `SELECT EXISTS (
                 SELECT 1 FROM pg_stat_activity WHERE pid = $1
             ) AS present`,
            [backendPid],
        );
        if (session.rows[0]?.present === false) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
        `PostgreSQL backend ${backendPid ?? "with unknown PID"} remained present after guarded termination`,
    );
}

async function assertRecoveryOwnsRestoreLock(
    recovery: Client,
    originalPid: number | null,
): Promise<void> {
    const identity = await recovery.query<{
        backend_pid: number;
    }>("SELECT pg_backend_pid() AS backend_pid");
    expect(identity.rows[0]?.backend_pid).not.toBe(originalPid);
    await waitForBackendToDisappear(recovery, originalPid);
    const ownedLock = await recovery.query<{ held: boolean }>(
        `SELECT EXISTS (
             SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory'
                AND granted
                AND pid = pg_backend_pid()
         ) AS held`,
    );
    expect(ownedLock.rows[0]?.held).toBe(true);
}

async function assertBackendEndedAndLockFreed(
    observer: Client,
    backendPid: number | null,
    advisoryLock: number,
): Promise<void> {
    const session = await observer.query<{ present: boolean }>(
        `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity WHERE pid = $1
         ) AS present`,
        [backendPid],
    );
    expect(session.rows[0]?.present).toBe(false);
    const available = await observer.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [advisoryLock],
    );
    expect(available.rows[0]?.acquired).toBe(true);
    await observer.query("SELECT pg_advisory_unlock($1)", [advisoryLock]);
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
         ) VALUES ($1, 'backup-user', 'admin', false, $2::jsonb, $3, NULL, $4)`,
        [
            userId,
            JSON.stringify({ sources: ["library"], threshold: 0.75 }),
            Buffer.from([0, 1, 2, 255]),
            timestamp,
        ],
    );
    await client.query(
        `INSERT INTO "SystemSettings" ("id", "openaiApiKey", "fanartApiKey", "updatedAt")
         VALUES ('default', $1, 'v2:broken-value', $2)`,
        [encryptedSetting, timestamp],
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
                   $1::jsonb, 'migrating', $2, $2)`,
        [JSON.stringify(null), timestamp],
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
        const profilePicture = crypto.randomBytes(100 * 1024);
        await seedTypeFamilies(
            source,
            userId,
            encryptedSetting,
            encryptedPassword,
        );
        await source.query(
            `UPDATE "User" SET "profilePicture" = $1 WHERE "id" = $2`,
            [profilePicture, userId],
        );
        const sourceState = await captureDatabaseState(source);

        const archivePath = path.join(directory, "roundtrip.soundspan-backup");
        const wrapped = await wrapEncryptionKey(
            backupKey,
            "integration passphrase",
            null,
        );
        const exporter = await openBackupExport({
            wrappedKey: wrapped.wrappedKey,
            macKey: wrapped.macKey,
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
        expect(restored.rows[0]?.profilePicture).toEqual(profilePicture);
        expect(
            decryptWithKey(restored.rows[0]!.encryptedSecret, currentKey),
        ).toBe("app-password");
        expect(decryptWithKey(restored.rows[0]!.openaiApiKey, currentKey)).toBe(
            "setting-secret",
        );
        expect(restored.rows[0]?.fanartApiKey).toBe("v2:broken-value");
        const jsonNulls = await target.query<{
            preprocessing_is_json_null: boolean;
            mood_mix_is_sql_null: boolean;
        }>(
            `
            SELECT e.preprocessing = 'null'::jsonb AS preprocessing_is_json_null,
                   u."moodMixParams" IS NULL AS mood_mix_is_sql_null
              FROM embedding_spaces e CROSS JOIN "User" u
             WHERE e.id = 'backup-space' AND u.id = $1
        `,
            [userId],
        );
        expect(jsonNulls.rows[0]).toEqual({
            preprocessing_is_json_null: true,
            mood_mix_is_sql_null: true,
        });

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
                `INSERT INTO "User" ("id", "username", "role") VALUES ('older-user', 'older-user', 'admin')`,
            );
            await olderClient.query(
                `INSERT INTO "SystemSettings" ("id", "updatedAt") VALUES ('default', now())`,
            );

            const previousUrl = config.databaseUrl;
            config.databaseUrl = olderUrl;
            const olderArchive = path.join(directory, "older.soundspan-backup");
            const olderWrapped = await wrapEncryptionKey(
                backupKey,
                "older integration passphrase",
                null,
            );
            try {
                const exporter = await openBackupExport({
                    wrappedKey: olderWrapped.wrappedKey,
                    macKey: olderWrapped.macKey,
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
            await resetApplicationSchema(target, { allowExistingUsers: true });
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

            await resetApplicationSchema(target, { allowExistingUsers: true });
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
                backupPepperFingerprint: null,
                macKey: olderWrapped.macKey,
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
        await resetApplicationSchema(target, { allowExistingUsers: true });
        await deployCurrentMigrations(targetUrl);
        await target.query(
            `INSERT INTO "User" ("id", "username", "role")
             VALUES ('corrupt-user', 'corrupt-user', 'admin')`,
        );
        await target.query(
            `INSERT INTO "SystemSettings" ("id", "updatedAt")
             VALUES ('default', now())`,
        );
        const wrapped = await wrapEncryptionKey(
            backupKey,
            "corruption integration passphrase",
            null,
        );
        const archivePath = path.join(
            directory,
            "corrupt-source.soundspan-backup",
        );
        const previousUrl = config.databaseUrl;
        config.databaseUrl = targetUrl;
        try {
            const exporter = await openBackupExport({
                wrappedKey: wrapped.wrappedKey,
                macKey: wrapped.macKey,
                appVersion: "corruption-integration",
            });
            try {
                await exporter.streamTo(fs.createWriteStream(archivePath));
            } finally {
                await exporter.close();
            }
        } finally {
            config.databaseUrl = previousUrl;
        }
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
        const authenticatedBody = `${records.slice(0, -1).join("\n")}\n`;
        records[records.length - 1] = JSON.stringify({
            type: "end",
            mac: crypto
                .createHmac("sha256", wrapped.macKey)
                .update(authenticatedBody, "utf8")
                .digest("base64"),
        });
        const corrupted = path.join(directory, "corrupted.soundspan-backup");
        await fsp.writeFile(corrupted, gzipSync(`${records.join("\n")}\n`));

        await expect(
            validateBackupArchive(corrupted, wrapped.macKey),
        ).resolves.toBeDefined();
        await resetApplicationSchema(target, { allowExistingUsers: true });
        await deployCurrentMigrations(targetUrl);
        const restoreJob = await prepareRestoreRuntime(targetUrl, currentKey);
        await restoreJob.startRestoreJob({
            uploadId: "integration-corrupt",
            filePath: corrupted,
            backupKey,
            backupPepperFingerprint: null,
            macKey: wrapped.macKey,
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
        config.databaseUrl = targetUrl;
        const {
            invalidateRestoreLockCache,
            isRestoreLockHeld,
            RESTORE_ADVISORY_LOCK,
        } = await import("../src/services/backup/restoreLock");
        invalidateRestoreLockCache();
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

    it("terminates only the recorded restore backend and frees its advisory lock", async () => {
        const {
            acquireRestoreClient,
            releaseRestoreClient,
            withRecoveryRestoreClient,
        } = await import("../src/services/backup/restoreClient");
        const { RESTORE_ADVISORY_LOCK } =
            await import("../src/services/backup/restoreLock");
        config.databaseUrl = databaseUrlWithOptions(
            targetUrl,
            "-c datestyle=Postgres,MDY -c timezone=America/Los_Angeles",
        );
        const original = await acquireRestoreClient();
        const originalDateStyle = await original.client.query<[string]>({
            text: "SHOW datestyle",
            rowMode: "array",
        });
        expect(originalDateStyle.rows[0]?.[0]).toBe("Postgres, MDY");
        const originalSettings = await original.client.query<{
            date_style: string;
            time_zone: string;
            utc_offset_seconds: number;
        }>(
            `SELECT current_setting('DateStyle') AS date_style,
                    current_setting('TimeZone') AS time_zone,
                    extract(timezone FROM current_timestamp)::int AS utc_offset_seconds`,
        );
        expect(originalSettings.rows[0]?.date_style).toBe("Postgres, MDY");
        expect(originalSettings.rows[0]?.time_zone).toBe("America/Los_Angeles");
        expect(originalSettings.rows[0]?.utc_offset_seconds).not.toBe(0);
        const originalEnd = original.client.end.bind(original.client);
        const ignoredErrors = (): void => undefined;
        original.client.on("error", ignoredErrors);
        original.client.emit("error", new Error("force guarded takeover"));
        original.client.end = jest
            .fn()
            .mockRejectedValue(
                new Error("leave backend for guarded termination"),
            ) as unknown as Client["end"];

        try {
            config.databaseUrl = databaseUrlWithOptions(
                targetUrl,
                "-c timezone=UTC",
            );
            await withRecoveryRestoreClient(original, async (recovery) =>
                assertRecoveryOwnsRestoreLock(recovery, original.backendPid),
            );
            await assertBackendEndedAndLockFreed(
                target,
                original.backendPid,
                RESTORE_ADVISORY_LOCK,
            );
        } finally {
            config.databaseUrl = targetUrl;
            original.client.end = originalEnd;
            original.client.off("error", ignoredErrors);
            await originalEnd().catch(() => undefined);
            await releaseRestoreClient(original);
        }
    });

    it("closes a healthy restore backend before recovery takes the lock", async () => {
        const {
            acquireRestoreClient,
            releaseRestoreClient,
            withRecoveryRestoreClient,
        } = await import("../src/services/backup/restoreClient");
        const { RESTORE_ADVISORY_LOCK } =
            await import("../src/services/backup/restoreLock");
        config.databaseUrl = targetUrl;
        const original = await acquireRestoreClient();
        await original.client.query("BEGIN");
        const originalQuery = jest.spyOn(original.client, "query");
        const originalEnd = jest.spyOn(original.client, "end");
        const clientQuery = jest.spyOn(Client.prototype, "query");

        try {
            await withRecoveryRestoreClient(original, async (recovery) =>
                assertRecoveryOwnsRestoreLock(recovery, original.backendPid),
            );

            expect(
                clientQuery.mock.calls.some(([sql]) =>
                    String(sql).includes("pg_terminate_backend"),
                ),
            ).toBe(false);

            expect(originalQuery).toHaveBeenCalledWith("ROLLBACK");
            expect(originalQuery).toHaveBeenCalledWith(
                "SELECT pg_advisory_unlock($1)",
                [RESTORE_ADVISORY_LOCK],
            );
            expect(originalEnd).toHaveBeenCalledTimes(1);
            await assertBackendEndedAndLockFreed(
                target,
                original.backendPid,
                RESTORE_ADVISORY_LOCK,
            );
        } finally {
            clientQuery.mockRestore();
            await releaseRestoreClient(original);
        }
    });
});

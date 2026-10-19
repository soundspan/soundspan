import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    compareDatabases,
    databaseUrl,
    migrateDatabase,
    recreateDatabases,
    seedLibrary,
    SOURCE_DATABASE,
    summarizeDatabase,
    TARGET_DATABASE,
} from "./backupRestoreSmoke/database";
import {
    assertSmoke,
    type BackendProcess,
    expectJson,
    fetchBounded,
    printLogTail,
    randomSecret,
    redisDatabaseUrl,
    requiredEnv,
    startBackend,
    stopBackend,
    waitForReady,
} from "./backupRestoreSmoke/support";
import {
    assertRestoreSummary,
    downloadBackup,
    loginAndVerify,
    registerAndSeedApi,
    startRestore,
    uploadArchive,
    verifyRestartBarrier,
    waitForRestore,
} from "./backupRestoreSmoke/httpFlow";

const SOURCE_PORT = 3101;
const TARGET_PORT = 3102;

interface SmokeContext {
    backendRoot: string;
    tempRoot: string;
    logDir: string;
    adminUrl: string;
    redisUrl: string;
    sourceUrl: string;
    targetUrl: string;
}

interface BackupArtifact {
    archivePath: string;
    expectedSummary: { tables: number; rows: number };
    sizeBytes: number;
    sourceToken: string;
}

interface ProcessState {
    source: BackendProcess | null;
    target: BackendProcess | null;
}

function backendEnvironment(
    database: string,
    redis: string,
    port: number,
    runtimeRoot: string,
): NodeJS.ProcessEnv {
    const sessionSecret = randomSecret();
    const settingsEncryptionKey = randomSecret();
    const internalApiSecret = randomSecret();
    return {
        ...process.env,
        NODE_ENV: "production",
        BACKEND_PROCESS_ROLE: "api",
        PORT: String(port),
        DATABASE_URL: database,
        REDIS_URL: redis,
        SESSION_SECRET: sessionSecret,
        JWT_SECRET: sessionSecret,
        SETTINGS_ENCRYPTION_KEY: settingsEncryptionKey,
        INTERNAL_API_SECRET: internalApiSecret,
        MUSIC_PATH: path.join(runtimeRoot, "music"),
        TRANSCODE_CACHE_PATH: path.join(runtimeRoot, "cache", "transcodes"),
        SECURE_COOKIES: "false",
        ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        ADMIN_RESET_PASSWORD: "",
        LOCAL_LOGIN_ENABLED: "true",
        OIDC_ENABLED: "false",
        SECRETS_DB_ONLY: "false",
        AUDIO_ANALYSIS_ENABLED: "false",
        DISCOVERY_ENABLED: "false",
        AUTO_PLAYLISTS_ENABLED: "false",
        FEATURE_REQUESTS: "false",
        CATALOG_PERSISTENCE: "off",
        ENABLE_ENV_FILE_SYNC: "false",
        LOG_LEVEL: "info",
    };
}

async function prepareContext(): Promise<SmokeContext> {
    const backendRoot = path.resolve(__dirname, "..");
    const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "soundspan-backup-restore-smoke-"),
    );
    const logDir =
        process.env.SMOKE_LOG_DIR?.trim() || path.join(tempRoot, "logs");
    await fs.mkdir(logDir, { recursive: true });
    const adminUrl = requiredEnv("SMOKE_ADMIN_DATABASE_URL");
    const redisUrl = requiredEnv("SMOKE_REDIS_URL");
    return {
        backendRoot,
        tempRoot,
        logDir,
        adminUrl,
        redisUrl,
        sourceUrl: databaseUrl(adminUrl, SOURCE_DATABASE),
        targetUrl: databaseUrl(adminUrl, TARGET_DATABASE),
    };
}

async function prepareDatabases(context: SmokeContext): Promise<void> {
    await recreateDatabases(context.adminUrl);
    await migrateDatabase(context.backendRoot, context.sourceUrl);
    await migrateDatabase(context.backendRoot, context.targetUrl);
}

async function createSourceBackup(
    context: SmokeContext,
    sourceLog: string,
    processes: ProcessState,
): Promise<BackupArtifact> {
    const baseUrl = `http://127.0.0.1:${SOURCE_PORT}`;
    const runtimeRoot = path.join(context.tempRoot, "a");
    const env = backendEnvironment(
        context.sourceUrl,
        redisDatabaseUrl(context.redisUrl, 1),
        SOURCE_PORT,
        runtimeRoot,
    );
    await fs.mkdir(path.join(runtimeRoot, "music"), { recursive: true });
    processes.source = startBackend(context.backendRoot, env, sourceLog);
    await waitForReady(baseUrl, processes.source);
    const sourceToken = await registerAndSeedApi(baseUrl);
    await seedLibrary(context.sourceUrl);
    const expectedSummary = await summarizeDatabase(context.sourceUrl);
    const archivePath = path.join(context.tempRoot, "smoke.soundspan-backup");
    const sizeBytes = await downloadBackup(baseUrl, sourceToken, archivePath);
    await stopBackend(processes.source);
    processes.source = null;
    return { archivePath, expectedSummary, sizeBytes, sourceToken };
}

async function restoreTarget(
    context: SmokeContext,
    targetLog: string,
    artifact: BackupArtifact,
    processes: ProcessState,
): Promise<void> {
    const baseUrl = `http://127.0.0.1:${TARGET_PORT}`;
    const runtimeRoot = path.join(context.tempRoot, "b");
    const env = backendEnvironment(
        context.targetUrl,
        redisDatabaseUrl(context.redisUrl, 2),
        TARGET_PORT,
        runtimeRoot,
    );
    await fs.mkdir(path.join(runtimeRoot, "music"), { recursive: true });
    processes.target = startBackend(context.backendRoot, env, targetLog);
    await waitForReady(baseUrl, processes.target);
    const initialStatus = await expectJson(
        await fetchBounded(`${baseUrl}/api/restore/status`),
        200,
    );
    assertSmoke(
        initialStatus.available === true,
        "Restore was unavailable on the fresh target",
    );
    const uploadId = await uploadArchive(
        baseUrl,
        artifact.archivePath,
        artifact.sizeBytes,
    );
    await startRestore(baseUrl, uploadId);
    assertRestoreSummary(
        await waitForRestore(baseUrl),
        artifact.expectedSummary,
    );
    await verifyRestartBarrier(baseUrl, artifact.sourceToken);
    await stopBackend(processes.target);
    processes.target = startBackend(context.backendRoot, env, targetLog);
    await waitForReady(baseUrl, processes.target);
    await loginAndVerify(baseUrl);
    await compareDatabases(context.sourceUrl, context.targetUrl);
}

async function runSmoke(): Promise<void> {
    const context = await prepareContext();
    const sourceLog = path.join(context.logDir, "backend-a.log");
    const targetLog = path.join(context.logDir, "backend-b.log");
    const processes: ProcessState = { source: null, target: null };
    try {
        await prepareDatabases(context);
        const artifact = await createSourceBackup(
            context,
            sourceLog,
            processes,
        );
        await restoreTarget(context, targetLog, artifact, processes);
        process.stdout.write("Backup/restore smoke completed successfully.\n");
    } catch (error) {
        await Promise.all([printLogTail(sourceLog), printLogTail(targetLog)]);
        throw error;
    } finally {
        await Promise.all([
            stopBackend(processes.source),
            stopBackend(processes.target),
        ]);
    }
}

void runSmoke().catch((error: unknown) => {
    process.stderr.write(
        `Backup/restore smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
});

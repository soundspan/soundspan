import { spawn, type ChildProcessByStdio } from "child_process";
import fs from "fs/promises";
import path from "path";
import type { Readable } from "stream";
import type { BackupMigration } from "./backupFormat";
import { RestoreMigrationError } from "./backupErrors";
import { buildChildProcessEnvironment } from "../../config";

const OUTPUT_TAIL_BYTES = 64 * 1024;
const MIGRATION_TIMEOUT_MS = 30 * 60 * 1000;
const BACKEND_ROOT = path.resolve(__dirname, "../../..");
const PRISMA_BIN = path.join(BACKEND_ROOT, "node_modules", ".bin", "prisma");
const REAL_CONFIG = path.join(BACKEND_ROOT, "prisma.config.ts");
const REAL_SCHEMA = path.join(BACKEND_ROOT, "prisma", "schema.prisma");
const REAL_MIGRATIONS = path.join(BACKEND_ROOT, "prisma", "migrations");

function appendTail(
    current: Buffer<ArrayBufferLike>,
    chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> {
    const combined = Buffer.concat([current, chunk]);
    return combined.subarray(Math.max(0, combined.length - OUTPUT_TAIL_BYTES));
}

function startPrisma(
    configPath: string,
    databaseUrl: string,
): ChildProcessByStdio<null, Readable, Readable> {
    return spawn(PRISMA_BIN, ["migrate", "deploy", "--config", configPath], {
        cwd: BACKEND_ROOT,
        shell: false,
        env: buildChildProcessEnvironment({ DATABASE_URL: databaseUrl }),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
    });
}

function killPrismaGroup(
    child: ChildProcessByStdio<null, Readable, Readable>,
): void {
    if (child.pid === undefined) return;
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        // The process may already have exited before cancellation reached it.
    }
}

function migrationCloseError(
    code: number | null,
    abortReason: unknown,
    timedOut: boolean,
    tail: Buffer<ArrayBufferLike>,
    databaseUrl: string,
): Error | null {
    if (abortReason) {
        return abortReason instanceof Error
            ? abortReason
            : new Error("Migration cancelled");
    }
    if (timedOut) {
        return new RestoreMigrationError("Migration process timed out");
    }
    if (code === 0) return null;
    return new RestoreMigrationError(
        tail.toString("utf8").replaceAll(databaseUrl, "[REDACTED]"),
    );
}

function observePrismaOutput(
    child: ChildProcessByStdio<null, Readable, Readable>,
    observe: (chunk: Buffer) => void,
): void {
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
}

async function runPrisma(
    configPath: string,
    databaseUrl: string,
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const child = startPrisma(configPath, databaseUrl);
        let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let abortReason: unknown;
        let timedOut = false;
        let settled = false;
        observePrismaOutput(child, (chunk) => {
            tail = appendTail(tail, chunk);
        });
        const timeout = setTimeout(() => {
            timedOut = true;
            killPrismaGroup(child);
        }, MIGRATION_TIMEOUT_MS);
        timeout.unref();
        const cleanup = (): void => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", onAbort);
        };
        const rejectOnce = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onAbort = (): void => {
            if (abortReason) return;
            abortReason = signal?.reason ?? new Error("Migration cancelled");
            killPrismaGroup(child);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        child.once("error", (cause) => {
            rejectOnce(
                new RestoreMigrationError("Process could not start", { cause }),
            );
        });
        child.once("close", (code) => {
            if (settled) return;
            settled = true;
            cleanup();
            const error = migrationCloseError(
                code,
                abortReason,
                timedOut,
                tail,
                databaseUrl,
            );
            if (error) reject(error);
            else resolve();
        });
    });
}

function generatedConfig(migrationsPath: string): string {
    const prismaConfigModule = path.join(
        BACKEND_ROOT,
        "node_modules",
        "prisma",
        "config.js",
    );
    return `import { defineConfig, env } from ${JSON.stringify(prismaConfigModule)};
export default defineConfig({
  schema: ${JSON.stringify(REAL_SCHEMA)},
  migrations: { path: ${JSON.stringify(migrationsPath)} },
  datasource: { url: env("DATABASE_URL") },
});
`;
}

/** Create a byte-for-byte migration subset and deploy only the backup schema. */
export async function replayBackupMigrations(
    stagingDir: string,
    migrations: BackupMigration[],
    databaseUrl: string,
    signal?: AbortSignal,
): Promise<string> {
    const replayDir = path.join(stagingDir, "migration-replay");
    const migrationDir = path.join(replayDir, "migrations");
    await fs.rm(replayDir, { recursive: true, force: true });
    await fs.mkdir(migrationDir, { recursive: true });
    await fs.copyFile(
        path.join(REAL_MIGRATIONS, "migration_lock.toml"),
        path.join(migrationDir, "migration_lock.toml"),
    );
    for (const migration of migrations.slice(0, 10_000)) {
        await fs.cp(
            path.join(REAL_MIGRATIONS, migration.name),
            path.join(migrationDir, migration.name),
            { recursive: true },
        );
    }
    const configPath = path.join(replayDir, "prisma.config.ts");
    await fs.writeFile(configPath, generatedConfig(migrationDir), {
        mode: 0o600,
    });
    await runPrisma(configPath, databaseUrl, signal);
    return replayDir;
}

/** Deploy the image's complete migration history. */
export async function deployCurrentMigrations(
    databaseUrl: string,
    signal?: AbortSignal,
): Promise<void> {
    await runPrisma(REAL_CONFIG, databaseUrl, signal);
}

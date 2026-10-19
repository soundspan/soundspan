import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
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

async function runPrisma(
    configPath: string,
    databaseUrl: string,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            PRISMA_BIN,
            ["migrate", "deploy", "--config", configPath],
            {
                cwd: BACKEND_ROOT,
                shell: false,
                env: buildChildProcessEnvironment({
                    DATABASE_URL: databaseUrl,
                }),
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        child.stdout.on("data", (chunk: Buffer) => {
            tail = appendTail(tail, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            tail = appendTail(tail, chunk);
        });
        const timeout = setTimeout(
            () => child.kill("SIGKILL"),
            MIGRATION_TIMEOUT_MS,
        );
        timeout.unref();
        child.once("error", (cause) => {
            clearTimeout(timeout);
            reject(
                new RestoreMigrationError("Process could not start", { cause }),
            );
        });
        child.once("close", (code) => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new RestoreMigrationError(
                    tail.toString("utf8").replaceAll(databaseUrl, "[REDACTED]"),
                ),
            );
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
    await runPrisma(configPath, databaseUrl);
    return replayDir;
}

/** Deploy the image's complete migration history. */
export async function deployCurrentMigrations(
    databaseUrl: string,
): Promise<void> {
    await runPrisma(REAL_CONFIG, databaseUrl);
}

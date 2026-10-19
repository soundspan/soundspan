import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

const spawn = jest.fn();

jest.mock("child_process", () => ({ spawn }));
jest.mock("../../../config", () => ({
    buildChildProcessEnvironment: (overrides: NodeJS.ProcessEnv) => ({
        SAFE_PARENT: "yes",
        ...overrides,
    }),
}));

interface FakeChild extends EventEmitter {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: jest.Mock;
}

function childProcess(onKill?: (child: FakeChild) => void): FakeChild {
    const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: jest.fn(() => {
            onKill?.(child);
            return true;
        }),
    });
    return child;
}

describe("restore migration replay", () => {
    let stagingDir: string;

    beforeEach(async () => {
        jest.resetModules();
        jest.clearAllMocks();
        stagingDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "migration-replay-"),
        );
    });

    afterEach(async () => {
        jest.useRealTimers();
        await fs.rm(stagingDir, { recursive: true, force: true });
    });

    it("copies only image migration entries and writes a restricted generated config", async () => {
        const child = childProcess();
        spawn.mockImplementation(() => {
            setImmediate(() => child.emit("close", 0));
            return child;
        });
        const migrationNames = (
            await fs.readdir(
                path.resolve(__dirname, "../../../../prisma/migrations"),
                {
                    withFileTypes: true,
                },
            )
        )
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
            .slice(0, 2);
        const { replayBackupMigrations } =
            await import("../restoreMigrationReplay");

        const replayDir = await replayBackupMigrations(
            stagingDir,
            migrationNames.map((name) => ({ name, checksum: "archive-value" })),
            "postgresql://restore-secret@database/soundspan",
        );

        await expect(
            fs.readFile(
                path.join(replayDir, "migrations", "migration_lock.toml"),
                "utf8",
            ),
        ).resolves.toContain("provider");
        await expect(
            fs.readdir(path.join(replayDir, "migrations")),
        ).resolves.toEqual(
            expect.arrayContaining(["migration_lock.toml", ...migrationNames]),
        );
        const configPath = path.join(replayDir, "prisma.config.ts");
        const generated = await fs.readFile(configPath, "utf8");
        expect(generated).toContain(
            JSON.stringify(path.join(replayDir, "migrations")),
        );
        expect(generated).toContain("schema.prisma");
        expect(generated).toContain('env("DATABASE_URL")');
        expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
        expect(spawn).toHaveBeenCalledWith(
            expect.stringContaining("node_modules/.bin/prisma"),
            ["migrate", "deploy", "--config", configPath],
            expect.objectContaining({
                shell: false,
                env: expect.objectContaining({
                    SAFE_PARENT: "yes",
                    DATABASE_URL:
                        "postgresql://restore-secret@database/soundspan",
                }),
            }),
        );
    });

    it("reports a redacted bounded output tail for non-zero exits", async () => {
        const child = childProcess();
        const databaseUrl = "postgresql://secret@database/soundspan";
        spawn.mockImplementation(() => {
            setImmediate(() => {
                child.stdout.write(`old-${"x".repeat(70 * 1024)}`);
                child.stderr.write(`failed ${databaseUrl}`);
                child.emit("close", 1);
            });
            return child;
        });
        const { deployCurrentMigrations } =
            await import("../restoreMigrationReplay");

        const error = await deployCurrentMigrations(databaseUrl).catch(
            (failure: unknown) => failure,
        );
        expect(error).toMatchObject({
            code: "RESTORE_MIGRATION_FAILED",
            outputTail: expect.not.stringContaining(databaseUrl),
        });
        expect((error as { outputTail: string }).outputTail).toContain(
            "[REDACTED]",
        );
        expect(
            Buffer.byteLength((error as { outputTail: string }).outputTail),
        ).toBeLessThanOrEqual(64 * 1024);
    });

    it("kills and waits for Prisma when migration execution is cancelled", async () => {
        const child = childProcess((process) => {
            queueMicrotask(() => process.emit("close", null, "SIGKILL"));
        });
        spawn.mockReturnValue(child);
        const controller = new AbortController();
        const { deployCurrentMigrations } =
            await import("../restoreMigrationReplay");

        const pending = deployCurrentMigrations(
            "postgresql://database/soundspan",
            controller.signal,
        );
        controller.abort(new Error("connection lost"));

        await expect(pending).rejects.toThrow("connection lost");
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("kills a migration that exceeds the fixed timeout", async () => {
        jest.useFakeTimers();
        const child = childProcess((process) => {
            queueMicrotask(() => process.emit("close", null, "SIGKILL"));
        });
        spawn.mockReturnValue(child);
        const { deployCurrentMigrations } =
            await import("../restoreMigrationReplay");
        const pending = deployCurrentMigrations(
            "postgresql://database/soundspan",
        );

        await jest.advanceTimersByTimeAsync(30 * 60 * 1000);

        await expect(pending).rejects.toMatchObject({
            code: "RESTORE_MIGRATION_FAILED",
            outputTail: expect.stringContaining("timed out"),
        });
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("wraps Prisma process start failures", async () => {
        const child = childProcess();
        spawn.mockImplementation(() => {
            setImmediate(() => child.emit("error", new Error("spawn failed")));
            return child;
        });
        const { deployCurrentMigrations } =
            await import("../restoreMigrationReplay");

        await expect(
            deployCurrentMigrations("postgresql://database/soundspan"),
        ).rejects.toMatchObject({
            code: "RESTORE_MIGRATION_FAILED",
            outputTail: "Process could not start",
            cause: expect.objectContaining({ message: "spawn failed" }),
        });
    });
});

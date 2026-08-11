import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const ENTRYPOINT_PATH = path.resolve(__dirname, "../../docker-entrypoint.sh");
const STRONG_SECRET = "s".repeat(32);
type SecretName =
    | "SESSION_SECRET"
    | "SETTINGS_ENCRYPTION_KEY"
    | "INTERNAL_API_SECRET";

function deleteUndefinedOverride(
    env: NodeJS.ProcessEnv,
    overrides: Record<string, string | undefined>,
    name: SecretName,
): void {
    if (overrides[name] === undefined && name in overrides) delete env[name];
}

describe("backend Docker entrypoint secret validation", () => {
    const commandDirectory = mkdtempSync(
        path.join(tmpdir(), "soundspan-entrypoint-test-"),
    );

    beforeAll(() => {
        const idPath = path.join(commandDirectory, "id");
        const sleepPath = path.join(commandDirectory, "sleep");
        writeFileSync(idPath, "#!/bin/sh\necho 1000\n");
        writeFileSync(sleepPath, "#!/bin/sh\nexit 0\n");
        chmodSync(idPath, 0o700);
        chmodSync(sleepPath, 0o700);
    });

    afterAll(() => {
        rmSync(commandDirectory, { recursive: true, force: true });
    });

    function runEntrypoint(
        overrides: Record<string, string | undefined>,
    ): ReturnType<typeof spawnSync> {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: `${commandDirectory}:${process.env.PATH ?? ""}`,
            RUN_DB_MIGRATIONS_ON_STARTUP: "false",
            PRISMA_GENERATE_ON_STARTUP: "false",
            REDIS_FLUSH_ON_STARTUP: "false",
            SESSION_SECRET: STRONG_SECRET,
            SETTINGS_ENCRYPTION_KEY: STRONG_SECRET,
            INTERNAL_API_SECRET: STRONG_SECRET,
            ...overrides,
        };

        deleteUndefinedOverride(env, overrides, "SESSION_SECRET");
        deleteUndefinedOverride(env, overrides, "SETTINGS_ENCRYPTION_KEY");
        deleteUndefinedOverride(env, overrides, "INTERNAL_API_SECRET");

        return spawnSync("sh", [ENTRYPOINT_PATH, "true"], {
            env,
            encoding: "utf8",
            timeout: 5_000,
        });
    }

    it.each(["SETTINGS_ENCRYPTION_KEY", "INTERNAL_API_SECRET"])(
        "rejects a %s shorter than 32 characters",
        (name) => {
            const result = runEntrypoint({ [name]: "w".repeat(31) });

            expect(result.status).toBe(1);
            expect(result.stderr).toContain(
                `${name} is missing, uses the published default, or is shorter than 32 characters.`,
            );
            expect(result.stderr).not.toContain("w".repeat(31));
        },
    );

    it.each(["SETTINGS_ENCRYPTION_KEY", "INTERNAL_API_SECRET"])(
        "requires %s",
        (name) => {
            const result = runEntrypoint({ [name]: undefined });

            expect(result.status).toBe(1);
            expect(result.stderr).toContain(`${name} is missing`);
        },
    );

    it.each([
        ["SETTINGS_ENCRYPTION_KEY", "default-encryption-key-change-me"],
        ["INTERNAL_API_SECRET", "soundspan-internal-secret-change-me"],
    ])("rejects the published %s default", (name, value) => {
        const result = runEntrypoint({ [name]: value });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${name} is missing`);
        expect(result.stderr).not.toContain(value);
    });

    it("accepts critical secrets at the 32-character boundary", () => {
        const result = runEntrypoint({});

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
    });
});

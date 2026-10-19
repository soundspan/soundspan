import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    evaluateRestoreCompatibility,
    readImageMigrations,
} from "../restoreCompatibility";

const a = { name: "001_a", checksum: "aaa" };
const b = { name: "002_b", checksum: "bbb" };

describe("restore compatibility", () => {
    it("accepts the same migration set", () => {
        expect(evaluateRestoreCompatibility([a, b], [a, b])).toEqual({
            outcome: "ok",
            migrationsToReplay: [a, b],
            pendingAfterLoad: 0,
            checksumWarnings: [],
        });
    });

    it("accepts an older backup and counts pending migrations", () => {
        const imageEntry = { ...a };
        const result = evaluateRestoreCompatibility([a], [imageEntry, b]);
        expect(result).toEqual({
            outcome: "ok",
            migrationsToReplay: [imageEntry],
            pendingAfterLoad: 1,
            checksumWarnings: [],
        });
        if (result.outcome === "ok") {
            expect(result.migrationsToReplay[0]).toBe(imageEntry);
        }
    });

    it("rejects a migration absent from the image", () => {
        expect(
            evaluateRestoreCompatibility(
                [a, { name: "003_c", checksum: "c" }],
                [a, b],
            ).outcome,
        ).toBe("BACKUP_NEWER_THAN_APP");
    });

    it("accepts checksum drift by name and reports a warning", () => {
        expect(
            evaluateRestoreCompatibility([{ ...a, checksum: "wrong" }], [a, b]),
        ).toEqual({
            outcome: "ok",
            migrationsToReplay: [a],
            pendingAfterLoad: 1,
            checksumWarnings: [a.name],
        });
    });

    it("accepts an empty legacy checksum and deduplicates names", () => {
        expect(
            evaluateRestoreCompatibility([{ ...a, checksum: "" }, a], [a, b]),
        ).toEqual({
            outcome: "ok",
            migrationsToReplay: [a],
            pendingAfterLoad: 1,
            checksumWarnings: [a.name],
        });
    });

    it("reads sorted migration directories and hashes migration bytes", async () => {
        const directory = await fs.mkdtemp(
            path.join(os.tmpdir(), "image-migrations-"),
        );
        try {
            await fs.mkdir(path.join(directory, "002_second"));
            await fs.mkdir(path.join(directory, "001_first"));
            await fs.writeFile(path.join(directory, "README"), "ignored");
            await fs.writeFile(
                path.join(directory, "002_second", "migration.sql"),
                "SELECT 2;\n",
            );
            await fs.writeFile(
                path.join(directory, "001_first", "migration.sql"),
                "SELECT 1;\n",
            );

            await expect(readImageMigrations(directory)).resolves.toEqual([
                {
                    name: "001_first",
                    checksum: crypto
                        .createHash("sha256")
                        .update("SELECT 1;\n")
                        .digest("hex"),
                },
                {
                    name: "002_second",
                    checksum: crypto
                        .createHash("sha256")
                        .update("SELECT 2;\n")
                        .digest("hex"),
                },
            ]);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});

import { evaluateRestoreCompatibility } from "../restoreCompatibility";

const a = { name: "001_a", checksum: "aaa" };
const b = { name: "002_b", checksum: "bbb" };

describe("restore compatibility", () => {
    it("accepts the same migration set", () => {
        expect(evaluateRestoreCompatibility([a, b], [a, b])).toEqual({
            outcome: "ok",
            migrationsToReplay: [a, b],
            pendingAfterLoad: 0,
        });
    });

    it("accepts an older backup and counts pending migrations", () => {
        const imageEntry = { ...a };
        const result = evaluateRestoreCompatibility([a], [imageEntry, b]);
        expect(result).toEqual({
            outcome: "ok",
            migrationsToReplay: [imageEntry],
            pendingAfterLoad: 1,
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

    it("rejects a checksum mismatch", () => {
        expect(
            evaluateRestoreCompatibility([{ ...a, checksum: "wrong" }], [a, b])
                .outcome,
        ).toBe("BACKUP_MIGRATION_CHECKSUM_MISMATCH");
    });
});

import {
    BACKUP_FORMAT_MAGIC,
    BACKUP_FORMAT_VERSION,
    backupHeaderSchema,
    encodeBackupRecord,
    parseBackupRecord,
    type BackupHeader,
} from "../backupFormat";

const header: BackupHeader = {
    type: "header",
    magic: BACKUP_FORMAT_MAGIC,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: "2026-10-19T12:00:00.000Z",
    appVersion: "2.6.1",
    wrappedKey: {
        salt: "c2FsdA==",
        iv: "aXZpdml2aXZpdml2",
        tag: "dGFn",
        ciphertext: "Y2lwaGVydGV4dA==",
    },
    migrations: [{ name: "20260101000000_init", checksum: "abc" }],
    tables: [
        {
            name: "User",
            columns: [{ name: "id", type: "text" }],
            rowCount: 1,
        },
    ],
    sequences: [],
};

describe("backup format", () => {
    it("accepts a valid header and round-trips record framing", () => {
        expect(backupHeaderSchema.parse(header)).toEqual(header);
        expect(parseBackupRecord(encodeBackupRecord(header).trim())).toEqual(
            header,
        );
    });

    it("rejects a wrong magic or version", () => {
        expect(() =>
            backupHeaderSchema.parse({ ...header, magic: "other" }),
        ).toThrow();
        expect(() =>
            backupHeaderSchema.parse({ ...header, formatVersion: 2 }),
        ).toThrow();
    });

    it("does not accept a cleartext pepper fingerprint", () => {
        expect(() =>
            backupHeaderSchema.parse({
                ...header,
                pepperFingerprint: "deadbeef",
            }),
        ).toThrow();
    });

    it("rejects oversized bounded fields", () => {
        expect(() =>
            backupHeaderSchema.parse({
                ...header,
                appVersion: "x".repeat(257),
            }),
        ).toThrow();
        expect(() =>
            backupHeaderSchema.parse({
                ...header,
                migrations: Array.from({ length: 10_001 }, (_, index) => ({
                    name: String(index),
                    checksum: "a",
                })),
            }),
        ).toThrow();
    });

    it.each(["../escape", "nested/name", "migration name", "x".repeat(256)])(
        "rejects unsafe migration name %s",
        (name) => {
            expect(() =>
                backupHeaderSchema.parse({
                    ...header,
                    migrations: [{ name, checksum: "abc" }],
                }),
            ).toThrow();
        },
    );
});

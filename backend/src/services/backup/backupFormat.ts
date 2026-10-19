import { z } from "zod";
import { BackupFormatError } from "./backupErrors";

export const BACKUP_FORMAT_MAGIC = "soundspan-backup" as const;
export const BACKUP_FORMAT_VERSION = 1 as const;
export const MAX_BACKUP_RECORD_BYTES = 64 * 1024 * 1024;

const boundedString = z.string().min(1).max(10_000);
const base64String = z
    .string()
    .min(1)
    .max(100_000)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/);
const safeCount = z.number().int().safe().nonnegative();

export const wrappedEncryptionKeySchema = z
    .object({
        salt: base64String,
        iv: base64String,
        tag: base64String,
        ciphertext: base64String,
    })
    .strict();

export type WrappedEncryptionKey = z.infer<typeof wrappedEncryptionKeySchema>;

export const migrationEntrySchema = z
    .object({
        name: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
        checksum: boundedString,
    })
    .strict();

export const backupColumnSchema = z
    .object({ name: boundedString, type: boundedString })
    .strict();

export const backupTableSchema = z
    .object({
        name: boundedString,
        columns: z.array(backupColumnSchema).max(10_000),
        rowCount: safeCount,
    })
    .strict();

export const backupSequenceSchema = z
    .object({
        name: boundedString,
        table: boundedString,
        column: boundedString,
        lastValue: z.string().max(100),
        isCalled: z.boolean(),
    })
    .strict();

export const backupHeaderSchema = z
    .object({
        type: z.literal("header"),
        magic: z.literal(BACKUP_FORMAT_MAGIC),
        formatVersion: z.literal(BACKUP_FORMAT_VERSION),
        createdAt: z.string().datetime(),
        appVersion: z.string().min(1).max(256),
        pepperFingerprint: z.string().max(256).nullable(),
        wrappedKey: wrappedEncryptionKeySchema,
        migrations: z.array(migrationEntrySchema).max(10_000),
        tables: z.array(backupTableSchema).max(10_000),
        sequences: z.array(backupSequenceSchema).max(10_000),
    })
    .strict()
    .superRefine((header, context) => {
        const migrationNames = new Set(
            header.migrations.map((entry) => entry.name),
        );
        const tableNames = new Set(header.tables.map((table) => table.name));
        const sequenceNames = new Set(
            header.sequences.map((entry) => entry.name),
        );
        const totalRows = header.tables.reduce(
            (sum, table) => sum + table.rowCount,
            0,
        );
        const hasDuplicateColumns = header.tables.some(
            (table) =>
                new Set(table.columns.map((column) => column.name)).size !==
                table.columns.length,
        );
        if (
            migrationNames.size !== header.migrations.length ||
            tableNames.size !== header.tables.length ||
            sequenceNames.size !== header.sequences.length ||
            hasDuplicateColumns ||
            !Number.isSafeInteger(totalRows)
        ) {
            context.addIssue({
                code: "custom",
                message:
                    "Backup header contains duplicate or unsafe inventory values",
            });
        }
    });

export const backupRowsSchema = z
    .object({
        type: z.literal("rows"),
        table: boundedString,
        rowCount: z.number().int().min(1).max(1_000),
        rows: z.string().min(2).max(MAX_BACKUP_RECORD_BYTES),
    })
    .strict();

export const backupEndSchema = z.object({ type: z.literal("end") }).strict();
export const backupRecordSchema = z.discriminatedUnion("type", [
    backupHeaderSchema,
    backupRowsSchema,
    backupEndSchema,
]);

export type BackupMigration = z.infer<typeof migrationEntrySchema>;
export type BackupTable = z.infer<typeof backupTableSchema>;
export type BackupSequence = z.infer<typeof backupSequenceSchema>;
export type BackupHeader = z.infer<typeof backupHeaderSchema>;
export type BackupRowsRecord = z.infer<typeof backupRowsSchema>;
export type BackupRecord = z.infer<typeof backupRecordSchema>;

export function encodeBackupRecord(record: BackupRecord): string {
    return `${JSON.stringify(backupRecordSchema.parse(record))}\n`;
}

export function parseBackupRecord(line: string): BackupRecord {
    try {
        return backupRecordSchema.parse(JSON.parse(line) as unknown);
    } catch (cause) {
        throw new BackupFormatError("Backup record is invalid", { cause });
    }
}

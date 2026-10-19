import assert from "node:assert/strict";
import { test } from "node:test";
import {
    MAX_BACKUP_PASSPHRASE_LENGTH,
    chunkRange,
    isRestoreRunning,
    isRetryableChunkError,
    readApiErrorCode,
    restoreErrorMessage,
    restoreHoldsFirstRun,
    restoreProgressPercent,
    validateBackupPassphrase,
} from "../../features/backup/backupRestoreModel";
import {
    flowFromStartError,
    flowFromStatus,
} from "../../features/backup/restoreFlowModel";
import type { RestoreStatus } from "../../lib/api/backup";

function apiError(status: number, code?: string, message = "failed"): Error {
    const error = new Error(message) as Error & {
        status: number;
        data: { code?: string };
    };
    error.status = status;
    error.data = code ? { code } : {};
    return error;
}

function status(overrides: Partial<RestoreStatus>): RestoreStatus {
    return {
        available: false,
        state: "idle",
        progress: null,
        error: null,
        summary: null,
        restartRequired: false,
        ...overrides,
    };
}

test("validateBackupPassphrase enforces length and confirmation", () => {
    assert.match(validateBackupPassphrase("short") ?? "", /at least 12/);
    assert.equal(validateBackupPassphrase("twelve chars"), null);
    assert.match(
        validateBackupPassphrase(
            "x".repeat(MAX_BACKUP_PASSPHRASE_LENGTH + 1),
        ) ?? "",
        /at most/,
    );
    assert.match(
        validateBackupPassphrase("twelve chars", "twelve charz") ?? "",
        /don't match/,
    );
    assert.equal(
        validateBackupPassphrase("twelve chars", "twelve chars"),
        null,
    );
});

test("chunkRange covers the file exactly, with a short last chunk", () => {
    assert.deepEqual(chunkRange(0, 4, 10), { start: 0, end: 4 });
    assert.deepEqual(chunkRange(1, 4, 10), { start: 4, end: 8 });
    assert.deepEqual(chunkRange(2, 4, 10), { start: 8, end: 10 });
});

test("restore running states and first-run hold", () => {
    assert.equal(isRestoreRunning("loading"), true);
    assert.equal(isRestoreRunning("idle"), false);
    assert.equal(isRestoreRunning("complete"), false);
    assert.equal(restoreHoldsFirstRun(status({ state: "migrating" })), true);
    assert.equal(
        restoreHoldsFirstRun(
            status({ state: "complete", restartRequired: true }),
        ),
        true,
    );
    assert.equal(restoreHoldsFirstRun(status({ state: "complete" })), false);
    assert.equal(restoreHoldsFirstRun(status({ state: "failed" })), false);
});

test("restoreErrorMessage maps known codes and falls back otherwise", () => {
    assert.match(
        restoreErrorMessage("BACKUP_PASSPHRASE_INVALID", "x"),
        /passphrase doesn't match/,
    );
    assert.equal(
        restoreErrorMessage("SOMETHING_NEW", "server text"),
        "server text",
    );
    assert.equal(restoreErrorMessage(undefined, "server text"), "server text");
});

test("restoreProgressPercent is bounded and null before loading", () => {
    assert.equal(restoreProgressPercent(null), null);
    const base = { completedTables: 0, totalTables: 1 };
    assert.equal(
        restoreProgressPercent({ ...base, completedRows: 0, totalRows: 0 }),
        null,
    );
    assert.equal(
        restoreProgressPercent({ ...base, completedRows: 1, totalRows: 3 }),
        33,
    );
    assert.equal(
        restoreProgressPercent({ ...base, completedRows: 9, totalRows: 3 }),
        100,
    );
});

test("readApiErrorCode reads only string codes from API errors", () => {
    assert.equal(
        readApiErrorCode(apiError(400, "BACKUP_FORMAT_INVALID")),
        "BACKUP_FORMAT_INVALID",
    );
    assert.equal(readApiErrorCode(new Error("plain")), undefined);
    assert.equal(readApiErrorCode("not an error"), undefined);
});

test("isRetryableChunkError retries only transient failures", () => {
    assert.equal(isRetryableChunkError(new TypeError("network down")), true);
    assert.equal(isRetryableChunkError(apiError(503)), true);
    assert.equal(isRetryableChunkError(apiError(429)), true);
    assert.equal(
        isRetryableChunkError(apiError(409, "RESTORE_UPLOAD_WRONG_REPLICA")),
        false,
    );
    assert.equal(isRetryableChunkError(apiError(404)), false);
    assert.equal(
        isRetryableChunkError(new DOMException("cancelled", "AbortError")),
        false,
    );
});

test("flowFromStatus maps server states to page steps", () => {
    assert.equal(flowFromStatus(status({ state: "idle" })).kind, "form");
    assert.equal(
        flowFromStatus(status({ state: "loading" })).kind,
        "restoring",
    );
    assert.equal(
        flowFromStatus(status({ state: "complete" })).kind,
        "complete",
    );
    const failed = flowFromStatus(
        status({
            state: "failed",
            error: {
                code: "BACKUP_SCHEMA_MISMATCH",
                message: "Tables differ.",
            },
        }),
    );
    assert.deepEqual(failed, {
        kind: "failed",
        message: "Tables differ.",
        freshInstallIntact: true,
    });
    const dirty = flowFromStatus(
        status({
            state: "failed",
            error: {
                code: "RESTORE_CLEANUP_FAILED",
                message: "Cleanup failed.",
            },
        }),
    );
    assert.equal(dirty.kind === "failed" && dirty.freshInstallIntact, false);
});

test("flowFromStartError keeps the upload only for a wrong passphrase", () => {
    const wrong = apiError(400, "BACKUP_PASSPHRASE_INVALID");
    assert.equal(flowFromStartError(wrong, true).kind, "passphrase");
    assert.equal(flowFromStartError(wrong, false).kind, "form");
    const newer = flowFromStartError(
        apiError(409, "BACKUP_NEWER_THAN_APP"),
        true,
    );
    assert.equal(newer.kind, "form");
    assert.match(
        newer.kind === "form" ? (newer.error ?? "") : "",
        /newer version/,
    );
});

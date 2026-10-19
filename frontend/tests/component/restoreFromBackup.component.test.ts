import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RestoreStatus, RestoreUploadSession } from "../../lib/api/backup";

/**
 * Behaviour tests for the first-run restore flow: the file goes up in the
 * chunks the server planned, the passphrase starts the restore, progress is
 * followed until the restart prompt; a wrong passphrase keeps the upload so
 * only the passphrase is retyped; a reload mid-restore resumes the progress
 * view; a failed restore says the fresh install is intact. `@/lib/api` is
 * the boundary mock.
 */

GlobalRegistrator.register({ url: "http://localhost/onboarding" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const idle: RestoreStatus = {
    available: true,
    state: "idle",
    progress: null,
    error: null,
    summary: null,
    restartRequired: false,
    upload: null,
};

let statusQueue: RestoreStatus[] = [];
let completeFailures: Error[] = [];
const uploadSession: RestoreUploadSession = {
    uploadId: "upload-7",
    chunkSizeBytes: 4,
    totalChunks: 3,
    expiresAt: "2030-01-01T00:00:00.000Z",
};
const getRestoreStatus = mock.fn(async () => statusQueue.shift() ?? idle);
const startRestoreUpload = mock.fn(async (_size: number) => uploadSession);
const uploadRestoreChunk = mock.fn(
    async (_id: string, _index: number, _chunk: Blob) => undefined,
);
const completeRestoreUpload = mock.fn(async (_id: string, _pass: string) => {
    const failure = completeFailures.shift();
    if (failure) throw failure;
    return {
        restoreId: "r1",
        backupCreatedAt: "2026-10-01T10:00:00.000Z",
        backupAppVersion: "2.6.1",
        appVersion: "2.7.0",
    };
});
const cancelRestoreUpload = mock.fn(async (_id: string) => undefined);
const cancelRestoreUploadOnExit = mock.fn((_id: string) => undefined);

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getRestoreStatus,
            startRestoreUpload,
            uploadRestoreChunk,
            completeRestoreUpload,
            cancelRestoreUpload,
            cancelRestoreUploadOnExit,
        },
    },
});
mock.module("@/lib/logger", {
    namedExports: {
        createFrontendLogger: () => ({
            error: () => undefined,
            warn: () => undefined,
            info: () => undefined,
            debug: () => undefined,
        }),
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    statusQueue = [];
    completeFailures = [];
    for (const fn of [
        getRestoreStatus,
        startRestoreUpload,
        uploadRestoreChunk,
        completeRestoreUpload,
        cancelRestoreUpload,
        cancelRestoreUploadOnExit,
    ]) {
        fn.mock.resetCalls();
    }
    document.body.replaceChildren();
});

/** Drain microtasks and the zero-delay status-check timer, a few rounds. */
async function flush(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

async function mountFlow() {
    const { RestoreFromBackup } =
        await import("../../features/backup/components/RestoreFromBackup");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(React.createElement(RestoreFromBackup, {}));
        await flush();
    });
    // Effects flush when the first act ends; the first status check runs on
    // a zero-delay timer queued by them.
    await React.act(async () => {
        await flush();
    });
    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

async function typePassphrase(value: string) {
    const element = document.getElementById("restore-passphrase");
    assert.ok(element instanceof HTMLInputElement, "Missing passphrase input");
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the input value setter");
    await React.act(async () => {
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        await flush();
    });
}

async function chooseFile(contents: string) {
    const element = document.getElementById("restore-file");
    assert.ok(element instanceof HTMLInputElement, "Missing file input");
    const file = new File([contents], "home.soundspan-backup");
    Object.defineProperty(element, "files", {
        configurable: true,
        value: [file],
    });
    await React.act(async () => {
        element.dispatchEvent(new Event("change", { bubbles: true }));
        await flush();
    });
}

async function clickButton(text: string) {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();
    });
}

test("uploads the planned chunks, starts the restore, and asks for a restart", async (t) => {
    statusQueue = [
        idle,
        {
            ...idle,
            available: false,
            state: "complete",
            restartRequired: true,
            summary: {
                backupCreatedAt: "2026-10-01T10:00:00.000Z",
                backupAppVersion: "2.6.1",
                appVersion: "2.7.0",
                tables: 70,
                rows: 1234,
                migrationsAppliedAfterLoad: 2,
                credentialsReencrypted: 5,
                credentialsUndecryptable: 0,
                apiKeysNeedReissue: true,
                migrationChecksumWarnings: 0,
            },
        },
    ];
    const harness = await mountFlow();
    t.after(harness.unmount);

    await chooseFile("abcdefghij");
    await typePassphrase("correct horse battery");
    await clickButton("Restore");

    assert.deepEqual(
        startRestoreUpload.mock.calls.map((call) => call.arguments[0]),
        [10],
    );
    assert.deepEqual(
        uploadRestoreChunk.mock.calls.map((call) => call.arguments[1]),
        [0, 1, 2],
    );
    assert.deepEqual(completeRestoreUpload.mock.calls[0]?.arguments, [
        "upload-7",
        "correct horse battery",
    ]);
    const text = harness.container.textContent ?? "";
    assert.match(text, /Restart soundspan to finish/);
    assert.match(text, /docker restart soundspan/);
    assert.match(text, /Upgraded the restored data to version 2\.7\.0/);
    assert.match(text, /API keys, linked devices/);
    assert.equal(cancelRestoreUpload.mock.callCount(), 0);
});

test("a wrong passphrase keeps the upload and only asks for the passphrase", async (t) => {
    completeFailures = [
        Object.assign(new Error("bad passphrase"), {
            status: 400,
            data: { code: "BACKUP_PASSPHRASE_INVALID" },
        }),
    ];
    statusQueue = [idle, { ...idle, state: "complete" }];
    const harness = await mountFlow();
    t.after(harness.unmount);

    await chooseFile("abcdefghij");
    await typePassphrase("wrong passphrase!!");
    await clickButton("Restore");

    assert.match(harness.container.textContent ?? "", /The file is uploaded/);
    assert.equal(cancelRestoreUpload.mock.callCount(), 0);

    await typePassphrase("correct horse battery");
    await clickButton("Restore");

    assert.equal(startRestoreUpload.mock.callCount(), 1);
    assert.equal(uploadRestoreChunk.mock.callCount(), 3);
    assert.deepEqual(
        completeRestoreUpload.mock.calls.map((call) => call.arguments),
        [
            ["upload-7", "wrong passphrase!!"],
            ["upload-7", "correct horse battery"],
        ],
    );
});

test("a newer-version backup is refused and the upload is discarded", async (t) => {
    completeFailures = [
        Object.assign(new Error("newer"), {
            status: 409,
            data: { code: "BACKUP_NEWER_THAN_APP" },
        }),
    ];
    const harness = await mountFlow();
    t.after(harness.unmount);

    await chooseFile("abcdefghij");
    await typePassphrase("correct horse battery");
    await clickButton("Restore");

    assert.match(harness.container.textContent ?? "", /newer version/);
    assert.deepEqual(
        cancelRestoreUpload.mock.calls.map((call) => call.arguments),
        [["upload-7"]],
    );
});

test("a reload during a restore shows its progress", async (t) => {
    statusQueue = [
        {
            ...idle,
            available: false,
            state: "loading",
            progress: {
                completedTables: 3,
                totalTables: 70,
                completedRows: 500,
                totalRows: 1000,
            },
        },
    ];
    const harness = await mountFlow();
    t.after(harness.unmount);

    const text = harness.container.textContent ?? "";
    assert.match(text, /Restoring your data/);
    assert.match(text, /500 of 1,000 rows/);
    assert.equal(document.getElementById("restore-file"), null);
});

test("a failed restore says the fresh install is intact", async (t) => {
    statusQueue = [
        {
            ...idle,
            state: "failed",
            error: {
                code: "BACKUP_SCHEMA_MISMATCH",
                message: "The backup's tables don't match this version.",
            },
        },
    ];
    const harness = await mountFlow();
    t.after(harness.unmount);

    const text = harness.container.textContent ?? "";
    assert.match(text, /tables don't match/);
    assert.match(text, /still a fresh install/);

    await clickButton("Try again");
    assert.ok(document.getElementById("restore-file"));
});

test("an upload another page started is shown with its expiry, not the form", async (t) => {
    statusQueue = [
        {
            ...idle,
            available: false,
            state: "uploading",
            upload: { expiresAt: "2030-01-01T12:10:00.000Z" },
        },
    ];
    const harness = await mountFlow();
    t.after(harness.unmount);

    assert.match(
        harness.container.textContent ?? "",
        /Another upload of a backup is in progress/,
    );
    assert.equal(document.getElementById("restore-file"), null);
});

test("leaving the page mid-upload cancels the upload on the server", async (t) => {
    let releaseChunk: () => void = () => undefined;
    uploadRestoreChunk.mock.mockImplementation(
        () =>
            new Promise<undefined>((resolve) => {
                releaseChunk = () => resolve(undefined);
            }),
    );
    t.after(() => uploadRestoreChunk.mock.restore());
    const harness = await mountFlow();
    t.after(harness.unmount);

    await chooseFile("abcdefghij");
    await typePassphrase("correct horse battery");
    await clickButton("Restore");
    window.dispatchEvent(new Event("pagehide"));

    assert.deepEqual(
        cancelRestoreUploadOnExit.mock.calls.map((call) => call.arguments),
        [["upload-7"]],
    );
    releaseChunk();
});

import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Behaviour tests for the admin Backup section: a valid, confirmed
 * passphrase mints the download session and then starts a native download of
 * the cookie-scoped path; invalid passphrases never reach the server; a busy
 * server is explained. `@/lib/api` is the boundary mock and anchor clicks are
 * recorded instead of navigating.
 */

GlobalRegistrator.register({ url: "http://localhost/admin" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let sessionFailure: Error | null = null;
const createBackupDownloadSession = mock.fn(async (_passphrase: string) => {
    if (sessionFailure) throw sessionFailure;
});
const clickedLinks: Array<{ href: string; download: boolean }> = [];

mock.module("@/lib/api", {
    namedExports: { api: { createBackupDownloadSession } },
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
    sessionFailure = null;
    clickedLinks.length = 0;
    createBackupDownloadSession.mock.resetCalls();
    Object.defineProperty(HTMLAnchorElement.prototype, "click", {
        configurable: true,
        writable: true,
        value(this: HTMLAnchorElement) {
            clickedLinks.push({
                href: this.getAttribute("href") ?? "",
                download: this.hasAttribute("download"),
            });
        },
    });
    document.body.replaceChildren();
});

async function flush(): Promise<void> {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

async function mountSection() {
    const { BackupSection } =
        await import("../../features/settings/components/sections/BackupSection");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(React.createElement(BackupSection));
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

function input(label: string): HTMLInputElement {
    const element = document.querySelector(`input[aria-label="${label}"]`);
    assert.ok(element instanceof HTMLInputElement, `Missing ${label} input`);
    return element;
}

async function typeInto(element: HTMLInputElement, value: string) {
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

async function submit(): Promise<void> {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === "Download backup",
    );
    assert.ok(button instanceof HTMLButtonElement, "Missing download button");
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flush();
    });
}

async function fillPassphrases(passphrase: string, confirmation: string) {
    await typeInto(input("Backup passphrase"), passphrase);
    await typeInto(input("Confirm backup passphrase"), confirmation);
}

test("a confirmed passphrase mints the session, then downloads the backup", async (t) => {
    const harness = await mountSection();
    t.after(harness.unmount);

    await fillPassphrases("correct horse battery", "correct horse battery");
    await submit();

    assert.deepEqual(
        createBackupDownloadSession.mock.calls.map((call) => call.arguments),
        [["correct horse battery"]],
    );
    assert.deepEqual(clickedLinks, [
        { href: "/api/backup/download", download: true },
    ]);
    assert.equal(input("Backup passphrase").value, "");
    assert.match(
        harness.container.textContent ?? "",
        /Your browser is downloading the backup/,
    );
});

test("a short or mismatched passphrase never reaches the server", async (t) => {
    const harness = await mountSection();
    t.after(harness.unmount);

    await fillPassphrases("short", "short");
    await submit();
    assert.match(harness.container.textContent ?? "", /at least 12/);

    await fillPassphrases("correct horse battery", "correct horse batterx");
    await submit();
    assert.match(harness.container.textContent ?? "", /don't match/);

    assert.equal(createBackupDownloadSession.mock.callCount(), 0);
    assert.equal(clickedLinks.length, 0);
});

test("a running backup is explained and nothing downloads", async (t) => {
    sessionFailure = Object.assign(new Error("busy"), {
        status: 409,
        data: { code: "BACKUP_IN_PROGRESS" },
    });
    const harness = await mountSection();
    t.after(harness.unmount);

    await fillPassphrases("correct horse battery", "correct horse battery");
    await submit();

    assert.equal(clickedLinks.length, 0);
    assert.match(
        harness.container.textContent ?? "",
        /Another backup is running/,
    );
});

test("says the backup leaves out music files and needs the passphrase", async (t) => {
    const harness = await mountSection();
    t.after(harness.unmount);
    const text = harness.container.textContent ?? "";
    assert.match(text, /Music files are not included/);
    assert.match(text, /can't be restored without it/);
});

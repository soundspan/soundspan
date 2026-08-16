import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface IdentityRecord {
    id: string;
    provider: string;
    email: string | null;
    displayName: string | null;
    subjectHint: string;
    createdAt: string;
}

interface AppPasswordRecord {
    id: string;
    displayName: string;
    createdAt: string;
    lastUsedAt: string | null;
}

let oidcEnabled = true;
let identities: IdentityRecord[] = [];
let appPasswords: AppPasswordRecord[] = [];
let unlinkFailure: Error | null = null;

const getAuthConfig = mock.fn(async () => ({
    localLoginEnabled: true,
    oidcEnabled,
    oidcProviderName: "Company SSO",
}));
const getExternalIdentities = mock.fn(async () => ({ identities }));
const startOidcLink = mock.fn(async () => ({
    redirectUrl: `${window.location.origin}/settings#oidc-provider`,
}));
const unlinkExternalIdentity = mock.fn(async (id: string) => {
    if (unlinkFailure) throw unlinkFailure;
    identities = identities.filter((identity) => identity.id !== id);
    return { message: "Identity unlinked" };
});
const listAppPasswords = mock.fn(async () => ({ appPasswords }));
const createAppPassword = mock.fn(async (displayName: string) => {
    const appPassword = {
        id: "app-new",
        displayName,
        createdAt: "2026-08-15T12:00:00.000Z",
        lastUsedAt: null,
        secret: "ssap_once-only-secret",
    };
    appPasswords = [appPassword, ...appPasswords];
    return { appPassword };
});
const revokeAppPassword = mock.fn(async (id: string) => {
    appPasswords = appPasswords.filter((password) => password.id !== id);
    return { message: "App password revoked" };
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getAuthConfig,
            getExternalIdentities,
            startOidcLink,
            unlinkExternalIdentity,
            listAppPasswords,
            createAppPassword,
            revokeAppPassword,
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
    oidcEnabled = true;
    identities = [];
    appPasswords = [];
    unlinkFailure = null;
    getAuthConfig.mock.resetCalls();
    getExternalIdentities.mock.resetCalls();
    startOidcLink.mock.resetCalls();
    unlinkExternalIdentity.mock.resetCalls();
    listAppPasswords.mock.resetCalls();
    createAppPassword.mock.resetCalls();
    revokeAppPassword.mock.resetCalls();
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/settings");
});

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function mountSecuritySection() {
    const { SignInSecuritySection } =
        await import("../../features/settings/components/sections/SignInSecuritySection");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(SignInSecuritySection));
        await flushAsyncWork();
    });

    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function findButton(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

function findLastButton(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button"))
        .filter((candidate) => candidate.textContent?.trim() === text)
        .at(-1);
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await flushAsyncWork();
    });
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the input value setter");
    await React.act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

test("renders, links, and unlinks OIDC identities", async (t) => {
    identities = [
        {
            id: "identity-1",
            provider: "oidc:https://idp.example",
            email: "alice@example.com",
            displayName: "Alice Example",
            subjectHint: "subject-…",
            createdAt: "2026-08-10T12:00:00.000Z",
        },
    ];
    const harness = await mountSecuritySection();
    t.after(harness.unmount);

    assert.match(harness.container.textContent ?? "", /Company SSO/);
    assert.match(harness.container.textContent ?? "", /Alice Example/);
    assert.match(harness.container.textContent ?? "", /alice@example\.com/);
    assert.match(harness.container.textContent ?? "", /subject-…/);

    await click(findButton("Link Company SSO account"));
    assert.equal(startOidcLink.mock.callCount(), 1);
    assert.equal(window.location.hash, "#oidc-provider");

    await click(findButton("Unlink"));
    assert.ok(document.querySelector('[role="dialog"]'));
    await click(findLastButton("Unlink"));

    assert.deepEqual(unlinkExternalIdentity.mock.calls[0]?.arguments, [
        "identity-1",
    ]);
    assert.doesNotMatch(harness.container.textContent ?? "", /Alice Example/);
});

test("surfaces the strand guard when the last sign-in method cannot be unlinked", async (t) => {
    identities = [
        {
            id: "identity-1",
            provider: "oidc:https://idp.example",
            email: "alice@example.com",
            displayName: "Alice Example",
            subjectHint: "subject-…",
            createdAt: "2026-08-10T12:00:00.000Z",
        },
    ];
    unlinkFailure = new Error("Cannot unlink the last sign-in method");
    const harness = await mountSecuritySection();
    t.after(harness.unmount);

    await click(findButton("Unlink"));
    await click(findLastButton("Unlink"));

    assert.match(
        document.body.textContent ?? "",
        /Cannot unlink the last sign-in method/,
    );
    assert.match(harness.container.textContent ?? "", /Alice Example/);
});

test("shows the link result once and removes OIDC status parameters", async (t) => {
    window.history.replaceState(
        {},
        "",
        "/settings?keep=1&ssoError=identity_already_linked#sign-in-security",
    );
    const harness = await mountSecuritySection();
    t.after(harness.unmount);

    assert.match(
        harness.container.textContent ?? "",
        /This SSO identity is already linked to another account/,
    );
    assert.equal(window.location.search, "?keep=1");
    assert.equal(window.location.hash, "#sign-in-security");
});

test("shows a successful link result and strips it from the URL", async (t) => {
    window.history.replaceState({}, "", "/settings?ssoLinked=1");
    const harness = await mountSecuritySection();
    t.after(harness.unmount);

    assert.match(harness.container.textContent ?? "", /SSO account linked\./);
    assert.equal(window.location.search, "");
});

test("creates, reveals once, copies, and revokes app passwords", async (t) => {
    oidcEnabled = false;
    appPasswords = [
        {
            id: "app-old",
            displayName: "Kitchen tablet",
            createdAt: "2026-08-01T12:00:00.000Z",
            lastUsedAt: null,
        },
    ];
    const clipboardWrites: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
            writeText: async (value: string) => {
                clipboardWrites.push(value);
            },
        },
    });
    const harness = await mountSecuritySection();
    t.after(harness.unmount);

    assert.match(
        harness.container.textContent ?? "",
        /Use app passwords in OpenSubsonic apps instead of your account password\./,
    );
    assert.doesNotMatch(
        harness.container.textContent ?? "",
        /Link Company SSO account/,
    );

    const nameInput = document.querySelector("#app-password-display-name");
    assert.ok(nameInput instanceof HTMLInputElement);
    await typeInto(nameInput, "Bedroom speaker");
    await click(findButton("Create app password"));

    assert.deepEqual(createAppPassword.mock.calls[0]?.arguments, [
        "Bedroom speaker",
    ]);
    const secretInput = document.querySelector(
        'input[aria-label="New app password"]',
    );
    assert.ok(secretInput instanceof HTMLInputElement);
    assert.equal(secretInput.value, "ssap_once-only-secret");
    assert.match(
        harness.container.textContent ?? "",
        /you won.t see this again/i,
    );
    await click(findButton("Copy"));
    assert.deepEqual(clipboardWrites, ["ssap_once-only-secret"]);
    await click(findButton("Dismiss"));
    assert.equal(
        document.querySelector('input[aria-label="New app password"]'),
        null,
    );

    const revokeButtons = Array.from(
        document.querySelectorAll("button"),
    ).filter((button) => button.textContent?.trim() === "Revoke");
    assert.ok(revokeButtons[0] instanceof HTMLButtonElement);
    await click(revokeButtons[0]);
    await click(findLastButton("Revoke"));

    assert.deepEqual(revokeAppPassword.mock.calls[0]?.arguments, ["app-new"]);
    assert.doesNotMatch(harness.container.textContent ?? "", /Bedroom speaker/);
});

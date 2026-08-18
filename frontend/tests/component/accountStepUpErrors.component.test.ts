import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const setup2FA = mock.fn(async () => {
    throw new Error("Interactive session authentication required");
});
const enable2FA = mock.fn(async () => {
    throw new Error("Interactive session authentication required");
});
const disable2FA = mock.fn(async () => {
    throw new Error("Interactive session authentication required");
});
let twoFactorEnabled = false;
let settingUpTwoFactor = false;

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            user: {
                username: "listener",
                email: "listener@example.com",
                role: "user",
            },
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: { post: async () => ({}) },
    },
});

mock.module("../../features/settings/hooks/useTwoFactor", {
    namedExports: {
        useTwoFactor: () => ({
            twoFactorEnabled,
            settingUpTwoFactor,
            twoFactorQR: "",
            twoFactorSecret: "",
            recoveryCodes: [],
            showRecoveryCodes: false,
            load2FAStatus: async () => undefined,
            setup2FA,
            enable2FA,
            disable2FA,
            cancel2FASetup: () => undefined,
            closeRecoveryCodes: () => undefined,
        }),
    },
});

mock.module("next/image", { defaultExport: () => null });

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    setup2FA.mock.resetCalls();
    enable2FA.mock.resetCalls();
    disable2FA.mock.resetCalls();
    twoFactorEnabled = false;
    settingUpTwoFactor = false;
    document.body.replaceChildren();
});

async function mountAccountSection() {
    const { AccountSection } =
        await import("../../features/settings/components/sections/AccountSection");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(AccountSection, {
                settings: { displayName: "Listener" } as never,
                onUpdate: () => undefined,
            }),
        );
    });

    return {
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

function findInput(placeholder: string): HTMLInputElement {
    const input = document.querySelector(`input[placeholder="${placeholder}"]`);
    assert.ok(
        input instanceof HTMLInputElement,
        `Missing ${placeholder} input`,
    );
    return input;
}

function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the input value setter");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(button: HTMLButtonElement): Promise<void> {
    await React.act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });
}

test("shows the interactive-session message when 2FA setup is forbidden", async (t) => {
    const harness = await mountAccountSection();
    t.after(harness.unmount);
    await click(findButton("Enable"));

    assert.equal(setup2FA.mock.callCount(), 1);
    assert.match(
        document.body.textContent ?? "",
        /Interactive session authentication required/,
    );
});

test("shows the interactive-session message when 2FA enablement is forbidden", async (t) => {
    settingUpTwoFactor = true;
    const harness = await mountAccountSection();
    t.after(harness.unmount);

    await React.act(async () =>
        typeInto(findInput("Enter 6-digit code"), "123456"),
    );
    await click(findButton("Verify"));

    assert.equal(enable2FA.mock.callCount(), 1);
    assert.match(
        document.body.textContent ?? "",
        /Interactive session authentication required/,
    );
});

test("shows the interactive-session message when 2FA disablement is forbidden", async (t) => {
    twoFactorEnabled = true;
    const harness = await mountAccountSection();
    t.after(harness.unmount);

    await click(findButton("Disable"));
    await React.act(async () => {
        typeInto(findInput("Password"), "password");
        typeInto(findInput("6-digit code"), "123456");
    });
    await click(findButton("Disable 2FA"));

    assert.equal(disable2FA.mock.callCount(), 1);
    assert.match(
        document.body.textContent ?? "",
        /Interactive session authentication required/,
    );
});

import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const users = [
    {
        id: "local-linked",
        username: "local-linked-user",
        email: "local@example.com",
        role: "user" as const,
        createdAt: "2026-08-14T12:00:00.000Z",
        hasPassword: true,
        linkedProviders: ["oidc:https://idp.example"],
    },
    {
        id: "sso-only",
        username: "sso-user",
        email: "sso@example.com",
        role: "user" as const,
        createdAt: "2026-08-15T12:00:00.000Z",
        hasPassword: false,
        linkedProviders: ["oidc:https://idp.example"],
    },
    {
        id: "admin-target",
        username: "admin-target-user",
        email: "admin@example.com",
        role: "admin" as const,
        createdAt: "2026-08-15T13:00:00.000Z",
        hasPassword: true,
        linkedProviders: [],
    },
];

const get = mock.fn(async (path: string) => {
    assert.equal(path, "/auth/users");
    return users;
});
const patch = mock.fn(async () => users[1]);
const getInviteCodes = mock.fn(async () => []);

mock.module("@/lib/api", {
    namedExports: {
        api: {
            get,
            patch,
            getInviteCodes,
            createInviteCode: async () => ({}),
            revokeInviteCode: async () => ({}),
            post: async () => ({}),
            delete: async () => ({}),
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            user: {
                id: "admin-current",
                username: "admin",
                role: "admin",
            },
        }),
    },
});

mock.module("@/hooks/useSocialPresence", {
    namedExports: {
        useAdminConnectedUsers: () => ({ users: [], isLoading: false }),
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
    get.mock.resetCalls();
    patch.mock.resetCalls();
    getInviteCodes.mock.resetCalls();
    document.body.replaceChildren();
});

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function mountUserManagementSection() {
    const { UserManagementSection } =
        await import("../../features/settings/components/sections/UserManagementSection");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(UserManagementSection));
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

async function click(element: Element): Promise<void> {
    await React.act(async () => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

async function selectValue(
    select: HTMLSelectElement,
    value: string,
): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
    )?.set;
    assert.ok(setter, "expected the select value setter");
    await React.act(async () => {
        setter.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await flushAsyncWork();
    });
}

function findButton(text: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    assert.ok(button instanceof HTMLButtonElement, `Missing ${text} button`);
    return button;
}

test("shows SSO badges and labels password setup for SSO-only users", async (t) => {
    const harness = await mountUserManagementSection();
    t.after(harness.unmount);

    const badges = Array.from(
        harness.container.querySelectorAll("span"),
        (element) => element.textContent?.trim(),
    );
    assert.ok(badges.includes("SSO"));
    assert.ok(badges.includes("SSO-only"));

    const ssoUserLabel = Array.from(
        harness.container.querySelectorAll("div"),
    ).find(
        (element) =>
            element.textContent?.includes("sso-user") &&
            element.querySelector("div") === null,
    );
    assert.ok(ssoUserLabel, "Missing SSO-only user row");
    await click(ssoUserLabel);

    assert.match(
        document.querySelector('[role="dialog"]')?.textContent ?? "",
        /Set password \(enables local login\)/,
    );
    const passwordInput = document.querySelector(
        '[role="dialog"] input[type="password"]',
    );
    assert.ok(passwordInput instanceof HTMLInputElement);
    await typeInto(passwordInput, "new-local-password");
    await click(findButton("Save Changes"));

    assert.deepEqual(patch.mock.calls[0]?.arguments, [
        "/auth/users/sso-only",
        { password: "new-local-password" },
    ]);
});

test("sends an edited role for any user", async (t) => {
    const harness = await mountUserManagementSection();
    t.after(harness.unmount);
    const userRow = Array.from(harness.container.querySelectorAll("div")).find(
        (element) =>
            element.textContent?.includes("local-linked-user") &&
            element.querySelector("div") === null,
    );
    assert.ok(userRow, "Missing local user row");
    await click(userRow);

    const roleSelect = document.querySelector(
        '[role="dialog"] select#edit-user-role',
    );
    assert.ok(roleSelect instanceof HTMLSelectElement);
    await selectValue(roleSelect, "admin");
    await click(findButton("Save Changes"));

    assert.deepEqual(patch.mock.calls[0]?.arguments, [
        "/auth/users/local-linked",
        { role: "admin" },
    ]);
});

test("shows the OIDC role overwrite warning only for linked users", async (t) => {
    const harness = await mountUserManagementSection();
    t.after(harness.unmount);
    const linkedUserRow = Array.from(
        harness.container.querySelectorAll("div"),
    ).find(
        (element) =>
            element.textContent?.includes("local-linked-user") &&
            element.querySelector("div") === null,
    );
    assert.ok(linkedUserRow, "Missing linked user row");
    await click(linkedUserRow);

    const warning =
        "OIDC role management (if enabled) will overwrite manual role changes at this user's next SSO login.";
    assert.match(
        document.querySelector('[role="dialog"]')?.textContent ?? "",
        new RegExp(warning.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    await click(findButton("Cancel"));
    const localUserRow = Array.from(
        harness.container.querySelectorAll("div"),
    ).find(
        (element) =>
            element.textContent?.includes("admin-target-user") &&
            element.querySelector("div") === null,
    );
    assert.ok(localUserRow, "Missing unlinked user row");
    await click(localUserRow);

    assert.doesNotMatch(
        document.querySelector('[role="dialog"]')?.textContent ?? "",
        /OIDC role management/,
    );
});

test("renders the backend last-admin rejection", async (t) => {
    patch.mock.mockImplementationOnce(async () => {
        throw new Error("Cannot demote the last admin");
    });
    const harness = await mountUserManagementSection();
    t.after(harness.unmount);
    const userRow = Array.from(harness.container.querySelectorAll("div")).find(
        (element) =>
            element.textContent?.includes("admin-target-user") &&
            element.querySelector("div") === null,
    );
    assert.ok(userRow, "Missing admin user row");
    await click(userRow);

    const roleSelect = document.querySelector(
        '[role="dialog"] select#edit-user-role',
    );
    assert.ok(roleSelect instanceof HTMLSelectElement);
    await selectValue(roleSelect, "user");
    await click(findButton("Save Changes"));

    assert.match(
        document.querySelector('[role="dialog"]')?.textContent ?? "",
        /Cannot demote the last admin/,
    );
});

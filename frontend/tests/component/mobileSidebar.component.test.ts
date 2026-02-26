import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    pathname: "/discover",
    hasActiveSessions: false,
};

const Icon = () => React.createElement("i");

mock.module("next/navigation", {
    namedExports: {
        usePathname: () => state.pathname,
    },
});

mock.module("next/link", {
    defaultExport: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    }) =>
        React.createElement("a", { href, ...rest }, children),
});

mock.module("next/image", {
    defaultExport: ({
        src,
        alt,
        ...rest
    }: {
        src: string;
        alt: string;
    }) => React.createElement("img", { src, alt, ...rest }),
});

mock.module("lucide-react", {
    namedExports: {
        Settings: Icon,
        RefreshCw: Icon,
        LogOut: Icon,
        Compass: Icon,
        Heart: Icon,
        X: Icon,
        Radio: Icon,
        Users: Icon,
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            scanLibrary: async () => undefined,
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            logout: async () => undefined,
        }),
    },
});

mock.module("@/hooks/useActiveListenSessions", {
    namedExports: {
        useActiveListenSessions: () => state.hasActiveSessions,
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({
            toast: {
                error: () => undefined,
                success: () => undefined,
            },
        }),
    },
});

mock.module("@/components/ui/EqBars", {
    namedExports: {
        EqBars: () => React.createElement("span", null, "eq-bars"),
    },
});

beforeEach(() => {
    state.pathname = "/discover";
    state.hasActiveSessions = false;
});

test("returns null when closed", async () => {
    const { MobileSidebar } = await import(
        "../../components/layout/MobileSidebar.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: false,
            onClose: () => undefined,
        })
    );

    assert.equal(html, "");
});

test("renders quick links and omits my history", async () => {
    const { MobileSidebar } = await import(
        "../../components/layout/MobileSidebar.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose: () => undefined,
        })
    );

    assert.match(html, /Quick Links/);
    assert.match(html, />Discover</);
    assert.match(html, />My Liked</);
    assert.match(html, />Radio</);
    assert.match(html, />Listen Together</);
    assert.doesNotMatch(html, /My History/);
});

test("shows listen-together marker when sessions are active", async () => {
    state.hasActiveSessions = true;
    state.pathname = "/listen-together";

    const { MobileSidebar } = await import(
        "../../components/layout/MobileSidebar.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose: () => undefined,
        })
    );

    assert.match(html, /eq-bars/);
});

test("marks settings as the current route when viewing settings", async () => {
    state.pathname = "/settings";

    const { MobileSidebar } = await import(
        "../../components/layout/MobileSidebar.tsx"
    );

    const html = renderToStaticMarkup(
        React.createElement(MobileSidebar, {
            isOpen: true,
            onClose: () => undefined,
        })
    );

    assert.match(html, /href="\/settings"/);
    assert.match(html, /aria-current="page"/);
});

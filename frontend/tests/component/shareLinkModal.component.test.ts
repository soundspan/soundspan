import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const icon = (name: string) => {
    const MockIcon = (props: Record<string, unknown> = {}) =>
        React.createElement("svg", { ...props, "data-icon": name });
    MockIcon.displayName = `MockIcon${name}`;
    return MockIcon;
};

mock.module("lucide-react", {
    namedExports: {
        Copy: icon("copy"),
        Link2: icon("link2"),
        Loader2: icon("loader2"),
        Trash2: icon("trash2"),
        X: icon("x"),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            success: () => undefined,
            error: () => undefined,
        },
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            createShareLink: async () => ({
                accessPath: "/api/share-links/access/test-token",
            }),
            listShareLinks: async () => [],
            revokeShareLink: async () => ({ success: true }),
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
        },
    },
});

test("ShareLinkModal renders track share fields when open", async () => {
    const { ShareLinkModal } = await import(
        "../../components/ui/ShareLinkModal"
    );

    const html = renderToStaticMarkup(
        React.createElement(ShareLinkModal, {
            isOpen: true,
            onClose: () => undefined,
            resourceType: "track",
            resourceId: "track-1",
            resourceName: "Track One",
        })
    );

    assert.match(html, /Share Track/);
    assert.match(html, /Track One/);
    assert.match(html, /Expires at/);
    assert.match(html, /Max plays/);
    assert.match(html, /Create link/);
    assert.match(html, /Existing share links/);
    assert.match(html, /Refresh/);
});

test("ShareLinkModal renders album share title when sharing albums", async () => {
    const { ShareLinkModal } = await import(
        "../../components/ui/ShareLinkModal"
    );

    const html = renderToStaticMarkup(
        React.createElement(ShareLinkModal, {
            isOpen: true,
            onClose: () => undefined,
            resourceType: "album",
            resourceId: "album-1",
            resourceName: "Album One",
        })
    );

    assert.match(html, /Share Album/);
    assert.match(html, /Album One/);
});

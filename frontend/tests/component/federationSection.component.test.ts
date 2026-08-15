import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Check: Icon,
        Clipboard: Icon,
        KeyRound: Icon,
        Link: Icon,
        Loader2: Icon,
        Network: Icon,
        Plus: Icon,
        RefreshCw: Icon,
        RotateCw: Icon,
        Server: Icon,
        Trash2: Icon,
        Unlink: Icon,
        X: Icon,
    },
});

const noop = () => undefined;

test("federation peer list renders its empty state", async () => {
    const { FederationPeersList } =
        await import("../../features/settings/components/sections/FederationSection");
    const html = renderToStaticMarkup(
        React.createElement(FederationPeersList, {
            peers: [],
            busyPeerId: null,
            onSync: noop,
            onRotate: noop,
            onRevoke: noop,
            onDelete: noop,
        }),
    );
    assert.match(html, /No federation peers linked/);
});

test("federation peer list renders active, offline, and revoked status chips", async () => {
    const { FederationPeersList } =
        await import("../../features/settings/components/sections/FederationSection");
    const basePeer = {
        direction: "CONSUMER" as const,
        baseUrl: "https://peer.example",
        scopes: ["library:read" as const, "stream:read" as const],
        lastSeenAt: "2026-08-15T12:00:00.000Z",
        lastSyncCursor: null,
        catalogEpoch: null,
        createdAt: "2026-08-15T12:00:00.000Z",
        updatedAt: "2026-08-15T12:00:00.000Z",
    };
    const html = renderToStaticMarkup(
        React.createElement(FederationPeersList, {
            peers: [
                {
                    ...basePeer,
                    id: "active",
                    name: "Alpha",
                    status: "ACTIVE" as const,
                },
                {
                    ...basePeer,
                    id: "offline",
                    name: "Beta",
                    status: "OFFLINE" as const,
                },
                {
                    ...basePeer,
                    id: "revoked",
                    name: "Gamma",
                    status: "REVOKED" as const,
                },
            ],
            busyPeerId: null,
            onSync: noop,
            onRotate: noop,
            onRevoke: noop,
            onDelete: noop,
        }),
    );
    assert.match(html, /Alpha/);
    assert.match(html, /ACTIVE/);
    assert.match(html, /OFFLINE/);
    assert.match(html, /REVOKED/);
    assert.match(html, /library:read/);
});

test("one-time credential dialog shows the token and irreversible warning", async () => {
    const { OneTimeCredentialDialog } =
        await import("../../features/settings/components/sections/FederationSection");
    const html = renderToStaticMarkup(
        React.createElement(OneTimeCredentialDialog, {
            peerName: "Family server",
            token: "secret-once-token",
            onClose: noop,
        }),
    );
    assert.match(html, /secret-once-token/);
    assert.match(html, /you won&#x27;t see this again/i);
    assert.match(html, /Copy token/);
});

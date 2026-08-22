import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Activity: Icon,
        AlertTriangle: Icon,
        ArrowDownToLine: Icon,
        ArrowLeftRight: Icon,
        ArrowUpFromLine: Icon,
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
        inboundStatus: null,
        showDedupedCopies: false,
        maxConcurrentStreams: null,
        maxStreamKbps: null,
        lastSeenAt: "2026-08-15T12:00:00.000Z",
        lastSyncSuccessAt: null,
        lastSyncDurationMs: null,
        lastErrorAt: null,
        lastError: null,
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
                    outboundStatus: "ACTIVE" as const,
                },
                {
                    ...basePeer,
                    id: "offline",
                    name: "Beta",
                    outboundStatus: "OFFLINE" as const,
                },
                {
                    ...basePeer,
                    id: "revoked",
                    name: "Gamma",
                    outboundStatus: "REVOKED" as const,
                },
                {
                    ...basePeer,
                    id: "mutual",
                    name: "Delta",
                    direction: "BOTH" as const,
                    inboundStatus: "ACTIVE" as const,
                    outboundStatus: "OFFLINE" as const,
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
    assert.match(html, /Sharing to them/);
    assert.match(html, /Consuming from them/);
});

test("peer cards render only their own direction lines", async () => {
    const { FederationPeersList } =
        await import("../../features/settings/components/sections/FederationSection");
    const basePeer = {
        baseUrl: "https://peer.example",
        scopes: ["library:read" as const],
        inboundStatus: null,
        outboundStatus: null,
        showDedupedCopies: false,
        maxConcurrentStreams: null,
        maxStreamKbps: null,
        lastSeenAt: null,
        lastSyncSuccessAt: null,
        lastSyncDurationMs: null,
        lastErrorAt: null,
        lastError: null,
        lastSyncCursor: null,
        catalogEpoch: null,
        createdAt: "2026-08-15T12:00:00.000Z",
        updatedAt: "2026-08-15T12:00:00.000Z",
    };
    const hostHtml = renderToStaticMarkup(
        React.createElement(FederationPeersList, {
            peers: [
                {
                    ...basePeer,
                    id: "host-only",
                    name: "HostOnly",
                    direction: "HOST" as const,
                    inboundStatus: "ACTIVE" as const,
                },
            ],
            busyPeerId: null,
            onSync: noop,
            onRotate: noop,
            onRevoke: noop,
            onDelete: noop,
        }),
    );
    assert.match(hostHtml, /Sharing to them/);
    assert.doesNotMatch(hostHtml, /Consuming from them/);

    const consumerHtml = renderToStaticMarkup(
        React.createElement(FederationPeersList, {
            peers: [
                {
                    ...basePeer,
                    id: "consumer-only",
                    name: "ConsumerOnly",
                    direction: "CONSUMER" as const,
                    outboundStatus: "ACTIVE" as const,
                },
            ],
            busyPeerId: null,
            onSync: noop,
            onRotate: noop,
            onRevoke: noop,
            onDelete: noop,
        }),
    );
    assert.match(consumerHtml, /Consuming from them/);
    assert.doesNotMatch(consumerHtml, /Sharing to them/);
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

test("connect builders map the explicit client-role payloads", async () => {
    const { buildLinkPeerInput, buildPairPeerInput } =
        await import("../../features/settings/components/sections/federationPairing");

    assert.deepEqual(
        buildLinkPeerInput("Friend", "https://peer.example", "tok"),
        { baseUrl: "https://peer.example", token: "tok", name: "Friend" },
    );
    assert.deepEqual(buildLinkPeerInput("  ", "https://peer.example", "tok"), {
        baseUrl: "https://peer.example",
        token: "tok",
    });
    assert.deepEqual(
        buildPairPeerInput("Friend", "https://peer.example", "CODE1234", {
            embeddings: true,
        }),
        {
            name: "Friend",
            baseUrl: "https://peer.example",
            code: "CODE1234",
            scopes: ["library:read", "stream:read", "embeddings:read"],
        },
    );
    assert.deepEqual(
        buildPairPeerInput("Friend", "https://peer.example", "CODE1234", {
            embeddings: false,
        }),
        { name: "Friend", baseUrl: "https://peer.example", code: "CODE1234" },
    );
});

test("federation error mapper prefers actionable code messages", async () => {
    const { federationErrorMessage } =
        await import("../../features/settings/components/sections/federationPairing");

    const coded = Object.assign(new Error("Request failed"), {
        data: { code: "FEDERATION_CODE_EXPIRED" },
    });
    assert.match(federationErrorMessage(coded), /expired/i);
    assert.match(federationErrorMessage(coded), /30 minutes/);

    const unreachable = Object.assign(new Error("Request failed"), {
        data: { code: "FEDERATION_PEER_UNREACHABLE" },
    });
    assert.match(federationErrorMessage(unreachable), /Could not reach/);

    assert.equal(
        federationErrorMessage(new Error("plain message")),
        "plain message",
    );
    assert.equal(federationErrorMessage(null), "Federation request failed");
});

test("explicit pairing panel presents share and connect roles", async () => {
    const { FederationAddPanel } =
        await import("../../features/settings/components/sections/federationPairing");
    const html = renderToStaticMarkup(
        React.createElement(FederationAddPanel, {
            busy: false,
            pairingCode: "ABCD2345",
            onHost: async () => undefined,
            onLink: async () => undefined,
            onPair: async () => undefined,
            onCreateCode: noop,
        }),
    );
    assert.match(html, /Share my library/);
    assert.match(html, /Connect to a library/);
    assert.match(html, /ABCD2345/);
    assert.match(html, /valid for 30 minutes/);
    assert.match(html, /Two-way sharing is two deliberate steps/);
    assert.doesNotMatch(html, /also share this library back/i);
});

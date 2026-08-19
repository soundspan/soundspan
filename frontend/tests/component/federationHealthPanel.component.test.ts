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
        RefreshCw: Icon,
    },
});

test("federation health cards render state, freshness, catalog, leases, and errors", async () => {
    const { FederationHealthCards } =
        await import("../../features/settings/components/sections/FederationHealthPanel");
    const html = renderToStaticMarkup(
        React.createElement(FederationHealthCards, {
            now: new Date("2026-08-19T12:00:00.000Z"),
            peers: [
                {
                    id: "peer-1",
                    name: "Family Library",
                    direction: "BOTH",
                    inboundStatus: "ACTIVE",
                    outboundStatus: "ACTIVE",
                    lastSeenAt: "2026-08-19T11:59:00.000Z",
                    lastSyncSuccessAt: "2026-08-19T11:58:00.000Z",
                    lastSyncDurationMs: 1_250,
                    syncLagSeconds: 120,
                    catalog: {
                        artist: 10,
                        album: 20,
                        track: 300,
                        audiobook: 4,
                        podcast: 5,
                    },
                    activeStreamLeases: 2,
                    maxConcurrentStreams: 4,
                    lastError: "Peer timed out",
                    lastErrorAt: "2026-08-19T10:00:00.000Z",
                    health: "amber",
                },
            ],
        }),
    );

    assert.match(html, /Family Library/);
    assert.match(html, /AMBER/);
    assert.match(html, /2m ago/);
    assert.match(html, /300 tracks/);
    assert.match(html, /2 \/ 4 active streams/);
    assert.match(html, /Peer timed out/);
});

test("federation health cards render an empty state", async () => {
    const { FederationHealthCards } =
        await import("../../features/settings/components/sections/FederationHealthPanel");
    const html = renderToStaticMarkup(
        React.createElement(FederationHealthCards, { peers: [] }),
    );
    assert.match(html, /No federation peer health data/);
});

test("federation health cards present revoked peers distinctly", async () => {
    const { FederationHealthCards } =
        await import("../../features/settings/components/sections/FederationHealthPanel");
    const html = renderToStaticMarkup(
        React.createElement(FederationHealthCards, {
            peers: [
                {
                    id: "peer-revoked",
                    name: "Revoked Library",
                    direction: "CONSUMER",
                    inboundStatus: null,
                    outboundStatus: "REVOKED",
                    lastSeenAt: null,
                    lastSyncSuccessAt: null,
                    lastSyncDurationMs: null,
                    syncLagSeconds: null,
                    catalog: {
                        artist: 0,
                        album: 0,
                        track: 0,
                        audiobook: 0,
                        podcast: 0,
                    },
                    activeStreamLeases: 0,
                    maxConcurrentStreams: null,
                    lastError: null,
                    lastErrorAt: null,
                    health: "revoked",
                },
            ],
        }),
    );

    assert.match(html, /REVOKED/);
    assert.match(html, /bg-gray-500/);
    assert.doesNotMatch(html, /bg-red-500/);
});

test("federation health cards render only direction-applicable details", async () => {
    const { FederationHealthCards } =
        await import("../../features/settings/components/sections/FederationHealthPanel");
    const basePeer = {
        inboundStatus: null,
        outboundStatus: null,
        lastSeenAt: null,
        lastSyncSuccessAt: null,
        lastSyncDurationMs: null,
        syncLagSeconds: null,
        catalog: {
            artist: 10,
            album: 20,
            track: 300,
            audiobook: 4,
            podcast: 5,
        },
        activeStreamLeases: 2,
        maxConcurrentStreams: 4,
        lastError: null,
        lastErrorAt: null,
        health: "green" as const,
    };
    const html = renderToStaticMarkup(
        React.createElement(FederationHealthCards, {
            peers: [
                {
                    ...basePeer,
                    id: "host",
                    name: "Host only",
                    direction: "HOST" as const,
                    inboundStatus: "ACTIVE" as const,
                },
                {
                    ...basePeer,
                    id: "consumer",
                    name: "Consumer only",
                    direction: "CONSUMER" as const,
                    outboundStatus: "ACTIVE" as const,
                },
            ],
        }),
    );
    const hostCard = html.slice(
        html.indexOf("Host only"),
        html.indexOf("Consumer only"),
    );
    const consumerCard = html.slice(html.indexOf("Consumer only"));

    assert.match(hostCard, /Synced n\/a/);
    assert.doesNotMatch(hostCard, /Never synced|300 tracks/);
    assert.match(hostCard, /2 \/ 4 active streams/);
    assert.match(consumerCard, /Never synced/);
    assert.match(consumerCard, /300 tracks/);
    assert.doesNotMatch(consumerCard, /active streams/);
});

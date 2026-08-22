import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Network: Icon,
    },
});

const basePeer = {
    peerId: "peer-1",
    peerName: "Family server",
    fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

test("peer presence renders home-peer badge, freshness, and tracks", async () => {
    const { PeerPresenceSection } =
        await import("../../components/activity/PeerPresenceSection");
    const html = renderToStaticMarkup(
        React.createElement(PeerPresenceSection, {
            peers: [
                {
                    ...basePeer,
                    users: [
                        {
                            username: "alice",
                            displayName: "Alice",
                            status: "playing" as const,
                            track: {
                                title: "Song",
                                artist: "Artist",
                                album: "Album",
                            },
                            updatedAt: basePeer.fetchedAt,
                        },
                        {
                            username: "bob",
                            status: "idle" as const,
                            updatedAt: basePeer.fetchedAt,
                        },
                    ],
                },
            ],
        }),
    );
    assert.match(html, /From Family server/);
    assert.match(html, /updated 5m ago/);
    assert.match(html, /Alice/);
    assert.match(html, /Song — Artist/);
    assert.match(html, /bob/);
    // Idle users never show a track line.
    assert.equal(html.match(/—/g)?.length, 1);
});

test("peer presence renders nothing when no peer has users", async () => {
    const { PeerPresenceSection } =
        await import("../../components/activity/PeerPresenceSection");
    const html = renderToStaticMarkup(
        React.createElement(PeerPresenceSection, {
            peers: [{ ...basePeer, users: [] }],
        }),
    );
    assert.equal(html, "");
});

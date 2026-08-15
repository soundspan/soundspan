import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("lucide-react", {
    namedExports: {
        Network: (props: Record<string, unknown> = {}) =>
            React.createElement("svg", props),
    },
});

test("PeerBadge identifies an online federation peer", async () => {
    const { PeerBadge } = await import("../../components/ui/PeerBadge");
    const html = renderToStaticMarkup(
        React.createElement(PeerBadge, { peerName: "Josh", online: true }),
    );
    assert.match(html, /title="From Josh"/);
    assert.match(html, /<svg/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, />Josh</);
    assert.doesNotMatch(html, /opacity-50/);
});

test("PeerBadge uses the muted treatment when the peer is offline", async () => {
    const { PeerBadge } = await import("../../components/ui/PeerBadge");
    const html = renderToStaticMarkup(
        React.createElement(PeerBadge, { peerName: "Sam", online: false }),
    );
    assert.match(html, /title="From Sam"/);
    assert.match(html, /<svg/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /opacity-50/);
});

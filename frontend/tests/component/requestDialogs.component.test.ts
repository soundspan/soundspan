import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/components/ui/Modal", {
    namedExports: {
        Modal: (props: {
            isOpen: boolean;
            title: string;
            children: React.ReactNode;
            footer?: React.ReactNode;
        }) =>
            props.isOpen
                ? React.createElement(
                      "div",
                      { role: "dialog" },
                      React.createElement("h2", null, props.title),
                      props.children,
                      props.footer,
                  )
                : null,
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

const request = {
    id: "req-1",
    userId: "user-1",
    type: "album",
    artistName: "Boards of Canada",
    albumTitle: "Geogaddi",
    artistMbid: null,
    rgMbid: "rg-1",
    status: "pending",
    note: null,
    deniedReason: null,
    reviewedAt: null,
    downloadJobId: null,
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
};

test("the decline dialog names the album and takes an optional reason", async () => {
    const { DeclineRequestDialog } =
        await import("../../features/requests/components/DeclineRequestDialog");

    const html = renderToStaticMarkup(
        React.createElement(DeclineRequestDialog, {
            request,
            deniedCooldownDays: 30,
            onClose: () => undefined,
            onConfirm: () => undefined,
        }),
    );

    assert.match(html, />Decline request</);
    assert.match(html, /nobody can request this album again for 30 days\./);
    assert.match(html, /Boards of Canada — Geogaddi/);
    assert.match(html, /Reason \(optional\)/);
    assert.match(html, /<textarea[^>]*maxLength="500"/);
    assert.match(html, />Decline</);
});

test("the decline dialog renders nothing without a request", async () => {
    const { DeclineRequestDialog } =
        await import("../../features/requests/components/DeclineRequestDialog");

    const html = renderToStaticMarkup(
        React.createElement(DeclineRequestDialog, {
            request: null,
            deniedCooldownDays: null,
            onClose: () => undefined,
            onConfirm: () => undefined,
        }),
    );

    assert.equal(html, "");
});

test("the stale dialog offers age presets with 30 days preselected", async () => {
    const { DeclineStaleDialog } =
        await import("../../features/requests/components/DeclineStaleDialog");

    const html = renderToStaticMarkup(
        React.createElement(DeclineStaleDialog, {
            isOpen: true,
            onClose: () => undefined,
            onConfirm: () => undefined,
        }),
    );

    assert.match(html, />Decline stale requests</);
    for (const days of [7, 14, 30, 90]) {
        assert.match(html, new RegExp(`<option value="${days}"`));
    }
    assert.match(html, /<option value="30" selected="">30 days/);
    assert.match(html, /does not start a re-request cooldown/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationLink } from "@/lib/notificationLinks";

test("a fulfilled request links to its album when the album is known", () => {
    assert.equal(
        notificationLink("request_fulfilled", {
            requestId: "req-1",
            albumId: "album-1",
        }),
        "/album/album-1",
    );
});

test("other request notifications link to the requests page", () => {
    assert.equal(
        notificationLink("request_fulfilled", { requestId: "req-1" }),
        "/requests",
    );
    assert.equal(
        notificationLink("request_failed", {
            requestId: "req-1",
            albumId: "album-1",
        }),
        "/requests",
    );
    assert.equal(
        notificationLink("request_approved", { requestId: "req-1" }),
        "/requests",
    );
});

test("non-request notifications keep playlist, album, and artist links", () => {
    assert.equal(
        notificationLink("playlist_ready", { playlistId: "pl-1" }),
        "/playlist/pl-1",
    );
    assert.equal(
        notificationLink("download_complete", { albumId: "al-1" }),
        "/album/al-1",
    );
    assert.equal(
        notificationLink("system", { artistId: "ar-1" }),
        "/artist/ar-1",
    );
});

test("missing or malformed metadata has no link", () => {
    assert.equal(notificationLink("system", undefined), null);
    assert.equal(notificationLink("system", null), null);
    assert.equal(notificationLink("system", "text"), null);
    assert.equal(notificationLink("system", { albumId: 42 }), null);
});

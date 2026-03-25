import assert from "node:assert/strict";
import test from "node:test";
import { buildAbsoluteShareUrl, canShareTrack } from "../../lib/shareLinks";

test("canShareTrack returns true for local tracks", () => {
    assert.equal(
        canShareTrack({
            id: "track-1",
            title: "Track One",
            artist: { name: "Artist" },
            album: { title: "Album" },
            duration: 200,
        }),
        true
    );
});

test("canShareTrack returns false for remote tracks", () => {
    assert.equal(
        canShareTrack({
            id: "yt:abc123",
            title: "Remote Track",
            artist: { name: "Artist" },
            album: { title: "Album" },
            duration: 200,
            streamSource: "youtube",
            youtubeVideoId: "abc123",
        }),
        false
    );
});

test("buildAbsoluteShareUrl expands backend access paths", () => {
    assert.equal(
        buildAbsoluteShareUrl(
            "/api/share-links/access/token-123",
            "https://soundspan.example"
        ),
        "https://soundspan.example/api/share-links/access/token-123"
    );
});

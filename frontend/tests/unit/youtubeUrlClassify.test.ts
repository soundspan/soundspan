import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyYouTubeUrl,
    isYouTubePlaylistOrChannelUrl,
} from "../../lib/youtube-url.ts";

const VIDEO_ID = "dQw4w9WgXcQ";
const PLAYLIST_ID = "PL-TQY69MwxBRttHQST4uYTaFs4RQPLuOH";

test("pure playlist URL classifies as playlist", () => {
    const result = classifyYouTubeUrl(
        `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`
    );
    assert.deepEqual(result, { kind: "playlist", playlistId: PLAYLIST_ID });
});

test("watch URL with a real list prefers the playlist over the video", () => {
    const result = classifyYouTubeUrl(
        `https://www.youtube.com/watch?v=${VIDEO_ID}&list=${PLAYLIST_ID}`
    );
    assert.deepEqual(result, { kind: "playlist", playlistId: PLAYLIST_ID });
});

test("RD radio/mix list classifies as mix with its focused video", () => {
    const result = classifyYouTubeUrl(
        `https://www.youtube.com/watch?v=${VIDEO_ID}&list=RD${VIDEO_ID}&start_radio=1`
    );
    assert.deepEqual(result, {
        kind: "mix",
        videoId: VIDEO_ID,
        listId: `RD${VIDEO_ID}`,
    });
});

for (const url of [
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}`,
    `https://www.youtube.com/shorts/${VIDEO_ID}`,
    VIDEO_ID,
]) {
    test(`single video URL classifies as video: ${url}`, () => {
        assert.deepEqual(classifyYouTubeUrl(url), {
            kind: "video",
            videoId: VIDEO_ID,
        });
    });
}

test("@handle channel classifies as channel", () => {
    assert.deepEqual(
        classifyYouTubeUrl("https://www.youtube.com/@BookClubRadio"),
        { kind: "channel", channel: "@BookClubRadio" }
    );
});

test("@handle with a tab still classifies as channel", () => {
    assert.deepEqual(
        classifyYouTubeUrl("https://www.youtube.com/@BookClubRadio/streams"),
        { kind: "channel", channel: "@BookClubRadio" }
    );
});

test("/channel/UC… classifies as channel", () => {
    assert.deepEqual(
        classifyYouTubeUrl(
            "https://www.youtube.com/channel/UCabcdEFGHijklMNOpqrSTUvw"
        ),
        { kind: "channel", channel: "UCabcdEFGHijklMNOpqrSTUvw" }
    );
});

test("legacy /c/ and /user/ classify as channel", () => {
    assert.equal(
        classifyYouTubeUrl("https://www.youtube.com/c/SomeName").kind,
        "channel"
    );
    assert.equal(
        classifyYouTubeUrl("https://www.youtube.com/user/LegacyName").kind,
        "channel"
    );
});

for (const url of [
    `https://music.youtube.com/playlist?list=${PLAYLIST_ID}`,
    `https://example.com/playlist?list=${PLAYLIST_ID}`,
    "not a url",
    "",
]) {
    test(`unrecognized input classifies as unknown: ${JSON.stringify(url)}`, () => {
        assert.equal(classifyYouTubeUrl(url).kind, "unknown");
    });
}

test("isYouTubePlaylistOrChannelUrl gates only playlist/channel", () => {
    assert.equal(
        isYouTubePlaylistOrChannelUrl(
            `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`
        ),
        true
    );
    assert.equal(
        isYouTubePlaylistOrChannelUrl("https://www.youtube.com/@BookClubRadio"),
        true
    );
    assert.equal(
        isYouTubePlaylistOrChannelUrl(
            `https://www.youtube.com/watch?v=${VIDEO_ID}`
        ),
        false
    );
    assert.equal(
        isYouTubePlaylistOrChannelUrl(
            `https://www.youtube.com/watch?v=${VIDEO_ID}&list=RD${VIDEO_ID}`
        ),
        false
    );
});

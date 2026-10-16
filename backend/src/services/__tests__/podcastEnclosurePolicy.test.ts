import { classifyPodcastEnclosureMimeType } from "../podcastEnclosurePolicy";

describe("classifyPodcastEnclosureMimeType", () => {
    it.each([
        "audio/mpeg",
        "audio/ogg",
        "application/mpeg",
        "application/octet-stream+mp3",
        "video/m4a",
    ])("classifies the existing audio-compatible type %s as audio", (type) => {
        expect(classifyPodcastEnclosureMimeType(type)).toEqual({
            kind: "audio",
            mimeType: type,
        });
    });

    it.each(["video/mp4", "video/x-m4v", "video/m4v", "video/webm"])(
        "classifies the browser-compatible type %s as video",
        (type) => {
            expect(classifyPodcastEnclosureMimeType(type)).toEqual({
                kind: "video",
                mimeType: type,
            });
        },
    );

    it("normalizes case and parameters for a supported video type", () => {
        expect(
            classifyPodcastEnclosureMimeType('Video/MP4; codecs="avc1"'),
        ).toEqual({
            kind: "video",
            mimeType: "video/mp4",
        });
    });

    it("normalizes an accepted audio type without changing its classification", () => {
        expect(
            classifyPodcastEnclosureMimeType('audio/MPEG; codecs="mp3"'),
        ).toEqual({
            kind: "audio",
            mimeType: "audio/mpeg",
        });
    });

    it.each([
        undefined,
        "",
        "APPLICATION/MPEG",
        "video/quicktime",
        "video/x-matroska",
        "application/octet-stream",
    ])("classifies the unsupported type %s as unsupported", (type) => {
        expect(classifyPodcastEnclosureMimeType(type)).toEqual({
            kind: "unsupported",
        });
    });
});

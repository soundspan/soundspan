import { parseM3U } from "../m3uParser";

describe("parseM3U", () => {
    it("parses plain M3U content and normalizes backslashes", () => {
        const parsed = parseM3U(
            "\n# Comment\nmusic\\track-one.mp3\nfolder/track-two.mp3\n"
        );

        expect(parsed).toEqual([
            {
                filePath: "music/track-one.mp3",
                artist: null,
                title: null,
                durationSeconds: null,
            },
            {
                filePath: "folder/track-two.mp3",
                artist: null,
                title: null,
                durationSeconds: null,
            },
        ]);
    });

    it("parses extended M3U content and carries EXTINF metadata to the next path", () => {
        const parsed = parseM3U(
            "#EXTM3U\n#EXTINF:123,Sample Artist - Sample title\nC:\\music\\sample.mp3\n#EXTINF:-1,Stream Name\nhttps://example.com/live\n"
        );

        expect(parsed).toEqual([
            {
                filePath: "C:/music/sample.mp3",
                artist: "Sample Artist",
                title: "Sample title",
                durationSeconds: 123,
            },
            {
                filePath: "https://example.com/live",
                artist: null,
                title: "Stream Name",
                durationSeconds: -1,
            },
        ]);
    });

    it("skips unknown directives while preserving pending EXTINF metadata", () => {
        const parsed = parseM3U(
            "#EXTM3U\n#EXTINF:200,Known Metadata\n#EXTVLCOPT:http-user-agent=Custom\nrelative\\path.mp3\n#EXTUNKNOWN:ignore-me\nnext.mp3\n"
        );

        expect(parsed).toEqual([
            {
                filePath: "relative/path.mp3",
                artist: null,
                title: "Known Metadata",
                durationSeconds: 200,
            },
            {
                filePath: "next.mp3",
                artist: null,
                title: null,
                durationSeconds: null,
            },
        ]);
    });

    it("rejects content containing null bytes", () => {
        expect(() => parseM3U("good.mp3\0bad.mp3")).toThrow(
            "M3U content contains null bytes"
        );
    });

    it("enforces a max entry limit", () => {
        expect(() => parseM3U("a.mp3\nb.mp3", { maxEntries: 1 })).toThrow(
            "M3U file exceeds maximum of 1 entries"
        );
    });
});

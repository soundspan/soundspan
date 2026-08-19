jest.mock("../../config", () => ({
    config: { music: { musicPath: "/music" } },
}));

import { buildFederatedAudioInfo } from "../libraryAudioInfo";

describe("buildFederatedAudioInfo", () => {
    it("derives FLAC codec, bitrate, and lossless status", () => {
        expect(
            buildFederatedAudioInfo({
                mime: "audio/flac",
                fileSize: 30_000_000,
                duration: 240,
            }),
        ).toEqual({
            codec: "FLAC",
            bitrate: 1000,
            sampleRate: null,
            bitDepth: null,
            lossless: true,
            channels: null,
        });
    });

    it.each([
        { fileSize: null, duration: 240 },
        { fileSize: 30_000_000, duration: null },
        { fileSize: 0, duration: 240 },
        { fileSize: 30_000_000, duration: 0 },
    ])("returns a null bitrate for invalid size or duration: %j", (input) => {
        expect(
            buildFederatedAudioInfo({ mime: "audio/mpeg", ...input }),
        ).toEqual({
            codec: "MP3",
            bitrate: null,
            sampleRate: null,
            bitDepth: null,
            lossless: false,
            channels: null,
        });
    });
});

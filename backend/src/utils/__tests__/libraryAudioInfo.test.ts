jest.mock("../../config", () => ({
    config: { music: { musicPath: "/music" } },
}));

import { buildFederatedAudioInfo } from "../libraryAudioInfo";

describe("buildFederatedAudioInfo", () => {
    it.each([
        ["MP3", "MP3", false],
        ["FLAC", "FLAC", true],
        ["M4A", "AAC", false],
        ["AAC", "AAC", false],
        ["OGG", "OGG", false],
        ["Opus", "Opus", false],
        ["WAV", "WAV", true],
        ["WMA", "WMA", false],
        ["APE", "APE", true],
        ["WavPack", "WavPack", true],
    ])(
        "normalizes scanner format label %s to %s",
        (mime, expectedCodec, expectedLossless) => {
            expect(
                buildFederatedAudioInfo({
                    mime,
                    fileSize: 30_000_000,
                    duration: 240,
                }),
            ).toEqual({
                codec: expectedCodec,
                bitrate: 1000,
                sampleRate: null,
                bitDepth: null,
                lossless: expectedLossless,
                channels: null,
            });
        },
    );

    it.each([
        ["audio/aac", "AAC", false],
        ["audio/alac", "ALAC", true],
        ["audio/flac", "FLAC", true],
        ["audio/mp3", "MP3", false],
        ["audio/mpeg", "MP3", false],
        ["audio/mp4; codecs=mp4a.40.2", "AAC", false],
        ["audio/ogg", "OGG", false],
        ["audio/opus", "Opus", false],
        ["audio/wav", "WAV", true],
        ["audio/webm", "WEBM", false],
        ["audio/x-flac", "FLAC", true],
        ["audio/x-wav", "WAV", true],
        ["application/ogg", "OGG", false],
    ])(
        "normalizes MIME value %s to %s",
        (mime, expectedCodec, expectedLossless) => {
            expect(
                buildFederatedAudioInfo({
                    mime,
                    fileSize: 30_000_000,
                    duration: 240,
                }),
            ).toMatchObject({
                codec: expectedCodec,
                lossless: expectedLossless,
            });
        },
    );

    it.each([
        { fileSize: null, duration: 240 },
        { fileSize: 30_000_000, duration: null },
        { fileSize: 0, duration: 240 },
        { fileSize: 30_000_000, duration: 0 },
    ])("returns a null bitrate for invalid size or duration: %j", (input) => {
        expect(
            buildFederatedAudioInfo({ mime: "MP3", ...input }),
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

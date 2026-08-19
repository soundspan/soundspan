jest.mock("../../config", () => ({
    config: { music: { musicPath: "/music" } },
}));

import { buildFederatedAudioInfo } from "../libraryAudioInfo";
import { deriveAudioFormatLabel } from "../../services/audioFormatLabel";

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
        ["audio/mpeg", null, false],
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
        [
            { codec: "MPEG 1 Layer 3", container: "MPEG" },
            "track.mp3",
            "MP3",
            false,
        ],
        [{ codec: "MPEG-1 layer 3" }, "track.m4a", "MP3", false],
        [{ codec: "MPEG-4/AAC" }, "track.m4a", "AAC", false],
        [{ codec: "AAC", container: "ADTS/MPEG-4" }, "track.aac", "AAC", false],
        [{ container: "ADTS/MPEG-4" }, "track.aac", "AAC", false],
        [{ codec: "ALAC" }, "track.m4a", "ALAC", true],
        [{ codec: "Vorbis I", container: "Ogg" }, "track.ogg", "Vorbis", false],
        [{ container: "Ogg" }, "track.ogg", "OGG", false],
        [{ codec: "Opus", container: "Ogg" }, "track.opus", "Opus", false],
        [{ codec: "FLAC", container: "FLAC" }, "track.flac", "FLAC", true],
        [{ codec: "PCM", container: "WAVE" }, "track.wav", "PCM", true],
        [{ container: "WAVE" }, "track.wav", "WAV", true],
        [{ container: "Monkey's Audio" }, "track.ape", "APE", true],
        [{ codec: "PCM", container: "WavPack" }, "track.wv", "PCM", true],
        [{ codec: "DSD", container: "WavPack" }, "track.wv", "DSD", true],
        [{ container: "WavPack" }, "track.wv", "WavPack", true],
        [
            { codec: "Windows Media Audio 9.2", container: "ASF/audio" },
            "track.wma",
            "WMA",
            false,
        ],
        [{ container: "ASF/audio" }, "track.wma", "WMA", false],
    ] as const)(
        "normalizes music-metadata producer label for %s",
        (format, filePath, expectedCodec, expectedLossless) => {
            const mime = deriveAudioFormatLabel(format, filePath);

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
        [
            { codec: "raw", container: "M4A", lossless: true },
            "track.m4a",
            "raw",
            "PCM",
            true,
        ],
        [
            { codec: "Speex 1.2", container: "Ogg" },
            "track.spx",
            "Speex 1.2",
            "Speex",
            false,
        ],
        [
            { codec: "PCM", container: "WavPack", lossless: false },
            "track.wv",
            "PCM",
            "PCM",
            true,
        ],
    ] as const)(
        "normalizes remaining music-metadata producer label for %s",
        (format, filePath, expectedLabel, expectedCodec, expectedLossless) => {
            const mime = deriveAudioFormatLabel(format, filePath);

            expect(mime).toBe(expectedLabel);
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
        ["mPeG 2.5 lAyEr 3", "MP3", false],
        ["advanced AAC LC", "AAC", false],
        ["ogg/vOrBiS", "Vorbis", false],
        ["signed PCM little-endian", "PCM", true],
        ["Waveform audio", "WAV", true],
        ["Monkey audio", "APE", true],
        ["WavPack stream", "WavPack", true],
        ["Windows Media Audio Lossless", "WMA", true],
    ])(
        "applies bounded mixed-case heuristic for %s",
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

    it.each(["doggone", "Isaac", "landscape", "escape"])(
        "does not infer a codec from an embedded family substring in %s",
        (mime) => {
            expect(
                buildFederatedAudioInfo({
                    mime,
                    fileSize: 30_000_000,
                    duration: 240,
                }),
            ).toMatchObject({ codec: null, lossless: false });
        },
    );

    it("keeps the scanner's ambiguous unknown fallback distinct from real MP3 labels", () => {
        const unknownLabel = deriveAudioFormatLabel({}, "track.unknown");
        const extensionLabel = deriveAudioFormatLabel({}, "track.mp3");
        const parserLabel = deriveAudioFormatLabel(
            { codec: "MPEG 1 Layer 3", container: "MPEG" },
            "track.mp3",
        );

        expect(unknownLabel).toBe("audio/mpeg");
        expect(extensionLabel).toBe("MP3");
        expect(parserLabel).toBe("MPEG 1 Layer 3");
        expect(
            [
                unknownLabel,
                "",
                "totally-unknown-codec",
                "landscape",
                "x".repeat(257),
            ].map((mime) =>
                buildFederatedAudioInfo({
                    mime,
                    fileSize: null,
                    duration: null,
                }),
            ),
        ).toEqual(
            Array.from({ length: 5 }, () =>
                expect.objectContaining({ codec: null, lossless: false }),
            ),
        );
        expect(
            [extensionLabel, parserLabel].map((mime) =>
                buildFederatedAudioInfo({
                    mime,
                    fileSize: null,
                    duration: null,
                }),
            ),
        ).toEqual([
            expect.objectContaining({ codec: "MP3", lossless: false }),
            expect.objectContaining({ codec: "MP3", lossless: false }),
        ]);
    });

    it.each([
        { fileSize: null, duration: 240 },
        { fileSize: 30_000_000, duration: null },
        { fileSize: 0, duration: 240 },
        { fileSize: 30_000_000, duration: 0 },
    ])("returns a null bitrate for invalid size or duration: %j", (input) => {
        expect(buildFederatedAudioInfo({ mime: "MP3", ...input })).toEqual({
            codec: "MP3",
            bitrate: null,
            sampleRate: null,
            bitDepth: null,
            lossless: false,
            channels: null,
        });
    });
});

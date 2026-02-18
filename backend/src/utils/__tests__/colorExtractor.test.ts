const mockSharp = jest.fn();
const mockResize = jest.fn();
const mockRaw = jest.fn();
const mockToBuffer = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("sharp", () => ({
    __esModule: true,
    default: (...args: unknown[]) => mockSharp(...args),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

import { extractColorsFromImage } from "../colorExtractor";

describe("colorExtractor", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockSharp.mockReturnValue({
            resize: mockResize,
        });
        mockResize.mockReturnValue({
            raw: mockRaw,
        });
        mockRaw.mockReturnValue({
            toBuffer: mockToBuffer,
        });
    });

    it("returns fallback palette when no usable pixels are found", async () => {
        mockToBuffer.mockResolvedValueOnce({
            data: Buffer.from([250, 250, 250, 255]), // too bright -> skipped
            info: { channels: 4 },
        });

        const result = await extractColorsFromImage(Buffer.from([1, 2, 3]));

        expect(result).toEqual({
            vibrant: "#1db954",
            darkVibrant: "#121212",
            lightVibrant: "#181818",
            muted: "#535353",
            darkMuted: "#121212",
            lightMuted: "#b3b3b3",
        });
    });

    it("skips transparent pixels when channels include alpha and uses remaining opaque pixels", async () => {
        mockToBuffer.mockResolvedValueOnce({
            data: Buffer.from([
                0, 0, 0, 0, // transparent -> skipped
                90, 45, 30, 255, // valid opaque pixel
            ]),
            info: { channels: 4 },
        });

        const result = await extractColorsFromImage(Buffer.from([1, 2, 3]));

        expect(result).toEqual({
            vibrant: "#ffe196",
            darkVibrant: "#361b12",
            lightVibrant: "#ffffb4",
            muted: "#5a2d1e",
            darkMuted: "#24120c",
            lightMuted: "#87432d",
        });
    });

    it("handles 3-channel (no alpha) images by treating alpha as fully opaque", async () => {
        mockToBuffer.mockResolvedValueOnce({
            data: Buffer.from([90, 45, 30]), // RGB pixel
            info: { channels: 3 },
        });

        const result = await extractColorsFromImage(Buffer.from([1, 2, 3]));

        expect(result).toEqual({
            vibrant: "#ffe196",
            darkVibrant: "#361b12",
            lightVibrant: "#ffffb4",
            muted: "#5a2d1e",
            darkMuted: "#24120c",
            lightMuted: "#87432d",
        });
    });

    it("uses the high-brightness boost fallback path for vibrant color", async () => {
        mockToBuffer.mockResolvedValueOnce({
            data: Buffer.from([150, 150, 150]), // 1.3x vibrant boost branch
            info: { channels: 3 },
        });

        const result = await extractColorsFromImage(Buffer.from([1, 2, 3]));

        expect(result).toEqual({
            vibrant: "#c3c3c3",
            darkVibrant: "#5a5a5a",
            lightVibrant: "#eaeaea",
            muted: "#969696",
            darkMuted: "#3c3c3c",
            lightMuted: "#e1e1e1",
        });
    });

    it("extracts deterministic palette from image pixel data", async () => {
        mockToBuffer.mockResolvedValueOnce({
            data: Buffer.from([
                100, 50, 50, 255, // valid
                0, 0, 0, 255, // too dark
                255, 255, 255, 255, // too bright
            ]),
            info: { channels: 4 },
        });

        const result = await extractColorsFromImage(Buffer.from([1, 2, 3]));

        expect(result).toEqual({
            vibrant: "#ff8787",
            darkVibrant: "#361b1b",
            lightVibrant: "#ffa2a2",
            muted: "#5a2d2d",
            darkMuted: "#241212",
            lightMuted: "#874343",
        });
    });

    it("returns fallback palette when sharp processing throws", async () => {
        mockToBuffer.mockRejectedValueOnce(new Error("sharp failed"));

        const result = await extractColorsFromImage(Buffer.from([1, 2, 3]));

        expect(mockLoggerError).toHaveBeenCalledWith(
            "[ColorExtractor] Failed to extract colors:",
            expect.any(Error)
        );
        expect(result).toEqual({
            vibrant: "#1db954",
            darkVibrant: "#121212",
            lightVibrant: "#181818",
            muted: "#535353",
            darkMuted: "#121212",
            lightMuted: "#b3b3b3",
        });
    });
});

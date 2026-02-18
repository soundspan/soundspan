const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockWriteFile = jest.fn();
const mockParseFile = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("fs", () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    promises: {
        writeFile: (...args: unknown[]) => mockWriteFile(...args),
    },
}));

jest.mock(
    "music-metadata",
    () => ({
        parseFile: (...args: unknown[]) => mockParseFile(...args),
    }),
    { virtual: true }
);

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

import { CoverArtExtractor } from "../coverArtExtractor";

describe("CoverArtExtractor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockWriteFile.mockResolvedValue(undefined);
    });

    it("creates cache directory when constructor path does not exist", () => {
        mockExistsSync.mockReturnValueOnce(false);

        new CoverArtExtractor("/tmp/covers");

        expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/covers", {
            recursive: true,
        });
    });

    it("does not recreate cache directory when it already exists", () => {
        mockExistsSync.mockReturnValueOnce(true);

        new CoverArtExtractor("/tmp/covers");

        expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it("returns cached filename without parsing when art already exists", async () => {
        mockExistsSync.mockImplementation((target: string) => {
            if (target === "/tmp/covers") return true;
            if (target === "/tmp/covers/album-1.jpg") return true;
            return false;
        });

        const extractor = new CoverArtExtractor("/tmp/covers");
        const result = await extractor.extractCoverArt("/music/song.mp3", "album-1");

        expect(result).toBe("album-1.jpg");
        expect(mockParseFile).not.toHaveBeenCalled();
    });

    it("returns null when audio file has no embedded picture", async () => {
        mockExistsSync.mockImplementation((target: string) => {
            if (target === "/tmp/covers") return true;
            if (target === "/tmp/covers/album-2.jpg") return false;
            return false;
        });
        mockParseFile.mockResolvedValueOnce({ common: { picture: [] } });

        const extractor = new CoverArtExtractor("/tmp/covers");
        const result = await extractor.extractCoverArt("/music/song2.mp3", "album-2");

        expect(result).toBeNull();
        expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("extracts and caches cover art from metadata", async () => {
        mockExistsSync.mockImplementation((target: string) => {
            if (target === "/tmp/covers") return true;
            if (target === "/tmp/covers/album-3.jpg") return false;
            return false;
        });
        mockParseFile.mockResolvedValueOnce({
            common: {
                picture: [{ data: Buffer.from([1, 2, 3, 4]) }],
            },
        });

        const extractor = new CoverArtExtractor("/tmp/covers");
        const result = await extractor.extractCoverArt("/music/song3.mp3", "album-3");

        expect(mockWriteFile).toHaveBeenCalledWith(
            "/tmp/covers/album-3.jpg",
            Buffer.from([1, 2, 3, 4])
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[COVER-ART] Extracted cover art from song3.mp3: album-3.jpg"
        );
        expect(result).toBe("album-3.jpg");
    });

    it("returns null and logs when extraction throws", async () => {
        mockExistsSync.mockImplementation((target: string) => {
            if (target === "/tmp/covers") return true;
            if (target === "/tmp/covers/album-4.jpg") return false;
            return false;
        });
        mockParseFile.mockRejectedValueOnce(new Error("parse failed"));

        const extractor = new CoverArtExtractor("/tmp/covers");
        const result = await extractor.extractCoverArt("/music/song4.mp3", "album-4");

        expect(result).toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[COVER-ART] Failed to extract from /music/song4.mp3:",
            expect.any(Error)
        );
    });

    it("returns cached path for getCoverArtPath only when file exists", async () => {
        mockExistsSync.mockImplementation((target: string) => {
            if (target === "/tmp/covers") return true;
            if (target === "/tmp/covers/album-5.jpg") return true;
            if (target === "/tmp/covers/album-6.jpg") return false;
            return false;
        });

        const extractor = new CoverArtExtractor("/tmp/covers");
        const found = await extractor.getCoverArtPath("album-5");
        const missing = await extractor.getCoverArtPath("album-6");

        expect(found).toBe("album-5.jpg");
        expect(missing).toBeNull();
    });
});

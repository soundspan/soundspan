const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLookup = jest.fn();

jest.mock("dns/promises", () => ({
    lookup: (...args: unknown[]) => mockLookup(...args),
}));

jest.mock("fs", () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
    },
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            transcodeCachePath: "/tmp/transcode-cache",
        },
    },
}));

import {
    downloadAndStoreImage,
    localImageExists,
    getLocalImagePath,
    deleteLocalImage,
    isExternalUrl,
    isNativePath,
} from "../imageStorage";

function createImageResponse(
    byteLength: number,
    contentType: string,
    status = 200,
): Response {
    return new Response(new Uint8Array(byteLength), {
        status,
        headers: { "content-type": contentType },
    });
}

describe("imageStorage service", () => {
    const fetchMock = jest.fn();
    const timeoutMock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        (global as any).fetch = fetchMock;
        (global as any).AbortSignal = { timeout: timeoutMock };
        timeoutMock.mockReturnValue("timeout-signal");
        mockExistsSync.mockReturnValue(true);
        mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    });

    it("returns null early when URL is empty", async () => {
        const result = await downloadAndStoreImage("", "artist-1", "artist");
        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("downloads and stores artist image on valid response", async () => {
        mockExistsSync.mockImplementation((target: string) => {
            if (target.includes("/covers/artists")) return false;
            return true;
        });
        fetchMock.mockResolvedValueOnce(
            createImageResponse(1600, "image/jpeg"),
        );

        const result = await downloadAndStoreImage(
            "https://img.example.com/a.jpg",
            "artist-1",
            "artist",
        );

        expect(mockMkdirSync).toHaveBeenCalledWith(
            "/tmp/covers/artists",
            expect.objectContaining({ recursive: true }),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "https://img.example.com/a.jpg",
            expect.objectContaining({
                headers: expect.objectContaining({
                    "User-Agent": expect.stringContaining("soundspan"),
                }),
                signal: "timeout-signal",
            }),
        );
        expect(mockWriteFileSync).toHaveBeenCalledWith(
            "/tmp/covers/artists/artist-1.jpg",
            expect.any(Buffer),
        );
        expect(result).toBe("native:artists/artist-1.jpg");
    });

    it("returns null without fetching when the image host resolves privately", async () => {
        const targetUrl = "https://images.attacker.test/cover.jpg";
        mockLookup.mockResolvedValue([{ address: "127.0.0.2", family: 4 }]);

        const result = await downloadAndStoreImage(
            targetUrl,
            "artist-private",
            "artist",
        );

        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalledWith(
            targetUrl,
            expect.anything(),
        );
        expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("returns null for non-ok fetch responses", async () => {
        fetchMock.mockResolvedValueOnce(
            createImageResponse(2000, "image/jpeg", 404),
        );

        const result = await downloadAndStoreImage(
            "https://img.example.com/missing.jpg",
            "album-1",
            "album",
        );

        expect(result).toBeNull();
    });

    it("returns null when content-type is not image", async () => {
        fetchMock.mockResolvedValueOnce(createImageResponse(2000, "text/html"));

        const result = await downloadAndStoreImage(
            "https://img.example.com/not-image",
            "album-2",
            "album",
        );

        expect(result).toBeNull();
    });

    it("returns null when image is too small", async () => {
        fetchMock.mockResolvedValueOnce(createImageResponse(100, "image/png"));

        const result = await downloadAndStoreImage(
            "https://img.example.com/tiny.png",
            "album-3",
            "album",
        );

        expect(result).toBeNull();
    });

    it("returns null when fetch throws", async () => {
        fetchMock.mockRejectedValueOnce(new Error("network error"));

        const result = await downloadAndStoreImage(
            "https://img.example.com/fail.jpg",
            "album-4",
            "album",
        );

        expect(result).toBeNull();
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ImageStorage] Download failed: network error",
        );
    });

    it("resolves local image path helpers correctly", () => {
        mockExistsSync.mockImplementation((target: string) =>
            target.endsWith("/covers/albums/album-5.jpg"),
        );

        expect(localImageExists("https://remote/image.jpg")).toBe(false);
        expect(localImageExists("native:albums/album-5.jpg")).toBe(true);
        expect(localImageExists("native:albums/missing.jpg")).toBe(false);

        expect(getLocalImagePath("http://remote")).toBeNull();
        expect(getLocalImagePath("native:albums/missing.jpg")).toBeNull();
        expect(getLocalImagePath("native:albums/album-5.jpg")).toBe(
            "/tmp/covers/albums/album-5.jpg",
        );
    });

    it("deletes local image when file exists and handles failure", () => {
        mockExistsSync.mockImplementation((target: string) =>
            target.endsWith("/covers/albums/album-6.jpg"),
        );

        mockUnlinkSync.mockImplementation(() => undefined);
        expect(deleteLocalImage("native:albums/album-6.jpg")).toBe(true);
        expect(mockUnlinkSync).toHaveBeenCalledWith(
            "/tmp/covers/albums/album-6.jpg",
        );

        mockUnlinkSync.mockImplementationOnce(() => {
            throw new Error("permission denied");
        });
        expect(deleteLocalImage("native:albums/album-6.jpg")).toBe(false);

        expect(deleteLocalImage("native:albums/missing.jpg")).toBe(false);
    });

    it("classifies external and native URLs", () => {
        expect(isExternalUrl(null)).toBe(false);
        expect(isExternalUrl("native:artists/a.jpg")).toBe(false);
        expect(isExternalUrl("https://example.com/a.jpg")).toBe(true);
        expect(isExternalUrl("http://example.com/a.jpg")).toBe(true);

        expect(isNativePath(undefined)).toBe(false);
        expect(isNativePath("https://example.com")).toBe(false);
        expect(isNativePath("native:albums/a.jpg")).toBe(true);
    });
});

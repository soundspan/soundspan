import crypto from "node:crypto";
import path from "node:path";

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            transcodeCachePath: "/tmp/test-transcode",
        },
    },
}));

jest.mock("../imageProxy", () => ({
    fetchExternalImage: jest.fn(),
}));

jest.mock("fs");

type FsModule = typeof import("fs");
type FetchExternalImageFn = typeof import("../imageProxy").fetchExternalImage;

const CACHE_DIR = path.join("/tmp/test-transcode", "../covers/browse");

async function loadBrowseImageCache() {
    jest.resetModules();

    const module = await import("../browseImageCache");
    const fs = jest.requireMock("fs") as jest.Mocked<FsModule>;
    const { fetchExternalImage } = jest.requireMock("../imageProxy") as {
        fetchExternalImage: jest.MockedFunction<FetchExternalImageFn>;
    };
    const { logger } = jest.requireMock("../../utils/logger") as {
        logger: {
            debug: jest.Mock;
            info: jest.Mock;
            warn: jest.Mock;
            error: jest.Mock;
        };
    };

    return {
        ...module,
        fs,
        mockFetchExternalImage: fetchExternalImage,
        logger,
    };
}

describe("browseImageCache", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("browseImageCacheKey returns deterministic SHA-256 hex", async () => {
        const { browseImageCacheKey } = await loadBrowseImageCache();
        const url = "https://images.example/cover.jpg";

        expect(browseImageCacheKey(url)).toBe(
            crypto.createHash("sha256").update(url).digest("hex")
        );
        expect(browseImageCacheKey(url)).toHaveLength(64);
    });

    it("getBrowseImageFromCache returns null when image file is missing", async () => {
        const { getBrowseImageFromCache, fs } = await loadBrowseImageCache();
        const mockExistsSync = fs.existsSync as jest.MockedFunction<
            FsModule["existsSync"]
        >;

        mockExistsSync.mockReturnValue(false);

        expect(getBrowseImageFromCache("missing-key")).toBeNull();
    });

    it("ensureCacheDir initializes once and reuses cacheDir on subsequent calls", async () => {
        const { getBrowseImageFromCache, fs } = await loadBrowseImageCache();
        const mockExistsSync = fs.existsSync as jest.MockedFunction<
            FsModule["existsSync"]
        >;
        const mockMkdirSync = fs.mkdirSync as jest.MockedFunction<
            FsModule["mkdirSync"]
        >;

        mockExistsSync.mockReturnValue(false);

        getBrowseImageFromCache("one");
        getBrowseImageFromCache("two");

        expect(mockMkdirSync).toHaveBeenCalledTimes(1);
        expect(mockMkdirSync).toHaveBeenCalledWith(CACHE_DIR, { recursive: true });
    });

    it("getBrowseImageFromCache returns cached entry with metadata content type", async () => {
        const { getBrowseImageFromCache, fs } = await loadBrowseImageCache();
        const mockExistsSync = fs.existsSync as jest.MockedFunction<
            FsModule["existsSync"]
        >;
        const mockReadFileSync = fs.readFileSync as jest.Mock;

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue("image/webp\n");

        expect(getBrowseImageFromCache("abc")).toEqual({
            filePath: path.join(CACHE_DIR, "abc.img"),
            contentType: "image/webp",
        });
    });

    it("getBrowseImageFromCache keeps default type when meta file is empty", async () => {
        const { getBrowseImageFromCache, fs } = await loadBrowseImageCache();
        const mockExistsSync = fs.existsSync as jest.MockedFunction<
            FsModule["existsSync"]
        >;
        const mockReadFileSync = fs.readFileSync as jest.Mock;

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue("   ");

        expect(getBrowseImageFromCache("empty-meta")).toEqual({
            filePath: path.join(CACHE_DIR, "empty-meta.img"),
            contentType: "image/jpeg",
        });
    });

    it("getBrowseImageFromCache falls back to image/jpeg when meta read fails", async () => {
        const { getBrowseImageFromCache, fs } = await loadBrowseImageCache();
        const mockExistsSync = fs.existsSync as jest.MockedFunction<
            FsModule["existsSync"]
        >;
        const mockReadFileSync = fs.readFileSync as jest.Mock;

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockImplementation(() => {
            throw new Error("meta missing");
        });

        expect(getBrowseImageFromCache("no-meta")).toEqual({
            filePath: path.join(CACHE_DIR, "no-meta.img"),
            contentType: "image/jpeg",
        });
    });

    it("fetchAndCacheBrowseImage returns null when upstream fetch fails", async () => {
        const { fetchAndCacheBrowseImage, mockFetchExternalImage, logger } =
            await loadBrowseImageCache();

        mockFetchExternalImage.mockResolvedValue({
            ok: false,
            url: "https://images.example/bad.jpg",
            status: "fetch_error",
            message: "boom",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/bad.jpg")
        ).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("fetchAndCacheBrowseImage rejects non-image content-type", async () => {
        const { fetchAndCacheBrowseImage, mockFetchExternalImage, logger, fs } =
            await loadBrowseImageCache();

        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/not-image",
            buffer: Buffer.alloc(1000, 1),
            contentType: "text/html",
            etag: "etag",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/not-image")
        ).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("fetchAndCacheBrowseImage rejects tiny responses", async () => {
        const { fetchAndCacheBrowseImage, mockFetchExternalImage, logger, fs } =
            await loadBrowseImageCache();

        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/tiny.jpg",
            buffer: Buffer.alloc(100, 1),
            contentType: "image/jpeg",
            etag: "etag",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/tiny.jpg")
        ).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("fetchAndCacheBrowseImage rejects oversized responses", async () => {
        const { fetchAndCacheBrowseImage, mockFetchExternalImage, logger, fs } =
            await loadBrowseImageCache();

        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/huge.jpg",
            buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 1),
            contentType: "image/jpeg",
            etag: "etag",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/huge.jpg")
        ).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("fetchAndCacheBrowseImage caches valid image and preserves image/* content-type", async () => {
        const { fetchAndCacheBrowseImage, mockFetchExternalImage, fs } =
            await loadBrowseImageCache();
        const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<
            FsModule["writeFileSync"]
        >;
        const mockRenameSync = fs.renameSync as jest.MockedFunction<
            FsModule["renameSync"]
        >;

        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/cover.png",
            buffer: Buffer.alloc(1000, 1),
            contentType: "image/png",
            etag: "etag",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/cover.png")
        ).resolves.toEqual({
            filePath: path.join(
                CACHE_DIR,
                `${crypto
                    .createHash("sha256")
                    .update("https://images.example/cover.png")
                    .digest("hex")}.img`
            ),
            contentType: "image/png",
        });

        expect(mockRenameSync).toHaveBeenCalledTimes(1);
        expect(mockWriteFileSync).toHaveBeenNthCalledWith(
            2,
            expect.stringMatching(/\.meta$/),
            "image/png"
        );
    });

    it("fetchAndCacheBrowseImage defaults to image/jpeg when contentType is empty", async () => {
        const { fetchAndCacheBrowseImage, mockFetchExternalImage, fs } =
            await loadBrowseImageCache();
        const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<
            FsModule["writeFileSync"]
        >;

        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/no-type",
            buffer: Buffer.alloc(1000, 1),
            contentType: "",
            etag: "etag",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/no-type")
        ).resolves.toEqual({
            filePath: path.join(
                CACHE_DIR,
                `${crypto
                    .createHash("sha256")
                    .update("https://images.example/no-type")
                    .digest("hex")}.img`
            ),
            contentType: "image/jpeg",
        });
        expect(mockWriteFileSync).toHaveBeenNthCalledWith(
            2,
            expect.stringMatching(/\.meta$/),
            "image/jpeg"
        );
    });

    it("fetchAndCacheBrowseImage returns null and cleans tmp file when write fails", async () => {
        const { fetchAndCacheBrowseImage, mockFetchExternalImage, fs, logger } =
            await loadBrowseImageCache();
        const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<
            FsModule["writeFileSync"]
        >;
        const mockUnlinkSync = fs.unlinkSync as jest.MockedFunction<
            FsModule["unlinkSync"]
        >;

        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/write-fail",
            buffer: Buffer.alloc(1000, 1),
            contentType: "image/jpeg",
            etag: "etag",
        });
        mockWriteFileSync.mockImplementationOnce(() => {
            throw new Error("disk full");
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/write-fail")
        ).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
        expect(mockUnlinkSync).toHaveBeenCalledWith(
            expect.stringMatching(/\.tmp$/)
        );
    });

    it("fetchAndCacheBrowseImage swallows cleanup errors after write failure", async () => {
        const { fetchAndCacheBrowseImage, mockFetchExternalImage, fs, logger } =
            await loadBrowseImageCache();
        const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<
            FsModule["writeFileSync"]
        >;
        const mockUnlinkSync = fs.unlinkSync as jest.MockedFunction<
            FsModule["unlinkSync"]
        >;

        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/cleanup-fail",
            buffer: Buffer.alloc(1000, 1),
            contentType: "image/jpeg",
            etag: "etag",
        });
        mockWriteFileSync.mockImplementationOnce(() => {
            throw new Error("write failed");
        });
        mockUnlinkSync.mockImplementationOnce(() => {
            throw new Error("unlink failed");
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/cleanup-fail")
        ).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    });
});

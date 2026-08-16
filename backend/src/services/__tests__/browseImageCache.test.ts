import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const mockScopedLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
const mockLogger = {
    ...mockScopedLogger,
    child: jest.fn(() => mockScopedLogger),
};
let mockTranscodeCachePath = "";
const mockRecordBrowseImageCacheResult = jest.fn();

jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

jest.mock("../../config", () => ({
    config: {
        get music() {
            return { transcodeCachePath: mockTranscodeCachePath };
        },
        browseImageCache: {
            maxBytes: 20 * 1024 * 1024,
            maxEntries: 100,
        },
    },
}));

jest.mock("../imageProxy", () => ({
    fetchExternalImage: jest.fn(),
}));
jest.mock("../../metrics", () => ({
    recordBrowseImageCacheResult: mockRecordBrowseImageCacheResult,
}));

type FetchExternalImageFn = typeof import("../imageProxy").fetchExternalImage;

async function loadBrowseImageCache() {
    jest.resetModules();
    const module = await import("../browseImageCache");
    const { fetchExternalImage } = jest.requireMock("../imageProxy") as {
        fetchExternalImage: jest.MockedFunction<FetchExternalImageFn>;
    };
    return { ...module, fetchExternalImage };
}

describe("browseImageCache", () => {
    let tempDir: string;
    let cacheDir: string;

    beforeEach(async () => {
        jest.clearAllMocks();
        tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "soundspan-browse-image-cache-unit-"),
        );
        mockTranscodeCachePath = path.join(tempDir, "transcodes");
        cacheDir = path.join(tempDir, "covers", "browse");
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    async function seedCacheEntry(
        key: string,
        contentType?: string,
    ): Promise<void> {
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(
            path.join(cacheDir, `${key}.img`),
            Buffer.alloc(700),
        );
        if (contentType !== undefined) {
            await fs.writeFile(path.join(cacheDir, `${key}.meta`), contentType);
        }
    }

    it("returns a deterministic SHA-256 key", async () => {
        const { browseImageCacheKey } = await loadBrowseImageCache();
        const url = "https://images.example/cover.jpg";

        expect(browseImageCacheKey(url)).toBe(
            crypto.createHash("sha256").update(url).digest("hex"),
        );
        expect(browseImageCacheKey(url)).toHaveLength(64);
    });

    it("creates the cache directory lazily and returns null for a miss", async () => {
        const { getBrowseImageFromCache } = await loadBrowseImageCache();
        const key = crypto.createHash("sha256").update("missing").digest("hex");

        await expect(getBrowseImageFromCache(key)).resolves.toBeNull();
        expect(mockRecordBrowseImageCacheResult).toHaveBeenCalledWith("miss");
        await expect(fs.stat(cacheDir)).resolves.toMatchObject({});
    });

    it("returns a cached entry with its metadata content type", async () => {
        const { browseImageCacheKey, getBrowseImageFromCache } =
            await loadBrowseImageCache();
        const key = browseImageCacheKey("https://images.example/cover.webp");
        await seedCacheEntry(key, "image/webp\n");

        await expect(getBrowseImageFromCache(key)).resolves.toEqual({
            filePath: path.join(cacheDir, `${key}.img`),
            contentType: "image/webp",
        });
        expect(mockRecordBrowseImageCacheResult).toHaveBeenCalledWith("hit");
    });

    it.each([undefined, "   "])(
        "defaults missing or empty metadata to image/jpeg",
        async (metadata) => {
            const { browseImageCacheKey, getBrowseImageFromCache } =
                await loadBrowseImageCache();
            const key = browseImageCacheKey(
                `https://images.example/default-${metadata ?? "missing"}`,
            );
            await seedCacheEntry(key, metadata);

            await expect(getBrowseImageFromCache(key)).resolves.toEqual({
                filePath: path.join(cacheDir, `${key}.img`),
                contentType: "image/jpeg",
            });
        },
    );

    it("returns null when the upstream fetch fails", async () => {
        const { fetchAndCacheBrowseImage, fetchExternalImage } =
            await loadBrowseImageCache();
        fetchExternalImage.mockResolvedValue({
            ok: false,
            url: "https://images.example/bad.jpg",
            status: "fetch_error",
            message: "boom",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/bad.jpg"),
        ).resolves.toBeNull();
        expect(mockScopedLogger.warn).toHaveBeenCalledTimes(1);
    });

    it("rejects a non-image content type", async () => {
        const { fetchAndCacheBrowseImage, fetchExternalImage } =
            await loadBrowseImageCache();
        fetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/not-image",
            buffer: Buffer.alloc(1_000, 1),
            contentType: "text/html",
            etag: "etag",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/not-image"),
        ).resolves.toBeNull();
        await expect(fs.readdir(cacheDir)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("rejects a response below the minimum image size", async () => {
        const { fetchAndCacheBrowseImage, fetchExternalImage } =
            await loadBrowseImageCache();
        fetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/tiny.jpg",
            buffer: Buffer.alloc(100, 1),
            contentType: "image/jpeg",
            etag: "etag",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/tiny.jpg"),
        ).resolves.toBeNull();
    });

    it("preserves the 5 MiB per-response cap", async () => {
        const { fetchAndCacheBrowseImage, fetchExternalImage } =
            await loadBrowseImageCache();
        fetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/huge.jpg",
            buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 1),
            contentType: "image/jpeg",
            etag: "etag",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/huge.jpg"),
        ).resolves.toBeNull();
        await expect(fs.readdir(cacheDir)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it.each([
        ["image/png", "image/png"],
        ["", "image/jpeg"],
    ])(
        "caches a valid image using %s metadata",
        async (sourceType, expected) => {
            const { fetchAndCacheBrowseImage, fetchExternalImage } =
                await loadBrowseImageCache();
            const url = `https://images.example/cover-${expected}`;
            fetchExternalImage.mockResolvedValue({
                ok: true,
                url,
                buffer: Buffer.alloc(1_000, 1),
                contentType: sourceType,
                etag: "etag",
            });

            const entry = await fetchAndCacheBrowseImage(url);

            expect(entry).toEqual({
                filePath: expect.stringMatching(/\.img$/),
                contentType: expected,
            });
            await expect(fs.readFile(entry!.filePath)).resolves.toEqual(
                Buffer.alloc(1_000, 1),
            );
            await expect(
                fs.readFile(entry!.filePath.replace(/\.img$/, ".meta"), "utf8"),
            ).resolves.toBe(expected);
        },
    );

    it("returns null and leaves no partial files when a write fails", async () => {
        const { fetchAndCacheBrowseImage, fetchExternalImage } =
            await loadBrowseImageCache();
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.chmod(cacheDir, 0o500);
        fetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/write-fail",
            buffer: Buffer.alloc(1_000, 1),
            contentType: "image/jpeg",
            etag: "etag",
        });

        await expect(
            fetchAndCacheBrowseImage("https://images.example/write-fail"),
        ).resolves.toBeNull();
        expect(mockScopedLogger.error).toHaveBeenCalledTimes(1);
        await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
        await fs.chmod(cacheDir, 0o700);
    });
});

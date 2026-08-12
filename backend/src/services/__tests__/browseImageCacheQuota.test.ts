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
let mockMaxBytes = 10 * 1024 * 1024;
let mockMaxEntries = 100;

jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

jest.mock("../../config", () => ({
    config: {
        get music() {
            return { transcodeCachePath: mockTranscodeCachePath };
        },
        browseImageCache: {
            get maxBytes() {
                return mockMaxBytes;
            },
            get maxEntries() {
                return mockMaxEntries;
            },
        },
    },
}));

jest.mock("../imageProxy", () => ({
    fetchExternalImage: jest.fn(),
}));

type FetchExternalImageFn = typeof import("../imageProxy").fetchExternalImage;

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function loadBrowseImageCache() {
    jest.resetModules();
    const module = await import("../browseImageCache");
    const { fetchExternalImage } = jest.requireMock("../imageProxy") as {
        fetchExternalImage: jest.MockedFunction<FetchExternalImageFn>;
    };
    return { ...module, fetchExternalImage };
}

async function cacheFootprint(cacheDir: string) {
    const files = await fs.readdir(cacheDir);
    const sizes = await Promise.all(
        files.map(
            async (file) => (await fs.stat(path.join(cacheDir, file))).size,
        ),
    );
    return {
        files,
        imageEntries: files.filter((file) => file.endsWith(".img")),
        totalBytes: sizes.reduce((sum, size) => sum + size, 0),
    };
}

describe("browseImageCache disk quota", () => {
    let tempDir: string;
    let cacheDir: string;

    beforeEach(async () => {
        jest.clearAllMocks();
        tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "soundspan-browse-image-cache-"),
        );
        mockTranscodeCachePath = path.join(tempDir, "transcodes");
        cacheDir = path.join(tempDir, "covers", "browse");
        mockMaxBytes = 1_450;
        mockMaxEntries = 2;
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("bounds unique-query churn by configured bytes and entries", async () => {
        mockMaxEntries = 10;
        const { fetchAndCacheBrowseImage, fetchExternalImage } =
            await loadBrowseImageCache();
        fetchExternalImage.mockImplementation(async () => ({
            ok: true,
            url: "https://listen.tidal.com/image",
            buffer: Buffer.alloc(700, 1),
            contentType: "image/jpeg",
            etag: "etag",
        }));

        for (let index = 0; index < 4; index += 1) {
            await fetchAndCacheBrowseImage(
                `https://listen.tidal.com/image?id=cover&nonce=${index}`,
            );
        }

        const footprint = await cacheFootprint(cacheDir);
        expect(footprint.imageEntries).toHaveLength(2);
        expect(footprint.files).toHaveLength(4);
        expect(footprint.totalBytes).toBeLessThanOrEqual(mockMaxBytes);
        expect(footprint.files.some((file) => file.endsWith(".tmp"))).toBe(
            false,
        );
    });

    it("evicts the least-recently-used image and its metadata sidecar", async () => {
        mockMaxBytes = 10_000;
        mockMaxEntries = 2;
        const {
            browseImageCacheKey,
            fetchAndCacheBrowseImage,
            fetchExternalImage,
            getBrowseImageFromCache,
        } = await loadBrowseImageCache();
        fetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://resources.tidal.com/images/cover.jpg",
            buffer: Buffer.alloc(700, 1),
            contentType: "image/jpeg",
            etag: "etag",
        });
        const firstUrl = "https://resources.tidal.com/images/first.jpg";
        const secondUrl = "https://resources.tidal.com/images/second.jpg";
        const thirdUrl = "https://resources.tidal.com/images/third.jpg";
        await fetchAndCacheBrowseImage(firstUrl);
        await fetchAndCacheBrowseImage(secondUrl);

        const firstKey = browseImageCacheKey(firstUrl);
        const secondKey = browseImageCacheKey(secondUrl);
        const oldTime = new Date("2025-01-01T00:00:00.000Z");
        const newerTime = new Date("2025-01-02T00:00:00.000Z");
        await Promise.all([
            fs.utimes(path.join(cacheDir, `${firstKey}.img`), oldTime, oldTime),
            fs.utimes(
                path.join(cacheDir, `${firstKey}.meta`),
                oldTime,
                oldTime,
            ),
            fs.utimes(
                path.join(cacheDir, `${secondKey}.img`),
                newerTime,
                newerTime,
            ),
            fs.utimes(
                path.join(cacheDir, `${secondKey}.meta`),
                newerTime,
                newerTime,
            ),
        ]);

        await expect(getBrowseImageFromCache(firstKey)).resolves.not.toBeNull();
        await fetchAndCacheBrowseImage(thirdUrl);

        const thirdKey = browseImageCacheKey(thirdUrl);
        await expect(
            fs.access(path.join(cacheDir, `${firstKey}.img`)),
        ).resolves.toBeUndefined();
        await expect(
            fs.access(path.join(cacheDir, `${firstKey}.meta`)),
        ).resolves.toBeUndefined();
        await expect(
            fs.access(path.join(cacheDir, `${secondKey}.img`)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
            fs.access(path.join(cacheDir, `${secondKey}.meta`)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
            fs.access(path.join(cacheDir, `${thirdKey}.img`)),
        ).resolves.toBeUndefined();
    });

    it.each([
        "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
        "https://lh3.googleusercontent.com/image-id=w100-h100",
        "https://yt3.ggpht.com/image-id=s100-c-k-c0x00ffffff-no-rj",
        "https://resources.tidal.com/images/album-id/640x640.jpg",
    ])("canonicalizes volatile query variants for %s", async (baseUrl) => {
        const { browseImageCacheKey } = await loadBrowseImageCache();

        expect(
            browseImageCacheKey(`${baseUrl}?sqp=first&rs=signature-one`),
        ).toBe(
            browseImageCacheKey(
                `${baseUrl}?sqp=second&rs=signature-two#ignored-fragment`,
            ),
        );
    });

    it("keeps path-based image transforms distinct", async () => {
        const { browseImageCacheKey } = await loadBrowseImageCache();

        expect(
            browseImageCacheKey(
                "https://lh3.googleusercontent.com/image-id=w100-h100",
            ),
        ).not.toBe(
            browseImageCacheKey(
                "https://lh3.googleusercontent.com/image-id=w200-h200",
            ),
        );
    });

    it("coalesces concurrent writes to one complete image-metadata pair", async () => {
        const { fetchAndCacheBrowseImage, fetchExternalImage } =
            await loadBrowseImageCache();
        const deferred = createDeferred<{
            ok: true;
            url: string;
            buffer: Buffer;
            contentType: string;
            etag: string;
        }>();
        fetchExternalImage.mockReturnValue(deferred.promise);
        const url = "https://i.ytimg.com/vi/concurrent/hqdefault.jpg";

        const first = fetchAndCacheBrowseImage(url);
        const second = fetchAndCacheBrowseImage(url);
        await Promise.resolve();
        expect(fetchExternalImage).toHaveBeenCalledTimes(1);
        deferred.resolve({
            ok: true,
            url,
            buffer: Buffer.alloc(700, 7),
            contentType: "image/webp",
            etag: "etag",
        });

        const [firstEntry, secondEntry] = await Promise.all([first, second]);
        expect(firstEntry).toEqual(secondEntry);
        expect(firstEntry).not.toBeNull();
        const footprint = await cacheFootprint(cacheDir);
        expect(footprint.imageEntries).toHaveLength(1);
        expect(footprint.files).toHaveLength(2);
        await expect(fs.readFile(firstEntry!.filePath)).resolves.toEqual(
            Buffer.alloc(700, 7),
        );
        await expect(
            fs.readFile(
                firstEntry!.filePath.replace(/\.img$/, ".meta"),
                "utf8",
            ),
        ).resolves.toBe("image/webp");
    });
});

import type {
    LocalDashAsset,
    LocalDashAssetRequest,
    SegmentedManifestProfile,
    SegmentedManifestQuality,
} from "../manifestService";
import type {
    EnsureLocalDashSegmentsInput,
    LocalDashSegmentAsset,
    SegmentedDashManifestProfile,
} from "../segmentService";

type AssertExact<T extends true> = T;
type IsExact<A, B> =
    (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
        ? (<T>() => T extends B ? 1 : 2) extends
          (<T>() => T extends A ? 1 : 2)
            ? true
            : false
        : false;

const resolveManifestService = async () => {
    jest.resetModules();

    const mockEnsureLocalDashSegments = jest.fn();

    jest.doMock("../segmentService", () => ({
        segmentedSegmentService: {
            ensureLocalDashSegments: (...args: unknown[]) =>
                mockEnsureLocalDashSegments(...args),
        },
    }));

    const firstImport = await import("../manifestService");
    const secondImport = await import("../manifestService");

    return {
        firstImport,
        secondImport,
        segmentedManifestService: firstImport.segmentedManifestService,
        mocks: {
            mockEnsureLocalDashSegments,
        },
    };
};

describe("segmentedManifestService", () => {
    afterEach(() => {
        jest.resetModules();
        jest.dontMock("../segmentService");
        jest.clearAllMocks();
    });

    it("is instantiated once as the module singleton", async () => {
        const { firstImport, secondImport, segmentedManifestService } =
            await resolveManifestService();

        expect(firstImport.segmentedManifestService).toBe(segmentedManifestService);
        expect(secondImport.segmentedManifestService).toBe(segmentedManifestService);
        expect(segmentedManifestService.constructor.name).toBe(
            "SegmentedManifestService",
        );
        expect(typeof segmentedManifestService.getOrCreateLocalDashAsset).toBe(
            "function",
        );
    });

    it("calls segmentedSegmentService.ensureLocalDashSegments with the request", async () => {
        const { segmentedManifestService, mocks } = await resolveManifestService();
        const request: LocalDashAssetRequest = {
            trackId: "track-1",
            sourcePath: "/music/track-1.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        };

        mocks.mockEnsureLocalDashSegments.mockResolvedValueOnce({
            cacheKey: "cache-1",
            outputDir: "/tmp/cache-1",
            manifestPath: "/tmp/cache-1/manifest.mpd",
            quality: "medium",
            manifestProfile: "steady_state_dual",
        });

        await segmentedManifestService.getOrCreateLocalDashAsset(request);

        expect(mocks.mockEnsureLocalDashSegments).toHaveBeenCalledTimes(1);
        expect(mocks.mockEnsureLocalDashSegments).toHaveBeenCalledWith(request);
    });

    it("returns the asset produced by segmentedSegmentService", async () => {
        const { segmentedManifestService, mocks } = await resolveManifestService();
        const request: LocalDashAssetRequest = {
            trackId: "track-2",
            sourcePath: "/music/track-2.flac",
            sourceModified: new Date("2026-02-21T00:00:00.000Z"),
            quality: "high",
        };
        const asset: LocalDashAsset = {
            cacheKey: "cache-2",
            outputDir: "/tmp/cache-2",
            manifestPath: "/tmp/cache-2/manifest.mpd",
            quality: "high",
            manifestProfile: "steady_state_dual",
        };

        mocks.mockEnsureLocalDashSegments.mockResolvedValueOnce(asset);

        await expect(
            segmentedManifestService.getOrCreateLocalDashAsset(request),
        ).resolves.toBe(asset);
    });

    it("passes through every request property unchanged", async () => {
        const { segmentedManifestService, mocks } = await resolveManifestService();
        const request: LocalDashAssetRequest = {
            trackId: "track-3",
            sourcePath: "/music/track-3.flac",
            sourceModified: new Date("2026-02-22T00:00:00.000Z"),
            quality: "low",
            manifestProfile: "startup_single",
            cacheIdentity: "track-3-low-v2",
        };

        mocks.mockEnsureLocalDashSegments.mockResolvedValueOnce({
            cacheKey: "cache-3",
            outputDir: "/tmp/cache-3",
            manifestPath: "/tmp/cache-3/manifest.mpd",
            quality: "low",
            manifestProfile: "startup_single",
        });

        await segmentedManifestService.getOrCreateLocalDashAsset(request);

        expect(mocks.mockEnsureLocalDashSegments.mock.calls[0]?.[0]).toBe(request);
        expect(mocks.mockEnsureLocalDashSegments.mock.calls[0]?.[0]).toEqual({
            trackId: "track-3",
            sourcePath: "/music/track-3.flac",
            sourceModified: new Date("2026-02-22T00:00:00.000Z"),
            quality: "low",
            manifestProfile: "startup_single",
            cacheIdentity: "track-3-low-v2",
        });
    });

    it("re-exports manifest-related types", () => {
        const qualities: SegmentedManifestQuality[] = [
            "original",
            "high",
            "medium",
            "low",
        ];
        const manifestProfile: SegmentedManifestProfile = "steady_state_dual";
        const request: LocalDashAssetRequest = {
            trackId: "track-4",
            sourcePath: "/music/track-4.flac",
            sourceModified: new Date("2026-02-23T00:00:00.000Z"),
            quality: "original",
            manifestProfile,
            cacheIdentity: "track-4-original",
        };
        const asset: LocalDashAsset = {
            cacheKey: "cache-4",
            outputDir: "/tmp/cache-4",
            manifestPath: "/tmp/cache-4/manifest.mpd",
            quality: "original",
            manifestProfile,
        };
        const forwardedRequest: EnsureLocalDashSegmentsInput = request;
        const forwardedAsset: LocalDashSegmentAsset = asset;
        const exactProfileType: AssertExact<
            IsExact<SegmentedManifestProfile, SegmentedDashManifestProfile>
        > = true;

        expect(qualities).toEqual(["original", "high", "medium", "low"]);
        expect(manifestProfile).toBe("steady_state_dual");
        expect(forwardedRequest).toEqual(request);
        expect(forwardedAsset).toEqual(asset);
        expect(exactProfileType).toBe(true);
    });
});

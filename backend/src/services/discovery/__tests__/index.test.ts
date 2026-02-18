describe("services/discovery index exports", () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it("re-exports members from discovery submodules", async () => {
        const batchClass = class BatchLoggerMock {};
        const batchInstance = { kind: "batch" };
        const lifecycleClass = class LifecycleMock {};
        const lifecycleInstance = { kind: "lifecycle" };

        const seedingClass = class SeedingMock {};
        const seedingInstance = { kind: "seeding" };

        const recClass = class RecommendationsMock {};
        const recInstance = { kind: "recs" };

        jest.doMock("../discoveryBatchLogger", () => ({
            DiscoveryBatchLogger: batchClass,
            discoveryBatchLogger: batchInstance,
        }));
        jest.doMock("../discoveryAlbumLifecycle", () => ({
            DiscoveryAlbumLifecycle: lifecycleClass,
            discoveryAlbumLifecycle: lifecycleInstance,
        }));
        jest.doMock("../discoverySeeding", () => ({
            DiscoverySeeding: seedingClass,
            discoverySeeding: seedingInstance,
        }));
        jest.doMock("../discoveryRecommendations", () => ({
            DiscoveryRecommendationsService: recClass,
            discoveryRecommendationsService: recInstance,
        }));

        const index = await import("../index");

        expect(index.DiscoveryBatchLogger).toBe(batchClass);
        expect(index.discoveryBatchLogger).toBe(batchInstance);

        expect(index.DiscoveryAlbumLifecycle).toBe(lifecycleClass);
        expect(index.discoveryAlbumLifecycle).toBe(lifecycleInstance);

        expect(index.DiscoverySeeding).toBe(seedingClass);
        expect(index.discoverySeeding).toBe(seedingInstance);

        expect(index.DiscoveryRecommendationsService).toBe(recClass);
        expect(index.discoveryRecommendationsService).toBe(recInstance);
    });
});

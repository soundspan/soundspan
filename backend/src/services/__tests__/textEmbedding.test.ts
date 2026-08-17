const mockEmbedText = jest.fn();
const mockFetchProviderSpace = jest.fn();
const mockFindRegisteredProviderSpace = jest.fn();
const mockGetActiveSpace = jest.fn();
const mockWarn = jest.fn();
const mockConfig: { vibeProviderUrl: string | undefined } = {
    vibeProviderUrl: "http://provider:8090",
};

jest.mock("../../config", () => ({ config: mockConfig }));

jest.mock("../vibeProvider", () => {
    class VibeProviderError extends Error {}
    class VibeProviderTimeoutError extends VibeProviderError {}
    class VibeProviderUnavailableError extends VibeProviderError {}
    class VibeProviderSpaceMismatchError extends VibeProviderError {}
    return {
        embedText: (...args: unknown[]) => mockEmbedText(...args),
        fetchProviderSpace: (...args: unknown[]) =>
            mockFetchProviderSpace(...args),
        assertProviderMatchesActiveSpace: (
            provider: { family: string; checkpointHash: string; dim: number },
            active: { family: string; checkpointHash: string; dim: number },
        ) => {
            if (
                provider.family !== active.family ||
                provider.checkpointHash !== active.checkpointHash ||
                provider.dim !== active.dim
            ) {
                throw new VibeProviderSpaceMismatchError();
            }
        },
        VibeProviderError,
        VibeProviderTimeoutError,
        VibeProviderUnavailableError,
        VibeProviderSpaceMismatchError,
    };
});

jest.mock("../embeddingSpaces", () => ({
    findRegisteredProviderEmbeddingSpace: (...args: unknown[]) =>
        mockFindRegisteredProviderSpace(...args),
    getActiveSpace: (...args: unknown[]) => mockGetActiveSpace(...args),
}));

jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: (...args: unknown[]) => mockWarn(...args),
        error: jest.fn(),
        child: () => logger,
    };
    return { logger };
});

import {
    invalidateTextEmbeddingProviderSpaceCache,
    resolveTextEmbedding,
    TextEmbeddingProviderError,
    TextEmbeddingTimeoutError,
    TextEmbeddingUnavailableError,
} from "../textEmbedding";
import {
    VibeProviderSpaceMismatchError,
    VibeProviderTimeoutError,
    VibeProviderUnavailableError,
} from "../vibeProvider";

const activeSpace = {
    id: "space-active",
    family: "teacher",
    checkpointHash: "sha256:teacher",
    dim: 2,
    preprocessing: {},
};
const providerSpace = {
    family: "student",
    checkpointHash: "sha256:student",
    dim: 2,
    sampleRateHz: 48_000,
    preprocessing: {},
    revision: "test",
    textTower: true,
};
const migratingSpace = {
    id: "space-migrating",
    family: providerSpace.family,
    checkpointHash: providerSpace.checkpointHash,
    dim: providerSpace.dim,
    preprocessing: providerSpace.preprocessing,
    status: "migrating" as const,
    retiredAt: null,
    createdAt: new Date("2026-08-17T00:00:00.000Z"),
};

describe("text embedding space routing", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        invalidateTextEmbeddingProviderSpaceCache();
        mockConfig.vibeProviderUrl = "http://provider:8090";
        mockGetActiveSpace.mockResolvedValue(activeSpace);
        mockFetchProviderSpace.mockResolvedValue(providerSpace);
        mockFindRegisteredProviderSpace.mockResolvedValue(migratingSpace);
        mockEmbedText.mockResolvedValue([1, 0]);
    });

    it("embeds and searches in a registered migrating provider space", async () => {
        await expect(resolveTextEmbedding("quiet focus")).resolves.toEqual({
            embedding: [1, 0],
            spaceId: "space-migrating",
        });

        expect(mockFindRegisteredProviderSpace).toHaveBeenCalledWith(
            providerSpace,
        );
        expect(mockEmbedText).toHaveBeenCalledWith("quiet focus", {
            id: "space-migrating",
            dim: 2,
        });
        expect(mockWarn).toHaveBeenCalledWith(
            "Vibe text search is using the provider embedding space during migration",
            { providerSpaceId: "space-migrating" },
        );
    });

    it("uses and caches the active space when provider identity matches", async () => {
        mockFetchProviderSpace.mockResolvedValue({
            ...providerSpace,
            family: activeSpace.family,
            checkpointHash: activeSpace.checkpointHash,
        });

        await resolveTextEmbedding("first");
        await resolveTextEmbedding("second");

        expect(mockFetchProviderSpace).toHaveBeenCalledTimes(1);
        expect(mockGetActiveSpace).toHaveBeenCalledTimes(1);
        expect(mockFindRegisteredProviderSpace).not.toHaveBeenCalled();
        expect(mockEmbedText).toHaveBeenNthCalledWith(1, "first", {
            id: "space-active",
            dim: 2,
        });
        expect(mockEmbedText).toHaveBeenNthCalledWith(2, "second", {
            id: "space-active",
            dim: 2,
        });
    });

    it("rejects an unregistered provider space without embedding", async () => {
        mockFindRegisteredProviderSpace.mockResolvedValue(null);

        await expect(
            resolveTextEmbedding("quiet focus"),
        ).rejects.toBeInstanceOf(TextEmbeddingProviderError);
        await expect(
            resolveTextEmbedding("second query"),
        ).rejects.toBeInstanceOf(TextEmbeddingProviderError);

        expect(mockEmbedText).not.toHaveBeenCalled();
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(
            "Vibe text provider space is not registered",
            expect.objectContaining({
                family: providerSpace.family,
                checkpointHash: providerSpace.checkpointHash,
            }),
        );
    });

    it("reports provider mode as unavailable when the URL is unset", async () => {
        mockConfig.vibeProviderUrl = undefined;

        await expect(
            resolveTextEmbedding("quiet focus"),
        ).rejects.toBeInstanceOf(TextEmbeddingUnavailableError);

        expect(mockFetchProviderSpace).not.toHaveBeenCalled();
        expect(mockFindRegisteredProviderSpace).not.toHaveBeenCalled();
        expect(mockEmbedText).not.toHaveBeenCalled();
    });

    it.each([
        {
            error: new VibeProviderUnavailableError(),
            expected: TextEmbeddingUnavailableError,
        },
        {
            error: new VibeProviderTimeoutError(),
            expected: TextEmbeddingTimeoutError,
        },
        {
            error: new VibeProviderSpaceMismatchError(),
            expected: TextEmbeddingProviderError,
        },
    ])(
        "maps $error.name without a legacy fallback",
        async ({ error, expected }) => {
            mockEmbedText.mockRejectedValueOnce(error);

            await expect(
                resolveTextEmbedding("quiet focus"),
            ).rejects.toBeInstanceOf(expected);
        },
    );
});

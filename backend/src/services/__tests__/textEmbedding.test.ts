const mockEmbedText = jest.fn();
const mockFetchProviderSpace = jest.fn();
const mockAssertProviderMatchesActiveSpace = jest.fn();
const mockGetActiveSpace = jest.fn();
const mockXAdd = jest.fn(async (..._args: unknown[]) => "1-0");
const mockDel = jest.fn(async (..._args: unknown[]) => 1);
const mockBlockingBlPop = jest.fn();
const mockWarn = jest.fn();

jest.mock("../../config", () => ({
    config: { vibeProviderUrl: "http://provider:8090" },
}));

jest.mock("../vibeProvider", () => {
    class VibeProviderError extends Error {}
    class VibeProviderTimeoutError extends VibeProviderError {}
    class VibeProviderUnavailableError extends VibeProviderError {}
    class VibeProviderSpaceMismatchError extends VibeProviderError {}
    return {
        embedText: (...args: unknown[]) => mockEmbedText(...args),
        fetchProviderSpace: (...args: unknown[]) =>
            mockFetchProviderSpace(...args),
        assertProviderMatchesActiveSpace: (...args: unknown[]) =>
            mockAssertProviderMatchesActiveSpace(...args),
        VibeProviderError,
        VibeProviderTimeoutError,
        VibeProviderUnavailableError,
        VibeProviderSpaceMismatchError,
    };
});

jest.mock("../embeddingSpaces", () => ({
    getActiveSpace: (...args: unknown[]) => mockGetActiveSpace(...args),
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        xAdd: (...args: unknown[]) => mockXAdd(...args),
        del: (...args: unknown[]) => mockDel(...args),
    },
    blockingBlPop: (...args: unknown[]) => mockBlockingBlPop(...args),
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
    TextEmbeddingTimeoutError,
} from "../textEmbedding";
import { VibeProviderSpaceMismatchError } from "../vibeProvider";

const legacyResponse = JSON.stringify({
    requestId: "request-1",
    success: true,
    embedding: [0, 1],
    modelVersion: "teacher",
});

describe("text embedding space routing", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        invalidateTextEmbeddingProviderSpaceCache();
        mockGetActiveSpace.mockResolvedValue({
            id: "space-active",
            family: "teacher",
            checkpointHash: "sha256:teacher",
            dim: 2,
            preprocessing: {},
        });
        mockFetchProviderSpace.mockResolvedValue({
            family: "student",
            checkpointHash: "sha256:student",
            dim: 2,
        });
        mockAssertProviderMatchesActiveSpace.mockImplementation(() => {
            throw new VibeProviderSpaceMismatchError();
        });
        mockBlockingBlPop.mockResolvedValue({ element: legacyResponse });
        mockEmbedText.mockResolvedValue([1, 0]);
    });

    it("falls back to the legacy teacher tower when provider and active space differ", async () => {
        await expect(resolveTextEmbedding("quiet focus")).resolves.toEqual([
            0, 1,
        ]);

        expect(mockEmbedText).not.toHaveBeenCalled();
        expect(mockXAdd).toHaveBeenCalledWith(
            "audio:text:embed:requests",
            "*",
            expect.objectContaining({ text: "quiet focus" }),
            expect.any(Object),
        );
        expect(mockWarn).toHaveBeenCalledTimes(1);
    });

    it("uses the provider without the legacy stream when its identity matches active", async () => {
        mockAssertProviderMatchesActiveSpace.mockReturnValue(undefined);

        await expect(resolveTextEmbedding("quiet focus")).resolves.toEqual([
            1, 0,
        ]);

        expect(mockEmbedText).toHaveBeenCalledWith("quiet focus");
        expect(mockXAdd).not.toHaveBeenCalled();
        expect(mockBlockingBlPop).not.toHaveBeenCalled();
    });

    it("treats provider identity lookup failure as a mismatch and rate-limits warnings", async () => {
        mockFetchProviderSpace.mockRejectedValue(new Error("space offline"));

        await resolveTextEmbedding("first");
        await resolveTextEmbedding("second");

        expect(mockEmbedText).not.toHaveBeenCalled();
        expect(mockXAdd).toHaveBeenCalledTimes(2);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockFetchProviderSpace).toHaveBeenCalledTimes(1);
    });

    it("preserves the legacy timeout identity after mismatch fallback", async () => {
        mockBlockingBlPop.mockResolvedValue(null);

        await expect(
            resolveTextEmbedding("quiet focus"),
        ).rejects.toBeInstanceOf(TextEmbeddingTimeoutError);
        expect(mockEmbedText).not.toHaveBeenCalled();
    });
});

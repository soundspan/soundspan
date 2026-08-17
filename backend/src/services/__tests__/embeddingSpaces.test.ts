const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();
const mockCreate = jest.fn();
const mockLoggerError = jest.fn();
const mockRecordProviderConfigError = jest.fn();
const mockChild = jest.fn((_scope: string) => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: mockLoggerError,
    child: jest.fn(),
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        embeddingSpace: {
            findMany: (...args: unknown[]) => mockFindMany(...args),
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
            create: (...args: unknown[]) => mockCreate(...args),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { child: (scope: string) => mockChild(scope) },
}));

jest.mock("../../metrics", () => ({
    recordVibeProviderConfigError: (...args: unknown[]) =>
        mockRecordProviderConfigError(...args),
}));

import {
    EmbeddingSpaceDimensionMismatchError,
    EmbeddingSpacePreprocessingMismatchError,
    findRegisteredProviderEmbeddingSpace,
    getActiveSpace,
    invalidateActiveSpaceCache,
    NoActiveEmbeddingSpaceError,
    resolveProviderEmbeddingSpace,
    RetiredEmbeddingSpaceError,
} from "../embeddingSpaces";

const activeSpace = {
    id: "space-active",
    family: "clap-music-audioset",
    checkpointHash: "checkpoint-hash",
    dim: 512,
    preprocessing: { sampleRateHz: 48000, mono: true },
    createdAt: new Date("2026-08-16T12:00:00.000Z"),
};

describe("embeddingSpaces", () => {
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-08-16T12:00:00.000Z"),
        );
        jest.clearAllMocks();
        invalidateActiveSpaceCache();
        mockFindMany.mockResolvedValue([activeSpace]);
    });

    afterEach(() => {
        invalidateActiveSpaceCache();
        jest.useRealTimers();
    });

    it("caches one active space for sixty seconds", async () => {
        await expect(getActiveSpace()).resolves.toMatchObject({
            id: "space-active",
            dim: 512,
        });
        await getActiveSpace();
        expect(mockFindMany).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(59_999);
        await getActiveSpace();
        expect(mockFindMany).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(2);
        await getActiveSpace();
        expect(mockFindMany).toHaveBeenCalledTimes(2);
    });

    it("invalidates the cached active space explicitly", async () => {
        await getActiveSpace();
        invalidateActiveSpaceCache();
        await getActiveSpace();

        expect(mockFindMany).toHaveBeenCalledTimes(2);
    });

    it("throws a typed error when no space is active", async () => {
        mockFindMany.mockResolvedValue([]);

        const promise = getActiveSpace();
        await expect(promise).rejects.toBeInstanceOf(
            NoActiveEmbeddingSpaceError,
        );
        await expect(promise).rejects.toMatchObject({
            code: "NO_ACTIVE_EMBEDDING_SPACE",
        });
    });

    it("shares one in-flight load between concurrent callers", async () => {
        let resolveLoad: (rows: unknown[]) => void = () => {};
        mockFindMany.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveLoad = resolve;
                }),
        );

        const first = getActiveSpace();
        const second = getActiveSpace();
        resolveLoad([activeSpace]);

        await expect(first).resolves.toMatchObject({ id: "space-active" });
        await expect(second).resolves.toMatchObject({ id: "space-active" });
        expect(mockFindMany).toHaveBeenCalledTimes(1);
    });

    it("never lets a load started before invalidation repopulate the cache", async () => {
        let resolveLoad: (rows: unknown[]) => void = () => {};
        mockFindMany.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveLoad = resolve;
                }),
        );

        const stale = getActiveSpace();
        invalidateActiveSpaceCache();
        resolveLoad([activeSpace]);
        await expect(stale).resolves.toMatchObject({ id: "space-active" });

        await getActiveSpace();
        expect(mockFindMany).toHaveBeenCalledTimes(2);
    });

    it("clears the in-flight load after a rejection", async () => {
        mockFindMany
            .mockRejectedValueOnce(new Error("db down"))
            .mockResolvedValueOnce([activeSpace]);

        await expect(getActiveSpace()).rejects.toThrow("db down");
        await expect(getActiveSpace()).resolves.toMatchObject({
            id: "space-active",
        });
        expect(mockFindMany).toHaveBeenCalledTimes(2);
    });

    it("does not cache a zero-active failure", async () => {
        mockFindMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([activeSpace]);

        await expect(getActiveSpace()).rejects.toBeInstanceOf(
            NoActiveEmbeddingSpaceError,
        );
        await expect(getActiveSpace()).resolves.toMatchObject({
            id: "space-active",
        });
        expect(mockFindMany).toHaveBeenCalledTimes(2);
    });

    it("logs an invariant error and returns the oldest active space", async () => {
        const newer = {
            ...activeSpace,
            id: "space-newer",
            createdAt: new Date("2026-08-16T13:00:00.000Z"),
        };
        mockFindMany.mockResolvedValue([activeSpace, newer]);

        await expect(getActiveSpace()).resolves.toMatchObject({
            id: "space-active",
        });

        expect(mockFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { status: "active" },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                take: 2,
            }),
        );
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Multiple active embedding spaces violate the registry invariant; using the oldest",
            { activeSpaceIds: ["space-active", "space-newer"] },
        );
    });
});

describe("provider embedding-space resolution", () => {
    const providerSpace = {
        family: "dclap-student",
        checkpointHash: "sha256:student",
        dim: 512,
        sampleRateHz: 48_000,
        preprocessing: { mono: true, window: "middle" },
        revision: "2026-08-16",
        textTower: true,
    };
    const registrySpace = {
        id: "space-student",
        family: providerSpace.family,
        checkpointHash: providerSpace.checkpointHash,
        dim: providerSpace.dim,
        preprocessing: providerSpace.preprocessing,
        status: "migrating" as const,
        retiredAt: null,
        createdAt: new Date("2026-08-16T12:00:00.000Z"),
    };

    beforeEach(() => jest.clearAllMocks());

    it("returns a registered provider space without creating one", async () => {
        mockFindUnique.mockResolvedValue(registrySpace);

        await expect(
            findRegisteredProviderEmbeddingSpace(providerSpace),
        ).resolves.toEqual(registrySpace);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it("returns null for an unregistered provider without creating one", async () => {
        mockFindUnique.mockResolvedValue(null);

        await expect(
            findRegisteredProviderEmbeddingSpace(providerSpace),
        ).resolves.toBeNull();
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it.each(["active", "migrating"] as const)(
        "uses a matching %s registry row",
        async (status) => {
            mockFindUnique.mockResolvedValue({ ...registrySpace, status });

            await expect(
                resolveProviderEmbeddingSpace(providerSpace),
            ).resolves.toEqual({
                space: expect.objectContaining({
                    id: "space-student",
                    status,
                }),
                registered: false,
            });
            expect(mockCreate).not.toHaveBeenCalled();
        },
    );

    it("accepts canonically identical preprocessing documents", async () => {
        mockFindUnique.mockResolvedValue({
            ...registrySpace,
            preprocessing: { window: "middle", mono: true },
        });

        await expect(
            resolveProviderEmbeddingSpace({
                ...providerSpace,
                preprocessing: { mono: true, window: "middle" },
            }),
        ).resolves.toEqual({
            space: expect.objectContaining({ id: "space-student" }),
            registered: false,
        });
        expect(mockRecordProviderConfigError).not.toHaveBeenCalled();
    });

    it("refuses a tuple whose preprocessing document differs", async () => {
        mockFindUnique.mockResolvedValue({
            ...registrySpace,
            preprocessing: { mono: false, window: "middle" },
        });

        const resolution = resolveProviderEmbeddingSpace(providerSpace);

        await expect(resolution).rejects.toBeInstanceOf(
            EmbeddingSpacePreprocessingMismatchError,
        );
        await expect(resolution).rejects.toMatchObject({
            code: "EMBEDDING_SPACE_PREPROCESSING_MISMATCH",
            spaceId: "space-student",
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Embedding-space provider preprocessing does not match the registered tuple",
            { spaceId: "space-student" },
        );
        expect(mockRecordProviderConfigError).toHaveBeenCalledWith(
            "preprocessing_mismatch",
        );
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it("registers an unknown provider as migrating", async () => {
        mockFindUnique.mockResolvedValue(null);
        mockCreate.mockResolvedValue(registrySpace);

        await expect(
            resolveProviderEmbeddingSpace(providerSpace),
        ).resolves.toEqual({
            space: registrySpace,
            registered: true,
        });
        expect(mockCreate).toHaveBeenCalledWith({
            data: {
                family: providerSpace.family,
                checkpointHash: providerSpace.checkpointHash,
                dim: providerSpace.dim,
                preprocessing: providerSpace.preprocessing,
                status: "migrating",
            },
            select: expect.objectContaining({ id: true, status: true }),
        });
    });

    it("refuses an existing provider tuple whose registered dimension differs", async () => {
        mockFindUnique.mockResolvedValue({ ...registrySpace, dim: 768 });

        const resolution = resolveProviderEmbeddingSpace(providerSpace);

        await expect(resolution).rejects.toBeInstanceOf(
            EmbeddingSpaceDimensionMismatchError,
        );
        await expect(resolution).rejects.toMatchObject({
            code: "EMBEDDING_SPACE_DIMENSION_MISMATCH",
            spaceId: "space-student",
            registeredDim: 768,
            providerDim: 512,
        });
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it("uses the winning compatible row after a P2002 registration race", async () => {
        mockFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(registrySpace);
        mockCreate.mockRejectedValue({ code: "P2002" });

        await expect(
            resolveProviderEmbeddingSpace(providerSpace),
        ).resolves.toEqual({
            space: registrySpace,
            registered: false,
        });
        expect(mockFindUnique).toHaveBeenCalledTimes(2);
    });

    it("refuses a dimension mismatch discovered after a P2002 registration race", async () => {
        mockFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ ...registrySpace, dim: 768 });
        mockCreate.mockRejectedValue({ code: "P2002" });

        await expect(
            resolveProviderEmbeddingSpace(providerSpace),
        ).rejects.toBeInstanceOf(EmbeddingSpaceDimensionMismatchError);
    });

    it("refuses a retired provider with a typed error", async () => {
        mockFindUnique.mockResolvedValue({
            ...registrySpace,
            status: "retired",
            retiredAt: new Date("2026-08-15T12:00:00.000Z"),
        });

        const resolution = resolveProviderEmbeddingSpace(providerSpace);
        await expect(resolution).rejects.toBeInstanceOf(
            RetiredEmbeddingSpaceError,
        );
        await expect(resolution).rejects.toMatchObject({
            code: "RETIRED_EMBEDDING_SPACE",
            spaceId: "space-student",
        });
    });
});

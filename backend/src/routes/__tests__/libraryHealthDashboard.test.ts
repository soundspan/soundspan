import { type NextFunction, type Request, type Response } from "express";

type AuthMode = "ok" | "unauthorized" | "forbidden";
const auth = { mode: "ok" as AuthMode };
const summary = jest.fn();
const gaps = jest.fn();
const analysis = jest.fn();
const storage = jest.fn();
const quality = jest.fn();
const duplicates = jest.fn();
const invalidate = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, res: Response, next: NextFunction) =>
        auth.mode === "unauthorized"
            ? res.status(401).json({ error: "Unauthorized" })
            : next(),
    requireAdmin: (_req: Request, res: Response, next: NextFunction) =>
        auth.mode === "forbidden"
            ? res.status(403).json({ error: "Forbidden" })
            : next(),
}));
jest.mock("../../services/libraryHealthDashboard", () => ({
    METADATA_GAP_KINDS: [
        "missing-art",
        "missing-mbid",
        "missing-genres",
        "missing-lyrics",
    ],
    getLibraryHealthDashboardSummary: (...args: unknown[]) => summary(...args),
    getLibraryHealthMetadataGaps: (...args: unknown[]) => gaps(...args),
    getLibraryHealthAnalysis: (...args: unknown[]) => analysis(...args),
    getLibraryHealthStorage: (...args: unknown[]) => storage(...args),
    getLibraryHealthQuality: (...args: unknown[]) => quality(...args),
    getLibraryHealthDuplicates: (...args: unknown[]) => duplicates(...args),
    invalidateLibraryHealthDashboardCache: (...args: unknown[]) =>
        invalidate(...args),
}));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ error: jest.fn() }) },
}));

import router from "../libraryHealthDashboard";

const summaryFixture = {
    metadataGaps: {
        missingArt: { albums: 2, artists: 1 },
        missingMbid: { albums: 3, artists: 2 },
        missingGenres: 4,
        missingLyrics: 5,
    },
    analysisCoverage: {
        total: 20,
        analysisStatus: {
            pending: 2,
            processing: 1,
            failed: 3,
            completed: 14,
        },
        vibeAnalysisStatus: {
            pending: 5,
            processing: 2,
            failed: 1,
            completed: 12,
        },
        loudness: { measured: 15, missing: 5 },
    },
    storage: {
        tracks: 20,
        totalFileSize: 123_456,
        mimeTypes: 3,
        artists: 7,
        isTruncated: false,
    },
    quality: { floorKbps: 192, albumsBelowFloor: 2, isTruncated: false },
    duplicates: {
        clusters: 1,
        byTier: { audioHash: 1, recordingMbid: 0, isrc: 0 },
        isTruncated: false,
    },
};
const missingGenresFixture = {
    kind: "missing-genres",
    counts: { tracks: 1 },
    items: [
        {
            id: "track-1",
            title: "Track One",
            filePath: "/music/track-one.mp3",
            albumTitle: "Album One",
            artistName: "Artist One",
        },
    ],
    total: 1,
    limit: 10,
    offset: 5,
};
const analysisFixture = {
    total: 20,
    analysisStatus: {
        pending: 2,
        processing: 1,
        failed: 1,
        completed: 16,
    },
    vibeAnalysisStatus: {
        pending: 5,
        processing: 2,
        failed: 1,
        completed: 12,
    },
    loudness: { measured: 15, missing: 5 },
    failed: {
        items: [
            {
                id: "track-2",
                title: "Failed Track",
                artistName: "Artist Two",
                albumTitle: "Album Two",
                analysisError: "decoder rejected file",
            },
        ],
        total: 1,
        limit: 50,
        offset: 0,
    },
};
const storageFixture = {
    formats: [
        {
            mime: "MPEG 1 Layer 3",
            trackCount: 20,
            totalFileSize: 123_456,
            averageBitrateKbps: 192.4,
            bitrateSampleSize: 20,
        },
    ],
    topArtists: [
        {
            artistId: "artist-1",
            artistName: "Artist One",
            trackCount: 20,
            totalFileSize: 123_456,
        },
    ],
    sampledTracks: 20,
    sampleLimit: 100_000,
    isTruncated: false,
};
const qualityFixture = {
    floorKbps: 160,
    items: [
        {
            albumId: "album-1",
            title: "Album One",
            artist: { id: "artist-1", name: "Artist One" },
            averageBitrateKbps: 128,
            trackCount: 10,
        },
    ],
    total: 1,
    limit: 50,
    offset: 0,
    sampledTracks: 20,
    sampleLimit: 100_000,
    isTruncated: false,
};
const duplicatesFixture = {
    clusters: [
        {
            tier: "audioHash",
            identity: "hash-1",
            memberCount: 2,
            totalFileSize: 12_000,
            members: [
                {
                    id: "track-3",
                    title: "Duplicate Track",
                    albumTitle: "Album Three",
                    artistName: "Artist Three",
                    filePath: "/music/duplicate-a.flac",
                    fileSize: 6_000,
                    mime: "FLAC",
                },
                {
                    id: "track-4",
                    title: "Duplicate Track",
                    albumTitle: "Album Four",
                    artistName: "Artist Four",
                    filePath: "/music/duplicate-b.flac",
                    fileSize: 6_000,
                    mime: "FLAC",
                },
            ],
        },
    ],
    total: 1,
    byTier: { audioHash: 1, recordingMbid: 0, isrc: 0 },
    isTruncated: false,
    limit: 50,
    offset: 0,
};

function getHandler(path: string, method: "get" | "post") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) throw new Error(`Route not found: ${method} ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn((statusCode: number) => {
            res.statusCode = statusCode;
            return res;
        }),
        json: jest.fn((payload: unknown) => {
            res.body = payload;
            return res;
        }),
    };
    return res;
}

async function invoke(
    path: string,
    method: "get" | "post",
    request: { query?: unknown; params?: unknown; body?: unknown } = {},
) {
    const res = createRes();
    const next = jest.fn((error?: unknown) => {
        if (error) throw error;
    });
    await getHandler(path, method)(
        {
            query: request.query ?? {},
            params: request.params ?? {},
            body: request.body,
        },
        res,
        next,
    );
    expect(next).not.toHaveBeenCalled();
    return res;
}

describe("library health dashboard routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        auth.mode = "ok";
        summary.mockResolvedValue(summaryFixture);
        gaps.mockResolvedValue(missingGenresFixture);
        analysis.mockResolvedValue(analysisFixture);
        storage.mockResolvedValue(storageFixture);
        quality.mockResolvedValue(qualityFixture);
        duplicates.mockResolvedValue(duplicatesFixture);
        invalidate.mockResolvedValue(undefined);
    });

    it.each([
        ["/gaps/:kind", { params: { kind: "not-a-gap" } }],
        [
            "/gaps/:kind",
            { params: { kind: "missing-art" }, query: { limit: "101" } },
        ],
        ["/analysis", { query: { limit: "101" } }],
        ["/quality", { query: { floor: "31" } }],
        ["/quality", { query: { unexpected: "true" } }],
        ["/duplicates", { query: { limit: "51" } }],
    ] as const)("rejects invalid input for %s", async (path, request) => {
        const response = await invoke(path, "get", request);
        expect(response.statusCode).toBe(400);
        expect(response.body).toEqual({
            error: "Invalid library health request",
        });
    });

    it("rejects limit[]=50 instead of coercing the array", async () => {
        const response = await invoke("/analysis", "get", {
            query: { limit: ["50"] },
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).toEqual({
            error: "Invalid library health request",
        });
    });

    it("returns the complete summary response", async () => {
        const response = await invoke("/summary", "get");

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(summaryFixture);
    });

    it("returns complete flat missing-genre track rows", async () => {
        const response = await invoke("/gaps/:kind", "get", {
            params: { kind: "missing-genres" },
            query: { limit: "10", offset: "5" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(missingGenresFixture);
        expect(gaps).toHaveBeenCalledWith("missing-genres", {
            limit: 10,
            offset: 5,
        });
    });

    it("returns the complete analysis response", async () => {
        const response = await invoke("/analysis", "get");

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(analysisFixture);
    });

    it("returns the complete quality response", async () => {
        const response = await invoke("/quality", "get", {
            query: { floor: "160" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(qualityFixture);
        expect(quality).toHaveBeenCalledWith(160, { limit: 50, offset: 0 });
    });

    it("returns the complete duplicate-cluster response", async () => {
        const response = await invoke("/duplicates", "get");

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(duplicatesFixture);
    });

    it("returns the complete storage response", async () => {
        const response = await invoke("/storage", "get");

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual(storageFixture);
    });

    it("invalidates caches before returning the complete refreshed summary", async () => {
        const response = await invoke("/refresh", "post", { body: {} });

        expect(response.statusCode).toBe(200);
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(summary).toHaveBeenCalledTimes(1);
        expect(response.body).toEqual(summaryFixture);
    });

    it("returns the canonical internal error when invalidation fails", async () => {
        invalidate.mockRejectedValueOnce(new Error("generation unavailable"));

        const response = await invoke("/refresh", "post", { body: {} });

        expect(response.statusCode).toBe(500);
        expect(response.body).toEqual({
            error: "Failed to refresh library health dashboard",
        });
        expect(summary).not.toHaveBeenCalled();
    });
});

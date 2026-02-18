jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
    requireAdmin: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const programmaticPlaylistService = {
    generateAllMixes: jest.fn(),
    generateMoodOnDemand: jest.fn(),
};
jest.mock("../../services/programmaticPlaylists", () => ({
    programmaticPlaylistService,
}));

const mockValidMoods = ["happy", "sad", "chill"] as const;
const moodBucketService = {
    getMoodPresets: jest.fn(),
    getMoodMix: jest.fn(),
    saveUserMoodMix: jest.fn(),
    backfillAllTracks: jest.fn(),
};
jest.mock("../../services/moodBucketService", () => ({
    moodBucketService,
    VALID_MOODS: mockValidMoods,
}));

const prisma = {
    track: {
        findMany: jest.fn(),
    },
    user: {
        update: jest.fn(),
    },
    playlist: {
        findFirst: jest.fn(),
        create: jest.fn(),
    },
    playlistItem: {
        createMany: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const redisClient = {
    get: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
};
jest.mock("../../utils/redis", () => ({
    redisClient,
}));

import router from "../mixes";

function getHandler(
    path: string,
    method: "get" | "post" | "put" | "delete"
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) {
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };
    return res;
}

describe("mixes route runtime", () => {
    const getMixes = getHandler("/", "get");
    const generateMood = getHandler("/mood", "post");
    const getMoodPresetsStatic = getHandler("/mood/presets", "get");
    const saveMoodPrefs = getHandler("/mood/save-preferences", "post");
    const getMoodBucketPresets = getHandler("/mood/buckets/presets", "get");
    const getMoodBucketMix = getHandler("/mood/buckets/:mood", "get");
    const saveMoodBucketMix = getHandler("/mood/buckets/:mood/save", "post");
    const backfillMoodBuckets = getHandler("/mood/buckets/backfill", "post");
    const refreshMixes = getHandler("/refresh", "post");
    const saveMixAsPlaylist = getHandler("/:id/save", "post");
    const getSingleMix = getHandler("/:id", "get");

    beforeEach(() => {
        jest.clearAllMocks();

        redisClient.get.mockResolvedValue(null);
        redisClient.setEx.mockResolvedValue("OK");
        redisClient.del.mockResolvedValue(1);

        programmaticPlaylistService.generateAllMixes.mockResolvedValue([
            {
                id: "mix-1",
                name: "Mix One",
                trackIds: ["t-1", "t-2"],
                trackCount: 2,
            },
        ]);
        programmaticPlaylistService.generateMoodOnDemand.mockResolvedValue({
            id: "mood-on-demand",
            name: "Mood Mix",
            trackIds: ["t-2", "t-1"],
            trackCount: 2,
        });

        moodBucketService.getMoodPresets.mockResolvedValue([
            { mood: "happy", count: 25 },
        ]);
        moodBucketService.getMoodMix.mockResolvedValue({
            id: "bucket-happy",
            name: "Happy Mix",
            trackIds: ["t-1", "t-2"],
            trackCount: 2,
        });
        moodBucketService.saveUserMoodMix.mockResolvedValue({
            id: "saved-happy",
            name: "Your Happy Mix",
            trackIds: ["t-2", "t-1"],
            trackCount: 2,
        });
        moodBucketService.backfillAllTracks.mockResolvedValue({
            processed: 120,
            assigned: 89,
        });

        prisma.track.findMany.mockResolvedValue([
            { id: "t-1", title: "Track 1", album: { artist: { name: "A1" } } },
            { id: "t-2", title: "Track 2", album: { artist: { name: "A2" } } },
        ]);
        prisma.user.update.mockResolvedValue({});
        prisma.playlist.findFirst.mockResolvedValue(null);
        prisma.playlist.create.mockResolvedValue({
            id: "pl-1",
            name: "Mix One",
        });
        prisma.playlistItem.createMany.mockResolvedValue({ count: 2 });
    });

    it("returns mixes from cache and falls back to generation", async () => {
        const unauthorizedReq = {} as any;
        const unauthorizedRes = createRes();
        await getMixes(unauthorizedReq, unauthorizedRes);
        expect(unauthorizedRes.statusCode).toBe(401);

        redisClient.get.mockResolvedValueOnce(
            JSON.stringify([{ id: "cached", trackIds: [], trackCount: 0 }])
        );
        const cachedReq = { user: { id: "u1" } } as any;
        const cachedRes = createRes();
        await getMixes(cachedReq, cachedRes);
        expect(cachedRes.statusCode).toBe(200);
        expect(cachedRes.body[0].id).toBe("cached");

        redisClient.get.mockResolvedValueOnce(null);
        const generatedReq = { session: { userId: "u1" } } as any;
        const generatedRes = createRes();
        await getMixes(generatedReq, generatedRes);
        expect(generatedRes.statusCode).toBe(200);
        expect(programmaticPlaylistService.generateAllMixes).toHaveBeenCalledWith(
            "u1"
        );
        expect(redisClient.setEx).toHaveBeenCalled();
    });

    it("validates and generates mood mixes", async () => {
        const unauthorizedReq = { body: {} } as any;
        const unauthorizedRes = createRes();
        await generateMood(unauthorizedReq, unauthorizedRes);
        expect(unauthorizedRes.statusCode).toBe(401);

        const invalidParamReq = {
            user: { id: "u1" },
            body: { notARealParam: true },
        } as any;
        const invalidParamRes = createRes();
        await generateMood(invalidParamReq, invalidParamRes);
        expect(invalidParamRes.statusCode).toBe(400);

        programmaticPlaylistService.generateMoodOnDemand.mockResolvedValueOnce(null);
        const noMixReq = { user: { id: "u1" }, body: { energy: { min: 0.5 } } } as any;
        const noMixRes = createRes();
        await generateMood(noMixReq, noMixRes);
        expect(noMixRes.statusCode).toBe(400);
        expect(noMixRes.body.error).toBe("Not enough tracks matching your criteria");

        const okReq = { user: { id: "u1" }, body: { energy: { min: 0.5 } } } as any;
        const okRes = createRes();
        await generateMood(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body.tracks.map((t: any) => t.id)).toEqual(["t-2", "t-1"]);
    });

    it("returns static mood presets", async () => {
        const req = {} as any;
        const res = createRes();
        await getMoodPresetsStatic(req, res);

        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.some((preset: any) => preset.id === "happy")).toBe(true);
    });

    it("saves mood preferences and invalidates cache", async () => {
        const unauthorizedReq = { body: { energy: { min: 0.3 } } } as any;
        const unauthorizedRes = createRes();
        await saveMoodPrefs(unauthorizedReq, unauthorizedRes);
        expect(unauthorizedRes.statusCode).toBe(401);

        const missingParamsReq = { user: { id: "u1" }, body: {} } as any;
        const missingParamsRes = createRes();
        await saveMoodPrefs(missingParamsReq, missingParamsRes);
        expect(missingParamsRes.statusCode).toBe(400);

        const okReq = {
            user: { id: "u1" },
            body: { moodHappy: { min: 0.4 }, energy: { min: 0.5 } },
        } as any;
        const okRes = createRes();
        await saveMoodPrefs(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: "u1" },
            data: { moodMixParams: okReq.body },
        });
        expect(redisClient.del).toHaveBeenCalledWith("mixes:u1");
    });

    it("serves mood bucket presets and mood bucket mixes", async () => {
        const presetsReq = {} as any;
        const presetsRes = createRes();
        await getMoodBucketPresets(presetsReq, presetsRes);
        expect(presetsRes.statusCode).toBe(200);
        expect(presetsRes.body).toEqual([{ mood: "happy", count: 25 }]);

        const invalidMoodReq = { params: { mood: "angry" } } as any;
        const invalidMoodRes = createRes();
        await getMoodBucketMix(invalidMoodReq, invalidMoodRes);
        expect(invalidMoodRes.statusCode).toBe(400);

        moodBucketService.getMoodMix.mockResolvedValueOnce(null);
        const noMixReq = { params: { mood: "happy" } } as any;
        const noMixRes = createRes();
        await getMoodBucketMix(noMixReq, noMixRes);
        expect(noMixRes.statusCode).toBe(400);

        const okReq = { params: { mood: "happy" } } as any;
        const okRes = createRes();
        await getMoodBucketMix(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body.tracks.map((t: any) => t.id)).toEqual(["t-1", "t-2"]);
    });

    it("saves mood bucket mixes and supports backfill", async () => {
        const unauthorizedSaveReq = { params: { mood: "happy" } } as any;
        const unauthorizedSaveRes = createRes();
        await saveMoodBucketMix(unauthorizedSaveReq, unauthorizedSaveRes);
        expect(unauthorizedSaveRes.statusCode).toBe(401);

        const invalidMoodReq = {
            user: { id: "u1" },
            params: { mood: "angry" },
        } as any;
        const invalidMoodRes = createRes();
        await saveMoodBucketMix(invalidMoodReq, invalidMoodRes);
        expect(invalidMoodRes.statusCode).toBe(400);

        moodBucketService.saveUserMoodMix.mockResolvedValueOnce(null);
        const noMixReq = {
            user: { id: "u1" },
            params: { mood: "happy" },
        } as any;
        const noMixRes = createRes();
        await saveMoodBucketMix(noMixReq, noMixRes);
        expect(noMixRes.statusCode).toBe(400);

        const okSaveReq = {
            user: { id: "u1" },
            params: { mood: "happy" },
        } as any;
        const okSaveRes = createRes();
        await saveMoodBucketMix(okSaveReq, okSaveRes);
        expect(okSaveRes.statusCode).toBe(200);
        expect(okSaveRes.body.success).toBe(true);
        expect(redisClient.del).toHaveBeenCalledWith("mixes:u1");

        const unauthorizedBackfillReq = {} as any;
        const unauthorizedBackfillRes = createRes();
        await backfillMoodBuckets(unauthorizedBackfillReq, unauthorizedBackfillRes);
        expect(unauthorizedBackfillRes.statusCode).toBe(401);

        const okBackfillReq = { user: { id: "admin-1" } } as any;
        const okBackfillRes = createRes();
        await backfillMoodBuckets(okBackfillReq, okBackfillRes);
        expect(okBackfillRes.statusCode).toBe(200);
        expect(okBackfillRes.body).toEqual({
            success: true,
            processed: 120,
            assigned: 89,
        });
    });

    it("refreshes mixes, saves mixes as playlists, and fetches single mixes", async () => {
        const refreshUnauthorizedReq = {} as any;
        const refreshUnauthorizedRes = createRes();
        await refreshMixes(refreshUnauthorizedReq, refreshUnauthorizedRes);
        expect(refreshUnauthorizedRes.statusCode).toBe(401);

        const refreshReq = { user: { id: "u1" } } as any;
        const refreshRes = createRes();
        await refreshMixes(refreshReq, refreshRes);
        expect(refreshRes.statusCode).toBe(200);
        expect(programmaticPlaylistService.generateAllMixes).toHaveBeenCalledWith(
            "u1",
            true
        );

        const saveUnauthorizedReq = { params: { id: "mix-1" }, body: {} } as any;
        const saveUnauthorizedRes = createRes();
        await saveMixAsPlaylist(saveUnauthorizedReq, saveUnauthorizedRes);
        expect(saveUnauthorizedRes.statusCode).toBe(401);

        redisClient.get.mockResolvedValueOnce(JSON.stringify([]));
        const saveMissingReq = {
            user: { id: "u1" },
            params: { id: "mix-404" },
            body: {},
        } as any;
        const saveMissingRes = createRes();
        await saveMixAsPlaylist(saveMissingReq, saveMissingRes);
        expect(saveMissingRes.statusCode).toBe(404);

        redisClient.get.mockResolvedValueOnce(
            JSON.stringify([{ id: "mix-1", name: "Mix One", trackIds: ["t-1"] }])
        );
        prisma.playlist.findFirst.mockResolvedValueOnce({
            id: "pl-existing",
            name: "Mix One",
        });
        const conflictReq = {
            user: { id: "u1" },
            params: { id: "mix-1" },
            body: {},
        } as any;
        const conflictRes = createRes();
        await saveMixAsPlaylist(conflictReq, conflictRes);
        expect(conflictRes.statusCode).toBe(409);

        redisClient.get.mockResolvedValueOnce(
            JSON.stringify([
                { id: "mix-1", name: "Mix One", trackIds: ["t-1", "t-2"] },
            ])
        );
        prisma.playlist.findFirst.mockResolvedValueOnce(null);
        const saveOkReq = {
            user: { id: "u1" },
            params: { id: "mix-1" },
            body: { name: "Saved Mix" },
        } as any;
        const saveOkRes = createRes();
        await saveMixAsPlaylist(saveOkReq, saveOkRes);
        expect(saveOkRes.statusCode).toBe(200);
        expect(prisma.playlist.create).toHaveBeenCalled();
        expect(prisma.playlistItem.createMany).toHaveBeenCalled();

        const singleUnauthorizedReq = { params: { id: "mix-1" } } as any;
        const singleUnauthorizedRes = createRes();
        await getSingleMix(singleUnauthorizedReq, singleUnauthorizedRes);
        expect(singleUnauthorizedRes.statusCode).toBe(401);

        redisClient.get.mockResolvedValueOnce(JSON.stringify([]));
        const singleMissingReq = {
            user: { id: "u1" },
            params: { id: "missing" },
        } as any;
        const singleMissingRes = createRes();
        await getSingleMix(singleMissingReq, singleMissingRes);
        expect(singleMissingRes.statusCode).toBe(404);

        redisClient.get.mockResolvedValueOnce(
            JSON.stringify([
                {
                    id: "mix-1",
                    name: "Mix One",
                    trackIds: ["t-2", "t-1"],
                    trackCount: 2,
                },
            ])
        );
        const singleReq = { user: { id: "u1" }, params: { id: "mix-1" } } as any;
        const singleRes = createRes();
        await getSingleMix(singleReq, singleRes);
        expect(singleRes.statusCode).toBe(200);
        expect(singleRes.body.tracks.map((t: any) => t.id)).toEqual(["t-2", "t-1"]);
    });
});

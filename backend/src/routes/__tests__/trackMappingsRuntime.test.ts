jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const trackMappingService = {
    getMappingsForAlbum: jest.fn(),
    createMapping: jest.fn(),
};
jest.mock("../../services/trackMappingService", () => ({
    trackMappingService,
}));

import router from "../trackMappings";

function getHandler(path: string, method: "get" | "post") {
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

describe("trackMappings route runtime", () => {
    const getAlbumMappings = getHandler("/album/:albumId", "get");
    const postBatchMappings = getHandler("/batch", "post");

    beforeEach(() => {
        jest.clearAllMocks();
        trackMappingService.getMappingsForAlbum.mockResolvedValue([]);
        trackMappingService.createMapping.mockResolvedValue({
            id: "cm_1",
            trackId: "track_1",
            trackTidalId: "ct_1",
            trackYtMusicId: null,
            confidence: 0.9,
            source: "manual",
            stale: false,
        });
    });

    it("returns album mappings", async () => {
        trackMappingService.getMappingsForAlbum.mockResolvedValueOnce([
            { id: "cm_1" },
        ]);

        const req = { params: { albumId: "album_1" } } as any;
        const res = createRes();

        await getAlbumMappings(req, res);

        expect(trackMappingService.getMappingsForAlbum).toHaveBeenCalledWith(
            "album_1"
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ mappings: [{ id: "cm_1" }] });
    });

    it("rejects batch payload items with no linkage keys", async () => {
        const req = {
            body: {
                mappings: [
                    {
                        confidence: 0.8,
                        source: "gap-fill",
                    },
                ],
            },
        } as any;
        const res = createRes();

        await postBatchMappings(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid mappings array",
                details: expect.arrayContaining([
                    expect.objectContaining({
                        message: expect.stringContaining(
                            "At least one linkage key is required"
                        ),
                    }),
                ]),
            })
        );
        expect(trackMappingService.createMapping).not.toHaveBeenCalled();
    });

    it("accepts batch payload when at least one linkage key is present", async () => {
        const req = {
            body: {
                mappings: [
                    {
                        trackId: "track_1",
                        confidence: 0.9,
                        source: "manual",
                    },
                    {
                        trackTidalId: "ct_1",
                        confidence: 0.7,
                        source: "gap-fill",
                    },
                ],
            },
        } as any;
        const res = createRes();

        await postBatchMappings(req, res);

        expect(res.statusCode).toBe(200);
        expect(trackMappingService.createMapping).toHaveBeenCalledTimes(2);
        expect(trackMappingService.createMapping).toHaveBeenNthCalledWith(1, {
            trackId: "track_1",
            confidence: 0.9,
            source: "manual",
        });
        expect(trackMappingService.createMapping).toHaveBeenNthCalledWith(2, {
            trackTidalId: "ct_1",
            confidence: 0.7,
            source: "gap-fill",
        });
        expect(res.body).toEqual(
            expect.objectContaining({
                mappings: expect.any(Array),
            })
        );
    });
});

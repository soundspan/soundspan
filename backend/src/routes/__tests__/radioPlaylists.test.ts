import type { Request, Response } from "express";

jest.mock("../../config", () => ({ config: { port: 3006 } }));

jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});

const prisma = {
    playlist: {
        findUnique: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
    },
    playlistItem: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        createMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({ prisma }));

const selectLibraryRadioStationTracks = jest.fn();
jest.mock("../../services/libraryRadioStationSelection", () => ({
    isLibraryRadioPlaylistType: (value: string) =>
        ["genre", "decade", "discovery", "favorites", "workout"].includes(
            value,
        ),
    selectLibraryRadioStationTracks,
}));

import { radioPlaylistRouter } from "../library/radioPlaylists";
import { swaggerSpec } from "../../config/swagger";

type HttpMethod = "post";
const MAX_ROUTE_HANDLERS = 3;

function getRouteStack(path: string, method: HttpMethod) {
    const layer = (radioPlaylistRouter as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    }
    return layer.route.stack;
}

async function invoke(path: string, req: any, res: any) {
    const stack = getRouteStack(path, "post");
    for (let index = 0; index < MAX_ROUTE_HANDLERS; index += 1) {
        const entry = stack[index];
        if (!entry) return;
        let nextCalled = false;
        await entry.handle(req, res, () => {
            nextCalled = true;
        });
        if (!nextCalled) return;
    }
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

describe("radio-generated playlist routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.$transaction.mockImplementation(async (operation: any) =>
            operation(prisma),
        );
        prisma.$queryRaw.mockResolvedValue([
            {
                id: "playlist-1",
                userId: "user-1",
                mixId: "radio-ephemeral:genre:Rock",
            },
        ]);
        prisma.playlist.findUnique.mockResolvedValue(null);
        prisma.playlist.create.mockResolvedValue({ id: "playlist-1" });
        prisma.playlist.upsert.mockResolvedValue({
            id: "playlist-1",
            name: "Rock Radio",
        });
        prisma.playlist.update.mockResolvedValue({ id: "playlist-1" });
        prisma.playlistItem.findMany.mockResolvedValue([]);
        prisma.playlistItem.deleteMany.mockResolvedValue({ count: 0 });
        prisma.playlistItem.createMany.mockResolvedValue({ count: 0 });
        selectLibraryRadioStationTracks.mockResolvedValue({ tracks: [] });
    });

    it("returns an existing station playlist without selecting or mutating tracks", async () => {
        prisma.playlist.findUnique.mockResolvedValue({
            id: "playlist-existing",
            items: [{ trackId: "track-1" }, { trackId: "track-2" }],
        });
        const res = createRes();

        await invoke(
            "/radio/playlists",
            {
                user: { id: "user-1" },
                body: { filter: { type: "genre", value: "Rock" } },
            },
            res,
        );

        expect(res.body).toEqual({
            playlistId: "playlist-existing",
            entries: [{ id: "track-1" }, { id: "track-2" }],
        });
        expect(selectLibraryRadioStationTracks).not.toHaveBeenCalled();
        expect(prisma.playlist.create).not.toHaveBeenCalled();
        expect(prisma.playlist.upsert).not.toHaveBeenCalled();
        expect(prisma.playlistItem.deleteMany).not.toHaveBeenCalled();
        expect(prisma.playlistItem.createMany).not.toHaveBeenCalled();
    });

    it("generates by the shared selector when the station playlist is absent", async () => {
        prisma.playlist.findUnique.mockResolvedValue(null);
        const tracks = [{ id: "track-1" }, { id: "track-2" }];
        selectLibraryRadioStationTracks.mockResolvedValue({ tracks });
        prisma.playlistItem.createMany.mockResolvedValue({ count: 2 });
        const res = createRes();

        await invoke(
            "/radio/playlists",
            {
                user: { id: "user-1" },
                body: {
                    filter: { type: "genre", value: "Rock" },
                },
            },
            res,
        );

        expect(selectLibraryRadioStationTracks).toHaveBeenCalledWith(
            {
                type: "genre",
                value: "rock",
                limit: 25,
                userId: "user-1",
            },
            prisma,
        );
        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    userId: "user-1",
                    mixId: "radio-ephemeral:genre:rock",
                    name: "Rock Radio",
                    isPublic: false,
                },
            }),
        );
        expect(prisma.playlistItem.deleteMany).toHaveBeenCalledWith({
            where: { playlistId: "playlist-1" },
        });
        expect(prisma.playlistItem.createMany).toHaveBeenCalledWith({
            data: [
                { playlistId: "playlist-1", trackId: "track-1", sort: 0 },
                { playlistId: "playlist-1", trackId: "track-2", sort: 1 },
            ],
            skipDuplicates: true,
        });
        expect(res.body).toEqual({
            playlistId: "playlist-1",
            entries: tracks,
        });
    });

    it("rejects generation and append batch sizes outside 1..100", async () => {
        const generateRes = createRes();
        const appendRes = createRes();

        await invoke(
            "/radio/playlists",
            {
                user: { id: "user-1" },
                body: { filter: { type: "workout" }, size: 101 },
            },
            generateRes,
        );
        await invoke(
            "/radio/playlists/:id/append",
            {
                user: { id: "user-1" },
                params: { id: "playlist-1" },
                body: { count: 0 },
            },
            appendRes,
        );

        expect(generateRes.statusCode).toBe(400);
        expect(appendRes.statusCode).toBe(400);
        expect(selectLibraryRadioStationTracks).not.toHaveBeenCalled();
    });

    it("validates playlist ownership before append", async () => {
        prisma.$queryRaw.mockResolvedValue([
            {
                id: "playlist-1",
                userId: "user-2",
                mixId: "radio-ephemeral:genre:Rock",
            },
        ]);
        const res = createRes();

        await invoke(
            "/radio/playlists/:id/append",
            {
                user: { id: "user-1" },
                params: { id: "playlist-1" },
                body: { count: 25 },
            },
            res,
        );

        expect(res.statusCode).toBe(403);
        expect(selectLibraryRadioStationTracks).not.toHaveBeenCalled();
    });

    it("validates playlist ownership before regeneration", async () => {
        prisma.$queryRaw.mockResolvedValue([
            {
                id: "playlist-1",
                userId: "user-2",
                mixId: "radio-ephemeral:decade:1990",
            },
        ]);
        const res = createRes();

        await invoke(
            "/radio/playlists/:id/regenerate",
            {
                user: { id: "user-1" },
                params: { id: "playlist-1" },
                body: {},
            },
            res,
        );

        expect(res.statusCode).toBe(403);
        expect(selectLibraryRadioStationTracks).not.toHaveBeenCalled();
    });

    it("appends only new tracks and assigns consecutive sort positions", async () => {
        prisma.$queryRaw.mockResolvedValue([
            {
                id: "playlist-1",
                userId: "user-1",
                mixId: "radio-ephemeral:genre:Rock",
            },
        ]);
        prisma.playlistItem.findMany.mockResolvedValue([
            { trackId: "track-1", sort: 0 },
            { trackId: "track-2", sort: 1 },
        ]);
        selectLibraryRadioStationTracks.mockResolvedValue({
            tracks: [{ id: "track-2" }, { id: "track-3" }, { id: "track-4" }],
        });
        prisma.playlistItem.createMany.mockResolvedValue({ count: 2 });
        const res = createRes();

        await invoke(
            "/radio/playlists/:id/append",
            {
                user: { id: "user-1" },
                params: { id: "playlist-1" },
                body: { count: 2 },
            },
            res,
        );

        expect(selectLibraryRadioStationTracks).toHaveBeenCalledWith(
            {
                type: "genre",
                value: "Rock",
                limit: 4,
                userId: "user-1",
            },
            prisma,
        );
        expect(prisma.playlistItem.createMany).toHaveBeenCalledWith({
            data: [
                { playlistId: "playlist-1", trackId: "track-3", sort: 2 },
                { playlistId: "playlist-1", trackId: "track-4", sort: 3 },
            ],
            skipDuplicates: true,
        });
        expect(res.body).toEqual({
            playlistId: "playlist-1",
            entries: [{ id: "track-3" }, { id: "track-4" }],
        });
    });

    it("reports only the rows accepted by createMany", async () => {
        prisma.$queryRaw.mockResolvedValue([
            {
                id: "playlist-1",
                userId: "user-1",
                mixId: "radio-ephemeral:genre:Rock",
            },
        ]);
        prisma.playlistItem.findMany.mockResolvedValue([
            { trackId: "track-1", sort: 0 },
        ]);
        selectLibraryRadioStationTracks.mockResolvedValue({
            tracks: [{ id: "track-2" }, { id: "track-3" }],
        });
        prisma.playlistItem.createMany.mockResolvedValue({ count: 1 });
        const res = createRes();

        await invoke(
            "/radio/playlists/:id/append",
            {
                user: { id: "user-1" },
                params: { id: "playlist-1" },
                body: { count: 2 },
            },
            res,
        );

        expect(res.body).toEqual({
            playlistId: "playlist-1",
            entries: [{ id: "track-2" }],
        });
    });

    it("retries a bounded playlist transaction after a lock timeout", async () => {
        prisma.$transaction
            .mockRejectedValueOnce(new Error("lock timeout"))
            .mockImplementationOnce(async (operation: any) =>
                operation(prisma),
            );
        const res = createRes();

        await invoke(
            "/radio/playlists/:id/append",
            {
                user: { id: "user-1" },
                params: { id: "playlist-1" },
                body: { count: 2 },
            },
            res,
        );

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(res.body).toEqual({ playlistId: "playlist-1", entries: [] });
    });

    it("binds playlist ownership into the row-lock query", async () => {
        const res = createRes();

        await invoke(
            "/radio/playlists/:id/append",
            {
                user: { id: "user-1" },
                params: { id: "playlist-1" },
                body: { count: 2 },
            },
            res,
        );

        expect(
            prisma.$queryRaw.mock.calls.some((call) => {
                const boundValues = call.slice(1);
                return (
                    boundValues.includes("playlist-1") &&
                    boundValues.includes("user-1")
                );
            }),
        ).toBe(true);
    });

    it("returns a typed 503 after retryable transaction failures exhaust", async () => {
        jest.useFakeTimers();
        try {
            prisma.$transaction.mockRejectedValue(
                Object.assign(new Error("lock timeout"), { code: "55P03" }),
            );
            const res = createRes();

            const request = invoke(
                "/radio/playlists/:id/append",
                {
                    user: { id: "user-1" },
                    params: { id: "playlist-1" },
                    body: { count: 2 },
                },
                res,
            );
            await jest.runAllTimersAsync();
            await request;

            expect(prisma.$transaction).toHaveBeenCalledTimes(3);
            expect(res.statusCode).toBe(503);
            expect(res.body).toEqual({
                error: "Radio playlist is temporarily unavailable",
                code: "RADIO_PLAYLIST_RETRY_EXHAUSTED",
            });
        } finally {
            jest.useRealTimers();
        }
    });

    it("regenerates an owned playlist by replacing its entries", async () => {
        prisma.$queryRaw.mockResolvedValue([
            {
                id: "playlist-1",
                userId: "user-1",
                mixId: "radio-ephemeral:decade:1990",
            },
        ]);
        prisma.playlistItem.findMany.mockResolvedValue([
            { trackId: "old-1", sort: 0 },
            { trackId: "old-2", sort: 1 },
        ]);
        selectLibraryRadioStationTracks.mockResolvedValue({
            tracks: [{ id: "new-1" }, { id: "new-2" }],
        });
        prisma.playlistItem.createMany.mockResolvedValue({ count: 2 });
        const res = createRes();

        await invoke(
            "/radio/playlists/:id/regenerate",
            {
                user: { id: "user-1" },
                params: { id: "playlist-1" },
                body: {},
            },
            res,
        );

        expect(selectLibraryRadioStationTracks).toHaveBeenCalledWith(
            {
                type: "decade",
                value: "1990",
                limit: 2,
                userId: "user-1",
            },
            prisma,
        );
        expect(prisma.playlistItem.deleteMany).toHaveBeenCalledWith({
            where: { playlistId: "playlist-1" },
        });
        expect(prisma.playlistItem.createMany).toHaveBeenCalledWith({
            data: [
                { playlistId: "playlist-1", trackId: "new-1", sort: 0 },
                { playlistId: "playlist-1", trackId: "new-2", sort: 1 },
            ],
            skipDuplicates: true,
        });
        expect(res.body).toEqual({
            playlistId: "playlist-1",
            entries: [{ id: "new-1" }, { id: "new-2" }],
        });
    });

    it("documents the create filter as the runtime discriminated union", () => {
        type FilterContract = {
            discriminator?: { propertyName: string };
            oneOf: Array<{
                additionalProperties?: boolean;
                required?: string[];
                properties: Record<string, { enum?: string[] }>;
            }>;
        };
        const document = swaggerSpec as {
            paths: Record<
                string,
                {
                    post: {
                        requestBody: {
                            content: {
                                "application/json": {
                                    schema: {
                                        properties: {
                                            filter: FilterContract;
                                        };
                                    };
                                };
                            };
                        };
                    };
                }
            >;
        };
        const filter =
            document.paths["/api/library/radio/playlists"].post.requestBody
                .content["application/json"].schema.properties.filter;

        expect(filter.discriminator).toEqual({ propertyName: "type" });
        expect(filter.oneOf).toHaveLength(5);
        expect(
            filter.oneOf.map((variant) => variant.properties.type.enum?.[0]),
        ).toEqual(["genre", "decade", "discovery", "favorites", "workout"]);
        expect(filter.oneOf[0]).toEqual(
            expect.objectContaining({
                additionalProperties: false,
                required: ["type", "value"],
            }),
        );
        expect(filter.oneOf[1]).toEqual(
            expect.objectContaining({
                additionalProperties: false,
                required: ["type", "value"],
            }),
        );
        for (const variant of filter.oneOf.slice(2)) {
            expect(variant).toEqual(
                expect.objectContaining({
                    additionalProperties: false,
                    required: ["type"],
                }),
            );
            expect(variant.properties).not.toHaveProperty("value");
        }
    });
});

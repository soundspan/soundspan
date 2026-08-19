import type { Request, Response } from "express";

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
        upsert: jest.fn(),
        update: jest.fn(),
    },
    playlistItem: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        createMany: jest.fn(),
    },
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

    it("generates by the shared selector and replaces the same station playlist", async () => {
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

        expect(selectLibraryRadioStationTracks).toHaveBeenCalledWith({
            type: "genre",
            value: "rock",
            limit: 25,
            userId: "user-1",
        });
        expect(prisma.playlist.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    userId_mixId: {
                        userId: "user-1",
                        mixId: "radio-ephemeral:genre:rock",
                    },
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
        prisma.playlist.findUnique.mockResolvedValue({
            id: "playlist-1",
            userId: "user-2",
            mixId: "radio-ephemeral:genre:Rock",
        });
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
        prisma.playlist.findUnique.mockResolvedValue({
            id: "playlist-1",
            userId: "user-2",
            mixId: "radio-ephemeral:decade:1990",
        });
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
        prisma.playlist.findUnique.mockResolvedValue({
            id: "playlist-1",
            userId: "user-1",
            mixId: "radio-ephemeral:genre:Rock",
        });
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

        expect(selectLibraryRadioStationTracks).toHaveBeenCalledWith({
            type: "genre",
            value: "Rock",
            limit: 4,
            userId: "user-1",
        });
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

    it("regenerates an owned playlist by replacing its entries", async () => {
        prisma.playlist.findUnique.mockResolvedValue({
            id: "playlist-1",
            userId: "user-1",
            mixId: "radio-ephemeral:decade:1990",
        });
        prisma.playlistItem.findMany.mockResolvedValue([
            { trackId: "old-1", sort: 0 },
            { trackId: "old-2", sort: 1 },
        ]);
        selectLibraryRadioStationTracks.mockResolvedValue({
            tracks: [{ id: "new-1" }, { id: "new-2" }],
        });
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

        expect(selectLibraryRadioStationTracks).toHaveBeenCalledWith({
            type: "decade",
            value: "1990",
            limit: 2,
            userId: "user-1",
        });
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
});

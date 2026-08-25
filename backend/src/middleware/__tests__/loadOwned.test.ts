jest.mock("../../utils/db", () => ({
    prisma: { playlist: { findUnique: jest.fn() } },
}));

import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { loadOwned } from "../loadOwned";

const findUnique = prisma.playlist.findUnique as jest.Mock;

function createResponse() {
    const response = { status: jest.fn(), json: jest.fn() };
    response.status.mockReturnValue(response);
    response.json.mockReturnValue(response);
    return response;
}

async function run(resource: unknown) {
    findUnique.mockResolvedValue(resource);
    const req = {
        params: { id: "playlist-1" },
        user: { id: "user-1", username: "alice", role: "user" },
    } as unknown as Request;
    const res = createResponse();
    const next = jest.fn() as NextFunction;
    await loadOwned("playlist")(req, res as unknown as Response, next);
    return { req, res, next };
}

describe("loadOwned middleware", () => {
    beforeEach(() => findUnique.mockReset());

    it("loads an owned resource onto req.owned", async () => {
        const resource = { id: "playlist-1", userId: "user-1" };
        const { req, next } = await run(resource);

        expect(req.owned).toEqual(resource);
        expect(findUnique).toHaveBeenCalledWith({
            where: { id: "playlist-1" },
        });
        expect(next).toHaveBeenCalledWith();
    });

    it("uses a custom route parameter as the model id", async () => {
        findUnique.mockResolvedValue({ id: "playlist-2", userId: "user-1" });
        const req = {
            params: { playlistId: "playlist-2" },
            user: { id: "user-1", username: "alice", role: "user" },
        } as unknown as Request;

        await loadOwned("playlist", "playlistId")(
            req,
            createResponse() as unknown as Response,
            jest.fn(),
        );

        expect(findUnique).toHaveBeenCalledWith({
            where: { id: "playlist-2" },
        });
    });

    it("returns 404 when the resource is missing", async () => {
        const { res, next } = await run(null);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: "Playlist not found" });
        expect(next).not.toHaveBeenCalled();
    });

    it("returns 403 when the resource belongs to another user", async () => {
        const { res, next } = await run({
            id: "playlist-1",
            userId: "user-2",
        });

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: "Access denied" });
        expect(next).not.toHaveBeenCalled();
    });
});

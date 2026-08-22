import type { NextFunction, Request, Response } from "express";
import request from "supertest";

const browse = jest.fn();
const detail = jest.fn();
const followed = jest.fn();
const follow = jest.fn();
const unfollow = jest.fn();
const copy = jest.fn();

class MockPeerPlaylistError extends Error {
    constructor(readonly errorClass: string) {
        super("peer playlist failed");
    }
}

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, res: Response, next: NextFunction) => {
        if (req.header("x-test-user") !== "yes") {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = { id: "user-1", username: "user", role: "user" };
        return next();
    },
    requireAuthOrToken: (_req: Request, _res: Response, next: NextFunction) =>
        next(),
    requireAdmin: (_req: Request, res: Response) =>
        res.status(403).json({ error: "Forbidden" }),
}));
jest.mock("../../services/federationPeerPlaylists", () => ({
    browseFederationPeerPlaylists: browse,
    copyFederationPeerPlaylist: copy,
    followFederationPeerPlaylist: follow,
    getFederationPeerPlaylist: detail,
    listFollowedFederationPeerPlaylists: followed,
    unfollowFederationPeerPlaylist: unfollow,
    PeerPlaylistError: MockPeerPlaylistError,
}));
jest.mock("../../utils/db", () => ({
    prisma: {
        user: { findMany: jest.fn() },
        syncGroupMember: { findMany: jest.fn() },
        track: { findMany: jest.fn() },
    },
}));
jest.mock("../../utils/redis", () => ({
    redisClient: { scanIterator: jest.fn(), mGet: jest.fn(), set: jest.fn() },
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));
jest.mock("../../services/federationPresence", () => ({
    readFederationPeerPresenceSnapshots: jest.fn(),
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        }),
    },
}));

import router from "../social";
import { createRouteTestApp } from "./helpers/createRouteTestApp";

const app = createRouteTestApp("/api/social", router);

describe("social peer playlist routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        browse.mockResolvedValue({ playlists: [], errors: [] });
        detail.mockResolvedValue({ playlist: { tracks: [] } });
        followed.mockResolvedValue({ playlists: [] });
        follow.mockResolvedValue({ followed: true, followId: "follow-1" });
        unfollow.mockResolvedValue({ followed: false });
        copy.mockResolvedValue({ playlistId: "copy-1", copied: 1, skipped: 2 });
    });

    it("requires authentication but permits a non-admin user to browse", async () => {
        const denied = await request(app).get("/api/social/peer-playlists");
        const allowed = await request(app)
            .get("/api/social/peer-playlists")
            .set("x-test-user", "yes");

        expect(denied.status).toBe(401);
        expect(allowed.status).toBe(200);
        expect(browse).toHaveBeenCalledTimes(1);
    });

    it("passes caller ownership to follow, unfollow, and copy", async () => {
        const base = "/api/social/peer-playlists/peer-1/playlist-1";
        const headers = { "x-test-user": "yes" };

        expect(
            (await request(app).post(`${base}/follow`).set(headers)).status,
        ).toBe(200);
        expect(
            (await request(app).delete(`${base}/follow`).set(headers)).status,
        ).toBe(200);
        const copied = await request(app).post(`${base}/copy`).set(headers);

        expect(copied.status).toBe(200);
        expect(follow).toHaveBeenCalledWith("user-1", "peer-1", "playlist-1");
        expect(unfollow).toHaveBeenCalledWith("user-1", "peer-1", "playlist-1");
        expect(copy).toHaveBeenCalledWith("user-1", "peer-1", "playlist-1");
    });

    it("maps peer timeout and offline failures to stable errors", async () => {
        detail.mockRejectedValueOnce(new MockPeerPlaylistError("timeout"));
        detail.mockRejectedValueOnce(new MockPeerPlaylistError("offline"));
        const path = "/api/social/peer-playlists/peer-1/playlist-1";

        const timedOut = await request(app).get(path).set("x-test-user", "yes");
        const offline = await request(app).get(path).set("x-test-user", "yes");

        expect(timedOut.status).toBe(504);
        expect(timedOut.body).toEqual({
            error: "Peer playlist request timed out",
        });
        expect(offline.status).toBe(503);
        expect(offline.body).toEqual({ error: "Federation peer is offline" });
    });
});

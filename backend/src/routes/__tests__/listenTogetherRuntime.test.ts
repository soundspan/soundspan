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

jest.mock("../../services/listenTogether", () => ({
    createGroup: jest.fn(),
    joinGroup: jest.fn(),
    discoverGroups: jest.fn(),
    getActiveGroupCount: jest.fn(),
    getMyGroup: jest.fn(),
    leaveGroup: jest.fn(),
    endGroup: jest.fn(),
}));

import router from "../listenTogether";
import { logger } from "../../utils/logger";
import {
    createGroup,
    joinGroup,
    discoverGroups,
    getActiveGroupCount,
    getMyGroup,
    leaveGroup,
    endGroup,
} from "../../services/listenTogether";
import { GroupError } from "../../services/listenTogetherManager";

const mockCreateGroup = createGroup as jest.Mock;
const mockJoinGroup = joinGroup as jest.Mock;
const mockDiscoverGroups = discoverGroups as jest.Mock;
const mockGetActiveGroupCount = getActiveGroupCount as jest.Mock;
const mockGetMyGroup = getMyGroup as jest.Mock;
const mockLeaveGroup = leaveGroup as jest.Mock;
const mockEndGroup = endGroup as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;

function getHandler(path: string, method: "get" | "post", stackIndex = 0) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    return layer.route.stack[stackIndex].handle;
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

describe("listenTogether routes runtime", () => {
    const createGroupHandler = getHandler("/", "post");
    const joinGroupHandler = getHandler("/join", "post");
    const discoverGroupsHandler = getHandler("/discover", "get");
    const activeCountHandler = getHandler("/active-count", "get");
    const myGroupHandler = getHandler("/mine", "get");
    const leaveGroupHandler = getHandler("/:groupId/leave", "post");
    const endGroupHandler = getHandler("/:groupId/end", "post");

    const baseSnapshot = {
        id: "group-1",
        name: "Road Trip",
        joinCode: "ABC123",
        groupType: "host-follower",
        visibility: "public",
        isActive: true,
        hostUserId: "u1",
        syncState: "paused",
        playback: {
            queue: [],
            currentIndex: 0,
            isPlaying: false,
            positionMs: 0,
            serverTime: 1708128000000,
            stateVersion: 0,
            trackId: null,
        },
        members: [
            {
                userId: "u1",
                username: "alice",
                isHost: true,
                joinedAt: "2026-02-17T00:00:00.000Z",
                isConnected: true,
            },
        ],
    };

    beforeEach(() => {
        jest.clearAllMocks();

        mockCreateGroup.mockResolvedValue(baseSnapshot);
        mockJoinGroup.mockResolvedValue({
            ...baseSnapshot,
            members: [
                ...baseSnapshot.members,
                {
                    userId: "u2",
                    username: "bob",
                    isHost: false,
                    joinedAt: "2026-02-17T00:01:00.000Z",
                    isConnected: true,
                },
            ],
        });
        mockDiscoverGroups.mockResolvedValue([
            {
                id: "group-1",
                name: "Road Trip",
                joinCode: "ABC123",
            },
        ]);
        mockGetActiveGroupCount.mockResolvedValue(4);
        mockGetMyGroup.mockResolvedValue(baseSnapshot);
        mockLeaveGroup.mockResolvedValue({ ended: false });
        mockEndGroup.mockResolvedValue(undefined);
    });

    it("handles success paths for create/join/discover/mine/leave/end/count", async () => {
        const createReq = {
            user: { id: "u1", username: "alice" },
            body: {
                name: "Road Trip",
                visibility: "private",
                queueTrackIds: ["t1", "t2"],
                currentTrackId: "t2",
                currentTimeMs: 4321,
                isPlaying: true,
            },
        } as any;
        const createResPayload = createRes();
        await createGroupHandler(createReq, createResPayload);

        expect(mockCreateGroup).toHaveBeenCalledWith("u1", "alice", createReq.body);
        expect(createResPayload.statusCode).toBe(201);
        expect(createResPayload.body).toEqual(baseSnapshot);

        const joinReq = {
            user: { id: "u2", username: "bob" },
            body: { joinCode: "abc123" },
        } as any;
        const joinResPayload = createRes();
        await joinGroupHandler(joinReq, joinResPayload);

        expect(mockJoinGroup).toHaveBeenCalledWith("u2", "bob", "abc123");
        expect(joinResPayload.statusCode).toBe(200);
        expect(joinResPayload.body).toEqual(
            expect.objectContaining({ id: "group-1" })
        );

        const discoverReq = { user: { id: "u2" } } as any;
        const discoverResPayload = createRes();
        await discoverGroupsHandler(discoverReq, discoverResPayload);
        expect(mockDiscoverGroups).toHaveBeenCalledWith("u2");
        expect(discoverResPayload.statusCode).toBe(200);
        expect(discoverResPayload.body).toEqual([
            {
                id: "group-1",
                name: "Road Trip",
                joinCode: "ABC123",
            },
        ]);

        const activeCountResPayload = createRes();
        await activeCountHandler({} as any, activeCountResPayload);
        expect(mockGetActiveGroupCount).toHaveBeenCalledTimes(1);
        expect(activeCountResPayload.statusCode).toBe(200);
        expect(activeCountResPayload.body).toEqual({ count: 4 });

        const mineReq = { user: { id: "u1" } } as any;
        const mineResPayload = createRes();
        await myGroupHandler(mineReq, mineResPayload);
        expect(mockGetMyGroup).toHaveBeenCalledWith("u1");
        expect(mineResPayload.statusCode).toBe(200);
        expect(mineResPayload.body).toEqual(baseSnapshot);

        const leaveReq = {
            user: { id: "u2" },
            params: { groupId: "group-1" },
        } as any;
        const leaveResPayload = createRes();
        await leaveGroupHandler(leaveReq, leaveResPayload);
        expect(mockLeaveGroup).toHaveBeenCalledWith("u2", "group-1");
        expect(leaveResPayload.statusCode).toBe(200);
        expect(leaveResPayload.body).toEqual({ success: true, ended: false });

        const endReq = {
            user: { id: "u1" },
            params: { groupId: "group-1" },
        } as any;
        const endResPayload = createRes();
        await endGroupHandler(endReq, endResPayload);
        expect(mockEndGroup).toHaveBeenCalledWith("u1", "group-1");
        expect(endResPayload.statusCode).toBe(200);
        expect(endResPayload.body).toEqual({ success: true });
    });

    it("returns 400 with zod details when create payload is invalid", async () => {
        const req = {
            user: { id: "u1", username: "alice" },
            body: { currentTimeMs: -1, queueTrackIds: Array.from({ length: 501 }, () => "t") },
        } as any;
        const res = createRes();

        await createGroupHandler(req, res);

        expect(mockCreateGroup).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid request",
                details: expect.any(Array),
            })
        );
    });

    it("returns 400 with zod details when join payload is invalid", async () => {
        const req = {
            user: { id: "u1", username: "alice" },
            body: { joinCode: "" },
        } as any;
        const res = createRes();

        await joinGroupHandler(req, res);

        expect(mockJoinGroup).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid request",
                details: expect.any(Array),
            })
        );
    });

    it("maps GroupError codes to expected HTTP statuses", async () => {
        const cases: Array<{
            code: "NOT_FOUND" | "NOT_MEMBER" | "NOT_ALLOWED" | "INVALID" | "CONFLICT";
            status: number;
        }> = [
            { code: "NOT_FOUND", status: 404 },
            { code: "NOT_MEMBER", status: 403 },
            { code: "NOT_ALLOWED", status: 403 },
            { code: "INVALID", status: 400 },
            { code: "CONFLICT", status: 409 },
        ];

        for (const testCase of cases) {
            const req = {
                user: { id: "u1", username: "alice" },
                body: { joinCode: "ABC123" },
            } as any;
            const res = createRes();

            mockJoinGroup.mockRejectedValueOnce(
                new GroupError(testCase.code, `${testCase.code} failure`)
            );

            await joinGroupHandler(req, res);

            expect(res.statusCode).toBe(testCase.status);
            expect(res.body).toEqual({ error: `${testCase.code} failure` });
        }

        expect(mockLoggerError).not.toHaveBeenCalled();
    });

    it("returns 500 and logs on unexpected errors", async () => {
        const error = new Error("database unavailable");
        mockDiscoverGroups.mockRejectedValueOnce(error);

        const req = { user: { id: "u1" } } as any;
        const res = createRes();

        await discoverGroupsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Internal server error" });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[ListenTogether] discover failed:",
            error
        );
    });
});

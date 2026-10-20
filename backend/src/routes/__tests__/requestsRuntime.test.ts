const mockCreateRequest = jest.fn();
const mockListRequestsForUser = jest.fn();
const mockCancelOwnRequest = jest.fn();
const mockListAllRequests = jest.fn();
const mockApproveRequest = jest.fn();
const mockDenyRequest = jest.fn();
const mockGetRequestAvailability = jest.fn();
const mockGetRequestCounts = jest.fn();
const mockApprovePendingRequestsForUser = jest.fn();
const mockDenyStaleRequests = jest.fn();
const mockEnqueueAlbumDownloadInBackground = jest.fn();

class MockMusicRequestServiceError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly retryAfter?: Date,
    ) {
        super(message);
        this.name = "MusicRequestServiceError";
    }
}

const requireAuth = jest.fn((req: any, res: any, next: () => void) => {
    if (!req.user)
        return res.status(401).json({ error: "Authentication required" });
    next();
});
const requireAdmin = jest.fn((req: any, res: any, next: () => void) => {
    if (req.user?.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
    }
    next();
});

jest.mock("../../middleware/auth", () => ({ requireAuth, requireAdmin }));
jest.mock("../../services/musicRequestService", () => ({
    MusicRequestServiceError: MockMusicRequestServiceError,
    MUSIC_REQUEST_STATUSES: [
        "pending",
        "approved",
        "denied",
        "fulfilled",
        "failed",
        "cancelled",
    ],
    createRequest: (...args: unknown[]) => mockCreateRequest(...args),
    listRequestsForUser: (...args: unknown[]) =>
        mockListRequestsForUser(...args),
    cancelOwnRequest: (...args: unknown[]) => mockCancelOwnRequest(...args),
    listAllRequests: (...args: unknown[]) => mockListAllRequests(...args),
    approveRequest: (...args: unknown[]) => mockApproveRequest(...args),
    denyRequest: (...args: unknown[]) => mockDenyRequest(...args),
    getRequestAvailability: (...args: unknown[]) =>
        mockGetRequestAvailability(...args),
    getRequestCounts: (...args: unknown[]) => mockGetRequestCounts(...args),
}));
jest.mock("../../services/musicRequestBulkActions", () => ({
    MAX_BULK_APPROVALS: 25,
    approvePendingRequestsForUser: (...args: unknown[]) =>
        mockApprovePendingRequestsForUser(...args),
    denyStaleRequests: (...args: unknown[]) => mockDenyStaleRequests(...args),
}));
jest.mock("../../services/albumDownloadQueueService", () => ({
    enqueueAlbumDownloadInBackground: (...args: unknown[]) =>
        mockEnqueueAlbumDownloadInBackground(...args),
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

import router from "../requests";

type HttpMethod = "get" | "post" | "delete";

function routeLayer(path: string, method: HttpMethod) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer)
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    return layer;
}

function finalHandler(path: string, method: HttpMethod) {
    const stack = routeLayer(path, method).route.stack;
    return stack[stack.length - 1].handle;
}

async function invokeRoute(
    path: string,
    method: HttpMethod,
    req: any,
    res: any,
): Promise<void> {
    for (const entry of routeLayer(path, method).route.stack) {
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
        body: undefined,
        status: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
    };
    return res;
}

const validBody = {
    artistName: "Massive Attack",
    albumTitle: "Mezzanine",
    artistMbid: "10adbeaa-cdf8-4435-b6f1-14b76af17c34",
    rgMbid: "4f9d25d1-32c2-4093-83a5-34fcbaaf6f25",
    note: "Please add this",
};

describe("requests route runtime", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockCreateRequest.mockResolvedValue({ id: "request-1", ...validBody });
        mockListRequestsForUser.mockResolvedValue([]);
        mockCancelOwnRequest.mockResolvedValue({
            kind: "updated",
            request: {},
        });
        mockListAllRequests.mockResolvedValue([]);
        mockApproveRequest.mockResolvedValue({
            kind: "updated",
            request: { id: "request-1", status: "approved" },
            duplicate: true,
            dispatch: null,
        });
        mockDenyRequest.mockResolvedValue({
            kind: "updated",
            request: { id: "request-1", status: "denied" },
        });
        mockGetRequestAvailability.mockResolvedValue({
            enabled: true,
            remainingToday: 9,
            dailyCap: 10,
            deniedCooldownDays: 30,
        });
        mockGetRequestCounts.mockResolvedValue({
            pending: 1,
            approved: 2,
            denied: 3,
            fulfilled: 4,
            failed: 5,
            cancelled: 6,
        });
        mockApprovePendingRequestsForUser.mockResolvedValue({
            approved: 1,
            fulfilled: 0,
            skipped: 0,
            failed: 0,
            remaining: 0,
            dispatches: [],
        });
        mockDenyStaleRequests.mockResolvedValue({ denied: 2, remaining: 0 });
        mockEnqueueAlbumDownloadInBackground.mockReturnValue(undefined);
    });

    it("requires an interactive authenticated session for the router", async () => {
        const authLayer = (router as any).stack.find(
            (entry: any) => !entry.route,
        );
        const res = createRes();
        const next = jest.fn();

        await authLayer.handle({}, res, next);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Authentication required" });
        expect(next).not.toHaveBeenCalled();
    });

    it.each([
        ["/", "get"],
        ["/counts", "get"],
        ["/bulk/approve", "post"],
        ["/bulk/deny-stale", "post"],
        ["/:id/approve", "post"],
        ["/:id/deny", "post"],
    ] as const)("rejects non-admin access to %s", async (path, method) => {
        const res = createRes();
        await invokeRoute(
            path,
            method,
            {
                user: { id: "user-1", role: "user" },
                params: { id: "request-1" },
                query: {},
                body: {},
            },
            res,
        );

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Admin access required" });
    });

    it("allows an admin to list requests", async () => {
        const res = createRes();
        await invokeRoute(
            "/",
            "get",
            { user: { id: "admin-1", role: "admin" }, query: {} },
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(mockListAllRequests).toHaveBeenCalledWith({
            status: undefined,
            limit: 50,
            offset: 0,
        });
    });

    it.each([
        ["/:id/approve", "post", mockApproveRequest],
        ["/:id/deny", "post", mockDenyRequest],
    ] as const)(
        "allows an admin to review through %s",
        async (path, method, service) => {
            const res = createRes();
            await invokeRoute(
                path,
                method,
                {
                    user: { id: "admin-1", role: "admin" },
                    params: { id: "request-1" },
                    body: {},
                },
                res,
            );

            expect(res.statusCode).toBe(200);
            expect(service).toHaveBeenCalled();
        },
    );

    it.each([
        ["bad MBID", { ...validBody, rgMbid: "not-an-mbid" }],
        [
            "oversized artist name",
            { ...validBody, artistName: "x".repeat(301) },
        ],
        [
            "oversized album title",
            { ...validBody, albumTitle: "x".repeat(301) },
        ],
        ["long note", { ...validBody, note: "x".repeat(501) }],
        ["unknown field", { ...validBody, unexpected: true }],
    ])(
        "rejects %s input with the canonical error shape",
        async (_name, body) => {
            const res = createRes();
            await finalHandler("/", "post")(
                { user: { id: "user-1" }, body },
                res,
                jest.fn(),
            );

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: "Invalid request body" });
            expect(mockCreateRequest).not.toHaveBeenCalled();
        },
    );

    it("normalizes mixed-case MBIDs before checking for an open request", async () => {
        mockCreateRequest.mockRejectedValueOnce(
            new MockMusicRequestServiceError(
                "already_requested",
                "Album has already been requested",
            ),
        );
        const res = createRes();

        await finalHandler("/", "post")(
            {
                user: { id: "user-1" },
                body: {
                    ...validBody,
                    artistMbid: validBody.artistMbid.toUpperCase(),
                    rgMbid: validBody.rgMbid.toUpperCase(),
                },
            },
            res,
            jest.fn(),
        );

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({
            error: "Album has already been requested",
            code: "already_requested",
        });
        expect(mockCreateRequest).toHaveBeenCalledWith("user-1", validBody);
    });

    it.each([
        ["already_in_library", 409, "Album is already in the library"],
        ["already_requested", 409, "Album has already been requested"],
        ["already_downloading", 409, "Album is already downloading"],
        ["daily_cap", 429, "Daily request limit reached"],
    ])("maps %s create rejection", async (code, status, message) => {
        mockCreateRequest.mockRejectedValueOnce(
            new MockMusicRequestServiceError(code, message),
        );
        const res = createRes();

        await finalHandler("/", "post")(
            { user: { id: "user-1" }, body: validBody },
            res,
            jest.fn(),
        );

        expect(res.statusCode).toBe(status);
        expect(res.body).toEqual({ error: message, code });
    });

    it("maps an active cooldown with retry guidance", async () => {
        const retryAfter = new Date("2026-11-01T00:00:00.000Z");
        mockCreateRequest.mockRejectedValueOnce(
            new MockMusicRequestServiceError(
                "recently_denied",
                "This album was declined recently and can be requested again later",
                retryAfter,
            ),
        );
        const res = createRes();

        await finalHandler("/", "post")(
            { user: { id: "user-1" }, body: validBody },
            res,
            jest.fn(),
        );

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({
            error: "This album was declined recently and can be requested again later",
            code: "recently_denied",
            retryAfter: "2026-11-01T00:00:00.000Z",
        });
    });

    it("returns a static canonical 500 for unexpected create failures", async () => {
        mockCreateRequest.mockRejectedValueOnce(
            new Error("secret database detail"),
        );
        const res = createRes();

        await finalHandler("/", "post")(
            { user: { id: "user-1" }, body: validBody },
            res,
            jest.fn(),
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to create music request" });
        expect(JSON.stringify(res.body)).not.toContain("database");
    });

    it.each([
        [{ kind: "not_found" }, 404, "Music request not found"],
        [
            { kind: "conflict", reason: "not_reviewable" },
            409,
            "Only pending requests can be cancelled",
        ],
    ])("maps cancellation outcomes", async (outcome, status, error) => {
        mockCancelOwnRequest.mockResolvedValueOnce(outcome);
        const res = createRes();

        await finalHandler("/:id", "delete")(
            { user: { id: "user-1" }, params: { id: "request-1" } },
            res,
            jest.fn(),
        );

        expect(res.statusCode).toBe(status);
        expect(res.body).toEqual({ error });
    });

    it("dispatches only a freshly created approval download", async () => {
        mockApproveRequest.mockResolvedValueOnce({
            kind: "updated",
            request: { id: "request-1", status: "approved" },
            duplicate: false,
            dispatch: {
                jobId: "job-1",
                type: "album",
                mbid: validBody.rgMbid,
                subject: "Massive Attack - Mezzanine",
                artistName: "Massive Attack",
                albumTitle: "Mezzanine",
            },
        });
        const res = createRes();

        await finalHandler("/:id/approve", "post")(
            { user: { id: "admin-1" }, params: { id: "request-1" } },
            res,
            jest.fn(),
        );

        expect(res.body).toEqual({ id: "request-1", status: "approved" });
        expect(mockEnqueueAlbumDownloadInBackground).toHaveBeenCalledWith({
            jobId: "job-1",
            type: "album",
            mbid: validBody.rgMbid,
            subject: "Massive Attack - Mezzanine",
            artistName: "Massive Attack",
            albumTitle: "Mezzanine",
        });
    });

    it("does not dispatch a duplicate approval job", async () => {
        const res = createRes();
        await finalHandler("/:id/approve", "post")(
            { user: { id: "admin-1" }, params: { id: "request-1" } },
            res,
            jest.fn(),
        );

        expect(res.statusCode).toBe(200);
        expect(mockEnqueueAlbumDownloadInBackground).not.toHaveBeenCalled();
    });

    it("rejects invalid admin status filters", async () => {
        const res = createRes();
        await finalHandler("/", "get")(
            { user: { id: "admin-1" }, query: { status: "unknown" } },
            res,
            jest.fn(),
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Invalid request query" });
    });

    it.each([
        [
            "/:id/approve",
            mockApproveRequest,
            "not_reviewable",
            "Only pending or failed requests can be approved",
        ],
        [
            "/:id/deny",
            mockDenyRequest,
            "not_reviewable",
            "Only pending or failed requests can be denied",
        ],
        [
            "/:id/approve",
            mockApproveRequest,
            "open_request_exists",
            "This user already has an open request for this album",
        ],
    ] as const)(
        "maps review conflicts on %s",
        async (path, service, reason, message) => {
            service.mockResolvedValueOnce({ kind: "conflict", reason });
            const res = createRes();

            await finalHandler(path, "post")(
                {
                    user: { id: "admin-1" },
                    params: { id: "request-1" },
                    body: {},
                },
                res,
                jest.fn(),
            );

            expect(res.statusCode).toBe(409);
            expect(res.body).toEqual({ error: message, code: reason });
        },
    );

    it("returns the configured denial cooldown in availability", async () => {
        const res = createRes();

        await finalHandler("/availability", "get")(
            { user: { id: "user-1" } },
            res,
            jest.fn(),
        );

        expect(mockGetRequestAvailability).toHaveBeenCalledWith("user-1");
        expect(res.body).toEqual({
            enabled: true,
            remainingToday: 9,
            dailyCap: 10,
            deniedCooldownDays: 30,
        });
    });

    it.each([
        ["/", "get", { limit: "0" }],
        ["/", "get", { limit: "101" }],
        ["/mine", "get", { offset: "-1" }],
    ] as const)("rejects invalid paging on %s", async (path, method, query) => {
        const res = createRes();

        await finalHandler(path, method)(
            { user: { id: "admin-1" }, query },
            res,
            jest.fn(),
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Invalid request query" });
    });

    it("passes status and paging to the caller's list", async () => {
        const page = { requests: [], total: 0, limit: 25, offset: 5 };
        mockListRequestsForUser.mockResolvedValueOnce(page);
        const res = createRes();

        await finalHandler("/mine", "get")(
            {
                user: { id: "user-1" },
                query: { status: "failed", limit: "25", offset: "5" },
            },
            res,
            jest.fn(),
        );

        expect(mockListRequestsForUser).toHaveBeenCalledWith("user-1", {
            status: "failed",
            limit: 25,
            offset: 5,
        });
        expect(res.body).toEqual(page);
    });

    it("returns zero-filled request counts", async () => {
        const res = createRes();

        await invokeRoute(
            "/counts",
            "get",
            { user: { id: "admin-1", role: "admin" } },
            res,
        );

        expect(res.body).toEqual({
            pending: 1,
            approved: 2,
            denied: 3,
            fulfilled: 4,
            failed: 5,
            cancelled: 6,
        });
    });

    it("dispatches bulk approvals and omits internal dispatches from the response", async () => {
        const dispatch = {
            jobId: "job-1",
            type: "album",
            mbid: validBody.rgMbid,
            subject: "Massive Attack - Mezzanine",
        };
        mockApprovePendingRequestsForUser.mockResolvedValueOnce({
            approved: 1,
            fulfilled: 1,
            skipped: 1,
            failed: 1,
            remaining: 2,
            dispatches: [dispatch],
        });
        const res = createRes();

        await invokeRoute(
            "/bulk/approve",
            "post",
            {
                user: { id: "admin-1", role: "admin" },
                body: { userId: "user-1" },
            },
            res,
        );

        expect(mockApprovePendingRequestsForUser).toHaveBeenCalledWith(
            "admin-1",
            "user-1",
        );
        expect(mockEnqueueAlbumDownloadInBackground).toHaveBeenCalledWith(
            dispatch,
        );
        expect(res.body).toEqual({
            approved: 1,
            fulfilled: 1,
            skipped: 1,
            failed: 1,
            remaining: 2,
        });
    });

    it("denies stale requests through the bounded bulk service", async () => {
        const res = createRes();

        await invokeRoute(
            "/bulk/deny-stale",
            "post",
            {
                user: { id: "admin-1", role: "admin" },
                body: { olderThanDays: 30, reason: " Not available " },
            },
            res,
        );

        expect(mockDenyStaleRequests).toHaveBeenCalledWith(
            "admin-1",
            30,
            "Not available",
        );
        expect(res.body).toEqual({ denied: 2, remaining: 0 });
    });

    it.each([
        ["/bulk/approve", { userId: "user-1", unexpected: true }],
        ["/bulk/deny-stale", { olderThanDays: 0 }],
        ["/bulk/deny-stale", { olderThanDays: 366 }],
        ["/bulk/deny-stale", { olderThanDays: 30, unexpected: true }],
    ])("rejects invalid strict bulk body on %s", async (path, body) => {
        const res = createRes();

        await finalHandler(path, "post")(
            { user: { id: "admin-1" }, body },
            res,
            jest.fn(),
        );

        expect(res.statusCode).toBe(400);
    });

    it("registers bulk routes before parameterized review routes", () => {
        const stack = (router as any).stack;
        const counts = stack.findIndex(
            (entry: any) => entry.route?.path === "/counts",
        );
        const cancel = stack.findIndex(
            (entry: any) => entry.route?.path === "/:id",
        );
        const bulkApprove = stack.findIndex(
            (entry: any) => entry.route?.path === "/bulk/approve",
        );
        const approve = stack.findIndex(
            (entry: any) => entry.route?.path === "/:id/approve",
        );
        const bulkDeny = stack.findIndex(
            (entry: any) => entry.route?.path === "/bulk/deny-stale",
        );
        const deny = stack.findIndex(
            (entry: any) => entry.route?.path === "/:id/deny",
        );

        expect(cancel).toBeGreaterThan(-1);
        expect(cancel).toBeLessThan(counts);
        expect(counts).toBeGreaterThan(-1);
        expect(counts).toBeLessThan(approve);
        expect(bulkApprove).toBeGreaterThan(-1);
        expect(bulkApprove).toBeLessThan(approve);
        expect(bulkDeny).toBeGreaterThan(-1);
        expect(bulkDeny).toBeLessThan(deny);
    });
});

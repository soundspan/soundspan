const mockCreateRequest = jest.fn();
const mockListRequestsForUser = jest.fn();
const mockCancelOwnRequest = jest.fn();
const mockListAllRequests = jest.fn();
const mockApproveRequest = jest.fn();
const mockDenyRequest = jest.fn();
const mockGetRequestAvailability = jest.fn();
const mockDispatchAlbumDownload = jest.fn();

class MockMusicRequestServiceError extends Error {
    constructor(
        public readonly code: string,
        message: string,
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
}));
jest.mock("../../services/downloadDispatcher", () => ({
    dispatchAlbumDownload: (...args: unknown[]) =>
        mockDispatchAlbumDownload(...args),
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
        });
        mockDispatchAlbumDownload.mockResolvedValue(undefined);
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
        expect(mockListAllRequests).toHaveBeenCalledWith(undefined);
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
        expect(res.body).toEqual({ error: "Album has already been requested" });
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
        expect(res.body).toEqual({ error: message });
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
        [{ kind: "conflict" }, 409, "Only pending requests can be cancelled"],
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
        expect(mockDispatchAlbumDownload).toHaveBeenCalledWith({
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
        expect(mockDispatchAlbumDownload).not.toHaveBeenCalled();
    });

    it("rejects invalid admin status filters", async () => {
        const res = createRes();
        await finalHandler("/", "get")(
            { user: { id: "admin-1" }, query: { status: "unknown" } },
            res,
            jest.fn(),
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Invalid request status" });
    });
});

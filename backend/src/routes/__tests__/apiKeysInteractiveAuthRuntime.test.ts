process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "api-keys-interactive-auth-test-pepper-123456";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
}));

const prisma = {
    apiKey: {
        create: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({ prisma }));

const scopedLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
scopedLogger.child.mockReturnValue(scopedLogger);
jest.mock("../../utils/logger", () => ({ logger: scopedLogger }));

import router from "../apiKeys";

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined,
        status: jest.fn((statusCode: number) => {
            res.statusCode = statusCode;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
    };
    return res;
}

async function executeRoute(
    method: "post" | "delete",
    path: string,
    req: any,
    res: any,
): Promise<void> {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) throw new Error(`Missing route ${method} ${path}`);

    const dispatch = async (index: number): Promise<void> => {
        const handler = layer.route.stack[index]?.handle;
        if (!handler) return;
        await handler(req, res, (error?: unknown) => {
            if (error) throw error;
            return dispatch(index + 1);
        });
    };
    await dispatch(0);
}

function interactiveRequest(body: Record<string, unknown> = {}): any {
    return {
        body,
        headers: { authorization: "Bearer access-token" },
        user: { id: "u1", username: "alice", role: "user" },
        params: { id: "key-1" },
    };
}

describe("API key management interactive authentication", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.apiKey.create.mockResolvedValue({
            name: "Laptop",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        prisma.apiKey.deleteMany.mockResolvedValue({ count: 1 });
    });

    test.each([
        ["post", "/", { deviceName: "Laptop" }],
        ["delete", "/:id", {}],
    ] as const)(
        "rejects X-API-Key authentication for %s %s",
        async (method, path, body) => {
            const req = interactiveRequest(body);
            req.headers["x-api-key"] = "stolen-key";
            const res = createRes();

            await executeRoute(method, path, req, res);

            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({
                error: "Interactive session authentication required",
            });
            expect(prisma.apiKey.create).not.toHaveBeenCalled();
            expect(prisma.apiKey.deleteMany).not.toHaveBeenCalled();
        },
    );

    it("creates a bounded key from the shipping device-name payload", async () => {
        const res = createRes();

        await executeRoute(
            "post",
            "/",
            interactiveRequest({ deviceName: "Laptop" }),
            res,
        );

        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual(
            expect.objectContaining({
                apiKey: expect.stringMatching(/^[0-9a-f]{64}$/),
                name: "Laptop",
                expiresAt: expect.any(Date),
            }),
        );
        expect(res.body.expiresAt.getTime()).toBeGreaterThan(
            res.body.createdAt.getTime(),
        );
    });

    it("revokes a key without adding a request body", async () => {
        const res = createRes();

        await executeRoute("delete", "/:id", interactiveRequest(), res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ message: "API key revoked successfully" });
    });
});

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

jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        systemSettings: {
            findUnique: jest.fn(),
        },
    },
}));

import router from "../system";
import { featureDetection } from "../../services/featureDetection";

const mockGetFeatures = featureDetection.getFeatures as jest.Mock;

function getHandler(path: string, method: "get") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
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

describe("system routes runtime", () => {
    const getFeatures = getHandler("/features", "get");

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns detected features", async () => {
        mockGetFeatures.mockResolvedValue({
            clapAvailable: true,
            allAvailable: true,
        });

        const req = { user: { id: "u1" } } as any;
        const res = createRes();

        await getFeatures(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            clapAvailable: true,
            allAvailable: true,
        });
    });

    it("returns 500 when feature detection fails", async () => {
        mockGetFeatures.mockRejectedValueOnce(new Error("probe failed"));
        const req = { user: { id: "u1" } } as any;
        const res = createRes();

        await getFeatures(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to detect features" });
    });
});

import express, {
    type NextFunction,
    type Request,
    type Response,
} from "express";
import request from "supertest";

type AuthMode = "ok" | "unauthorized" | "forbidden";
const auth = { mode: "ok" as AuthMode };
const summary = jest.fn();
const gaps = jest.fn();
const analysis = jest.fn();
const storage = jest.fn();
const quality = jest.fn();
const duplicates = jest.fn();
const invalidate = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, res: Response, next: NextFunction) =>
        auth.mode === "unauthorized"
            ? res.status(401).json({ error: "Unauthorized" })
            : next(),
    requireAdmin: (_req: Request, res: Response, next: NextFunction) =>
        auth.mode === "forbidden"
            ? res.status(403).json({ error: "Forbidden" })
            : next(),
}));
jest.mock("../../services/libraryHealthDashboard", () => ({
    METADATA_GAP_KINDS: [
        "missing-art",
        "missing-mbid",
        "missing-genres",
        "missing-lyrics",
    ],
    getLibraryHealthDashboardSummary: (...args: unknown[]) => summary(...args),
    getLibraryHealthMetadataGaps: (...args: unknown[]) => gaps(...args),
    getLibraryHealthAnalysis: (...args: unknown[]) => analysis(...args),
    getLibraryHealthStorage: (...args: unknown[]) => storage(...args),
    getLibraryHealthQuality: (...args: unknown[]) => quality(...args),
    getLibraryHealthDuplicates: (...args: unknown[]) => duplicates(...args),
    invalidateLibraryHealthDashboardCache: (...args: unknown[]) =>
        invalidate(...args),
}));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ error: jest.fn() }) },
}));

import router from "../libraryHealthDashboard";

const app = express();
app.use(express.json());
app.use("/api/library-health", router);

describe("library health dashboard routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        auth.mode = "ok";
        summary.mockResolvedValue({ metadataGaps: { missingLyrics: 2 } });
        gaps.mockResolvedValue({ kind: "missing-lyrics", items: [] });
        analysis.mockResolvedValue({ total: 4, failed: { items: [] } });
        storage.mockResolvedValue({ formats: [], topArtists: [] });
        quality.mockResolvedValue({ floorKbps: 192, items: [] });
        duplicates.mockResolvedValue({ clusters: [], total: 0 });
        invalidate.mockResolvedValue(undefined);
    });

    it.each([
        ["unauthorized", "get", "/api/library-health/summary", 401],
        ["forbidden", "get", "/api/library-health/summary", 403],
        ["unauthorized", "post", "/api/library-health/refresh", 401],
        ["forbidden", "post", "/api/library-health/refresh", 403],
    ] as const)("returns %s for %s %s", async (mode, method, path, status) => {
        auth.mode = mode;
        expect((await request(app)[method](path)).status).toBe(status);
    });

    it.each([
        "/api/library-health/gaps/not-a-gap",
        "/api/library-health/gaps/missing-art?limit=101",
        "/api/library-health/analysis?limit=101",
        "/api/library-health/quality?floor=31",
        "/api/library-health/quality?unexpected=true",
        "/api/library-health/duplicates?limit=51",
    ])("rejects invalid input for %s", async (path) => {
        const response = await request(app).get(path);
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: "Invalid library health request",
        });
    });

    it("returns panels and refreshes the summary", async () => {
        expect(
            (await request(app).get("/api/library-health/summary")).body,
        ).toEqual({ metadataGaps: { missingLyrics: 2 } });
        await request(app).get(
            "/api/library-health/gaps/missing-lyrics?limit=10&offset=5",
        );
        expect(
            (await request(app).get("/api/library-health/analysis")).body,
        ).toEqual({ total: 4, failed: { items: [] } });
        expect(
            (await request(app).get("/api/library-health/storage")).body,
        ).toEqual({ formats: [], topArtists: [] });
        await request(app).get("/api/library-health/quality?floor=160");
        expect(
            (await request(app).get("/api/library-health/duplicates")).body,
        ).toEqual({ clusters: [], total: 0 });
        const refreshed = await request(app).post(
            "/api/library-health/refresh",
        );
        expect(gaps).toHaveBeenCalledWith("missing-lyrics", {
            limit: 10,
            offset: 5,
        });
        expect(quality).toHaveBeenCalledWith(160, { limit: 50, offset: 0 });
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(refreshed.body).toEqual({ metadataGaps: { missingLyrics: 2 } });
    });
});

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({ prisma: {} }));

jest.mock("../../services/lastfm", () => ({ lastFmService: {} }));

jest.mock("../../services/discovery/exploreDiscovery", () => ({
    getExploreDiscovery: jest.fn(),
}));

import router from "../recommendations";
import { getExploreDiscovery } from "../../services/discovery/exploreDiscovery";
import { createMockJsonResponse } from "./helpers/mockJsonResponse";

const mockGetExploreDiscovery = getExploreDiscovery as jest.Mock;

function getExploreHandler() {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === "/explore" && entry.route?.methods?.get,
    );
    if (!layer) throw new Error("GET /explore not registered");
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe("GET /recommendations/explore", () => {
    beforeEach(() => jest.clearAllMocks());

    it("returns the current user's discovery shelves", async () => {
        const payload = {
            personalized: false,
            similarArtists: [],
            newReleases: [],
            trendingTracks: [],
            tagShelves: [],
        };
        mockGetExploreDiscovery.mockResolvedValueOnce(payload);
        const res = createMockJsonResponse();

        await getExploreHandler()({ user: { id: "user-9" }, query: {} }, res);

        expect(mockGetExploreDiscovery).toHaveBeenCalledWith("user-9");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(payload);
    });

    it("returns a generic 500 when discovery fails", async () => {
        mockGetExploreDiscovery.mockRejectedValueOnce(new Error("db down"));
        const res = createMockJsonResponse();

        await getExploreHandler()({ user: { id: "user-9" }, query: {} }, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get explore discovery" });
    });
});

import type { Request, Response } from "express";

const loadSubsonicArtistIndexSnapshot = jest.fn();
const sendSubsonicSuccess = jest.fn();

jest.mock("../../services/subsonicArtistIndexCache", () => ({
    loadSubsonicArtistIndexSnapshot,
}));
jest.mock("../../utils/subsonicResponse", () => ({
    getResponseFormat: () => "json",
    sendSubsonicError: jest.fn(),
    sendSubsonicSuccess,
    SubsonicErrorCode: { GENERIC: 0 },
}));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));

import { handleGetIndexes } from "../subsonic/browsing";

describe("Subsonic cached browsing", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("answers ifModifiedSince from the cached timestamp without loading artists", async () => {
        const lastModified = 1_777_000_000_000;
        loadSubsonicArtistIndexSnapshot.mockResolvedValue({
            artists: [
                {
                    id: "artist-1",
                    name: "Artist One",
                    heroUrl: null,
                    albumCount: 1,
                },
            ],
            lastModified,
        });

        await handleGetIndexes(
            {
                query: { ifModifiedSince: String(lastModified) },
            } as unknown as Request,
            {} as Response,
        );

        expect(loadSubsonicArtistIndexSnapshot).toHaveBeenCalledTimes(1);
        expect(sendSubsonicSuccess).toHaveBeenCalledWith(
            expect.anything(),
            {
                indexes: expect.objectContaining({
                    lastModified,
                    index: [],
                }),
            },
            "json",
            undefined,
        );
    });
});

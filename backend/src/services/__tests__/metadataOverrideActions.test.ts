jest.mock("../../utils/db", () => ({
    prisma: {
        artist: { findUnique: jest.fn(), update: jest.fn() },
        album: { findUnique: jest.fn() },
        track: { findFirst: jest.fn(), update: jest.fn() },
    },
}));
jest.mock("../../utils/redis", () => ({ redisClient: { del: jest.fn() } }));
jest.mock("../albumMetadataPersistence", () => ({
    updateAlbumMetadataWithOwnership: jest.fn(),
}));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));

import { prisma } from "../../utils/db";
import {
    applyMetadataOverrides,
    resetMetadataOverrides,
    MetadataEntityNotFoundError,
    type MetadataFieldMap,
} from "../metadataOverrideActions";

const artistUpdate = prisma.artist.update as jest.Mock;
const artistFindUnique = prisma.artist.findUnique as jest.Mock;

describe("metadata override service", () => {
    beforeEach(() => jest.clearAllMocks());

    it("maps defined fields and marks user overrides", async () => {
        artistUpdate.mockResolvedValue({ id: "artist-1" });
        const fieldMap: MetadataFieldMap = {
            name: { target: "displayName" },
            genres: { target: "userGenres" },
            mbid: { target: "mbid", marksOverride: false },
        };

        await applyMetadataOverrides(
            { type: "artist", id: "artist-1" },
            { name: "New name", genres: ["rock"], ignored: true },
            fieldMap,
        );

        expect(artistUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "artist-1" },
                data: {
                    displayName: "New name",
                    userGenres: ["rock"],
                    hasUserOverrides: true,
                },
            }),
        );
    });

    it("resets an existing artist with the canonical reset fields", async () => {
        artistFindUnique.mockResolvedValue({ id: "artist-1" });
        artistUpdate.mockResolvedValue({ id: "artist-1", displayName: null });

        const result = await resetMetadataOverrides({
            type: "artist",
            id: "artist-1",
        });

        expect(result).toEqual({ id: "artist-1", displayName: null });
        expect(artistUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ hasUserOverrides: false }),
            }),
        );
    });

    it("rejects a reset for a missing entity", async () => {
        artistFindUnique.mockResolvedValue(null);

        await expect(
            resetMetadataOverrides({ type: "artist", id: "missing" }),
        ).rejects.toBeInstanceOf(MetadataEntityNotFoundError);
    });
});

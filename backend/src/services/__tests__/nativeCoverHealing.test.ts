jest.mock("../../config", () => ({
    config: { music: { transcodeCachePath: "/tmp/soundspan-transcodes" } },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        album: {
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: { setEx: jest.fn() },
}));

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn() },
}));

jest.mock("../coverArt", () => ({
    coverArtService: { getCoverArt: jest.fn() },
}));

jest.mock("../imageProvider", () => ({
    imageProviderService: { getAlbumCover: jest.fn() },
}));

jest.mock("../deezer", () => ({
    deezerService: { getAlbumCover: jest.fn() },
}));

jest.mock("../musicbrainz", () => ({
    isValidMbid: (value: unknown) =>
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value,
        ),
}));

jest.mock("../imageStorage", () => ({
    downloadAndStoreImage: jest.fn(),
}));

import { prisma } from "../../utils/db";
import { coverArtService } from "../coverArt";
import { deezerService } from "../deezer";
import { imageProviderService } from "../imageProvider";
import { downloadAndStoreImage } from "../imageStorage";
import {
    nativeCoverHealInFlight,
    tryHealMissingNativeAlbumCover,
} from "../nativeCoverHealing";

const mockAlbumFindUnique = prisma.album.findUnique as jest.Mock;
const mockAlbumUpdate = prisma.album.update as jest.Mock;
const mockAlbumUpdateMany = prisma.album.updateMany as jest.Mock;
const mockCoverArtGet = coverArtService.getCoverArt as jest.Mock;
const mockProviderGet = imageProviderService.getAlbumCover as jest.Mock;
const mockDeezerGet = deezerService.getAlbumCover as jest.Mock;
const mockDownloadAndStoreImage = downloadAndStoreImage as jest.Mock;

describe("native cover healing", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        nativeCoverHealInFlight.clear();
    });

    it("conditionally clears stale native cover state before routing a federated album through the proxy endpoint", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            id: "federated-album",
            title: "Peer album",
            rgMbid: "11111111-1111-4111-8111-111111111111",
            coverUrl: "native:albums/federated-album.jpg",
            location: "FEDERATED",
            artist: { name: "Peer artist" },
        });

        const result = await tryHealMissingNativeAlbumCover(
            "albums/federated-album.jpg",
        );

        expect(result).toBe("/api/library/cover-art/federated-album");
        expect(mockAlbumUpdateMany).toHaveBeenCalledWith({
            where: {
                id: "federated-album",
                coverUrl: "native:albums/federated-album.jpg",
            },
            data: { coverUrl: null },
        });
        expect(mockAlbumUpdate).not.toHaveBeenCalled();
        expect(mockCoverArtGet).not.toHaveBeenCalled();
        expect(mockProviderGet).not.toHaveBeenCalled();
        expect(mockDeezerGet).not.toHaveBeenCalled();
    });

    it("does not overwrite a cover changed after the stale native value was read", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            id: "federated-race-album",
            title: "Peer race album",
            rgMbid: "22222222-2222-4222-8222-222222222222",
            coverUrl: "native:albums/federated-race-album.jpg",
            location: "FEDERATED",
            artist: { name: "Peer artist" },
        });
        mockAlbumUpdateMany.mockResolvedValue({ count: 0 });

        await tryHealMissingNativeAlbumCover("albums/federated-race-album.jpg");

        expect(mockAlbumUpdateMany).toHaveBeenCalledWith({
            where: {
                id: "federated-race-album",
                coverUrl: "native:albums/federated-race-album.jpg",
            },
            data: { coverUrl: null },
        });
        expect(mockAlbumUpdate).not.toHaveBeenCalled();
    });

    it("does not call image providers with a malformed release-group MBID", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            id: "malformed-mbid-album",
            title: "Malformed MBID album",
            rgMbid: "not-a-musicbrainz-uuid",
            coverUrl: "native:albums/malformed-mbid-album.jpg",
            location: "LIBRARY",
            artist: { name: "Local artist" },
        });

        await tryHealMissingNativeAlbumCover("albums/malformed-mbid-album.jpg");

        expect(mockCoverArtGet).not.toHaveBeenCalled();
        expect(mockProviderGet).not.toHaveBeenCalled();
        expect(mockDeezerGet).toHaveBeenCalledWith(
            "Local artist",
            "Malformed MBID album",
        );
    });

    it("removes settled heals so a later request can retry the same album", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            id: "retry-album",
            title: "Retry album",
            rgMbid: null,
            coverUrl: "native:albums/retry-album.jpg",
            location: "LIBRARY",
            artist: { name: "Local artist" },
        });
        mockDeezerGet
            .mockResolvedValueOnce("https://images.example/first.jpg")
            .mockResolvedValueOnce("https://images.example/second.jpg");
        mockDownloadAndStoreImage
            .mockResolvedValueOnce("native:albums/retry-album-first.jpg")
            .mockResolvedValueOnce("native:albums/retry-album-second.jpg");

        const firstResult = await tryHealMissingNativeAlbumCover(
            "albums/retry-album.jpg",
        );
        expect(nativeCoverHealInFlight.has("retry-album")).toBe(false);

        const secondResult = await tryHealMissingNativeAlbumCover(
            "albums/retry-album.jpg",
        );

        expect(firstResult).toContain("retry-album-first.jpg");
        expect(secondResult).toContain("retry-album-second.jpg");
        expect(mockAlbumFindUnique).toHaveBeenCalledTimes(2);
        expect(nativeCoverHealInFlight.has("retry-album")).toBe(false);
    });
});

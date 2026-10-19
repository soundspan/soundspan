jest.mock("../../config", () => ({
    config: {
        music: {
            transcodeCachePath: "/tmp/soundspan-transcodes",
            musicPath: "/music",
        },
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        album: {
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        track: { findFirst: jest.fn() },
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: { setEx: jest.fn() },
}));

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn() },
}));

jest.mock("../metadata/albumCoverResolver", () => ({
    resolveAlbumCover: jest.fn(),
}));

jest.mock("../imageStorage", () => ({
    downloadAndStoreImage: jest.fn(),
}));

const mockExtractCoverArt = jest.fn();
jest.mock("../coverArtExtractor", () => ({
    CoverArtExtractor: jest.fn(() => ({
        extractCoverArt: mockExtractCoverArt,
    })),
}));

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { resolveAlbumCover } from "../metadata/albumCoverResolver";
import { downloadAndStoreImage } from "../imageStorage";
import {
    nativeCoverHealInFlight,
    tryHealMissingNativeAlbumCover,
} from "../nativeCoverHealing";

const mockAlbumFindUnique = prisma.album.findUnique as jest.Mock;
const mockAlbumUpdate = prisma.album.update as jest.Mock;
const mockAlbumUpdateMany = prisma.album.updateMany as jest.Mock;
const mockResolveAlbumCover = resolveAlbumCover as jest.Mock;
const mockDownloadAndStoreImage = downloadAndStoreImage as jest.Mock;
const mockTrackFindFirst = prisma.track.findFirst as jest.Mock;

describe("native cover healing", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        nativeCoverHealInFlight.clear();
        mockTrackFindFirst.mockResolvedValue(null);
    });

    it("falls back to one local track embedded-art extraction", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            id: "embedded-album",
            title: "Embedded album",
            rgMbid: null,
            coverUrl: "native:embedded-album.jpg",
            location: "LIBRARY",
            artist: { name: "Local artist" },
        });
        mockResolveAlbumCover.mockResolvedValue(null);
        mockTrackFindFirst.mockResolvedValue({
            filePath: "Artist/Album/track.flac",
        });
        mockExtractCoverArt.mockResolvedValue("embedded-album.jpg");

        const result =
            await tryHealMissingNativeAlbumCover("embedded-album.jpg");

        expect(mockTrackFindFirst).toHaveBeenCalledTimes(1);
        expect(mockExtractCoverArt).toHaveBeenCalledWith(
            "/music/Artist/Album/track.flac",
            "embedded-album",
        );
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "embedded-album" },
            data: { coverUrl: "native:embedded-album.jpg" },
        });
        expect(result).toContain("native%3Aembedded-album.jpg");
    });

    it("negative-caches a failed embedded-art fallback per album", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            id: "missing-file-album",
            title: "Missing file album",
            rgMbid: null,
            coverUrl: "native:missing-file-album.jpg",
            location: "LIBRARY",
            artist: { name: "Local artist" },
        });
        mockResolveAlbumCover.mockResolvedValue(null);
        mockTrackFindFirst.mockResolvedValue({
            filePath: "Artist/Album/missing.flac",
        });
        mockExtractCoverArt.mockResolvedValue(null);

        await expect(
            tryHealMissingNativeAlbumCover("missing-file-album.jpg"),
        ).resolves.toBeNull();
        await expect(
            tryHealMissingNativeAlbumCover("missing-file-album.jpg"),
        ).resolves.toBeNull();

        expect(mockExtractCoverArt).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith(
            "Embedded cover fallback unavailable for album",
            { albumId: "missing-file-album" },
        );
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
        expect(mockResolveAlbumCover).not.toHaveBeenCalled();
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

    it("delegates malformed release-group identity gating to the resolver", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            id: "malformed-mbid-album",
            title: "Malformed MBID album",
            rgMbid: "not-a-musicbrainz-uuid",
            coverUrl: "native:albums/malformed-mbid-album.jpg",
            location: "LIBRARY",
            artist: { name: "Local artist" },
        });

        await tryHealMissingNativeAlbumCover("albums/malformed-mbid-album.jpg");

        expect(mockResolveAlbumCover).toHaveBeenCalledWith({
            artistName: "Local artist",
            albumTitle: "Malformed MBID album",
            rgMbid: "not-a-musicbrainz-uuid",
        });
    });

    it("uses a working persisted external URL before resolving providers", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            id: "existing-cover-album",
            title: "Existing Cover",
            rgMbid: "11111111-1111-4111-8111-111111111111",
            coverUrl: "https://images.example/existing.jpg",
            location: "LIBRARY",
            artist: { name: "Existing Artist" },
        });
        mockDownloadAndStoreImage.mockResolvedValue(
            "native:albums/existing-cover-album.jpg",
        );

        await tryHealMissingNativeAlbumCover("albums/existing-cover-album.jpg");

        expect(mockDownloadAndStoreImage).toHaveBeenCalledWith(
            "https://images.example/existing.jpg",
            "existing-cover-album",
            "album",
        );
        expect(mockResolveAlbumCover).not.toHaveBeenCalled();
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
        mockResolveAlbumCover
            .mockResolvedValueOnce({
                url: "https://images.example/first.jpg",
                source: "deezer",
            })
            .mockResolvedValueOnce({
                url: "https://images.example/second.jpg",
                source: "deezer",
            });
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

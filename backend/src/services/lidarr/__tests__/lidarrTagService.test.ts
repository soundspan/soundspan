import {
    lidarrService,
    createClientMock,
    primeServiceWithClient,
    mockGetSystemSettings,
    mockMusicBrainzSearchArtist,
    mockStripAlbumEdition,
    mockedConfig,
    LidarrHttpError,
    logger,
} from "../../__tests__/lidarrService.helpers";

describe("LidarrTagService delegation", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue(null);
        mockMusicBrainzSearchArtist.mockResolvedValue([]);
        mockStripAlbumEdition.mockImplementation((title: string) => title);
        mockedConfig.lidarr = undefined;
    });
    it("reads and creates discovery tags with cache semantics", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({
            data: [
                { id: 7, label: "soundspan-discovery" },
                { id: 8, label: "other" },
            ],
        });

        const first = await lidarrService.getOrCreateDiscoveryTag();
        const second = await lidarrService.getOrCreateDiscoveryTag();

        expect(first).toBe(7);
        expect(second).toBe(7);
        expect(client.get).toHaveBeenCalledTimes(1);
    });

    it("creates discovery tag when missing", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockResolvedValueOnce({ data: [] });
        client.post.mockResolvedValueOnce({
            data: { id: 99, label: "soundspan-discovery" },
        });

        const tag = await lidarrService.getOrCreateDiscoveryTag();
        expect(tag).toBe(99);
        expect(client.post).toHaveBeenCalledWith("/api/v1/tag", {
            label: "soundspan-discovery",
        });
    });

    it("returns safe defaults when tag endpoints fail", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        client.get.mockRejectedValueOnce(
            new LidarrHttpError({
                status: 502,
                method: "GET",
                path: "/api/v1/tag",
                attempts: 1,
                isTransient: true,
            }),
        );
        client.post.mockRejectedValueOnce(new Error("tag create failed"));

        await expect(lidarrService.getTags()).resolves.toEqual([]);
        await expect(lidarrService.createTag("new-tag")).resolves.toBeNull();

        expect(client.get).toHaveBeenCalledWith("/api/v1/tag");
        expect(client.post).toHaveBeenCalledWith("/api/v1/tag", {
            label: "new-tag",
        });
        expect(logger.error).toHaveBeenCalledWith(
            "[LIDARR] Failed to get tags:",
            {
                message: "Lidarr GET /api/v1/tag failed after 1 attempt(s)",
                status: 502,
                path: "/api/v1/tag",
            },
        );
    });

    it("retries discovery tag lookup after create failures and only caches successful IDs", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({
            data: [{ id: 101, label: "soundspan-discovery" }],
        });
        client.post.mockRejectedValueOnce(new Error("tag create conflict"));

        await expect(
            lidarrService.getOrCreateDiscoveryTag(),
        ).resolves.toBeNull();
        await expect(lidarrService.getOrCreateDiscoveryTag()).resolves.toBe(
            101,
        );
        await expect(lidarrService.getOrCreateDiscoveryTag()).resolves.toBe(
            101,
        );

        expect(client.get).toHaveBeenCalledTimes(2);
        expect(client.post).toHaveBeenCalledTimes(1);
        expect(client.post).toHaveBeenCalledWith("/api/v1/tag", {
            label: "soundspan-discovery",
        });
    });

    it("adds and removes artist tags by updating merged tag lists", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get
            .mockResolvedValueOnce({
                data: { id: 11, artistName: "Artist A", tags: [1, 2] },
            })
            .mockResolvedValueOnce({
                data: { id: 11, artistName: "Artist A", tags: [1, 2, 3] },
            });
        client.put.mockResolvedValue({});

        await expect(lidarrService.addTagsToArtist(11, [2, 3])).resolves.toBe(
            true,
        );
        await expect(
            lidarrService.removeTagsFromArtist(11, [1, 3]),
        ).resolves.toBe(true);

        expect(client.put).toHaveBeenCalledWith("/api/v1/artist/11", {
            id: 11,
            artistName: "Artist A",
            tags: [1, 2, 3],
        });
        expect(client.put).toHaveBeenCalledWith("/api/v1/artist/11", {
            id: 11,
            artistName: "Artist A",
            tags: [2],
        });
    });

    it("returns false when addTagsToArtist cannot persist merged tags", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({
            data: {
                id: 21,
                artistName: "Artist B",
                monitored: true,
                tags: [4, 7],
            },
        });
        client.put.mockRejectedValueOnce(new Error("tag update failed"));

        await expect(lidarrService.addTagsToArtist(21, [7, 9])).resolves.toBe(
            false,
        );
        expect(client.put).toHaveBeenCalledWith("/api/v1/artist/21", {
            id: 21,
            artistName: "Artist B",
            monitored: true,
            tags: [4, 7, 9],
        });
    });

    it("returns false when removeTagsFromArtist update fails after filtering tags", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);

        client.get.mockResolvedValueOnce({
            data: { id: 22, artistName: "Artist C", tags: [3, 5, 8] },
        });
        client.put.mockRejectedValueOnce(new Error("remove failed"));

        await expect(
            lidarrService.removeTagsFromArtist(22, [5, 99]),
        ).resolves.toBe(false);
        expect(client.put).toHaveBeenCalledWith("/api/v1/artist/22", {
            id: 22,
            artistName: "Artist C",
            tags: [3, 8],
        });
    });

    it("removes discovery tag by MBID when artist is found", async () => {
        const client = createClientMock();
        primeServiceWithClient(client);
        (lidarrService as any).discoveryTagId = 5;

        client.get
            .mockResolvedValueOnce({
                data: [
                    {
                        id: 12,
                        foreignArtistId: "artist-1",
                        artistName: "Artist",
                        tags: [5, 9],
                    },
                ],
            })
            .mockResolvedValueOnce({
                data: { id: 12, artistName: "Artist", tags: [5, 9] },
            });
        client.put.mockResolvedValue({});

        await expect(
            lidarrService.removeDiscoveryTagByMbid("artist-1"),
        ).resolves.toBe(true);
        expect(client.put).toHaveBeenCalledWith("/api/v1/artist/12", {
            id: 12,
            artistName: "Artist",
            tags: [9],
        });
    });
});

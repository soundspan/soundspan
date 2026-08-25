const mockResolveArtistImage = jest.fn();
const mockResolveAlbumCover = jest.fn();

jest.mock("../metadata/artistImageResolver", () => ({
    resolveArtistImage: mockResolveArtistImage,
}));

jest.mock("../metadata/albumCoverResolver", () => ({
    resolveAlbumCover: mockResolveAlbumCover,
}));

import { ImageProviderService } from "../imageProvider";

describe("image provider service behavior", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockResolveArtistImage.mockResolvedValue(null);
        mockResolveAlbumCover.mockResolvedValue(null);
    });

    it("delegates artist image resolution to the metadata facade", async () => {
        const service = new ImageProviderService();
        mockResolveArtistImage.mockResolvedValueOnce({
            url: "https://wikidata/artist.jpg",
            source: "wikidata",
        });

        await expect(
            service.getArtistImage("Artist Name", "artist-mbid"),
        ).resolves.toEqual({
            url: "https://wikidata/artist.jpg",
            source: "wikidata",
        });
        expect(mockResolveArtistImage).toHaveBeenCalledWith({
            artistName: "Artist Name",
            mbid: "artist-mbid",
        });
    });

    it("delegates album cover resolution to the metadata facade", async () => {
        const service = new ImageProviderService();
        mockResolveAlbumCover.mockResolvedValueOnce({
            url: "https://coverartarchive.example/front.jpg",
            source: "coverartarchive",
        });

        await expect(
            service.getAlbumCover("Artist Name", "Album Title", "rg-mbid", {
                timeout: 1_000,
            }),
        ).resolves.toEqual({
            url: "https://coverartarchive.example/front.jpg",
            source: "coverartarchive",
        });
        expect(mockResolveAlbumCover).toHaveBeenCalledWith({
            artistName: "Artist Name",
            albumTitle: "Album Title",
            rgMbid: "rg-mbid",
        });
    });
});

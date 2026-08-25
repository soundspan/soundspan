import { Readable } from "node:stream";
import type { AxiosInstance } from "axios";
import {
    LIDARR_ALBUM_RESPONSE_MAX_BYTES,
    fetchReconciliationAlbumMaps,
} from "../reconciliationAlbumStream";

describe("Lidarr reconciliation album stream", () => {
    it("indexes streamed array entries without retaining the raw catalog", async () => {
        const get = jest.fn(async () => ({
            data: Readable.from([
                '[{"id":1,"title":"Album ',
                'One","foreignAlbumId":"rg-1","artist":{"artistName":"Artist"},',
                '"statistics":{"percentOfTracks":100}},',
                '{"id":2,"title":"Empty","foreignAlbumId":"rg-2",',
                '"artist":{"artistName":"Artist"},"statistics":{"percentOfTracks":0}}]',
            ]),
        }));
        const albumsByMbid = new Map();
        const albumsByTitle = new Map();
        const signal = new AbortController().signal;

        await fetchReconciliationAlbumMaps(
            { get } as unknown as AxiosInstance,
            { albumsByMbid, albumsByTitle },
            signal,
        );

        expect(get).toHaveBeenCalledWith("/api/v1/album", {
            signal,
            responseType: "stream",
            maxContentLength: LIDARR_ALBUM_RESPONSE_MAX_BYTES,
            maxBodyLength: LIDARR_ALBUM_RESPONSE_MAX_BYTES,
        });
        expect(albumsByMbid).toEqual(
            new Map([
                [
                    "rg-1",
                    {
                        id: 1,
                        title: "Album One",
                        foreignAlbumId: "rg-1",
                        artistName: "Artist",
                        hasFiles: true,
                    },
                ],
            ]),
        );
        expect(albumsByTitle.has("artist|album one")).toBe(true);
    });

    it("supports buffered arrays returned by existing Axios test doubles", async () => {
        const get = jest.fn(async () => ({
            data: [
                {
                    id: 3,
                    title: "Buffered",
                    foreignAlbumId: "rg-3",
                    artist: { artistName: "Artist" },
                    statistics: { percentOfTracks: 50 },
                },
            ],
        }));
        const albumsByMbid = new Map();
        const albumsByTitle = new Map();

        await fetchReconciliationAlbumMaps(
            { get } as unknown as AxiosInstance,
            { albumsByMbid, albumsByTitle },
            new AbortController().signal,
        );

        expect(albumsByMbid.has("rg-3")).toBe(true);
    });

    it("rejects an aborted response before indexing entries", async () => {
        const controller = new AbortController();
        controller.abort(new Error("stop"));
        const get = jest.fn();

        await expect(
            fetchReconciliationAlbumMaps(
                { get } as unknown as AxiosInstance,
                { albumsByMbid: new Map(), albumsByTitle: new Map() },
                controller.signal,
            ),
        ).rejects.toThrow("stop");
        expect(get).not.toHaveBeenCalled();
    });
});

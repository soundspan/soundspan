const mockTrackFindUnique = jest.fn();
const mockTrackMappingFindMany = jest.fn();
const mockSystemSettingsFindUnique = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        track: { findUnique: mockTrackFindUnique },
        trackMapping: { findMany: mockTrackMappingFindMany },
        systemSettings: { findUnique: mockSystemSettingsFindUnique },
    },
}));

import {
    choosePeerPlaybackFallback,
    loadPeerPlaybackFallback,
} from "../peerPlaybackFallback";

describe("peer playback fallback ladder", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTrackFindUnique.mockResolvedValue({
            dedupOfTrackId: null,
            duration: 180,
        });
        mockSystemSettingsFindUnique.mockResolvedValue({
            playbackSourceOrder: "library,peers,tidal,ytmusic",
        });
    });

    it("selects the local dedup twin before provider mappings", () => {
        expect(
            choosePeerPlaybackFallback({
                localTwinId: "local-1",
                tidalTrackId: 42,
                youtubeVideoId: "video-1",
            }),
        ).toEqual([
            { source: "library", trackId: "local-1" },
            { source: "tidal", tidalTrackId: 42 },
            { source: "ytmusic", youtubeVideoId: "video-1" },
        ]);
    });

    it("selects an existing TIDAL mapping without a local twin", () => {
        expect(
            choosePeerPlaybackFallback({
                localTwinId: null,
                tidalTrackId: 42,
                youtubeVideoId: "video-1",
            }),
        ).toEqual([
            { source: "tidal", tidalTrackId: 42 },
            { source: "ytmusic", youtubeVideoId: "video-1" },
        ]);
    });

    it("honors the configured order for provider rungs", () => {
        expect(
            choosePeerPlaybackFallback(
                {
                    localTwinId: null,
                    tidalTrackId: 42,
                    youtubeVideoId: "video-1",
                },
                "library,peers,ytmusic,tidal",
            ),
        ).toEqual([
            { source: "ytmusic", youtubeVideoId: "video-1" },
            { source: "tidal", tidalTrackId: 42 },
        ]);
    });

    it("returns an empty ladder when no fallback exists", () => {
        expect(
            choosePeerPlaybackFallback({
                localTwinId: null,
                tidalTrackId: null,
                youtubeVideoId: null,
            }),
        ).toEqual([]);
    });

    it.each([
        ["low-confidence", 0.69, 180],
        ["duration-mismatch", 0.9, 196],
    ])("skips a %s provider mapping", async (_name, confidence, duration) => {
        mockTrackMappingFindMany.mockResolvedValueOnce([
            {
                confidence,
                trackTidal: { tidalId: 42, duration },
                trackYtMusic: null,
            },
        ]);

        await expect(loadPeerPlaybackFallback("peer-track")).resolves.toEqual(
            [],
        );
    });

    it("selects an eligible provider mapping", async () => {
        mockTrackMappingFindMany.mockResolvedValueOnce([
            {
                confidence: 0.7,
                trackTidal: { tidalId: 42, duration: 195 },
                trackYtMusic: null,
            },
        ]);

        await expect(loadPeerPlaybackFallback("peer-track")).resolves.toEqual([
            { source: "tidal", tidalTrackId: 42 },
        ]);
    });
});

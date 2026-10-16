jest.mock("../../../utils/db", () => ({
    prisma: { userSettings: { findUnique: jest.fn() } },
}));

jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

import { prisma } from "../../../utils/db";
import { getSystemSettings } from "../../../utils/systemSettings";
import { loadRemoteLibraryAccess } from "../providers";

const mockFindUserSettings = prisma.userSettings.findUnique as jest.Mock;
const mockGetSystemSettings = getSystemSettings as jest.Mock;

describe("remote library provider access", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindUserSettings.mockResolvedValue({
            tidalOAuthJson: "tidal-token",
            ytMusicOAuthJson: null,
        });
        mockGetSystemSettings.mockResolvedValue({
            tidalEnabled: true,
            ytMusicEnabled: true,
            playbackSourceOrder: "library,peers,tidal,ytmusic",
        });
    });

    it("performs no reads without an authenticated user", async () => {
        await expect(loadRemoteLibraryAccess(undefined)).resolves.toEqual({
            providers: { tidal: false, youtube: false },
            playbackSourceOrder: ["library", "peers", "tidal", "ytmusic"],
        });
        expect(mockFindUserSettings).not.toHaveBeenCalled();
        expect(mockGetSystemSettings).not.toHaveBeenCalled();
    });

    it("requires the system flag and a stored token for TIDAL", async () => {
        mockFindUserSettings.mockResolvedValueOnce({
            tidalOAuthJson: "   ",
            ytMusicOAuthJson: "ignored-for-public-playback",
        });

        const access = await loadRemoteLibraryAccess("user-1");

        expect(access.providers).toEqual({
            tidal: false,
            youtube: true,
        });
    });

    it("allows enabled YouTube Music through its public playback path", async () => {
        mockFindUserSettings.mockResolvedValueOnce({
            tidalOAuthJson: null,
            ytMusicOAuthJson: null,
        });

        const access = await loadRemoteLibraryAccess("user-1");

        expect(access.providers).toEqual({
            tidal: false,
            youtube: true,
        });
    });

    it("disables providers whose system flags are off", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            tidalEnabled: false,
            ytMusicEnabled: false,
            playbackSourceOrder: "library,peers,tidal,ytmusic",
        });

        const access = await loadRemoteLibraryAccess("user-1");

        expect(access.providers).toEqual({
            tidal: false,
            youtube: false,
        });
    });

    it("loads user and system settings once and parses playback order", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            tidalEnabled: true,
            ytMusicEnabled: true,
            playbackSourceOrder: "ytmusic,tidal,peers,library",
        });

        const access = await loadRemoteLibraryAccess("user-1");

        expect(access.providers).toEqual({ tidal: true, youtube: true });
        expect(access.playbackSourceOrder).toEqual([
            "ytmusic",
            "tidal",
            "peers",
            "library",
        ]);
        expect(mockFindUserSettings).toHaveBeenCalledTimes(1);
        expect(mockGetSystemSettings).toHaveBeenCalledTimes(1);
    });
});

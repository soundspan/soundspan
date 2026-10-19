const mockResolveRemoteAlbumMbids = jest.fn();
const mockRunWithSchedulerClaim = jest.fn();

jest.mock("../../../services/remoteAlbumMbidResolution", () => ({
    resolveRemoteAlbumMbids: (...args: unknown[]) =>
        mockResolveRemoteAlbumMbids(...args),
}));
jest.mock("../../../utils/schedulerClaim", () => ({
    runWithSchedulerClaim: (...args: unknown[]) =>
        mockRunWithSchedulerClaim(...args),
}));

import { processRemoteAlbumMbidResolution } from "../remoteAlbumMbidResolutionProcessor";

describe("remote album MBID resolution processor", () => {
    it("runs resolution under the claim and returns claim.acquired", async () => {
        mockResolveRemoteAlbumMbids.mockResolvedValueOnce({ scanned: 0 });
        mockRunWithSchedulerClaim.mockImplementationOnce(
            async (
                _key: string,
                _ttl: number,
                _description: string,
                work: () => Promise<unknown>,
            ) => {
                await work();
                return { acquired: true };
            },
        );

        await expect(processRemoteAlbumMbidResolution()).resolves.toBe(true);

        expect(mockRunWithSchedulerClaim).toHaveBeenCalledWith(
            "scheduler-claim:remote-album-mbid-resolution",
            90 * 60_000,
            "remote album MusicBrainz resolution",
            expect.any(Function),
        );
        expect(mockResolveRemoteAlbumMbids).toHaveBeenCalledTimes(1);
    });

    it("returns false when the scheduler claim is not acquired", async () => {
        mockRunWithSchedulerClaim.mockResolvedValueOnce({ acquired: false });

        await expect(processRemoteAlbumMbidResolution()).resolves.toBe(false);

        expect(mockResolveRemoteAlbumMbids).not.toHaveBeenCalled();
    });
});

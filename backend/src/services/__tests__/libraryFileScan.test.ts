const mockAdd = jest.fn();
jest.mock("../../workers/queues", () => ({ scanQueue: { add: mockAdd } }));

import { requestLibraryFileScan } from "../libraryFileScan";

describe("requestLibraryFileScan", () => {
    beforeEach(() => {
        mockAdd.mockReset();
        mockAdd.mockResolvedValue({});
    });

    it("queues a scan of only the given files", async () => {
        await requestLibraryFileScan("user-1", ["A/B/01. Song.flac"], "test");

        expect(mockAdd).toHaveBeenCalledWith(
            "scan",
            { userId: "user-1", source: "test", paths: ["A/B/01. Song.flac"] },
            { removeOnComplete: true, removeOnFail: 50 },
        );
    });

    it("queues nothing for an empty list", async () => {
        await requestLibraryFileScan(null, [], "test");

        expect(mockAdd).not.toHaveBeenCalled();
    });
});

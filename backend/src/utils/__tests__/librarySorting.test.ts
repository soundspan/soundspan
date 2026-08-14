import { TRACK_VISIBLE_WHERE } from "../librarySorting";

describe("library sorting query fragments", () => {
    it("provides a spreadable predicate for visible tracks", () => {
        expect({ ...TRACK_VISIBLE_WHERE, id: "track-1" }).toEqual({
            removedAt: null,
            id: "track-1",
        });
    });
});

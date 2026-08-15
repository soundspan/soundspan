import {
    LOCAL_TRACK_WHERE,
    parseLibraryOrigin,
    trackBrowseWhere,
} from "../librarySorting";

describe("library federation scoping", () => {
    it("keeps the local-only predicate byte-stable for default local rows", () => {
        expect(LOCAL_TRACK_WHERE).toEqual({ origin: "LOCAL" });
    });

    it("includes undeduplicated federated tracks in all-library browsing", () => {
        expect(trackBrowseWhere("all")).toEqual({
            OR: [
                { origin: "LOCAL" },
                { origin: "FEDERATED", dedupOfTrackId: null },
            ],
        });
    });

    it("suppresses federated duplicates in peer-only browsing", () => {
        expect(trackBrowseWhere("peers")).toEqual({
            origin: "FEDERATED",
            dedupOfTrackId: null,
        });
    });

    it("rejects unknown origin filters", () => {
        expect(parseLibraryOrigin("internet")).toBeNull();
    });
});

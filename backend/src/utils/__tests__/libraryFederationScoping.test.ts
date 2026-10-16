import {
    LIBRARY_BROWSE_ORIGIN_VALUES,
    LOCAL_TRACK_WHERE,
    parseLibraryBrowseOrigin,
    trackBrowseWhere,
} from "../librarySorting";
import { trackBrowseSql } from "../libraryRadioPredicates";

describe("library federation scoping", () => {
    it("parses the Library list-only remote origin", () => {
        expect(LIBRARY_BROWSE_ORIGIN_VALUES).toEqual([
            "all",
            "local",
            "peers",
            "remote",
        ]);
        expect(parseLibraryBrowseOrigin(undefined)).toBe("all");
        expect(parseLibraryBrowseOrigin("remote")).toBe("remote");
        expect(parseLibraryBrowseOrigin("REMOTE")).toBeNull();
        expect(parseLibraryBrowseOrigin(["remote"])).toBeNull();
    });

    it("keeps the local-only predicate byte-stable for default local rows", () => {
        expect(LOCAL_TRACK_WHERE).toEqual({ origin: "LOCAL" });
    });

    it("includes undeduplicated federated tracks in all-library browsing", () => {
        expect(trackBrowseWhere("all")).toEqual({
            OR: [
                { origin: "LOCAL" },
                {
                    origin: "FEDERATED",
                    OR: [
                        { dedupOfTrackId: null },
                        {
                            federationPeer: { showDedupedCopies: true },
                        },
                        { dedupOfTrack: { removedAt: { not: null } } },
                    ],
                },
            ],
        });
    });

    it("suppresses federated duplicates in peer-only browsing", () => {
        expect(trackBrowseWhere("peers")).toEqual({
            origin: "FEDERATED",
            OR: [
                { dedupOfTrackId: null },
                { federationPeer: { showDedupedCopies: true } },
                { dedupOfTrack: { removedAt: { not: null } } },
            ],
        });
    });

    it("keeps zero-federated browsing on the unchanged local arm", () => {
        const where = trackBrowseWhere("all");
        expect(where).toEqual(
            expect.objectContaining({
                OR: expect.arrayContaining([LOCAL_TRACK_WHERE]),
            }),
        );
    });

    it("makes SQL dedup suppression peer-aware through a bounded EXISTS", () => {
        const predicate = trackBrowseSql();
        expect(predicate.strings.join(" ")).toMatch(
            /EXISTS\s*\(\s*SELECT 1 FROM "FederationPeer" dedup_peer/,
        );
        expect(predicate.strings.join(" ")).toContain(
            'dedup_peer."showDedupedCopies"',
        );
    });
});

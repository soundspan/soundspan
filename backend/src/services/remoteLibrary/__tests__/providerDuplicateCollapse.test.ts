import { collapseProviderDuplicates } from "../providerDuplicateCollapse";

const tidal = (
    id: string,
    mappings: Array<{ id: string; trackId: string | null }>,
) => ({ provider: "tidal" as const, providerRowId: id, mappings });
const youtube = (
    id: string,
    mappings?: Array<{ id: string; trackId: string | null }>,
) => ({ provider: "youtube" as const, providerRowId: id, mappings });

describe("provider duplicate collapse", () => {
    it("prefers TIDAL for a shared mapping id and keeps unrelated rows", () => {
        const rows = collapseProviderDuplicates(
            [tidal("t1", [{ id: "mapping-1", trackId: null }])],
            [
                youtube("y1", [{ id: "mapping-1", trackId: null }]),
                youtube("y2", []),
            ],
            "tidal",
        );

        expect(rows.map((row) => row.providerRowId)).toEqual(["t1", "y2"]);
    });

    it("prefers YouTube Music for a shared mapped track id", () => {
        const rows = collapseProviderDuplicates(
            [tidal("t1", [{ id: "mapping-t", trackId: "track-1" }])],
            [youtube("y1", [{ id: "mapping-y", trackId: "track-1" }])],
            "youtube",
        );

        expect(rows.map((row) => row.providerRowId)).toEqual(["y1"]);
    });

    it("keeps provider rows when mappings were not selected", () => {
        const rows = collapseProviderDuplicates(
            [tidal("t1", [])],
            [youtube("y1")],
            "tidal",
        );

        expect(rows.map((row) => row.providerRowId)).toEqual(["t1", "y1"]);
    });
});

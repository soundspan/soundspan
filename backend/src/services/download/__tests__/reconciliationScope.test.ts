import type { DownloadJob } from "@prisma/client";
import { buildReconciliationScope } from "../reconciliationScope";

type ScopeJob = Pick<
    DownloadJob,
    "status" | "targetMbid" | "metadata" | "subject" | "lidarrRef"
>;

function scopeJob(overrides: Partial<ScopeJob> = {}): ScopeJob {
    return {
        status: "processing",
        targetMbid: "",
        metadata: null,
        subject: "Unparsed subject",
        lidarrRef: null,
        ...overrides,
    };
}

describe("buildReconciliationScope", () => {
    it("returns an empty scope when there are no active jobs", () => {
        expect(buildReconciliationScope([])).toEqual({
            needsQueue: false,
            albumTargets: [],
        });
    });

    it("requests only queue data for pending jobs", () => {
        expect(
            buildReconciliationScope([scopeJob({ status: "pending" })]),
        ).toEqual({ needsQueue: true, albumTargets: [] });
    });

    it("collects the primary and distinct Lidarr MBIDs", () => {
        const scope = buildReconciliationScope([
            scopeJob({
                targetMbid: "target-mbid",
                metadata: {
                    albumMbid: "album-mbid",
                    lidarrMbid: "lidarr-mbid",
                },
            }),
        ]);

        expect(scope.albumTargets[0]?.mbids).toEqual([
            "target-mbid",
            "lidarr-mbid",
        ]);
    });

    it("uses albumMbid before lidarrMbid when targetMbid is empty", () => {
        const scope = buildReconciliationScope([
            scopeJob({
                metadata: {
                    albumMbid: "album-mbid",
                    lidarrMbid: "lidarr-mbid",
                },
            }),
        ]);

        expect(scope.albumTargets[0]?.mbids).toEqual([
            "album-mbid",
            "lidarr-mbid",
        ]);
    });

    it("uses metadata artistName before the subject", () => {
        const scope = buildReconciliationScope([
            scopeJob({
                metadata: { artistName: "Metadata Artist" },
                subject: "Subject Artist - Subject Album",
            }),
        ]);

        expect(scope.albumTargets[0]?.artistName).toBe("Metadata Artist");
    });

    it("uses the parsed subject artist when metadata has no artist", () => {
        const scope = buildReconciliationScope([
            scopeJob({ subject: "Subject Artist - Subject Album" }),
        ]);

        expect(scope.albumTargets[0]?.artistName).toBe("Subject Artist");
    });

    it("omits artistName when the subject does not parse", () => {
        const scope = buildReconciliationScope([scopeJob()]);

        expect(scope.albumTargets[0]).toEqual({ mbids: [] });
    });

    it("de-duplicates repeated MBIDs", () => {
        const scope = buildReconciliationScope([
            scopeJob({
                targetMbid: "same-mbid",
                metadata: { lidarrMbid: "same-mbid" },
            }),
        ]);

        expect(scope.albumTargets[0]?.mbids).toEqual(["same-mbid"]);
    });
});

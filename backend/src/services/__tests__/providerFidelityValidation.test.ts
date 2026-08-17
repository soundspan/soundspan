jest.mock("../../config", () => ({
    config: { vibeProviderUrl: undefined, internalApiSecret: undefined },
}));
jest.mock("../../metrics", () => ({ recordVibeProviderRequest: jest.fn() }));
jest.mock("../embeddingSpaces", () => ({ getActiveSpace: jest.fn() }));

import type { ProviderSpace } from "../vibeProvider";
import {
    createEligibleTrackSampler,
    parseProviderFidelityArgs,
    ProviderFidelityExclusionError,
    providerFidelityJsonPath,
    renderProviderFidelityMarkdown,
    runProviderFidelityValidation,
} from "../providerFidelityValidation";

const space: ProviderSpace = {
    family: "clap-music-audioset",
    checkpointHash: "sha256:fixture",
    dim: 2,
    sampleRateHz: 48_000,
    preprocessing: { mono: true },
    revision: "fixture",
    textTower: true,
};

function tracks(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        id: `track-${index.toString().padStart(3, "0")}`,
        filePath: `Artist/Track-${index}.flac`,
    }));
}

function provider(
    overrides: {
        embedAudio?: (trackRef: string) => Promise<number[]>;
    } = {},
) {
    return {
        fetchSpace: jest.fn(async () => space),
        embedAudio: jest.fn(
            overrides.embedAudio ?? (async () => [1, 0] as number[]),
        ),
        embedText: jest.fn(async () => [1, 0] as number[]),
    };
}

describe("provider fidelity validation orchestration", () => {
    it("bounds indexed random-pivot sampling and reuses local eligibility", async () => {
        const findMany = jest
            .fn()
            .mockResolvedValueOnce([
                { id: "track-a", filePath: "A.flac" },
                { id: "track-b", filePath: "B.flac" },
            ])
            .mockResolvedValueOnce([{ id: "track-c", filePath: "C.flac" }]);
        const sample = createEligibleTrackSampler(
            { track: { findMany } },
            () => 0.75,
        );

        await expect(sample(3)).resolves.toHaveLength(3);
        expect(findMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: {
                    origin: "LOCAL",
                    removedAt: null,
                    filePath: { not: null },
                    random: { gte: 0.75 },
                },
                orderBy: { random: "asc" },
                take: 3,
            }),
        );
        expect(findMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ take: 1 }),
        );
    });

    it("fails fast when the providers declare different dimensions", async () => {
        const baseline = provider();
        const candidate = provider();
        candidate.fetchSpace.mockResolvedValue({ ...space, dim: 1024 });
        const sampleTracks = jest.fn(async () => tracks(4));

        await expect(
            runProviderFidelityValidation(
                { sample: 4, k: 1 },
                {
                    sampleTracks,
                    baseline,
                    candidate,
                    queries: ["electronic"],
                    nowMs: jest.fn(() => 1_000),
                    onProgress: jest.fn(),
                    onExclusion: jest.fn(),
                },
            ),
        ).rejects.toThrow("requires a distinct space");
        expect(baseline.embedAudio).not.toHaveBeenCalled();
        expect(candidate.embedAudio).not.toHaveBeenCalled();
    });

    it("calls both providers per track and permits exactly five percent exclusions", async () => {
        const sampledTracks = tracks(20);
        const baseline = provider();
        const candidate = provider({
            embedAudio: async (trackRef) =>
                trackRef === "Artist/Track-0.flac" ? [2, 0] : [1, 0],
        });
        const warn = jest.fn();
        const sampleTracks = jest.fn(async () => sampledTracks);

        const report = await runProviderFidelityValidation(
            { sample: 20, k: 1 },
            {
                sampleTracks,
                baseline,
                candidate,
                queries: ["electronic"],
                nowMs: jest
                    .fn()
                    .mockReturnValueOnce(1_000)
                    .mockReturnValueOnce(2_500),
                onProgress: jest.fn(),
                onExclusion: warn,
            },
        );

        expect(sampleTracks).toHaveBeenCalledWith(20);
        expect(baseline.embedAudio).toHaveBeenCalledTimes(20);
        expect(candidate.embedAudio).toHaveBeenCalledTimes(20);
        expect(report.sample).toEqual({
            requested: 20,
            selected: 20,
            valid: 19,
        });
        expect(report.exclusions).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(report.durationMs).toBe(1_500);
    });

    it("fails the run when malformed vectors exclude more than five percent", async () => {
        const sampledTracks = tracks(20);
        const malformed = new Set([
            "Artist/Track-0.flac",
            "Artist/Track-1.flac",
        ]);
        const baseline = provider({
            embedAudio: async (trackRef) =>
                malformed.has(trackRef) ? [Number.NaN, 0] : [1, 0],
        });
        const candidate = provider();

        const run = runProviderFidelityValidation(
            { sample: 20, k: 1 },
            {
                sampleTracks: async () => sampledTracks,
                baseline,
                candidate,
                queries: ["electronic"],
                nowMs: () => 1_000,
                onProgress: jest.fn(),
                onExclusion: jest.fn(),
            },
        );

        await expect(run).rejects.toBeInstanceOf(
            ProviderFidelityExclusionError,
        );
        await expect(run).rejects.toMatchObject({
            report: {
                sample: { requested: 20, selected: 20, valid: 18 },
                exclusionPolicyPassed: false,
                exclusions: expect.any(Array),
            },
        });
        expect(baseline.embedAudio).toHaveBeenCalledTimes(20);
        expect(candidate.embedAudio).toHaveBeenCalledTimes(20);
    });

    it("limits concurrent track comparisons to three", async () => {
        let active = 0;
        let maximum = 0;
        const embedAudio = async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await Promise.resolve();
            active -= 1;
            return [1, 0];
        };

        await runProviderFidelityValidation(
            { sample: 8, k: 1 },
            {
                sampleTracks: async () => tracks(8),
                baseline: provider({ embedAudio }),
                candidate: provider({ embedAudio }),
                queries: ["electronic"],
                nowMs: () => 1_000,
                onProgress: jest.fn(),
                onExclusion: jest.fn(),
            },
        );

        expect(maximum).toBeLessThanOrEqual(3);
    });

    it("renders provider identities, metric tables, and exclusions", async () => {
        const candidate = provider({ embedAudio: async () => [0.8, 0.6] });
        const report = await runProviderFidelityValidation(
            { sample: 3, k: 1 },
            {
                sampleTracks: async () => tracks(3),
                baseline: provider(),
                candidate,
                queries: ["electronic"],
                nowMs: () => 1_000,
                onProgress: jest.fn(),
                onExclusion: jest.fn(),
            },
        );

        const markdown = renderProviderFidelityMarkdown(report);

        expect(markdown).toContain("## Provider identities");
        expect(markdown).toContain("## Per-track cosine");
        expect(markdown).toContain("## Top-k neighbor overlap");
        expect(markdown).toContain("## Text-query result overlap");
        expect(markdown).toContain("## Exclusions");
    });
});

describe("provider fidelity CLI arguments", () => {
    it("applies defaults and derives the adjacent JSON path", () => {
        const options = parseProviderFidelityArgs(
            ["--candidate-url", "http://candidate:8090"],
            "http://configured-baseline:8091/",
        );

        expect(options).toEqual({
            baselineUrl: "http://configured-baseline:8091",
            candidateUrl: "http://candidate:8090",
            sample: 1_000,
            k: 10,
            outputPath: "provider-fidelity-report.md",
        });
        expect(providerFidelityJsonPath("reports/run.md")).toBe(
            "reports/run.json",
        );
    });

    it("rejects a .json output path before it can collide with the JSON report", () => {
        expect(() => providerFidelityJsonPath("reports/run.json")).toThrow(
            "must not end in .json",
        );
    });

    it("requires a candidate URL", () => {
        expect(() => parseProviderFidelityArgs([], undefined)).toThrow(
            "--candidate-url is required",
        );
    });

    it("requires a baseline URL when VIBE_PROVIDER_URL is unset", () => {
        expect(() =>
            parseProviderFidelityArgs(
                ["--candidate-url", "http://candidate"],
                undefined,
            ),
        ).toThrow("--baseline-url or VIBE_PROVIDER_URL is required");
    });

    it.each([
        [
            ["--candidate-url", "http://candidate", "--sample", "1"],
            "--sample must be between 2 and 2000",
        ],
        [
            ["--candidate-url", "http://candidate", "--sample", "2001"],
            "--sample must be between 2 and 2000",
        ],
        [
            ["--candidate-url", "http://candidate", "--k", "0"],
            "--k must be a positive integer",
        ],
        [
            [
                "--candidate-url",
                "http://candidate",
                "--sample",
                "10",
                "--k",
                "10",
            ],
            "--k must be less than --sample",
        ],
    ])("rejects invalid numeric bounds", (argv, message) => {
        expect(() =>
            parseProviderFidelityArgs(argv, "http://baseline"),
        ).toThrow(message);
    });
});

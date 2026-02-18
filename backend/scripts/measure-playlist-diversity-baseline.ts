import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";
import { prisma } from "../src/utils/db";
import { normalizeArtistName } from "../src/utils/artistNormalization";
import { programmaticPlaylistService } from "../src/services/programmaticPlaylists";
import { moodBucketService } from "../src/services/moodBucketService";
import { lastFmService } from "../src/services/lastfm";

type StratumKey = "sparse" | "medium" | "large" | "artist-skewed";

type StratumConfig = {
    key: StratumKey;
    trackCount: number;
    artistCount: number;
    dominantArtistShare?: number;
};

type GeneratorSpec = {
    id: string;
    run: (userId: string, dateSeed: string) => Promise<{ trackIds: string[] } | null>;
};

type RunMetric = {
    stratum: StratumKey;
    generatorId: string;
    runIndex: number;
    targetSize: number;
    playlistSize: number;
    maxArtistShare: number;
    uniqueArtistRatio: number;
    hhi: number;
    capViolations: number;
    underfill: boolean;
    generationMs: number;
    failedReasons: string[];
};

type AggregateSummary = {
    stratum: StratumKey;
    generatorId: string;
    samples: number;
    targetMode: number;
    medianMaxArtistShare: number;
    p95MaxArtistShare: number;
    medianUniqueArtistRatio: number;
    p95UniqueArtistRatio: number;
    medianHhi: number;
    p95Hhi: number;
    capViolationRate: number;
    underfillRate: number;
    medianGenerationMs: number;
    pass: boolean;
    failReasons: string[];
};

const RUNS_PER_GENERATOR = 30;
const ARTIST_CAP = 2;

const STRATA: StratumConfig[] = [
    { key: "sparse", trackCount: 400, artistCount: 40 },
    { key: "medium", trackCount: 1200, artistCount: 180 },
    { key: "large", trackCount: 5200, artistCount: 750 },
    {
        key: "artist-skewed",
        trackCount: 1200,
        artistCount: 80,
        dominantArtistShare: 0.45,
    },
];

const PARTY_GENRES = ["dance", "electronic", "pop", "house", "edm", "disco", "techno"];
const WORKOUT_GENRES = ["rock", "metal", "hip hop", "rap", "trap", "hardcore", "drum and bass"];
const FOCUS_GENRES = ["classical", "instrumental", "ambient", "jazz", "soundtrack", "piano"];
const CHILL_GENRES = ["indie", "lofi", "acoustic", "soul", "dream pop", "downtempo"];
const BASE_GENRES = ["alternative", "folk", "rnb", "funk", "new wave", "singer-songwriter"];

const ALL_GENRES = Array.from(
    new Set([...PARTY_GENRES, ...WORKOUT_GENRES, ...FOCUS_GENRES, ...CHILL_GENRES, ...BASE_GENRES]),
);

const GENERATORS: GeneratorSpec[] = [
    {
        id: "generateEraMix",
        run: (userId, dateSeed) => programmaticPlaylistService.generateEraMix(userId, dateSeed),
    },
    {
        id: "generateGenreMix",
        run: (userId, dateSeed) => programmaticPlaylistService.generateGenreMix(userId, dateSeed),
    },
    {
        id: "generateTopTracksMix",
        run: (userId, _dateSeed) => programmaticPlaylistService.generateTopTracksMix(userId),
    },
    {
        id: "generateRediscoverMix",
        run: (userId, dateSeed) =>
            programmaticPlaylistService.generateRediscoverMix(userId, dateSeed),
    },
    {
        id: "generateArtistSimilarMix",
        run: (userId, _dateSeed) => programmaticPlaylistService.generateArtistSimilarMix(userId),
    },
    {
        id: "generatePartyMix",
        run: (userId, dateSeed) => programmaticPlaylistService.generatePartyMix(userId, dateSeed),
    },
    {
        id: "generateChillMix",
        run: (userId, dateSeed) => programmaticPlaylistService.generateChillMix(userId, dateSeed),
    },
    {
        id: "generateWorkoutMix",
        run: (userId, dateSeed) => programmaticPlaylistService.generateWorkoutMix(userId, dateSeed),
    },
    {
        id: "generateFocusMix",
        run: (userId, dateSeed) => programmaticPlaylistService.generateFocusMix(userId, dateSeed),
    },
    {
        id: "moodBucketService.getMoodMix",
        run: async (_userId, _dateSeed) => moodBucketService.getMoodMix("chill", 15),
    },
];

let similarArtistNames: string[] = [];
(lastFmService as unknown as { getSimilarArtists: (mbid: string, name: string, limit?: number) => Promise<Array<{ name: string; match: number; url: string }>> }).getSimilarArtists = async (
    _artistMbid: string,
    _artistName: string,
    limit = 10,
) => {
    return similarArtistNames.slice(0, limit).map((name, index) => ({
        name,
        match: Math.max(0.05, 1 - index * 0.08),
        url: "",
    }));
};

function makeRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function choose<T>(rng: () => number, values: T[]): T {
    return values[Math.floor(rng() * values.length)];
}

function quantile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function median(values: number[]): number {
    return quantile(values, 0.5);
}

function p95(values: number[]): number {
    return quantile(values, 0.95);
}

function round(n: number, digits = 4): number {
    const factor = 10 ** digits;
    return Math.round(n * factor) / factor;
}

function mode(values: number[]): number {
    const counts = new Map<number, number>();
    for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let best = values[0] ?? 0;
    let bestCount = -1;
    for (const [value, count] of counts) {
        if (count > bestCount) {
            bestCount = count;
            best = value;
        }
    }
    return best;
}

function getTargetSize(generatorId: string, playlistSize: number): number {
    if (generatorId === "moodBucketService.getMoodMix") return 15;
    if (generatorId === "generateChillMix") {
        return playlistSize <= 10 ? 10 : 20;
    }
    return 20;
}

function getThresholds(targetSize: number) {
    if (targetSize <= 10) {
        return {
            maxArtistShare: 0.2,
            uniqueArtistRatio: 0.6,
            hhi: 0.22,
        };
    }

    // Inference from Task 0.3 rubric: use 20-track thresholds for 15+ mixes.
    return {
        maxArtistShare: 0.15,
        uniqueArtistRatio: 0.55,
        hhi: 0.18,
    };
}

function getUnderfillTolerance(stratum: StratumKey): number {
    return stratum === "sparse" ? 0.05 : 0.01;
}

async function createManyBatches<T>(
    rows: T[],
    batchSize: number,
    execute: (batch: T[]) => Promise<void>,
): Promise<void> {
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        await execute(batch);
    }
}

async function resetMeasurementData(): Promise<void> {
    await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
            "MoodBucket",
            "Play",
            "TrackGenre",
            "Track",
            "Album",
            "Artist",
            "Genre",
            "UserMoodMix",
            "UserSettings",
            "User"
        RESTART IDENTITY CASCADE
    `);
}

function buildArtistTrackCounts(config: StratumConfig): number[] {
    const counts = new Array(config.artistCount).fill(0);

    if (config.dominantArtistShare && config.artistCount > 1) {
        const dominantCount = Math.floor(config.trackCount * config.dominantArtistShare);
        counts[0] = dominantCount;
        let remaining = config.trackCount - dominantCount;
        let cursor = 1;
        while (remaining > 0) {
            counts[cursor] += 1;
            remaining -= 1;
            cursor += 1;
            if (cursor >= config.artistCount) cursor = 1;
        }
        return counts;
    }

    let remaining = config.trackCount;
    let cursor = 0;
    while (remaining > 0) {
        counts[cursor] += 1;
        remaining -= 1;
        cursor = (cursor + 1) % config.artistCount;
    }

    return counts;
}

async function seedStratum(config: StratumConfig): Promise<{ userId: string }> {
    const rng = makeRng(config.trackCount * 13 + config.artistCount * 7);
    const now = new Date("2026-02-13T12:00:00.000Z");

    const user = await prisma.user.create({
        data: {
            username: `baseline-${config.key}`,
            passwordHash: "$2b$10$baselinebaselinebaselinebaselinebaselinebaseline1",
            onboardingComplete: true,
        },
    });

    await prisma.genre.createMany({
        data: ALL_GENRES.map((name) => ({ name })),
        skipDuplicates: true,
    });

    const genreRows = await prisma.genre.findMany({
        where: { name: { in: ALL_GENRES } },
        select: { id: true, name: true },
    });
    const genreIdByName = new Map(genreRows.map((genre) => [genre.name, genre.id]));

    const decades = [1980, 1990, 2000, 2010, 2020];
    const artistRows = [] as Array<{ id: string; mbid: string; name: string; normalizedName: string }>;
    const albumRows = [] as Array<{
        id: string;
        rgMbid: string;
        artistId: string;
        title: string;
        year: number;
        originalYear: number;
        displayYear: number;
        primaryType: string;
        genres: string[];
    }>;
    const artistCategory: string[] = [];

    for (let i = 0; i < config.artistCount; i += 1) {
        const artistId = `${config.key}-artist-${i}`;
        const artistName = `${config.key.toUpperCase()} Artist ${i}`;
        const category = i % 4 === 0 ? "party" : i % 4 === 1 ? "workout" : i % 4 === 2 ? "focus" : "chill";
        artistCategory.push(category);

        artistRows.push({
            id: artistId,
            mbid: `${config.key}-mbid-${i}`,
            name: artistName,
            normalizedName: normalizeArtistName(artistName),
        });

        const decade = decades[i % decades.length];
        const year = decade + (i % 10);
        const categoryGenrePool =
            category === "party"
                ? PARTY_GENRES
                : category === "workout"
                  ? WORKOUT_GENRES
                  : category === "focus"
                    ? FOCUS_GENRES
                    : CHILL_GENRES;

        albumRows.push({
            id: `${config.key}-album-${i}`,
            rgMbid: `${config.key}-rgmbid-${i}`,
            artistId,
            title: `${artistName} Collection`,
            year,
            originalYear: year,
            displayYear: year,
            primaryType: "album",
            genres: [choose(rng, categoryGenrePool), choose(rng, BASE_GENRES)],
        });
    }

    await createManyBatches(artistRows, 500, async (batch) => {
        await prisma.artist.createMany({ data: batch });
    });

    await createManyBatches(albumRows, 500, async (batch) => {
        await prisma.album.createMany({
            data: batch.map((row) => ({
                ...row,
                genres: row.genres as unknown as object,
            })),
        });
    });

    const trackCounts = buildArtistTrackCounts(config);
    const trackRows: Array<Record<string, unknown>> = [];
    const trackGenreRows: Array<{ trackId: string; genreId: string }> = [];
    const moodBucketRows: Array<{ trackId: string; mood: string; score: number }> = [];

    let globalTrackIndex = 0;

    for (let artistIndex = 0; artistIndex < trackCounts.length; artistIndex += 1) {
        const artistId = artistRows[artistIndex].id;
        const albumId = `${config.key}-album-${artistIndex}`;
        const category = artistCategory[artistIndex];
        const count = trackCounts[artistIndex];

        for (let trackNo = 1; trackNo <= count; trackNo += 1) {
            const trackId = `${config.key}-track-${globalTrackIndex}`;
            const categoryGenres =
                category === "party"
                    ? PARTY_GENRES
                    : category === "workout"
                      ? WORKOUT_GENRES
                      : category === "focus"
                        ? FOCUS_GENRES
                        : CHILL_GENRES;

            const primaryGenre = choose(rng, categoryGenres);
            const secondaryGenre = choose(rng, BASE_GENRES);

            const valenceBase = category === "party" ? 0.75 : category === "workout" ? 0.65 : category === "focus" ? 0.45 : 0.4;
            const energyBase = category === "party" ? 0.8 : category === "workout" ? 0.85 : category === "focus" ? 0.45 : 0.35;
            const danceBase = category === "party" ? 0.8 : category === "workout" ? 0.65 : category === "focus" ? 0.35 : 0.45;
            const bpmBase = category === "party" ? 125 : category === "workout" ? 138 : category === "focus" ? 95 : 88;
            const instrBase = category === "focus" ? 0.85 : category === "chill" ? 0.45 : 0.15;
            const acousBase = category === "focus" ? 0.55 : category === "chill" ? 0.5 : 0.2;
            const arousalBase = category === "party" ? 0.78 : category === "workout" ? 0.84 : category === "focus" ? 0.45 : 0.38;
            const moodRelaxedBase = category === "focus" || category === "chill" ? 0.72 : 0.2;
            const moodAggressiveBase = category === "workout" ? 0.72 : category === "party" ? 0.35 : 0.12;
            const moodPartyBase = category === "party" ? 0.78 : 0.25;

            const jitter = () => (rng() - 0.5) * 0.12;
            const bounded = (value: number) => Math.max(0.01, Math.min(0.99, value));

            trackRows.push({
                id: trackId,
                albumId,
                title: `${artistRows[artistIndex].name} Track ${trackNo}`,
                trackNo,
                discNo: 1,
                duration: 180 + Math.floor(rng() * 120),
                filePath: `/music/${config.key}/${artistId}/track-${globalTrackIndex}.mp3`,
                fileModified: new Date(now.getTime() - Math.floor(rng() * 120) * 86400000),
                fileSize: 4_000_000 + Math.floor(rng() * 10_000_000),
                bpm: bpmBase + jitter() * 100,
                key: choose(rng, ["C", "D", "E", "F", "G", "A", "B"]),
                keyScale: category === "chill" ? "minor" : choose(rng, ["major", "minor"]),
                energy: bounded(energyBase + jitter()),
                danceability: bounded(danceBase + jitter()),
                valence: bounded(valenceBase + jitter()),
                arousal: bounded(arousalBase + jitter()),
                instrumentalness: bounded(instrBase + jitter()),
                acousticness: bounded(acousBase + jitter()),
                moodHappy: bounded(valenceBase + jitter()),
                moodSad: bounded(1 - valenceBase + jitter()),
                moodRelaxed: bounded(moodRelaxedBase + jitter()),
                moodAggressive: bounded(moodAggressiveBase + jitter()),
                moodParty: bounded(moodPartyBase + jitter()),
                moodAcoustic: bounded(acousBase + jitter()),
                moodElectronic: bounded(category === "party" ? 0.7 + jitter() : 0.3 + jitter()),
                danceabilityMl: bounded(danceBase + jitter()),
                moodTags:
                    category === "party"
                        ? ["party", "danceable", "upbeat"]
                        : category === "workout"
                          ? ["energetic", "powerful", "aggressive"]
                          : category === "focus"
                            ? ["instrumental", "calm", "focused"]
                            : ["chill", "relaxed", "mellow"],
                lastfmTags: [primaryGenre, secondaryGenre],
                essentiaGenres: [primaryGenre],
                analysisStatus: "completed",
                analysisMode: "enhanced",
                analyzedAt: now,
            });

            const primaryGenreId = genreIdByName.get(primaryGenre);
            if (primaryGenreId) {
                trackGenreRows.push({ trackId, genreId: primaryGenreId });
            }
            const secondaryGenreId = genreIdByName.get(secondaryGenre);
            if (secondaryGenreId && secondaryGenreId !== primaryGenreId) {
                trackGenreRows.push({ trackId, genreId: secondaryGenreId });
            }

            moodBucketRows.push({
                trackId,
                mood: category === "workout" ? "energetic" : category,
                score: 0.6 + rng() * 0.35,
            });

            if (category === "chill" && rng() > 0.2) {
                moodBucketRows.push({
                    trackId,
                    mood: "chill",
                    score: 0.65 + rng() * 0.3,
                });
            }

            globalTrackIndex += 1;
        }
    }

    await createManyBatches(trackRows, 1000, async (batch) => {
        await prisma.track.createMany({ data: batch as Array<any> });
    });

    await createManyBatches(trackGenreRows, 2000, async (batch) => {
        await prisma.trackGenre.createMany({ data: batch, skipDuplicates: true });
    });

    await createManyBatches(moodBucketRows, 2000, async (batch) => {
        await prisma.moodBucket.createMany({ data: batch, skipDuplicates: true });
    });

    const allTrackIds = trackRows.map((row) => row.id as string);
    const plays: Array<{ userId: string; trackId: string; playedAt: Date }> = [];

    // Top-track signal for generateTopTracksMix.
    const topTrackCandidates = allTrackIds.slice(0, 50);
    for (let i = 0; i < topTrackCandidates.length; i += 1) {
        const trackId = topTrackCandidates[i];
        const playCount = Math.max(1, 55 - i);
        for (let j = 0; j < playCount; j += 1) {
            plays.push({
                userId: user.id,
                trackId,
                playedAt: new Date(now.getTime() - (j % 28) * 86400000),
            });
        }
    }

    // Recent-play concentration for generateArtistSimilarMix top artist detection.
    const dominantArtistTrackIds = allTrackIds.filter((trackId) => trackId.includes(`${config.key}-track-`)).slice(0, 12);
    for (let i = 0; i < 120; i += 1) {
        plays.push({
            userId: user.id,
            trackId: dominantArtistTrackIds[i % dominantArtistTrackIds.length],
            playedAt: new Date(now.getTime() - (i % 6) * 86400000),
        });
    }

    await createManyBatches(plays, 2000, async (batch) => {
        await prisma.play.createMany({ data: batch });
    });

    similarArtistNames = artistRows.slice(1, 15).map((artist) => artist.name);

    return { userId: user.id };
}

function evaluateRun(metric: RunMetric): RunMetric {
    const thresholds = getThresholds(metric.targetSize);

    if (metric.capViolations > 0) {
        metric.failedReasons.push("capViolations");
    }

    if (metric.maxArtistShare > thresholds.maxArtistShare) {
        metric.failedReasons.push("maxArtistShare");
    }

    if (metric.uniqueArtistRatio < thresholds.uniqueArtistRatio) {
        metric.failedReasons.push("uniqueArtistRatio");
    }

    if (metric.hhi > thresholds.hhi) {
        metric.failedReasons.push("hhi");
    }

    return metric;
}

function summarize(metrics: RunMetric[]): AggregateSummary[] {
    const grouped = new Map<string, RunMetric[]>();

    for (const metric of metrics) {
        const key = `${metric.stratum}::${metric.generatorId}`;
        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key)!.push(metric);
    }

    const summaries: AggregateSummary[] = [];

    for (const [key, rows] of grouped.entries()) {
        const [stratum, generatorId] = key.split("::") as [StratumKey, string];
        const targetMode = mode(rows.map((row) => row.targetSize));
        const thresholds = getThresholds(targetMode);
        const underfillTolerance = getUnderfillTolerance(stratum);

        const capViolationRate = rows.filter((row) => row.capViolations > 0).length / rows.length;
        const underfillRate = rows.filter((row) => row.underfill).length / rows.length;

        const maxShareValues = rows.map((row) => row.maxArtistShare);
        const uniqueRatioValues = rows.map((row) => row.uniqueArtistRatio);
        const hhiValues = rows.map((row) => row.hhi);
        const generationValues = rows.map((row) => row.generationMs);

        const failReasons = new Set<string>();
        for (const row of rows) {
            for (const reason of row.failedReasons) {
                failReasons.add(reason);
            }
        }

        if (underfillRate > underfillTolerance) {
            failReasons.add("underfill");
        }

        const summary: AggregateSummary = {
            stratum,
            generatorId,
            samples: rows.length,
            targetMode,
            medianMaxArtistShare: round(median(maxShareValues)),
            p95MaxArtistShare: round(p95(maxShareValues)),
            medianUniqueArtistRatio: round(median(uniqueRatioValues)),
            p95UniqueArtistRatio: round(p95(uniqueRatioValues)),
            medianHhi: round(median(hhiValues)),
            p95Hhi: round(p95(hhiValues)),
            capViolationRate: round(capViolationRate),
            underfillRate: round(underfillRate),
            medianGenerationMs: round(median(generationValues), 2),
            pass:
                capViolationRate === 0 &&
                underfillRate <= underfillTolerance &&
                p95(maxShareValues) <= thresholds.maxArtistShare &&
                median(uniqueRatioValues) >= thresholds.uniqueArtistRatio &&
                p95(hhiValues) <= thresholds.hhi,
            failReasons: Array.from(failReasons.values()).sort(),
        };

        summaries.push(summary);
    }

    return summaries.sort((a, b) => {
        if (a.stratum === b.stratum) return a.generatorId.localeCompare(b.generatorId);
        return a.stratum.localeCompare(b.stratum);
    });
}

function decideRecommendation(summaries: AggregateSummary[]): string {
    const mediumLargeSkewFails = summaries.filter(
        (summary) =>
            ["medium", "large", "artist-skewed"].includes(summary.stratum) && !summary.pass,
    );

    if (mediumLargeSkewFails.length > 0) {
        return "Adapt/Implement";
    }

    const sparseFails = summaries.filter((summary) => summary.stratum === "sparse" && !summary.pass);
    if (
        sparseFails.length > 0 &&
        sparseFails.every((summary) => summary.failReasons.length === 1 && summary.failReasons[0] === "underfill")
    ) {
        return "Adapt with fallback tuning";
    }

    return "Keep as-is";
}

function buildReport(summaries: AggregateSummary[], recommendation: string): string {
    const generatedAt = new Date().toISOString();

    const lines: string[] = [];
    lines.push("# Playlist Diversity Baseline Report");
    lines.push("");
    lines.push(`- Generated at: ${generatedAt}`);
    lines.push("- Runner: `backend/scripts/measure-playlist-diversity-baseline.ts`");
    lines.push(`- Runs per generator per stratum: ${RUNS_PER_GENERATOR}`);
    lines.push(`- Artist cap threshold: ${ARTIST_CAP}`);
    lines.push("");
    lines.push("## Decision");
    lines.push("");
    lines.push(`- Recommendation: **${recommendation}**`);
    lines.push("");
    lines.push("## Summary Table");
    lines.push("");
    lines.push("| Stratum | Generator | Target | Pass | P95 maxShare | Median uniqueRatio | P95 HHI | capViolationRate | underfillRate | Median ms | Fail Reasons |");
    lines.push("|---|---|---:|---|---:|---:|---:|---:|---:|---:|---|");

    for (const summary of summaries) {
        lines.push(
            `| ${summary.stratum} | ${summary.generatorId} | ${summary.targetMode} | ${summary.pass ? "yes" : "no"} | ${summary.p95MaxArtistShare} | ${summary.medianUniqueArtistRatio} | ${summary.p95Hhi} | ${summary.capViolationRate} | ${summary.underfillRate} | ${summary.medianGenerationMs} | ${summary.failReasons.join(", ") || "-"} |`,
        );
    }

    lines.push("");
    lines.push("## Notes");
    lines.push("");
    lines.push("- For 15-track mood mixes, thresholds were inferred from the 20-track rubric (strict path)." );
    lines.push("- Metrics follow Task 0.3 definitions: `maxArtistShare`, `uniqueArtistRatio`, `HHI`, `capViolations`, `underfill`." );

    return lines.join("\n");
}

async function runMeasurement(): Promise<void> {
    const metrics: RunMetric[] = [];

    for (const stratum of STRATA) {
        await resetMeasurementData();
        const { userId } = await seedStratum(stratum);

        const trackArtistRows = await prisma.track.findMany({
            select: {
                id: true,
                album: {
                    select: {
                        artistId: true,
                    },
                },
            },
        });

        const trackArtistMap = new Map<string, string>(
            trackArtistRows.map((row) => [row.id, row.album.artistId]),
        );

        for (const generator of GENERATORS) {
            for (let runIndex = 0; runIndex < RUNS_PER_GENERATOR; runIndex += 1) {
                const seedDate = new Date(Date.UTC(2026, 0, 1 + runIndex)).toISOString().slice(0, 10);

                const started = performance.now();
                const mix = await generator.run(userId, seedDate);
                const generationMs = performance.now() - started;

                const trackIds = mix?.trackIds ?? [];
                const playlistSize = trackIds.length;
                const targetSize = getTargetSize(generator.id, playlistSize);

                const artistCounts = new Map<string, number>();
                for (const trackId of trackIds) {
                    const artistId = trackArtistMap.get(trackId) ?? `unknown:${trackId}`;
                    artistCounts.set(artistId, (artistCounts.get(artistId) ?? 0) + 1);
                }

                const counts = Array.from(artistCounts.values());
                const maxTracksPerArtist = counts.length > 0 ? Math.max(...counts) : 0;
                const maxArtistShare = playlistSize > 0 ? maxTracksPerArtist / playlistSize : 0;
                const uniqueArtistRatio = playlistSize > 0 ? artistCounts.size / playlistSize : 0;
                const hhi =
                    playlistSize > 0
                        ? counts.reduce((sum, count) => {
                              const share = count / playlistSize;
                              return sum + share * share;
                          }, 0)
                        : 0;
                const capViolations = counts.filter((count) => count > ARTIST_CAP).length;
                const underfill = playlistSize < targetSize;

                const metric = evaluateRun({
                    stratum: stratum.key,
                    generatorId: generator.id,
                    runIndex,
                    targetSize,
                    playlistSize,
                    maxArtistShare,
                    uniqueArtistRatio,
                    hhi,
                    capViolations,
                    underfill,
                    generationMs,
                    failedReasons: [],
                });

                metrics.push(metric);
            }
        }
    }

    const summaries = summarize(metrics);
    const recommendation = decideRecommendation(summaries);
    const report = buildReport(summaries, recommendation);

    const reportPath = path.resolve(
        process.cwd(),
        "..",
        "plans",
        "current",
        "fjordnode-feature-port",
        "PLAYLIST_DIVERSITY_BASELINE_REPORT.md",
    );

    fs.writeFileSync(reportPath, report, "utf8");
    console.log(`Baseline report written: ${reportPath}`);
    console.log(`Decision: ${recommendation}`);
}

runMeasurement()
    .catch((error) => {
        console.error("Baseline measurement failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

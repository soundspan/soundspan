/**
 * F13 benchmark: Spotify-import matchTrack-loop wall-clock, before/after
 * bounding it with PQueue (backend/src/services/spotifyImport.ts).
 *
 * Usage (from backend/, against the local dev Postgres/Redis):
 *   DATABASE_URL=postgresql://soundspan:<pw>@127.0.0.1:5432/soundspan \
 *   REDIS_URL=redis://127.0.0.1:6379 \
 *   SESSION_SECRET=<32+ chars> \
 *   MUSIC_PATH=/tmp/bench-music-placeholder \
 *     npx tsx scripts/benchmark-spotify-import.ts
 *
 * Scope: times ONLY the matchTrack loop's effect on buildPreviewFromTracklist
 * -- NOT a full, unmocked import. musicBrainzService is monkey-patched to
 * resolve instantly with empty results before the timed call, so:
 *   - Phase 0 (MusicBrainz "Unknown Album" enrichment) never fires at all --
 *     the fixture deliberately contains no "Unknown Album" tracks, so the
 *     `unknownCount > 0` guard in buildPreviewFromTracklist skips it.
 *   - The post-loop unmatched-album -> findAlbumMbid tail (which would
 *     otherwise hit the live, rate-limited MusicBrainz HTTP API once per
 *     unmatched album) resolves near-instantly instead.
 * That leaves the matchTrack loop -- serial on the base tree, PQueue-bounded
 * on this branch -- as the dominant cost in the measured wall-clock.
 *
 * READ-ONLY: only SELECTs against the DB (via matchTrack's Prisma calls).
 * No writes. No external HTTP (MusicBrainz stubbed, Deezer/Spotify never
 * imported by this path).
 *
 * The 50-track tracklist is sampled from the real DB on first run and
 * cached to BENCH_FIXTURE_PATH (default /tmp/f13-spotify-import-bench-fixture.json)
 * so every subsequent invocation -- across git checkouts, i.e. across the
 * before/after comparison -- uses the byte-identical tracklist. Delete the
 * cache file to force a fresh sample.
 */
import { performance } from "perf_hooks";
import fs from "fs";
import { execSync } from "child_process";
import { prisma } from "../src/utils/db";
import { musicBrainzService } from "../src/services/musicbrainz";
import { spotifyImportService } from "../src/services/spotifyImport";
import type { SpotifyTrack } from "../src/services/spotify";

const FIXTURE_PATH =
    process.env.BENCH_FIXTURE_PATH ||
    "/tmp/f13-spotify-import-bench-fixture.json";
const REAL_SAMPLE_COUNT = 40;
const PERTURBED_ABSENT_COUNT = 10;
const TOTAL_TRACKS = REAL_SAMPLE_COUNT + PERTURBED_ABSENT_COUNT;

interface Triple {
    title: string;
    albumTitle: string;
    artistName: string;
    durationSec: number;
    trackNo: number;
}

function currentTree(): string {
    try {
        const branch = execSync("git branch --show-current", {
            encoding: "utf8",
        }).trim();
        const sha = execSync("git rev-parse --short HEAD", {
            encoding: "utf8",
        }).trim();
        return branch ? `${branch}@${sha}` : `detached@${sha}`;
    } catch {
        return "unknown-tree";
    }
}

/** Samples REAL_SAMPLE_COUNT distinct (title, album, artist) triples from the
 * live corpus, scattered across several random offsets rather than one
 * contiguous block, for artist/album diversity. */
async function sampleRealTriples(count: number): Promise<Triple[]> {
    const total = await prisma.track.count();
    if (total === 0) {
        throw new Error("Track table is empty -- cannot sample a fixture");
    }

    const seen = new Set<string>();
    const results: Triple[] = [];
    const batches = 16;
    const perBatch = Math.max(1, Math.ceil((count / batches) * 1.5));

    for (let b = 0; b < batches && results.length < count; b++) {
        const maxOffset = Math.max(0, total - perBatch);
        const offset = Math.floor(Math.random() * (maxOffset + 1));
        const rows = await prisma.track.findMany({
            take: perBatch,
            skip: offset,
            include: { album: { include: { artist: true } } },
        });
        for (const row of rows) {
            if (results.length >= count) break;
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            results.push({
                title: row.title,
                albumTitle: row.album.title,
                artistName: row.album.artist.name,
                durationSec: row.duration,
                trackNo: row.trackNo,
            });
        }
    }

    if (results.length < count) {
        throw new Error(
            `Only sampled ${results.length}/${count} real triples -- corpus too small or offsets kept colliding`
        );
    }
    return results.slice(0, count);
}

/** ~half perturbed (real artist, mutated title/album -- exercises the
 * Strategy 2/3/4 near-miss paths), ~half fully fictional (guaranteed absent,
 * exercises the artist-not-found path and the unmatched-album tail). */
function buildPerturbedAbsent(seedTriples: Triple[], count: number): Triple[] {
    const out: Triple[] = [];
    const perturbedCount = Math.ceil(count / 2);

    for (let i = 0; i < perturbedCount && i < seedTriples.length; i++) {
        const seed = seedTriples[i];
        out.push({
            title: `${seed.title} (Live Bootleg Mix ${i})`,
            albumTitle: `${seed.albumTitle} - Nonexistent Reissue ${i}`,
            artistName: seed.artistName,
            durationSec: 210,
            trackNo: 1,
        });
    }
    for (let i = out.length; i < count; i++) {
        out.push({
            title: `Definitely Not A Real Track Title ${i}`,
            albumTitle: `Nonexistent Benchmark Album ${i}`,
            artistName: `Nonexistent Benchmark Artist ${i}`,
            durationSec: 200,
            trackNo: 1,
        });
    }
    return out;
}

async function buildFixture(): Promise<SpotifyTrack[]> {
    if (fs.existsSync(FIXTURE_PATH)) {
        const cached: SpotifyTrack[] = JSON.parse(
            fs.readFileSync(FIXTURE_PATH, "utf8")
        );
        console.log(
            `[fixture] reusing cached ${cached.length}-track fixture from ${FIXTURE_PATH}`
        );
        return cached;
    }

    console.log(
        `[fixture] sampling ${REAL_SAMPLE_COUNT} real triples from the DB...`
    );
    const real = await sampleRealTriples(REAL_SAMPLE_COUNT);
    const perturbedAbsent = buildPerturbedAbsent(real, PERTURBED_ABSENT_COUNT);
    const all = [...real, ...perturbedAbsent];

    const tracklist: SpotifyTrack[] = all.map((t, i) => ({
        spotifyId: `bench-${i}`,
        title: t.title,
        artist: t.artistName,
        artistId: `bench-artist-${i}`,
        album: t.albumTitle,
        albumId: `bench-album-${i}`,
        isrc: null,
        durationMs: t.durationSec * 1000,
        trackNumber: t.trackNo,
        previewUrl: null,
        coverUrl: null,
    }));

    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(tracklist, null, 2));
    console.log(
        `[fixture] wrote ${tracklist.length}-track fixture to ${FIXTURE_PATH} ` +
            `(${REAL_SAMPLE_COUNT} real + ${PERTURBED_ABSENT_COUNT} perturbed/absent)`
    );
    return tracklist;
}

function stubMusicBrainz(): void {
    // Zero external HTTP during the timed run -- see file header.
    musicBrainzService.searchArtist = async () => [];
    musicBrainzService.getReleaseGroups = async () => [];
    musicBrainzService.searchRecording = async () => null;
    musicBrainzService.clearStaleRecordingCaches = async () => 0;
}

async function timedRun(
    tracklist: SpotifyTrack[]
): Promise<{ ms: number; inLibrary: number; downloadable: number }> {
    // Private-access hatch: buildPreviewFromTracklist is private, but it's the
    // narrowest real (unmocked, un-reimplemented) entry point that contains
    // the matchTrack loop under test.
    const service = spotifyImportService as any;
    const meta = {
        id: "bench-playlist",
        name: "F13 Benchmark Playlist",
        description: null,
        owner: "bench",
        imageUrl: null,
        trackCount: tracklist.length,
    };

    const started = performance.now();
    const preview = await service.buildPreviewFromTracklist(
        tracklist,
        meta,
        "Spotify"
    );
    const ms = performance.now() - started;

    return {
        ms,
        inLibrary: preview.summary.inLibrary,
        downloadable: preview.summary.downloadable,
    };
}

async function main(): Promise<void> {
    const tree = currentTree();
    stubMusicBrainz();

    const tracklist = await buildFixture();
    if (tracklist.length !== TOTAL_TRACKS) {
        console.warn(
            `[warn] fixture has ${tracklist.length} tracks, expected ${TOTAL_TRACKS} ` +
                `(cache file may be stale -- delete ${FIXTURE_PATH} to resample)`
        );
    }

    // Untimed warmup pass: absorbs first-connection/JIT overhead so the timed
    // pass measures steady-state (DB warm) matchTrack-loop cost only. Same
    // treatment on every invocation, so it doesn't bias base vs branch.
    await timedRun(tracklist);

    const result = await timedRun(tracklist);

    console.log(
        `BENCH_RESULT tree=${tree} tracks=${tracklist.length} ms=${result.ms.toFixed(2)} ` +
            `inLibrary=${result.inLibrary} downloadable=${result.downloadable}`
    );
}

main()
    .catch((error) => {
        console.error("Benchmark failed:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
        // scanQueue (Bull/Redis) and the redis client keep open handles that
        // would otherwise hold the event loop past a clean exit.
        process.exit(process.exitCode ?? 0);
    });

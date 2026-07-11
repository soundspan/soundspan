// Behavior test for F13 (Discover Weekly half): selectFromTier and the
// "fill remaining slots" loop now consult a batched membership prefilter
// (prefetchArtistLibraryMembership) instead of calling isArtistInLibrary's
// real per-candidate DB probes. This suite is the arbiter referenced by the
// code comments in discoverWeekly.ts: it pins the exact decision semantics
// isArtistInLibrary documents, and proves the batched path agrees with the
// original per-candidate DB path on a realistic candidate set while issuing
// a single query instead of one (or two) per candidate.

describe("discover weekly artist library membership prefilter parity", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupMocks() {
        const lastFmService = {
            getSimilarArtists: jest.fn(async () => []),
            getArtistTopAlbums: jest.fn(async () => []),
            getTopAlbumsByTag: jest.fn(async () => []),
        };
        const musicBrainzService = {
            searchAlbum: jest.fn(async () => null),
        };
        const lidarrService = {
            getDiscoveryArtists: jest.fn(async () => []),
            removeDiscoveryTagByMbid: jest.fn(async () => ({ success: true })),
            deleteArtistById: jest.fn(async () => ({ success: true })),
            deleteAlbum: jest.fn(async () => ({ success: true })),
            getArtistAlbums: jest.fn(async () => []),
            deleteArtist: jest.fn(async () => ({ success: true })),
        };
        const prisma = {
            $connect: jest.fn(async () => undefined),
            $transaction: jest.fn(async (arg: unknown) => {
                if (typeof arg === "function") {
                    return (arg as (client: unknown) => Promise<unknown>)({});
                }
                return arg;
            }),
            discoveryBatch: {
                findMany: jest.fn(async () => []),
                findUnique: jest.fn(async () => null),
                update: jest.fn(async () => undefined),
            },
            downloadJob: {
                findMany: jest.fn(async () => []),
                update: jest.fn(async () => undefined),
                updateMany: jest.fn(async () => ({ count: 0 })),
            },
            track: {
                findMany: jest.fn(async () => []),
                createMany: jest.fn(async () => ({ count: 0 })),
            },
            album: {
                findMany: jest.fn(async () => []),
                findFirst: jest.fn(async () => null),
            },
            unavailableAlbum: { upsert: jest.fn(async () => undefined) },
            userDiscoverConfig: { findUnique: jest.fn(async () => null) },
            discoveryAlbum: { findFirst: jest.fn(async () => null) },
            ownedAlbum: {
                findFirst: jest.fn(async () => null),
                findMany: jest.fn(async () => []),
            },
            artist: {
                findFirst: jest.fn(async () => null),
                findMany: jest.fn(async () => []),
            },
            discoverExclusion: { findFirst: jest.fn(async () => null) },
            play: { findMany: jest.fn(async () => []) },
        };

        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/logger", () => ({
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
        }));
        jest.doMock("../../utils/artistNormalization", () => ({
            normalizeArtistName: jest.fn((name: string) => name),
        }));
        jest.doMock("axios", () => ({ __esModule: true, default: { get: jest.fn(), delete: jest.fn() } }));
        jest.doMock("../lastfm", () => ({ lastFmService }));
        jest.doMock("../musicbrainz", () => ({ musicBrainzService }));
        jest.doMock("../lidarr", () => ({ lidarrService }));
        jest.doMock("../../workers/queues", () => ({ scanQueue: { add: jest.fn(async () => undefined) } }));
        jest.doMock("date-fns", () => ({
            startOfWeek: jest.fn(() => new Date("2026-02-16T00:00:00.000Z")),
            subWeeks: jest.fn((date: Date) => date),
        }));
        jest.doMock("../../utils/systemSettings", () => ({
            getSystemSettings: jest.fn(async () => ({})),
        }));
        jest.doMock("../discoveryLogger", () => ({
            discoveryLogger: {
                start: jest.fn(() => "/tmp/discovery.log"),
                info: jest.fn(),
                section: jest.fn(),
                table: jest.fn(),
                error: jest.fn(),
                warn: jest.fn(),
                success: jest.fn(),
                list: jest.fn(),
                write: jest.fn(),
                end: jest.fn(),
            },
        }));
        jest.doMock("../acquisitionService", () => ({
            acquisitionService: { acquireAlbum: jest.fn(async () => ({ success: true, source: "soulseek" })) },
        }));
        jest.doMock("../discovery", () => ({
            discoveryBatchLogger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
            discoveryAlbumLifecycle: { processBeforeGeneration: jest.fn(async () => undefined) },
            discoverySeeding: {
                getSeedArtists: jest.fn(async () => []),
                isAlbumOwned: jest.fn(async () => false),
            },
        }));
        jest.doMock("../../utils/shuffle", () => ({
            shuffleArray: jest.fn((arr: unknown[]) => arr),
        }));
        jest.doMock("../artistCountsService", () => ({
            updateArtistCounts: jest.fn(async () => undefined),
        }));
        jest.doMock("../../config", () => ({
            config: { music: { musicPath: "/music" } },
        }));
        jest.doMock("@prisma/client", () => ({
            Prisma: {
                PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
                    code = "P1001";
                },
                PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
                PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
            },
        }));

        return { prisma };
    }

    it("reproduces isArtistInLibrary's exact two-probe decision from a hand-built membership map", async () => {
        setupMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const service = discoverWeeklyService as any;

        // (1) Real-mbid hit.
        await expect(
            service.isArtistInLibrary("Any Name", "mbid-real", {
                mbidHasAlbum: new Map([["mbid-real", true]]),
                nameHasAlbum: new Map(),
            })
        ).resolves.toBe(true);

        // (2) temp- mbid must NOT be matched by mbid, even if the map has a
        // (poisoned) entry for it -- proves the classify function itself
        // guards on the prefix, not just that the prefetch never populates it.
        await expect(
            service.isArtistInLibrary("No Name Match", "temp-poison", {
                mbidHasAlbum: new Map([["temp-poison", true]]),
                nameHasAlbum: new Map(),
            })
        ).resolves.toBe(false);
        // ...but the SAME temp- candidate still matches via its name probe.
        await expect(
            service.isArtistInLibrary("Name Hit", "temp-poison", {
                mbidHasAlbum: new Map([["temp-poison", true]]),
                nameHasAlbum: new Map([["name hit", true]]),
            })
        ).resolves.toBe(true);

        // (3) Name match is case-insensitive.
        await expect(
            service.isArtistInLibrary("MiXeD CaSe", undefined, {
                mbidHasAlbum: new Map(),
                nameHasAlbum: new Map([["mixed case", true]]),
            })
        ).resolves.toBe(true);

        // (4) Zero-album miss: mbid resolves but the map says "no album" (the
        // batched equivalent of an existence check on the album relation),
        // and the name probe also has nothing -- overall miss.
        await expect(
            service.isArtistInLibrary("Ghost", "mbid-zero", {
                mbidHasAlbum: new Map([["mbid-zero", false]]),
                nameHasAlbum: new Map([["ghost", false]]),
            })
        ).resolves.toBe(false);

        // Bonus: an MBID hit with zero albums is NOT mbid-first-else-false --
        // it falls through to an independent name probe, which can still hit.
        await expect(
            service.isArtistInLibrary("Ghost Rescued", "mbid-zero-2", {
                mbidHasAlbum: new Map([["mbid-zero-2", false]]),
                nameHasAlbum: new Map([["ghost rescued", true]]),
            })
        ).resolves.toBe(true);
    });

    it("classifies a mixed candidate set identically via the batched prefetch and the old per-candidate DB path, issuing exactly one findMany call", async () => {
        const { prisma } = setupMocks();

        // Stand-in Artist table. mbid is unique (schema constraint); name is
        // not, but no two rows here share a name -- the duplicate-name edge
        // has its own dedicated case below, which pins the deliberate
        // resolution the batched path applies to it.
        const dbRows = [
            { mbid: "mbid-real-1", name: "Real Hit Artist", albumCount: 1 },
            { mbid: "temp-owned-1", name: "Temp Mbid Artist", albumCount: 1 },
            { mbid: "mbid-zero-album", name: "Zero Album Owner", albumCount: 0 },
            { mbid: "mbid-casefold-owner", name: "CaseFold Artist", albumCount: 1 },
            { mbid: "mbid-fallthrough-src", name: "Fallthrough Empty", albumCount: 0 },
            { mbid: "mbid-other-owner", name: "Fallthrough Rescued", albumCount: 1 },
        ];
        const toAlbums = (n: number) =>
            Array.from({ length: Math.min(n, 1) }, (_, i) => ({ id: `album-${i}` }));

        // Old per-candidate path: prisma.artist.findFirst, exactly like
        // isArtistInLibrary's own (untouched) DB branch.
        (prisma.artist.findFirst as jest.Mock).mockImplementation(async (query: any) => {
            let row: (typeof dbRows)[number] | undefined;
            if (query?.where?.mbid) {
                row = dbRows.find((r) => r.mbid === query.where.mbid);
            } else if (query?.where?.name?.equals) {
                const target = String(query.where.name.equals).toLowerCase();
                row = dbRows.find((r) => r.name.toLowerCase() === target);
            }
            if (!row) return null;
            return { mbid: row.mbid, name: row.name, albums: toAlbums(row.albumCount) };
        });

        // Batched path: prisma.artist.findMany, filtered by the OR clauses
        // prefetchArtistLibraryMembership builds (mbid IN [...] OR one
        // insensitive-equals per unique name).
        (prisma.artist.findMany as jest.Mock).mockImplementation(async (query: any) => {
            const orClauses: any[] = query?.where?.OR ?? [];
            const matched = dbRows.filter((row) =>
                orClauses.some((clause) => {
                    if (clause.mbid?.in) return clause.mbid.in.includes(row.mbid);
                    if (clause.name?.equals) {
                        return row.name.toLowerCase() === String(clause.name.equals).toLowerCase();
                    }
                    return false;
                })
            );
            return matched.map((row) => ({
                mbid: row.mbid,
                name: row.name,
                albums: toAlbums(row.albumCount),
            }));
        });

        const candidates: Array<{ name: string; mbid?: string; expected: boolean; note: string }> = [
            { name: "Real Hit Artist", mbid: "mbid-real-1", expected: true, note: "real-mbid hit" },
            {
                name: "Some Unrelated Name",
                mbid: "temp-owned-1",
                expected: false,
                note: "temp- mbid ignored for the mbid probe; name doesn't independently match",
            },
            {
                name: "Temp Mbid Artist",
                mbid: "temp-owned-1",
                expected: true,
                note: "temp- mbid ignored for the mbid probe, but the name probe still hits",
            },
            { name: "casefold artist", mbid: undefined, expected: true, note: "name-case-insensitive hit" },
            {
                name: "Zero Album Owner",
                mbid: "mbid-zero-album",
                expected: false,
                note: "mbid hit with zero albums falls through to a name probe that also misses",
            },
            {
                name: "Fallthrough Rescued",
                mbid: "mbid-fallthrough-src",
                expected: true,
                note: "mbid hit with zero albums falls through to a DIFFERENT row matched by name that has an album",
            },
            { name: "Nobody Home", mbid: "mbid-does-not-exist", expected: false, note: "no match by either probe" },
        ];

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const service = discoverWeeklyService as any;

        const oldResults: boolean[] = [];
        for (const c of candidates) {
            oldResults.push(await service.isArtistInLibrary(c.name, c.mbid));
        }

        (prisma.artist.findMany as jest.Mock).mockClear();

        const membership = await service.prefetchArtistLibraryMembership(
            candidates.map((c) => ({ name: c.name, mbid: c.mbid }))
        );
        const newResults: boolean[] = [];
        for (const c of candidates) {
            newResults.push(await service.isArtistInLibrary(c.name, c.mbid, membership));
        }

        expect(prisma.artist.findMany).toHaveBeenCalledTimes(1);
        candidates.forEach((c, i) => {
            expect({ note: c.note, old: oldResults[i], batched: newResults[i] }).toEqual({
                note: c.note,
                old: c.expected,
                batched: c.expected,
            });
        });
    });

    it("resolves schema-legal duplicate case-insensitive names deterministically as in-library (OR across duplicate rows)", async () => {
        const { prisma } = setupMocks();

        // Artist.name carries no unique constraint (only mbid does), so two
        // rows whose names are case-insensitively equal -- one owning albums,
        // one not -- are schema-legal, even though the live corpus has zero
        // such pairs. The OLD per-candidate path decided membership with an
        // unordered findFirst({ name: insensitive-equals }): WHICH duplicate
        // row it saw was arbitrary (no orderBy), so the answer was
        // nondeterministic true-or-false. The batched prefilter deliberately
        // resolves that ambiguity instead of reproducing it: it ORs the
        // has->=1-album flag across ALL rows sharing the lowercased name, so
        // any duplicate owning an album marks the name in-library --
        // deterministically true. For a discovery feature this is the safe
        // direction: skip the ambiguous same-named artist rather than
        // maybe-recommend an artist the user already owns.
        //
        // Row order below puts the album-owning row FIRST so a naive
        // last-write-wins map build (a later albumless row overwriting true
        // with false) would fail this test -- the build must accumulate with
        // OR.
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([
            {
                mbid: "mbid-dup-with-album",
                name: "Duplicate Name",
                albums: [{ id: "album-dup-1" }],
            },
            {
                mbid: "mbid-dup-without-album",
                name: "duplicate name",
                albums: [],
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const service = discoverWeeklyService as any;

        const membership = await service.prefetchArtistLibraryMembership([
            { name: "DUPLICATE name" },
        ]);

        // Candidate casing differs from BOTH rows -- the classify step must
        // still hit via the lowercased name key, and must see the OR-merged
        // membership, not whichever duplicate happened to come last.
        await expect(
            service.isArtistInLibrary("DUPLICATE name", undefined, membership)
        ).resolves.toBe(true);
    });
});

import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

type DependencyList = ReadonlyArray<unknown> | undefined;

function depsChanged(prev: DependencyList, next: DependencyList): boolean {
    if (!prev || !next) return true;
    if (prev.length !== next.length) return true;
    for (let index = 0; index < prev.length; index += 1) {
        if (!Object.is(prev[index], next[index])) {
            return true;
        }
    }
    return false;
}

function createHookRuntime() {
    const stateValues: unknown[] = [];
    const refValues: Array<{ current: unknown }> = [];
    const memoValues: unknown[] = [];
    const memoDeps: DependencyList[] = [];
    const effectDeps: DependencyList[] = [];
    const cleanupByIndex: Array<(() => void) | undefined> = [];
    const pendingEffects: Array<() => void> = [];
    let hookIndex = 0;

    return {
        beginRender() {
            hookIndex = 0;
        },
        reset() {
            stateValues.length = 0;
            refValues.length = 0;
            memoValues.length = 0;
            memoDeps.length = 0;
            effectDeps.length = 0;
            for (const cleanup of cleanupByIndex) {
                cleanup?.();
            }
            cleanupByIndex.length = 0;
            pendingEffects.length = 0;
            hookIndex = 0;
        },
        useState<T>(initial: T | (() => T)) {
            const idx = hookIndex;
            hookIndex += 1;
            if (!(idx in stateValues)) {
                stateValues[idx] =
                    typeof initial === "function"
                        ? (initial as () => T)()
                        : initial;
            }
            const setState = (
                value: T | ((current: T) => T)
            ) => {
                const current = stateValues[idx] as T;
                stateValues[idx] =
                    typeof value === "function"
                        ? (value as (current: T) => T)(current)
                        : value;
            };
            return [stateValues[idx] as T, setState] as const;
        },
        useRef<T>(initial: T) {
            const idx = hookIndex;
            hookIndex += 1;
            if (!(idx in refValues)) {
                refValues[idx] = { current: initial };
            }
            return refValues[idx] as { current: T };
        },
        useMemo<T>(factory: () => T, deps: DependencyList) {
            const idx = hookIndex;
            hookIndex += 1;
            if (!(idx in memoValues) || depsChanged(memoDeps[idx], deps)) {
                memoValues[idx] = factory();
                memoDeps[idx] = deps;
            }
            return memoValues[idx] as T;
        },
        useCallback<T extends (...args: never[]) => unknown>(
            callback: T,
            deps: DependencyList
        ) {
            return this.useMemo(() => callback, deps);
        },
        useEffect(effect: () => void | (() => void), deps: DependencyList) {
            const idx = hookIndex;
            hookIndex += 1;
            if (depsChanged(effectDeps[idx], deps)) {
                effectDeps[idx] = deps;
                pendingEffects.push(() => {
                    cleanupByIndex[idx]?.();
                    const cleanup = effect();
                    cleanupByIndex[idx] =
                        typeof cleanup === "function" ? cleanup : undefined;
                });
            }
        },
        async flushEffects() {
            const queue = pendingEffects.splice(0, pendingEffects.length);
            for (const runEffect of queue) {
                runEffect();
            }
            await Promise.resolve();
            await Promise.resolve();
        },
    };
}

const runtime = createHookRuntime();

const loggerState = {
    errors: [] as string[],
};

const apiState = {
    tidalStatus: {
        enabled: true,
        available: true,
        authenticated: true,
    },
    ytStatus: {
        enabled: true,
        available: true,
        authenticated: true,
    },
    failTidalStatus: false,
    failYtStatus: false,
    rejectTidalBatch: false,
    rejectYtBatch: false,
    throwTidalBatch: false,
    throwYtBatch: false,
    tidalMatches: [] as Array<Record<string, unknown> | null>,
    ytMatches: [] as Array<Record<string, unknown> | null>,
    tidalPayloads: [] as Array<Record<string, unknown>[]>,
    ytPayloads: [] as Array<Record<string, unknown>[]>,
};

mock.module("react", {
    namedExports: {
        useState: runtime.useState.bind(runtime),
        useRef: runtime.useRef.bind(runtime),
        useMemo: runtime.useMemo.bind(runtime),
        useCallback: runtime.useCallback.bind(runtime),
        useEffect: runtime.useEffect.bind(runtime),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: (...args: unknown[]) => {
                loggerState.errors.push(args.map(String).join(" "));
            },
        },
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getTidalStreamingStatus: async () => {
                if (apiState.failTidalStatus) {
                    throw new Error("tidal status failed");
                }
                return apiState.tidalStatus;
            },
            getYtMusicStatus: async () => {
                if (apiState.failYtStatus) {
                    throw new Error("yt status failed");
                }
                return apiState.ytStatus;
            },
            matchTidalBatch: (payload: Array<Record<string, unknown>>) => {
                apiState.tidalPayloads.push(payload);
                if (apiState.throwTidalBatch) {
                    throw new Error("tidal batch threw");
                }
                if (apiState.rejectTidalBatch) {
                    return Promise.reject(new Error("tidal batch failed"));
                }
                return Promise.resolve({
                    matches: apiState.tidalMatches,
                });
            },
            matchYtMusicBatch: (payload: Array<Record<string, unknown>>) => {
                apiState.ytPayloads.push(payload);
                if (apiState.throwYtBatch) {
                    throw new Error("yt batch threw");
                }
                if (apiState.rejectYtBatch) {
                    return Promise.reject(new Error("yt batch failed"));
                }
                return Promise.resolve({
                    matches: apiState.ytMatches,
                });
            },
        },
    },
});

beforeEach(() => {
    runtime.reset();
    loggerState.errors = [];

    apiState.tidalStatus = {
        enabled: true,
        available: true,
        authenticated: true,
    };
    apiState.ytStatus = {
        enabled: true,
        available: true,
        authenticated: true,
    };
    apiState.failTidalStatus = false;
    apiState.failYtStatus = false;
    apiState.rejectTidalBatch = false;
    apiState.rejectYtBatch = false;
    apiState.throwTidalBatch = false;
    apiState.throwYtBatch = false;
    apiState.tidalMatches = [];
    apiState.ytMatches = [];
    apiState.tidalPayloads = [];
    apiState.ytPayloads = [];
});

async function settleHook<T>(hookFn: () => T): Promise<T> {
    let result = undefined as unknown as T;
    for (let pass = 0; pass < 5; pass += 1) {
        runtime.beginRender();
        result = hookFn();
        await runtime.flushEffects();
    }
    runtime.beginRender();
    return hookFn();
}

test("useTidalGapFill enriches discovery tracks and applies match duration fallback", async () => {
    const { useTidalGapFill, invalidateTidalStatusCache } = await import(
        "../../features/album/hooks/useTidalGapFill.ts"
    );
    invalidateTidalStatusCache();

    apiState.tidalMatches = [
        { id: 101, title: "Matched", artist: "Artist", duration: 255 },
        null,
    ];

    const album = {
        id: "album-gapfill-1",
        title: "Gapfill Album",
        artist: { id: "artist-1", name: "Artist One" },
        tracks: [
            {
                id: "track-1",
                title: "Needs Duration",
                duration: 0,
                filePath: "/music/local.flac",
            },
            {
                id: "track-2",
                title: "No Match",
                duration: 211,
            },
        ],
    };

    const result = await settleHook(() =>
        useTidalGapFill(album, "discovery")
    );

    assert.equal(apiState.tidalPayloads.length, 1);
    assert.equal(apiState.tidalPayloads[0].length, 2);
    assert.equal(result.isStatusResolved, true);
    assert.equal(result.matchCount, 1);
    assert.equal(result.enrichedTracks?.[0].streamSource, "tidal");
    assert.equal(result.enrichedTracks?.[0].tidalTrackId, 101);
    assert.equal(result.enrichedTracks?.[0].duration, 255);
    assert.equal(result.enrichedTracks?.[1].streamSource, undefined);
});

test("useTidalGapFill reports resolved unavailable state when status lookup fails", async () => {
    const { useTidalGapFill, invalidateTidalStatusCache } = await import(
        "../../features/album/hooks/useTidalGapFill.ts"
    );
    invalidateTidalStatusCache();
    apiState.failTidalStatus = true;

    const result = await settleHook(() =>
        useTidalGapFill(
            {
                id: "album-gapfill-2",
                title: "Album Two",
                tracks: [{ id: "track-1", title: "Track", duration: 200 }],
            },
            "library"
        )
    );

    assert.equal(result.tidalAvailable, false);
    assert.equal(result.isStatusResolved, true);
    assert.equal(apiState.tidalPayloads.length, 0);
});

test("useYtMusicGapFill skips TIDAL-enriched tracks and enriches remaining matches", async () => {
    const { useYtMusicGapFill, invalidateYtMusicStatusCache } = await import(
        "../../features/album/hooks/useYtMusicGapFill.ts"
    );
    invalidateYtMusicStatusCache();

    apiState.ytMatches = [{ videoId: "yt-101", title: "YT", duration: 222 }];

    const album = {
        id: "album-yt-1",
        title: "Album YT",
        artist: { id: "artist-1", name: "Artist One" },
        tracks: [
            {
                id: "track-tidal",
                title: "Already TIDAL",
                duration: 205,
                streamSource: "tidal",
                tidalTrackId: 99,
            },
            {
                id: "track-youtube",
                title: "Need YT",
                duration: 0,
                album: {},
            },
        ],
    };

    const result = await settleHook(() =>
        useYtMusicGapFill(album, "discovery")
    );

    assert.equal(apiState.ytPayloads.length, 1);
    assert.equal(apiState.ytPayloads[0].length, 1);
    assert.equal(result.matchCount, 1);
    assert.equal(result.enrichedTracks?.[0].streamSource, "tidal");
    assert.equal(result.enrichedTracks?.[1].streamSource, "youtube");
    assert.equal(result.enrichedTracks?.[1].youtubeVideoId, "yt-101");
    assert.equal(result.enrichedTracks?.[1].duration, 222);
});

test("useYtMusicGapFill logs and clears matches when batch match fails", async () => {
    const { useYtMusicGapFill, invalidateYtMusicStatusCache } = await import(
        "../../features/album/hooks/useYtMusicGapFill.ts"
    );
    invalidateYtMusicStatusCache();
    apiState.rejectYtBatch = true;

    const result = await settleHook(() =>
        useYtMusicGapFill(
            {
                id: "album-yt-2",
                title: "Album YT Fail",
                tracks: [{ id: "track-1", title: "Track", duration: 210 }],
            },
            "library"
        )
    );

    assert.equal(result.matchCount, 0);
    assert.equal(result.isMatching, false);
    assert.equal(
        loggerState.errors.some((entry) =>
            entry.includes("[YTMusic Gap-Fill] Batch match failed:")
        ),
        true
    );
});

test("useTidalTopTracks enriches only unowned top tracks", async () => {
    const { useTidalTopTracks } = await import(
        "../../features/artist/hooks/useTidalTopTracks.ts"
    );

    apiState.tidalMatches = [{ id: 777, title: "Matched", artist: "A", duration: 260 }];

    const artist = {
        id: "artist-top-1",
        name: "Artist One",
        topTracks: [
            {
                id: "owned-track",
                title: "Owned",
                duration: 200,
                album: { id: "album-1", title: "Album One" },
            },
            {
                id: "unowned-track",
                title: "Unowned",
                duration: 0,
                album: { id: "", title: "Unknown Album" },
            },
        ],
    };

    const result = await settleHook(() => useTidalTopTracks(artist));

    assert.equal(apiState.tidalPayloads.length >= 1, true);
    assert.equal(apiState.tidalPayloads.at(-1)?.length, 1);
    assert.equal(result.matchCount, 1);
    assert.equal(result.enrichedTopTracks?.[0].streamSource, undefined);
    assert.equal(result.enrichedTopTracks?.[1].streamSource, "tidal");
    assert.equal(result.enrichedTopTracks?.[1].tidalTrackId, 777);
    assert.equal(result.enrichedTopTracks?.[1].duration, 260);
});

test("useYtMusicTopTracks preserves TIDAL tracks and enriches unowned non-tidal tracks", async () => {
    const { useYtMusicTopTracks } = await import(
        "../../features/artist/hooks/useYtMusicTopTracks.ts"
    );

    apiState.ytMatches = [{ videoId: "yt-artist-2", title: "YT", duration: 233 }];

    const artist = {
        id: "artist-top-2",
        name: "Artist Two",
        topTracks: [
            {
                id: "tidal-track",
                title: "Tidal",
                duration: 201,
                streamSource: "tidal",
                tidalTrackId: 321,
                album: { id: "", title: "Unknown Album" },
            },
            {
                id: "yt-track",
                title: "Needs YT",
                duration: 0,
                album: { id: "", title: "Unknown Album" },
            },
            {
                id: "owned-track",
                title: "Owned",
                duration: 190,
                album: { id: "owned-1", title: "Owned Album" },
            },
        ],
    };

    const result = await settleHook(() => useYtMusicTopTracks(artist));

    assert.equal(apiState.ytPayloads.at(-1)?.length, 1);
    assert.equal(result.matchCount, 1);
    assert.equal(result.enrichedTopTracks?.[0].streamSource, "tidal");
    assert.equal(result.enrichedTopTracks?.[1].streamSource, "youtube");
    assert.equal(result.enrichedTopTracks?.[1].youtubeVideoId, "yt-artist-2");
    assert.equal(result.enrichedTopTracks?.[1].duration, 233);
    assert.equal(result.enrichedTopTracks?.[2].streamSource, undefined);
});

test("useDiscoverProviderGapFill marks tracks local when neither provider is available", async () => {
    const { useDiscoverProviderGapFill } = await import(
        "../../features/discover/hooks/useDiscoverProviderGapFill.ts"
    );

    apiState.tidalStatus = { enabled: true, available: false, authenticated: false };
    apiState.ytStatus = { enabled: true, available: false, authenticated: false };

    const tracks = [
        {
            id: "discover-1",
            title: "Track 1",
            artist: "Artist 1",
            album: "Album 1",
            albumId: "album-1",
            similarity: 0.9,
            tier: "high",
            coverUrl: null,
            available: true,
            duration: 200,
            isLiked: false,
            likedAt: null,
            sourceType: "tidal",
            streamSource: "tidal",
            tidalTrackId: 1,
        },
    ];

    const result = await settleHook(() => useDiscoverProviderGapFill(tracks));

    assert.equal(result.isMatching, false);
    assert.equal(result.tracks[0].sourceType, "local");
    assert.equal(result.tracks[0].streamSource, undefined);
    assert.equal(result.providerCounts.local, 1);
    assert.equal(result.providerCounts.tidal, 0);
    assert.equal(result.providerCounts.youtube, 0);
});

test("useDiscoverProviderGapFill prioritizes TIDAL matches over YT and handles matching errors", async () => {
    const { useDiscoverProviderGapFill } = await import(
        "../../features/discover/hooks/useDiscoverProviderGapFill.ts"
    );

    apiState.tidalStatus = { enabled: true, available: true, authenticated: true };
    apiState.ytStatus = { enabled: true, available: true, authenticated: true };
    apiState.tidalMatches = [{ id: 11 }, null];
    apiState.ytMatches = [{ videoId: "yt-11" }, { videoId: "yt-22" }];
    const matchedInput = [
        {
            id: "discover-local",
            title: "Local",
            artist: "Artist Local",
            album: "Album Local",
            albumId: "album-local",
            similarity: 0.95,
            tier: "high",
            coverUrl: null,
            available: true,
            duration: 200,
            isLiked: false,
            likedAt: null,
        },
        {
            id: "discover-a",
            title: "A",
            artist: "Artist A",
            album: "Album A",
            albumId: "album-a",
            similarity: 0.91,
            tier: "high",
            coverUrl: null,
            available: false,
            duration: 210,
            isLiked: false,
            likedAt: null,
        },
        {
            id: "discover-b",
            title: "B",
            artist: "Artist B",
            album: "Album B",
            albumId: "album-b",
            similarity: 0.81,
            tier: "medium",
            coverUrl: null,
            available: false,
            duration: 211,
            isLiked: false,
            likedAt: null,
        },
    ];

    const matched = await settleHook(() =>
        useDiscoverProviderGapFill(matchedInput)
    );

    // Local track stays local, unavailable tracks get gap-filled
    assert.equal(matched.tracks[0].sourceType, "local");
    assert.equal(matched.tracks[1].sourceType, "tidal");
    assert.equal(matched.tracks[2].sourceType, "youtube");
    assert.equal(matched.providerCounts.local, 1);
    assert.equal(matched.providerCounts.tidal, 1);
    assert.equal(matched.providerCounts.youtube, 1);
    // Only unavailable tracks should be sent to batch matchers
    assert.equal(apiState.tidalPayloads.at(-1)?.length, 2);
    assert.equal(apiState.ytPayloads.at(-1)?.length, 2);

    runtime.reset();
    apiState.throwTidalBatch = true;
    apiState.tidalPayloads = [];
    apiState.ytPayloads = [];
    const failedInput = [
        {
            id: "discover-error",
            title: "Err",
            artist: "Artist Err",
            album: "Album Err",
            albumId: "album-err",
            similarity: 0.5,
            tier: "explore",
            coverUrl: null,
            available: false,
            duration: 190,
            isLiked: false,
            likedAt: null,
        },
    ];

    const failed = await settleHook(() =>
        useDiscoverProviderGapFill(failedInput)
    );

    assert.equal(failed.tracks[0].sourceType, undefined);
    assert.equal(
        loggerState.errors.some((entry) =>
            entry.includes("[DiscoverGapFill] Provider matching failed:")
        ),
        true
    );
});

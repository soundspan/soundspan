import {
    albumOrphanRetentionGuardWhere,
    albumTracksOrphanRetentionGuardWhere,
    artistOrphanRetentionGuardWhere,
    classifyProviderTrackRetention,
    discoveryAlbumTracksOrphanRetentionGuardWhere,
    type ProviderTrackRetentionInput,
} from "../providerTrackRetention";

const now = new Date("2026-08-19T12:00:00.000Z");
const cutoff = new Date("2026-07-20T12:00:00.000Z");
const old = new Date("2026-07-19T12:00:00.000Z");

function input(
    overrides: Partial<ProviderTrackRetentionInput> = {},
): ProviderTrackRetentionInput {
    return {
        createdAt: old,
        mappings: [{ stale: true, staleAt: old }],
        hasLikedReference: false,
        hasPlaylistReference: false,
        latestPlayedAt: null,
        ...overrides,
    };
}

describe("provider track retention policy", () => {
    it.each([
        {
            name: "collects an old row whose mappings have been stale past retention",
            value: input(),
            expected: "collectable",
        },
        {
            name: "retains an active mapping",
            value: input({ mappings: [{ stale: false, staleAt: null }] }),
            expected: "live",
        },
        {
            name: "retains a liked row",
            value: input({ hasLikedReference: true }),
            expected: "live",
        },
        {
            name: "retains a playlist row",
            value: input({ hasPlaylistReference: true }),
            expected: "live",
        },
        {
            name: "retains a row played at the retention boundary",
            value: input({ latestPlayedAt: cutoff }),
            expected: "live",
        },
        {
            name: "retains a mapping staled at the retention boundary",
            value: input({ mappings: [{ stale: true, staleAt: cutoff }] }),
            expected: "live",
        },
        {
            name: "retains a stale mapping with no trustworthy stale timestamp",
            value: input({ mappings: [{ stale: true, staleAt: null }] }),
            expected: "live",
        },
        {
            name: "retains a recently created unmapped row",
            value: input({ createdAt: now, mappings: [] }),
            expected: "live",
        },
        {
            name: "collects an old unmapped row",
            value: input({ mappings: [] }),
            expected: "collectable",
        },
    ])("$name", ({ value, expected }) => {
        expect(classifyProviderTrackRetention(value, cutoff)).toBe(expected);
    });

    it("protects owned and overridden albums from parent collection", () => {
        expect(albumOrphanRetentionGuardWhere(cutoff)).toEqual(
            expect.objectContaining({
                hasUserOverrides: false,
                ownedBy: { none: {} },
            }),
        );
    });

    it("rechecks album retention at the track deletion boundary", () => {
        expect(albumTracksOrphanRetentionGuardWhere("album-1", cutoff)).toEqual(
            {
                albumId: "album-1",
                album: albumOrphanRetentionGuardWhere(cutoff),
            },
        );
    });

    it("rechecks discovery retention at the track deletion boundary", () => {
        expect(
            discoveryAlbumTracksOrphanRetentionGuardWhere("album-1", cutoff),
        ).toEqual({
            albumId: "album-1",
            album: expect.objectContaining({
                NOT: {
                    OR: [{ location: "LIBRARY" }, { rgMbid: { in: [] } }],
                },
                discoveryRecords: { none: { status: "LIKED" } },
            }),
        });
    });

    it("adds unlinked LIKED release groups to the discovery exclusion", () => {
        expect(
            discoveryAlbumTracksOrphanRetentionGuardWhere("album-1", cutoff, [
                "rolling-like",
            ]),
        ).toEqual(
            expect.objectContaining({
                album: expect.objectContaining({
                    NOT: {
                        OR: [
                            { location: "LIBRARY" },
                            { rgMbid: { in: ["rolling-like"] } },
                        ],
                    },
                }),
            }),
        );
    });

    it("protects owned and overridden artists from parent collection", () => {
        expect(artistOrphanRetentionGuardWhere(cutoff)).toEqual(
            expect.objectContaining({
                hasUserOverrides: false,
                ownedAlbums: { none: {} },
            }),
        );
    });
});

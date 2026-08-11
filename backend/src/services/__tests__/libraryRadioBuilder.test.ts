const mockTrackFindMany = jest.fn();
const mockPrismaQueryRaw = jest.fn();
const mockComputeAggregateFeatureVector = jest.fn();
const mockScoreTracksAgainstSeed = jest.fn();
const mockBuildTrackPreferenceScoreMapForUser = jest.fn();
const MAX_SQL_FRAGMENT_VALUES = 64;

interface SqlFragment {
    strings: readonly string[];
    values: readonly unknown[];
}

const isSqlFragment = (value: unknown): value is SqlFragment =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Partial<SqlFragment>).strings) &&
    Array.isArray((value as Partial<SqlFragment>).values);

const collectSql = (
    fragment: SqlFragment,
): { text: string; values: unknown[] } => {
    const pending: unknown[] = [fragment];
    const values: unknown[] = [];
    let text = "";

    for (
        let index = 0;
        index < pending.length && index < MAX_SQL_FRAGMENT_VALUES;
        index += 1
    ) {
        const value = pending[index];
        if (isSqlFragment(value)) {
            text += value.strings.join("");
            pending.push(...value.values);
        } else if (Array.isArray(value)) {
            pending.push(...value);
        } else {
            values.push(value);
        }
    }

    if (pending.length > MAX_SQL_FRAGMENT_VALUES) {
        throw new Error("SQL fragment exceeded the test inspection bound");
    }

    return { text, values };
};

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findMany: mockTrackFindMany,
        },
        $queryRaw: mockPrismaQueryRaw,
    },
    Prisma: {
        sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
            strings: [...strings],
            values,
        }),
        join: (values: unknown[]) => ({ strings: [""], values }),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../radioVibeEngine", () => ({
    computeAggregateFeatureVector: mockComputeAggregateFeatureVector,
    scoreTracksAgainstSeed: mockScoreTracksAgainstSeed,
}));

jest.mock("../trackPreference", () => ({
    applyTrackPreferenceSimilarityBias: jest.fn(),
}));

jest.mock("../libraryTrackPreferences", () => ({
    buildTrackPreferenceScoreMapForUser:
        mockBuildTrackPreferenceScoreMapForUser,
}));

jest.mock("../../utils/shuffle", () => ({
    shuffleArray: (values: unknown[]) => values,
}));

import { buildMultiTrackRadio } from "../libraryRadioBuilder";

const createSeedTrack = (genre: string) => ({
    id: "seed-1",
    lastfmTags: [],
    essentiaGenres: [],
    album: {
        artistId: "artist-1",
        artist: {
            id: "artist-1",
            genres: [genre],
            userGenres: [],
        },
    },
});

describe("buildMultiTrackRadio genre fallback", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockComputeAggregateFeatureVector.mockReturnValue({ energy: 0.5 });
        mockScoreTracksAgainstSeed.mockReturnValue([]);
        mockBuildTrackPreferenceScoreMapForUser.mockResolvedValue(new Map());
        mockPrismaQueryRaw.mockResolvedValue([]);
    });

    it.each([
        ["drum%bass", "%drum\\%bass%"],
        ["rock", "%rock%"],
    ])("binds genre %j as literal LIKE pattern %j", async (genre, pattern) => {
        mockTrackFindMany
            .mockResolvedValueOnce([createSeedTrack(genre)])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);

        await buildMultiTrackRadio(["seed-1"], ["seed-1"], 10, "user-1");

        expect(mockPrismaQueryRaw).toHaveBeenCalledTimes(1);
        const [strings, ...values] = mockPrismaQueryRaw.mock.calls[0];
        const query = collectSql({ strings: [...strings], values });
        expect(query.values).toContain(pattern);
        expect(query.text).toContain("ESCAPE '\\'");
    });
});

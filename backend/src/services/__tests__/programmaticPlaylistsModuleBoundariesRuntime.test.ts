const prisma = {
    album: { count: jest.fn(), findMany: jest.fn() },
    artist: { findMany: jest.fn(), findUnique: jest.fn() },
    genre: { findMany: jest.fn() },
    play: { findMany: jest.fn(), groupBy: jest.fn() },
    track: { count: jest.fn(), findMany: jest.fn() },
    trackGenre: { findMany: jest.fn() },
};

jest.mock("../../utils/db", () => ({ prisma }));

const mockLogger = {
    debug: jest.fn(),
    error: jest.fn(),
};
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

jest.mock("../../config", () => ({
    config: {
        generationDiversity: {
            shareCeiling: 0.25,
            weightAlpha: 0.5,
        },
    },
}));

jest.mock("../lastfm", () => ({
    lastFmService: { getSimilarArtists: jest.fn() },
}));

jest.mock("../moodBucketService", () => ({
    moodBucketService: { getUserMoodMix: jest.fn() },
}));

import {
    ProgrammaticPlaylistService,
    seededShuffle,
} from "../programmaticPlaylists";
import * as programmaticPlaylistsFacade from "../programmaticPlaylists";
import { ProgrammaticPlaylistServiceBase } from "../programmaticPlaylists/shared";
import { ProgrammaticPlaylistLibraryMixService } from "../programmaticPlaylists/libraryMixes";
import { ProgrammaticPlaylistActivityMixService } from "../programmaticPlaylists/activityMixes";
import { ProgrammaticPlaylistAudioAnalysisMixService } from "../programmaticPlaylists/audioAnalysisMixes";
import { ProgrammaticPlaylistContextualMixService } from "../programmaticPlaylists/contextualMixes";
import { ProgrammaticPlaylistCuratedMixService } from "../programmaticPlaylists/curatedMixes";
import { ProgrammaticPlaylistWeeklyAndMoodMixService } from "../programmaticPlaylists/weeklyAndMoodMixes";

type NullMixMethod =
    | "generateEraMix"
    | "generateChillMix"
    | "generateLateNightMix"
    | "generateMoodTagMix"
    | "generateMainCharacterEnergy"
    | "generateVocalDetox";

const boundaryCases: Array<{
    moduleClass: typeof ProgrammaticPlaylistServiceBase;
    method: NullMixMethod;
    args: string[];
}> = [
    {
        moduleClass: ProgrammaticPlaylistLibraryMixService,
        method: "generateEraMix",
        args: ["user-1", "2026-08-16"],
    },
    {
        moduleClass: ProgrammaticPlaylistActivityMixService,
        method: "generateChillMix",
        args: ["user-1", "2026-08-16"],
    },
    {
        moduleClass: ProgrammaticPlaylistAudioAnalysisMixService,
        method: "generateLateNightMix",
        args: ["user-1", "2026-08-16"],
    },
    {
        moduleClass: ProgrammaticPlaylistContextualMixService,
        method: "generateMoodTagMix",
        args: ["user-1", "2026-08-16", "calm", "Calm Mix", "Quiet tracks"],
    },
    {
        moduleClass: ProgrammaticPlaylistCuratedMixService,
        method: "generateMainCharacterEnergy",
        args: ["user-1", "2026-08-16"],
    },
    {
        moduleClass: ProgrammaticPlaylistWeeklyAndMoodMixService,
        method: "generateVocalDetox",
        args: ["user-1", "2026-08-16"],
    },
];

describe("programmatic playlist service module boundaries", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.album.count.mockResolvedValue(0);
        prisma.album.findMany.mockResolvedValue([]);
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.artist.findUnique.mockResolvedValue(null);
        prisma.genre.findMany.mockResolvedValue([]);
        prisma.play.findMany.mockResolvedValue([]);
        prisma.play.groupBy.mockResolvedValue([]);
        prisma.track.count.mockResolvedValue(0);
        prisma.track.findMany.mockResolvedValue([]);
        prisma.trackGenre.findMany.mockResolvedValue([]);
    });

    it("keeps shared deterministic selection available through the facade", () => {
        expect(seededShuffle(["a", "b", "c"], "boundary-seed")).toEqual(
            seededShuffle(["a", "b", "c"], "boundary-seed"),
        );
    });

    it("preserves the facade runtime export surface and singleton", () => {
        expect(Object.keys(programmaticPlaylistsFacade).sort()).toEqual([
            "ProgrammaticPlaylistService",
            "applyArtistCap",
            "programmaticPlaylistService",
            "seededShuffle",
        ]);
        expect(
            programmaticPlaylistsFacade.programmaticPlaylistService,
        ).toBeInstanceOf(ProgrammaticPlaylistService);
    });

    it("orchestrates the focused generators through the facade", async () => {
        const service = new ProgrammaticPlaylistService();

        await expect(service.generateAllMixes("user-1")).resolves.toEqual([]);
    });

    it.each(boundaryCases)(
        "serves $method through the composed facade",
        async ({ moduleClass, method, args }) => {
            const service = new ProgrammaticPlaylistService();

            expect(service).toBeInstanceOf(moduleClass);
            await expect(
                Reflect.apply(service[method], service, args),
            ).resolves.toBeNull();
        },
    );
});

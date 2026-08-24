type ParsedIdentityMetadata = {
    common: {
        musicbrainz_recordingid?: string;
        isrc?: string | string[];
    };
};

describe("audioHashBackfillProcessor", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadProcessor(
        tracks: Array<{
            id: string;
            filePath: string;
            origin?: "LOCAL" | "FEDERATED";
        }>,
        missingPaths: string[] = [],
    ) {
        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);

        const prisma = {
            track: {
                findMany: jest.fn(
                    async (args: { where?: { origin?: string } }) =>
                        args.where?.origin === "LOCAL"
                            ? tracks.filter(
                                  (track) => track.origin !== "FEDERATED",
                              )
                            : tracks,
                ),
                updateMany: jest.fn(async () => ({ count: 1 })),
            },
        };
        const schedulerQueue = {
            add: jest.fn(async () => ({})),
        };
        const computeAudioStreamHash = jest.fn<
            Promise<string | null>,
            [string]
        >(async (filePath) => {
            const suffix = filePath.length.toString(16).padStart(2, "0");
            return `sha256:${suffix.repeat(32)}`;
        });
        const parseFile = jest.fn<
            Promise<ParsedIdentityMetadata>,
            [string, { skipCovers: boolean }]
        >(async () => ({
            common: {
                musicbrainz_recordingid: " recording-default ",
                isrc: [" USRC17607839 "],
            },
        }));
        const access = jest.fn(async (filePath: string) => {
            if (missingPaths.includes(filePath)) {
                const error = new Error(
                    "missing file",
                ) as NodeJS.ErrnoException;
                error.code = "ENOENT";
                throw error;
            }
        });

        jest.doMock("fs", () => ({ promises: { access } }));
        jest.doMock("../../../utils/logger", () => ({ logger }));
        jest.doMock("../../../utils/db", () => ({ prisma }));
        jest.doMock("../../../config", () => ({
            config: { music: { musicPath: "/music" } },
        }));
        jest.doMock("../../../services/audioHash", () => ({
            computeAudioStreamHash,
        }));
        jest.doMock("music-metadata", () => ({ parseFile }), {
            virtual: true,
        });
        jest.doMock("../../queues", () => ({ schedulerQueue }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../audioHashBackfillProcessor");
        return {
            module,
            logger,
            prisma,
            schedulerQueue,
            computeAudioStreamHash,
            parseFile,
            access,
        };
    }

    function buildJob(startAfterId?: string) {
        return {
            id: "audio-hash-backfill-1",
            data: {
                ...(startAfterId ? { startAfterId } : { mode: "startup" }),
                sweepStartedAt: "2026-08-14T12:00:00.000Z",
            },
        } as any;
    }

    it("hashes one bounded batch, skips missing files, and enqueues the next cursor", async () => {
        const tracks = Array.from({ length: 51 }, (_, index) => ({
            id: `track-${index.toString().padStart(3, "0")}`,
            filePath: `Artist/Track-${index}.flac`,
        }));
        const missingPath = "/music/Artist/Track-10.flac";
        const {
            module,
            logger,
            prisma,
            schedulerQueue,
            computeAudioStreamHash,
            parseFile,
        } = loadProcessor(tracks, [missingPath]);

        await expect(
            module.processAudioHashBackfill(buildJob()),
        ).resolves.toEqual({
            processed: 50,
            hashed: 49,
            skipped: 1,
            continued: true,
        });

        expect(logger.child).toHaveBeenCalledWith("AudioHashBackfillProcessor");
        expect(prisma.track.findMany).toHaveBeenCalledWith({
            where: {
                audioHash: null,
                filePath: { not: null },
                origin: "LOCAL",
                removedAt: null,
            },
            orderBy: { id: "asc" },
            take: 51,
            select: { id: true, filePath: true },
        });
        expect(computeAudioStreamHash).toHaveBeenCalledTimes(49);
        expect(computeAudioStreamHash).not.toHaveBeenCalledWith(missingPath);
        expect(parseFile).toHaveBeenCalledTimes(49);
        expect(parseFile).toHaveBeenCalledWith("/music/Artist/Track-0.flac", {
            skipCovers: true,
        });
        expect(prisma.track.updateMany).toHaveBeenCalledTimes(49);
        expect(prisma.track.updateMany).toHaveBeenCalledWith({
            where: { id: "track-000", audioHash: null, origin: "LOCAL" },
            data: {
                audioHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
                audioHashedAt: expect.any(Date),
                recordingMbid: "recording-default",
                isrc: "USRC17607839",
            },
        });
        expect(schedulerQueue.add).toHaveBeenCalledWith(
            "track-audio-hash-backfill",
            {
                startAfterId: "track-049",
                sweepStartedAt: "2026-08-14T12:00:00.000Z",
            },
            {
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                jobId: "scheduler:audio-hash-backfill:2026-08-14T12:00:00.000Z:track-049",
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
    });

    it("resumes after a persisted cursor and stops after the final page", async () => {
        const tracks = [
            { id: "track-051", filePath: "Artist/Track-51.flac" },
            { id: "track-052", filePath: "Artist/Track-52.flac" },
        ];
        const { module, prisma, schedulerQueue } = loadProcessor(tracks);

        await expect(
            module.processAudioHashBackfill(buildJob("track-050")),
        ).resolves.toEqual({
            processed: 2,
            hashed: 2,
            skipped: 0,
            continued: false,
        });

        expect(prisma.track.findMany).toHaveBeenCalledWith({
            where: {
                audioHash: null,
                filePath: { not: null },
                origin: "LOCAL",
                removedAt: null,
                id: { gt: "track-050" },
            },
            orderBy: { id: "asc" },
            take: 51,
            select: { id: true, filePath: true },
        });
        expect(schedulerQueue.add).not.toHaveBeenCalled();
    });

    it("does not select federated tracks for local audio hashing", async () => {
        const { module, prisma, computeAudioStreamHash } = loadProcessor([
            {
                id: "track-federated",
                filePath: "Peer/Track.flac",
                origin: "FEDERATED",
            },
        ]);

        await expect(
            module.processAudioHashBackfill(buildJob()),
        ).resolves.toEqual({
            processed: 0,
            hashed: 0,
            skipped: 0,
            continued: false,
        });

        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    filePath: { not: null },
                    origin: "LOCAL",
                }),
            }),
        );
        expect(computeAudioStreamHash).not.toHaveBeenCalled();
        expect(prisma.track.updateMany).not.toHaveBeenCalled();
    });

    it("skips a hash write when a concurrent scan already populated it", async () => {
        const { module, prisma } = loadProcessor([
            { id: "track-raced", filePath: "Artist/Raced.flac" },
        ]);
        prisma.track.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(
            module.processAudioHashBackfill(buildJob()),
        ).resolves.toEqual({
            processed: 1,
            hashed: 0,
            skipped: 1,
            continued: false,
        });
        expect(prisma.track.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: "track-raced",
                    audioHash: null,
                    origin: "LOCAL",
                },
            }),
        );
    });

    it("normalizes string and array ISRC tag shapes", async () => {
        const { module, prisma, parseFile } = loadProcessor([
            { id: "track-array", filePath: "Artist/Array.flac" },
            { id: "track-string", filePath: "Artist/String.flac" },
        ]);
        parseFile
            .mockResolvedValueOnce({
                common: {
                    musicbrainz_recordingid: " recording-array ",
                    isrc: [" ARRAY-FIRST ", "ARRAY-SECOND"],
                },
            })
            .mockResolvedValueOnce({
                common: {
                    musicbrainz_recordingid: "recording-string",
                    isrc: " STRING-ISRC ",
                },
            });

        await module.processAudioHashBackfill(buildJob());

        expect(prisma.track.updateMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                data: expect.objectContaining({
                    recordingMbid: "recording-array",
                    isrc: "ARRAY-FIRST",
                }),
            }),
        );
        expect(prisma.track.updateMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                data: expect.objectContaining({
                    recordingMbid: "recording-string",
                    isrc: "STRING-ISRC",
                }),
            }),
        );
    });

    it("writes null tag keys when identity tags are absent", async () => {
        const { module, prisma, parseFile } = loadProcessor([
            { id: "track-untagged", filePath: "Artist/Untagged.flac" },
        ]);
        parseFile.mockResolvedValueOnce({ common: {} });

        await module.processAudioHashBackfill(buildJob());

        expect(prisma.track.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    recordingMbid: null,
                    isrc: null,
                }),
            }),
        );
    });

    it("still writes a successful hash when metadata parsing fails", async () => {
        const { module, prisma, parseFile } = loadProcessor([
            { id: "track-bad-tags", filePath: "Artist/Bad-Tags.flac" },
        ]);
        parseFile.mockRejectedValueOnce(new Error("unreadable tags"));

        await expect(
            module.processAudioHashBackfill(buildJob()),
        ).resolves.toEqual({
            processed: 1,
            hashed: 1,
            skipped: 0,
            continued: false,
        });
        expect(prisma.track.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    audioHash: expect.stringMatching(/^sha256:/),
                    recordingMbid: null,
                    isrc: null,
                }),
            }),
        );
    });

    it("writes nothing when hashing fails", async () => {
        const { module, prisma, computeAudioStreamHash, parseFile } =
            loadProcessor([
                { id: "track-no-hash", filePath: "Artist/No-Hash.flac" },
            ]);
        computeAudioStreamHash.mockResolvedValueOnce(null);

        await expect(
            module.processAudioHashBackfill(buildJob()),
        ).resolves.toEqual({
            processed: 1,
            hashed: 0,
            skipped: 1,
            continued: false,
        });
        expect(parseFile).toHaveBeenCalledWith("/music/Artist/No-Hash.flac", {
            skipCovers: true,
        });
        expect(prisma.track.updateMany).not.toHaveBeenCalled();
    });

    it("rejects a continuation without a validated sweep token", async () => {
        const { module, prisma } = loadProcessor([]);

        await expect(
            module.processAudioHashBackfill({
                id: "invalid",
                data: { startAfterId: "track-050" },
            } as any),
        ).rejects.toBeDefined();
        expect(prisma.track.findMany).not.toHaveBeenCalled();
    });
});

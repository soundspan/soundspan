describe("vibe vocabulary service behavior", () => {
    function loadModule() {
        jest.resetModules();

        const existsSync = jest.fn();
        const readFileSync = jest.fn();
        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        jest.doMock("fs", () => ({
            existsSync,
            readFileSync,
        }));
        jest.doMock("../../utils/logger", () => ({
            logger,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("../vibeVocabulary") as typeof import("../vibeVocabulary");
        return { mod, existsSync, readFileSync, logger };
    }

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("loads vocabulary from disk and caches it for repeated getVocabulary calls", () => {
        const { mod, existsSync, readFileSync, logger } = loadModule();
        existsSync.mockReturnValue(true);
        readFileSync.mockReturnValue(
            JSON.stringify({
                terms: {
                    chill: {
                        name: "chill",
                        type: "genre",
                        embedding: [1, 0],
                        featureProfile: { energy: 0.2 },
                    },
                },
                version: "v1",
                generatedAt: "2026-01-01T00:00:00.000Z",
            })
        );

        const loaded = mod.loadVocabulary();
        const cached = mod.getVocabulary();

        expect(loaded).toEqual(cached);
        expect(readFileSync).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(
            "[VIBE-VOCAB] Loaded 1 vocabulary terms"
        );
    });

    it("returns null when vocabulary file is missing or unreadable", () => {
        const missingCase = loadModule();
        missingCase.existsSync.mockReturnValue(false);
        expect(missingCase.mod.loadVocabulary()).toBeNull();
        expect(missingCase.logger.warn).toHaveBeenCalledWith(
            "[VIBE-VOCAB] Vocabulary file not found. Run generateVibeVocabulary script."
        );

        const parseErrorCase = loadModule();
        parseErrorCase.existsSync.mockReturnValue(true);
        parseErrorCase.readFileSync.mockReturnValue("{bad-json");
        expect(parseErrorCase.mod.loadVocabulary()).toBeNull();
        expect(parseErrorCase.logger.error).toHaveBeenCalledWith(
            "[VIBE-VOCAB] Failed to load vocabulary:",
            expect.any(Error)
        );
    });

    it("computes cosine similarity with edge cases", () => {
        const { mod } = loadModule();

        expect(mod.cosineSimilarity([1, 0], [1, 0])).toBe(1);
        expect(mod.cosineSimilarity([1, 2], [3])).toBe(0);
        expect(mod.cosineSimilarity([0, 0], [0, 0])).toBe(0);
    });

    it("blends embeddings using weighted averages", () => {
        const { mod } = loadModule();

        expect(mod.blendEmbeddings([])).toEqual([]);
        expect(
            mod.blendEmbeddings([
                { embedding: [1, 0], weight: 1 },
                { embedding: [0, 1], weight: 3 },
            ])
        ).toEqual([0.25, 0.75]);
    });

    it("finds similar terms, sorts by similarity, and applies thresholds", () => {
        const { mod } = loadModule();

        const vocab: import("../vibeVocabulary").Vocabulary = {
            terms: {
                a: {
                    name: "a",
                    type: "genre",
                    embedding: [1, 0],
                    featureProfile: {},
                },
                b: {
                    name: "b",
                    type: "mood",
                    embedding: [0.8, 0.2],
                    featureProfile: {},
                },
                c: {
                    name: "c",
                    type: "descriptor",
                    embedding: [0, 1],
                    featureProfile: {},
                },
            },
            version: "v1",
            generatedAt: "2026-01-01T00:00:00.000Z",
        };

        const matches = mod.findSimilarTerms([1, 0], vocab, 0.5, 2);
        expect(matches).toHaveLength(2);
        expect(matches[0].term.name).toBe("a");
        expect(matches[1].term.name).toBe("b");
    });

    it("expands queries with and without matched vocabulary terms", () => {
        const { mod } = loadModule();
        const vocab: import("../vibeVocabulary").Vocabulary = {
            terms: {
                chill: {
                    name: "chill",
                    type: "genre",
                    embedding: [0.9, 0.1],
                    featureProfile: { energy: 0.2 },
                },
                calm: {
                    name: "calm",
                    type: "mood",
                    embedding: [0.7, 0.3],
                    featureProfile: { valence: 0.6 },
                },
            },
            version: "v1",
            generatedAt: "2026-01-01T00:00:00.000Z",
        };

        const noMatch = mod.expandQueryWithVocabulary([0, 1], "query", vocab);
        expect(noMatch).toEqual({
            embedding: [0, 1],
            genreConfidence: 0,
            matchedTerms: [],
            originalQuery: "query",
        });

        const expanded = mod.expandQueryWithVocabulary([1, 0], "chill mix", vocab);
        expect(expanded.matchedTerms.map((t) => t.name)).toEqual(
            expect.arrayContaining(["chill", "calm"])
        );
        expect(expanded.genreConfidence).toBeGreaterThan(0.5);
        expect(expanded.embedding).toHaveLength(2);
    });

    it("blends feature profiles and computes feature-match scores", () => {
        const { mod } = loadModule();

        const profile = mod.blendFeatureProfiles([
            {
                name: "chill",
                type: "genre",
                embedding: [1, 0],
                featureProfile: { energy: 0.2, valence: 0.7 },
            },
            {
                name: "calm",
                type: "mood",
                embedding: [0, 1],
                featureProfile: { energy: 0.4 },
            },
        ]);
        expect(profile).toEqual({ energy: 0.30000000000000004, valence: 0.7 });
        expect(mod.blendFeatureProfiles([])).toEqual({});

        expect(
            mod.calculateFeatureMatch(
                { energy: 0.3, valence: null },
                { energy: 0.2, valence: 0.7 }
            )
        ).toBeGreaterThan(0.7);

        expect(mod.calculateFeatureMatch({}, {})).toBe(0.5);
    });

    it("re-ranks candidates by blending clap and feature scores", () => {
        const { mod, logger } = loadModule();

        const matchedTerms: import("../vibeVocabulary").VocabTerm[] = [
            {
                name: "energetic",
                type: "genre",
                embedding: [1, 0],
                featureProfile: { energy: 0.9, danceability: 0.8 },
            },
        ];

        const ranked = mod.rerankWithFeatures(
            [
                {
                    id: "t1",
                    distance: 0.2,
                    energy: 0.85,
                    danceability: 0.75,
                },
                {
                    id: "t2",
                    distance: 0.1,
                    energy: 0.2,
                    danceability: 0.2,
                },
            ],
            matchedTerms,
            0.8
        );

        expect(ranked[0].id).toBe("t1");
        expect(ranked[0]).toEqual(
            expect.objectContaining({
                finalScore: expect.any(Number),
                clapScore: expect.any(Number),
                featureScore: expect.any(Number),
            })
        );
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("[VIBE-RERANK] Genre confidence:")
        );

        const fallbackFeature = mod.rerankWithFeatures(
            [{ id: "t3", distance: 0.1 }],
            [],
            0.1
        );
        expect(fallbackFeature[0].featureScore).toBe(0.5);
    });
});

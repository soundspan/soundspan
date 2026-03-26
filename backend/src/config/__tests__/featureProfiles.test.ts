import { VOCAB_DEFINITIONS, VOCABULARY_TERMS } from "../featureProfiles";

const VALID_TERM_TYPES = ["genre", "mood", "vibe", "descriptor"] as const;

describe("config/featureProfiles", () => {
    test("VOCABULARY_TERMS contains all definition keys", () => {
        const definitionKeys = Object.keys(VOCAB_DEFINITIONS);

        expect(VOCABULARY_TERMS).toHaveLength(definitionKeys.length);
        expect(new Set(VOCABULARY_TERMS)).toEqual(new Set(definitionKeys));
    });

    test("all vocabulary entries have the required structure", () => {
        for (const [term, definition] of Object.entries(VOCAB_DEFINITIONS)) {
            expect(definition).toHaveProperty("type");
            expect(definition).toHaveProperty("featureProfile");

            expect(VALID_TERM_TYPES).toContain(definition.type);
            expect(definition.featureProfile).toEqual(expect.any(Object));

            if (definition.related !== undefined) {
                expect(Array.isArray(definition.related)).toBe(true);
                for (const relatedTerm of definition.related) {
                    expect(typeof relatedTerm).toBe("string");
                    expect(relatedTerm).not.toHaveLength(0);
                }
            }

            expect(term).toEqual(expect.any(String));
        }
    });

    test.each(["genre", "mood", "vibe", "descriptor"] as const)("has valid %s entries", (termType) => {
        const entries = Object.entries(VOCAB_DEFINITIONS).filter(([, definition]) => definition.type === termType);

        expect(entries.length).toBeGreaterThan(0);
        for (const [term, definition] of entries) {
            expect(definition.type).toBe(termType);
            expect(term).toEqual(expect.any(String));
            expect(Object.keys(definition.featureProfile).length).toBeGreaterThan(0);
        }
    });

    test("feature profile values stay within 0-1", () => {
        for (const [term, definition] of Object.entries(VOCAB_DEFINITIONS)) {
            for (const [property, value] of Object.entries(definition.featureProfile)) {
                expect(typeof value).toBe("number");
                expect(value).toBeGreaterThanOrEqual(0);
                expect(value).toBeLessThanOrEqual(1);
                expect(term).toEqual(expect.any(String));
                expect(property).toEqual(expect.any(String));
            }
        }
    });
});

import type { VocabTermDefinition } from "../config/featureProfiles";
import type { Vocabulary, VocabularySpaceIdentity } from "./vibeVocabulary";

interface GenerateVocabularyOptions {
    spaceIdentities: readonly VocabularySpaceIdentity[];
    termNames: readonly string[];
    definitions: Readonly<Record<string, VocabTermDefinition>>;
    embed(text: string): Promise<number[]>;
    generatedAt?: string;
}

/** Result of one bounded, sequential vocabulary generation pass. */
export interface GenerateVocabularyResult {
    vocabulary: Vocabulary;
    succeeded: number;
    failed: string[];
}

/** Require explicit provider opt-in before the operator script starts work. */
export function requireVibeProviderUrl(
    providerUrl: string | undefined,
): string {
    if (!providerUrl) {
        throw new Error(
            "VIBE_PROVIDER_URL is required to generate the vibe vocabulary",
        );
    }
    return providerUrl;
}

/** Build the existing vocabulary artifact from provider text embeddings. */
export async function generateVibeVocabulary(
    options: GenerateVocabularyOptions,
): Promise<GenerateVocabularyResult> {
    const terms: Vocabulary["terms"] = {};
    const failed: string[] = [];
    let succeeded = 0;

    for (let index = 0; index < options.termNames.length; index += 1) {
        const termName = options.termNames[index];
        const definition = options.definitions[termName];
        if (!definition) {
            failed.push(termName);
            continue;
        }
        try {
            const embedding = await options.embed(termName);
            terms[termName] = {
                name: termName,
                type: definition.type,
                embedding,
                featureProfile: definition.featureProfile,
                ...(definition.related ? { related: definition.related } : {}),
            };
            succeeded += 1;
        } catch {
            failed.push(termName);
        }
    }

    return {
        vocabulary: {
            version: "1.1.0",
            generatedAt: options.generatedAt ?? new Date().toISOString(),
            spaceIdentities: [...options.spaceIdentities],
            terms,
        },
        succeeded,
        failed,
    };
}

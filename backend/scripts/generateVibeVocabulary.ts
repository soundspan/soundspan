// backend/scripts/generateVibeVocabulary.ts

import { writeFileSync } from "fs";
import { join } from "path";
import { config } from "../src/config";
import {
    VOCAB_DEFINITIONS,
    VOCABULARY_TERMS,
} from "../src/config/featureProfiles";
import { embedText, fetchProviderSpace } from "../src/services/vibeProvider";
import {
    generateVibeVocabulary,
    requireVibeProviderUrl,
} from "../src/services/vibeVocabularyGenerator";

async function main() {
    requireVibeProviderUrl(config.vibeProviderUrl);
    console.log(
        `Generating embeddings for ${VOCABULARY_TERMS.length} terms...`,
    );
    const providerSpace = await fetchProviderSpace();
    const result = await generateVibeVocabulary({
        spaceIdentities: [
            {
                family: providerSpace.family,
                checkpointHash: providerSpace.checkpointHash,
            },
        ],
        termNames: VOCABULARY_TERMS,
        definitions: VOCAB_DEFINITIONS,
        embed: (text) =>
            embedText(text, {
                id: "vocabulary-generation",
                dim: providerSpace.dim,
            }),
    });

    const outputPath = join(__dirname, "../src/config/vibe-vocabulary.json");
    writeFileSync(outputPath, JSON.stringify(result.vocabulary, null, 2));

    console.log(
        `\nDone! ${result.succeeded} terms generated, ${result.failed.length} failed.`,
    );
    if (result.failed.length > 0) {
        console.log(`Failed terms: ${result.failed.join(", ")}`);
    }
    console.log(`Vocabulary saved to: ${outputPath}`);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
});

// backend/scripts/generateVibeVocabulary.ts

import { createClient } from "redis";
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { join } from "path";
import { VOCAB_DEFINITIONS, VOCABULARY_TERMS } from "../src/data/featureProfiles";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

interface VocabTerm {
    name: string;
    type: string;
    embedding: number[];
    featureProfile: Record<string, number>;
    related?: string[];
}

async function getClapTextEmbedding(
    redisClient: ReturnType<typeof createClient>,
    text: string
): Promise<number[]> {
    const requestId = randomUUID();
    const responseChannel = `audio:text:embed:response:${requestId}`;
    const requestChannel = "audio:text:embed";

    const subscriber = redisClient.duplicate();
    await subscriber.connect();

    try {
        return await new Promise<number[]>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Timeout getting embedding for: ${text}`));
            }, 30000);

            subscriber.subscribe(responseChannel, (message) => {
                clearTimeout(timeout);
                try {
                    const data = JSON.parse(message);
                    if (data.error) {
                        reject(new Error(data.error));
                    } else {
                        resolve(data.embedding);
                    }
                } catch (e) {
                    reject(new Error("Invalid response"));
                }
            });

            redisClient.publish(
                requestChannel,
                JSON.stringify({ requestId, text })
            );
        });
    } finally {
        await subscriber.unsubscribe(responseChannel);
        await subscriber.disconnect();
    }
}

async function main() {
    console.log("Connecting to Redis...");
    const redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();

    console.log(`Generating embeddings for ${VOCABULARY_TERMS.length} terms...`);

    const terms: Record<string, VocabTerm> = {};
    let success = 0;
    let failed = 0;

    for (const termName of VOCABULARY_TERMS) {
        const definition = VOCAB_DEFINITIONS[termName];

        try {
            process.stdout.write(`  ${termName}... `);
            const embedding = await getClapTextEmbedding(redisClient, termName);

            terms[termName] = {
                name: termName,
                type: definition.type,
                embedding,
                featureProfile: definition.featureProfile,
                related: definition.related
            };

            console.log(`OK (${embedding.length} dims)`);
            success++;
        } catch (error) {
            console.log(`FAILED: ${error}`);
            failed++;
        }

        // Small delay to not overwhelm the CLAP service
        await new Promise(r => setTimeout(r, 100));
    }

    const vocabulary = {
        version: "1.0.0",
        generatedAt: new Date().toISOString(),
        terms
    };

    const outputPath = join(__dirname, "../src/data/vibe-vocabulary.json");
    writeFileSync(outputPath, JSON.stringify(vocabulary, null, 2));

    console.log(`\nDone! ${success} terms generated, ${failed} failed.`);
    console.log(`Vocabulary saved to: ${outputPath}`);

    await redisClient.disconnect();
}

main().catch(console.error);

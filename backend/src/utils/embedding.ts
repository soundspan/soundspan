/**
 * Parse a pgvector embedding from its text representation "[0.1,0.2,...]"
 * into a number array.
 */
export function parseEmbedding(text: string): number[] {
    if (!text || typeof text !== "string") {
        throw new Error("Invalid embedding: expected non-empty string");
    }

    const values = text
        .replace(/[\[\]]/g, "")
        .split(",")
        .map((value) => Number(value.trim()));

    if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
        throw new Error("Invalid embedding: contains non-numeric values");
    }

    return values;
}

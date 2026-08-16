/**
 * Parse a pgvector embedding from its text representation "[0.1,0.2,...]"
 * into a number array.
 */
export function parseEmbedding(text: string): number[] {
    if (typeof text !== "string" || text.trim() === "") {
        throw new Error("Invalid embedding: expected non-empty string");
    }

    const values = text
        .trim()
        .split("[")
        .join("")
        .split("]")
        .join("")
        .split(",")
        .map((value: string) => value.trim());

    if (values.length === 0 || values.some((value: string) => value === "")) {
        throw new Error("Invalid embedding: contains non-numeric values");
    }

    const numbers = values.map((value: string) => Number(value));

    if (numbers.some((value: number) => !Number.isFinite(value))) {
        throw new Error("Invalid embedding: contains non-numeric values");
    }

    return numbers;
}

/**
 * Linearly interpolate between two embedding vectors.
 */
export function lerpEmbedding(a: number[], b: number[], t: number): number[] {
    return a.map((v, i) => v * (1 - t) + b[i] * t);
}

/**
 * Weighted average of multiple embeddings.
 */
export function blendEmbeddings(
    embeddings: number[][],
    weights: number[],
): number[] {
    const dim = embeddings[0].length;
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const result = new Array<number>(dim).fill(0);
    for (let i = 0; i < embeddings.length; i++) {
        const w = weights[i] / totalWeight;
        for (let d = 0; d < dim; d++) {
            result[d] += embeddings[i][d] * w;
        }
    }
    return result;
}

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

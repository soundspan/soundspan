import { foldAlbumSymbols } from "./albumMatchPolicy";

const MAX_ALBUM_SEARCH_QUERIES = 4;
const SYMBOL_WORDS = new Map<string, string>([
    ["+", "plus"],
    ["-", "minus"],
    ["=", "equals"],
    ["÷", "divide"],
    ["*", "times"],
    ["/", "slash"],
    ["&", "and"],
]);

function normalizeQuery(value: string): string {
    return value.replace(/\s+/gu, " ").trim();
}

function appendUniqueQuery(queries: string[], value: string): void {
    const query = normalizeQuery(value);
    if (queries.length >= MAX_ALBUM_SEARCH_QUERIES) return;
    if (queries.includes(query)) return;
    queries.push(query);
}

function spellSymbols(value: string): string {
    const symbols = value.match(/[+=÷*/&-]/gu) ?? [];
    return symbols.map((symbol) => SYMBOL_WORDS.get(symbol) ?? "").join(" ");
}

/** Build the bounded provider query sequence for an artist and album title. */
export function buildAlbumSearchQueries(
    artistName: string,
    albumTitle: string,
): string[] {
    const artist = artistName.trim();
    const title = albumTitle.trim();
    const firstQuery = normalizeQuery(`${artist} ${title}`);
    if (!artist || !title) return [firstQuery];

    const queries: string[] = [];
    appendUniqueQuery(queries, firstQuery);
    const foldedTitle = foldAlbumSymbols(title);
    if (foldedTitle !== title) {
        appendUniqueQuery(queries, `${artist} ${foldedTitle}`);
    }
    if (/[\p{L}\p{N}]/u.test(foldedTitle)) return queries;

    const words = spellSymbols(foldedTitle);
    if (words) appendUniqueQuery(queries, `${artist} ${words}`);
    appendUniqueQuery(queries, artist);
    return queries;
}

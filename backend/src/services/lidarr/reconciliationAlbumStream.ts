import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { normalizeForExactKey } from "../../utils/artistNormalization";
import type { LidarrCallConfig, LidarrHttpResponse } from "./lidarrHttpClient";

export const LIDARR_ALBUM_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const LIDARR_ALBUM_MAX_ITEMS = 250_000;
const LIDARR_ALBUM_MAX_ITEM_BYTES = 1024 * 1024;
const LIDARR_ALBUM_MAX_STREAM_CHUNKS = 1_000_000;

interface AlbumSnapshotInfo {
    id: number;
    title: string;
    foreignAlbumId: string;
    artistName: string;
    hasFiles: boolean;
}

interface ReconciliationAlbumMaps {
    albumsByMbid: Map<string, AlbumSnapshotInfo>;
    albumsByTitle: Map<string, AlbumSnapshotInfo>;
}

interface ReconciliationAlbumClient {
    get(
        path: string,
        config: LidarrCallConfig,
    ): Promise<LidarrHttpResponse<unknown>>;
}

interface JsonArrayParserState {
    started: boolean;
    ended: boolean;
    depth: number;
    inString: boolean;
    escaped: boolean;
    current: string;
    currentBytes: number;
    items: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function snapshotAlbum(value: unknown): AlbumSnapshotInfo | null {
    if (!isRecord(value) || !isRecord(value.statistics)) return null;
    if (!(Number(value.statistics.percentOfTracks) > 0)) return null;
    if (
        typeof value.id !== "number" ||
        typeof value.title !== "string" ||
        typeof value.foreignAlbumId !== "string"
    ) {
        return null;
    }
    const artistName =
        isRecord(value.artist) && typeof value.artist.artistName === "string"
            ? value.artist.artistName
            : "";
    return {
        id: value.id,
        title: value.title,
        foreignAlbumId: value.foreignAlbumId,
        artistName,
        hasFiles: true,
    };
}

function indexAlbum(target: ReconciliationAlbumMaps, value: unknown): void {
    const album = snapshotAlbum(value);
    if (!album) return;
    if (album.foreignAlbumId) {
        target.albumsByMbid.set(album.foreignAlbumId, album);
    }
    if (!album.artistName || !album.title) return;
    const key = `${normalizeForExactKey(album.artistName)}|${normalizeForExactKey(album.title)}`;
    target.albumsByTitle.set(key, album);
}

function completeItem(
    state: JsonArrayParserState,
    target: ReconciliationAlbumMaps,
): void {
    state.items += 1;
    if (state.items > LIDARR_ALBUM_MAX_ITEMS) {
        throw new Error("Lidarr album response exceeded the item bound");
    }
    indexAlbum(target, JSON.parse(state.current) as unknown);
    state.current = "";
    state.currentBytes = 0;
}

function consumeOutsideItem(state: JsonArrayParserState, char: string): void {
    if (/\s/.test(char) || char === ",") return;
    if (!state.started && char === "[") {
        state.started = true;
        return;
    }
    if (state.started && char === "]") {
        state.ended = true;
        return;
    }
    if (state.started && !state.ended && char === "{") {
        state.depth = 1;
        state.current = char;
        state.currentBytes = 1;
        return;
    }
    throw new Error("Lidarr album response was not a JSON object array");
}

function consumeInsideItem(
    state: JsonArrayParserState,
    char: string,
    target: ReconciliationAlbumMaps,
): void {
    state.current += char;
    state.currentBytes += Buffer.byteLength(char);
    if (state.currentBytes > LIDARR_ALBUM_MAX_ITEM_BYTES) {
        throw new Error("Lidarr album item exceeded the byte bound");
    }
    if (state.escaped) {
        state.escaped = false;
        return;
    }
    if (state.inString && char === "\\") {
        state.escaped = true;
        return;
    }
    if (char === '"') {
        state.inString = !state.inString;
        return;
    }
    if (state.inString) return;
    if (char === "{" || char === "[") state.depth += 1;
    if (char === "}" || char === "]") state.depth -= 1;
    if (state.depth === 0) completeItem(state, target);
}

function consumeText(
    state: JsonArrayParserState,
    text: string,
    target: ReconciliationAlbumMaps,
): void {
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (state.depth === 0) consumeOutsideItem(state, char);
        else consumeInsideItem(state, char, target);
    }
}

function assertComplete(state: JsonArrayParserState): void {
    if (!state.started || !state.ended || state.depth !== 0) {
        throw new Error("Lidarr album response ended before the JSON array");
    }
}

async function indexStream(
    stream: Readable,
    target: ReconciliationAlbumMaps,
    signal: AbortSignal,
): Promise<void> {
    const decoder = new StringDecoder("utf8");
    const state: JsonArrayParserState = {
        started: false,
        ended: false,
        depth: 0,
        inString: false,
        escaped: false,
        current: "",
        currentBytes: 0,
        items: 0,
    };
    const iterator = stream[Symbol.asyncIterator]();
    let totalBytes = 0;
    try {
        for (
            let chunkIndex = 0;
            chunkIndex < LIDARR_ALBUM_MAX_STREAM_CHUNKS;
            chunkIndex += 1
        ) {
            signal.throwIfAborted();
            const next = await iterator.next();
            if (next.done) {
                consumeText(state, decoder.end(), target);
                assertComplete(state);
                return;
            }
            const chunk = Buffer.isBuffer(next.value)
                ? next.value
                : Buffer.from(next.value);
            totalBytes += chunk.byteLength;
            if (totalBytes > LIDARR_ALBUM_RESPONSE_MAX_BYTES) {
                throw new Error(
                    "Lidarr album response exceeded the byte bound",
                );
            }
            consumeText(state, decoder.write(chunk), target);
        }
        throw new Error("Lidarr album response exceeded the chunk bound");
    } finally {
        await iterator.return?.();
        stream.destroy();
    }
}

function isReadable(value: unknown): value is Readable {
    return (
        isRecord(value) &&
        typeof value.destroy === "function" &&
        Symbol.asyncIterator in value
    );
}

/** Streams the unpaged Lidarr album array into the two derived snapshot maps. */
export async function fetchReconciliationAlbumMaps(
    client: ReconciliationAlbumClient,
    target: ReconciliationAlbumMaps,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    const response = await client.get("/api/v1/album", {
        signal,
        responseType: "stream",
        maxContentLength: LIDARR_ALBUM_RESPONSE_MAX_BYTES,
        maxBodyLength: LIDARR_ALBUM_RESPONSE_MAX_BYTES,
    });
    if (Array.isArray(response.data)) {
        if (response.data.length > LIDARR_ALBUM_MAX_ITEMS) {
            throw new Error("Lidarr album response exceeded the item bound");
        }
        for (const album of response.data) indexAlbum(target, album);
        return;
    }
    if (!isReadable(response.data)) {
        throw new Error("Lidarr album response was not readable");
    }
    await indexStream(response.data, target, signal);
}

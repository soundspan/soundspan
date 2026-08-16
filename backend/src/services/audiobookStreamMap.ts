import { z } from "zod";

const MAX_AUDIOBOOK_FILES = 10_000;
const byteFileSchema = z.strictObject({
    index: z.number().int().nonnegative(),
    byteLength: z.number().int().nonnegative().safe(),
});
const byteFilesSchema = z.array(byteFileSchema).max(MAX_AUDIOBOOK_FILES);

/** One byte interval to request from an Audiobookshelf track. */
export type AudiobookFileSlice = Readonly<{
    fileIndex: number;
    fileStartByte: number;
    fileEndByte: number;
}>;

type StreamMapEntry = Readonly<{
    fileIndex: number;
    streamStartByte: number;
    streamEndByte: number;
}>;

/** A validated translation table from concatenated bytes to track-local bytes. */
export type AudiobookStreamMap = Readonly<{
    totalBytes(): number;
    resolveRange(startByte: number, endByte: number): AudiobookFileSlice[];
}>;

/** The result of parsing and resolving one HTTP byte range. */
export type AudiobookRangeResolution =
    | Readonly<{
          kind: "partial";
          startByte: number;
          endByte: number;
          slices: AudiobookFileSlice[];
      }>
    | Readonly<{ kind: "unsatisfiable"; totalBytes: number }>;

function buildEntries(
    files: z.infer<typeof byteFilesSchema>,
): StreamMapEntry[] {
    const entries: StreamMapEntry[] = [];
    let streamStartByte = 0;
    for (const file of files) {
        if (file.byteLength === 0) continue;
        const streamEndByte = streamStartByte + file.byteLength - 1;
        if (!Number.isSafeInteger(streamEndByte)) {
            throw new RangeError(
                "Audiobook byte length exceeds safe integer range",
            );
        }
        entries.push({
            fileIndex: file.index,
            streamStartByte,
            streamEndByte,
        });
        streamStartByte = streamEndByte + 1;
    }
    return entries;
}

function assertResolvableRange(
    startByte: number,
    endByte: number,
    totalBytes: number,
): void {
    const valid =
        Number.isSafeInteger(startByte) &&
        Number.isSafeInteger(endByte) &&
        startByte >= 0 &&
        endByte >= startByte &&
        endByte < totalBytes;
    if (!valid) throw new RangeError("Audiobook byte range is not satisfiable");
}

function resolveEntries(
    entries: ReadonlyArray<StreamMapEntry>,
    startByte: number,
    endByte: number,
): AudiobookFileSlice[] {
    return entries.flatMap((entry) => {
        if (
            endByte < entry.streamStartByte ||
            startByte > entry.streamEndByte
        ) {
            return [];
        }
        return [
            {
                fileIndex: entry.fileIndex,
                fileStartByte:
                    Math.max(startByte, entry.streamStartByte) -
                    entry.streamStartByte,
                fileEndByte:
                    Math.min(endByte, entry.streamEndByte) -
                    entry.streamStartByte,
            },
        ];
    });
}

/** Build a deterministic byte-to-track translation table in payload order. */
export function buildAudiobookStreamMap(input: unknown): AudiobookStreamMap {
    const entries = buildEntries(byteFilesSchema.parse(input));
    const total = entries.at(-1)?.streamEndByte ?? -1;
    const totalByteLength = total + 1;
    return {
        totalBytes: () => totalByteLength,
        resolveRange: (startByte, endByte) => {
            assertResolvableRange(startByte, endByte, totalByteLength);
            return resolveEntries(entries, startByte, endByte);
        },
    };
}

function parseRangeNumber(value: string): number | null {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function unsatisfiable(totalBytes: number): AudiobookRangeResolution {
    return { kind: "unsatisfiable", totalBytes };
}

/** Parse and resolve a single HTTP bytes range against an audiobook map. */
export function resolveAudiobookRange(
    rangeHeader: string,
    map: AudiobookStreamMap,
): AudiobookRangeResolution {
    const totalBytes = map.totalBytes();
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || totalBytes === 0) return unsatisfiable(totalBytes);
    const [, rawStart = "", rawEnd = ""] = match;
    const startValue = rawStart === "" ? null : parseRangeNumber(rawStart);
    const endValue = rawEnd === "" ? null : parseRangeNumber(rawEnd);
    if (
        (rawStart !== "" && startValue === null) ||
        (rawEnd !== "" && endValue === null)
    ) {
        return unsatisfiable(totalBytes);
    }

    const startByte = startValue ?? Math.max(totalBytes - (endValue ?? 0), 0);
    const endByte =
        startValue === null
            ? totalBytes - 1
            : Math.min(endValue ?? totalBytes - 1, totalBytes - 1);
    if (startByte >= totalBytes || endByte < startByte) {
        return unsatisfiable(totalBytes);
    }
    return {
        kind: "partial",
        startByte,
        endByte,
        slices: map.resolveRange(startByte, endByte),
    };
}

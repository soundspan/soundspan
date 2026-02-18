export type RangeParseResult =
    | { ok: true; start: number; end: number }
    | { ok: false; status: 416 };

/**
 * Parse an HTTP Range header value into start/end byte offsets.
 * Handles standard ranges, open-ended ranges, and suffix ranges (bytes=-N).
 * Clamps end to file boundary per RFC 7233 Section 2.1.
 */
export function parseRangeHeader(
    rangeHeader: string,
    fileSize: number
): RangeParseResult {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const startPart = parts[0];
    const endPart = parts[1];

    let start: number;
    let end: number;

    if (startPart === "") {
        const suffixLength = parseInt(endPart || "", 10);
        if (Number.isNaN(suffixLength) || suffixLength <= 0) {
            return { ok: false, status: 416 };
        }
        start = Math.max(fileSize - suffixLength, 0);
        end = fileSize - 1;
    } else {
        const parsedStart = parseInt(startPart, 10);
        const parsedEnd = endPart ? parseInt(endPart, 10) : fileSize - 1;

        if (Number.isNaN(parsedStart)) {
            return { ok: false, status: 416 };
        }

        start = parsedStart;
        end = Number.isNaN(parsedEnd) ? fileSize - 1 : parsedEnd;
    }

    // Clamp end to file boundary per RFC 7233 Section 2.1
    end = Math.min(end, fileSize - 1);

    // Validate range
    if (start >= fileSize || start > end || start < 0) {
        return { ok: false, status: 416 };
    }

    return { ok: true, start, end };
}

type DelimitedSegmentPredicate = (segment: string) => boolean;

const STRIP_EVERY_SEGMENT: DelimitedSegmentPredicate = () => true;

/**
 * Replaces complete, non-nested delimited segments in one left-to-right pass.
 * Opening delimiters inside a segment are literal content, and unmatched
 * delimiters are preserved. Delimiters must be distinct single code units.
 * @throws {RangeError} When delimiters are not distinct single code units.
 */
export function stripDelimitedSegments(
    input: string,
    openDelimiter: string,
    closeDelimiter: string,
    shouldStrip: DelimitedSegmentPredicate = STRIP_EVERY_SEGMENT,
    replacement: string = "",
): string {
    if (openDelimiter.length !== 1 || closeDelimiter.length !== 1) {
        throw new RangeError("Delimited segment markers must be one character");
    }
    if (openDelimiter === closeDelimiter) {
        throw new RangeError("Delimited segment markers must be distinct");
    }

    const outputParts: string[] = [];
    let segmentStart = -1;
    let copyStart = 0;

    for (let index = 0; index < input.length; index += 1) {
        const character = input[index];
        if (segmentStart < 0) {
            if (character === openDelimiter) segmentStart = index + 1;
            continue;
        }
        if (character !== closeDelimiter) continue;

        if (shouldStrip(input.slice(segmentStart, index))) {
            outputParts.push(
                input.slice(copyStart, segmentStart - 1),
                replacement,
            );
            copyStart = index + 1;
        }
        segmentStart = -1;
    }

    if (outputParts.length === 0) return input;
    outputParts.push(input.slice(copyStart));
    return outputParts.join("");
}

import { stripDelimitedSegments } from "../../utils/stripDelimitedSegments";

const TRACK_DESCRIPTOR_PATTERN =
    /(?:live|remaster|remix|version|edit|demo|acoustic|radio|single|extended|instrumental|feat\.|ft\.|featuring)/i;

/**
 * Normalize a track title for Soulseek search matching: extract the main song
 * name by removing live performance details, remasters, and similar descriptors.
 * e.g. "Santa Claus Is Comin' to Town (Live at C.W. Post College, NY - Dec 1975)"
 * → "Santa Claus Is Comin' to Town"
 */
export function normalizeSoulseekTrackTitle(title: string): string {
    // Map Unicode punctuation to ASCII for better search matching: drop the
    // ellipsis (files don't have it), smart apostrophes and quotes → ASCII,
    // slash → space (file names can't have /), en/em dash → hyphen, and the
    // multiplication sign → x.
    let normalized = title
        .replace(/…/g, "")
        .replace(/[''′`]/g, "'")
        .replace(/[""]/g, '"')
        .replace(/\//g, " ")
        .replace(/[–—]/g, "-")
        .replace(/[×]/g, "x");

    // Remove delimited content only when it contains a known descriptor.
    normalized = stripDelimitedSegments(
        normalized,
        "(",
        ")",
        (segment) => TRACK_DESCRIPTOR_PATTERN.test(segment),
        " ",
    );
    normalized = stripDelimitedSegments(
        normalized,
        "[",
        "]",
        (segment) => TRACK_DESCRIPTOR_PATTERN.test(segment),
        " ",
    );
    // Remove trailing dash content (often contains year or version info).
    normalized = normalized.replace(
        /\s*-\s*(\d{4}|remaster|live|remix|version|edit|demo|acoustic).*$/i,
        "",
    );
    normalized = normalized.replace(/\s+/g, " ").trim();
    // If we stripped too much, return the original.
    return normalized.length < 3 ? title : normalized;
}

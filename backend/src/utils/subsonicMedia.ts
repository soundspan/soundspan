import path from "path";
import type { Quality } from "../services/audioStreaming";

const MIN_COVER_ART_SIZE = 16;
const MAX_COVER_ART_SIZE = 2048;

/**
 * Maps Subsonic bitrate and format query params to the internal stream quality tier.
 */
export function resolveSubsonicStreamQuality(
    maxBitRate: unknown,
    targetFormat: unknown,
): Quality {
    const requestedFormat =
        typeof targetFormat === "string" ? targetFormat.toLowerCase() : "";

    if (!maxBitRate || requestedFormat === "raw" || requestedFormat === "original") {
        return "original";
    }

    if (typeof maxBitRate !== "string") {
        return "original";
    }

    const bitrate = Number.parseInt(maxBitRate, 10);
    if (Number.isNaN(bitrate) || bitrate <= 0) {
        return "original";
    }

    if (bitrate < 192) {
        return "low";
    }
    if (bitrate < 320) {
        return "medium";
    }
    return "high";
}

/**
 * Resolves a track path and rejects values that escape the configured media root.
 */
export function resolveTrackPathWithinRoot(
    rootPath: string,
    trackFilePath: string,
): string | null {
    const normalizedRoot = path.resolve(rootPath);
    const normalizedTrackPath = trackFilePath.replace(/\\/g, "/");
    const resolvedPath = path.isAbsolute(normalizedTrackPath)
        ? path.resolve(normalizedTrackPath)
        : path.resolve(path.join(rootPath, normalizedTrackPath));

    if (
        resolvedPath !== normalizedRoot &&
        !resolvedPath.startsWith(`${normalizedRoot}${path.sep}`)
    ) {
        return null;
    }

    return resolvedPath;
}

/**
 * Parses and bounds a requested cover art size to the supported min/max range.
 */
export function parseCoverArtSize(value: unknown): number | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < MIN_COVER_ART_SIZE) {
        return undefined;
    }

    return Math.min(parsed, MAX_COVER_ART_SIZE);
}

/**
 * Returns true when a cover-art URL is publicly reachable over HTTP(S).
 */
export function isPublicCoverArtUrl(rawUrl: string): boolean {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return false;
        }

        const hostname = parsed.hostname.toLowerCase();
        if (
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            hostname === "::1" ||
            hostname === "0.0.0.0" ||
            hostname.startsWith("10.") ||
            hostname.startsWith("192.168.") ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
            hostname.endsWith(".local") ||
            hostname.endsWith(".internal")
        ) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

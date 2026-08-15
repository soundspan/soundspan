import { execFile } from "child_process";
import { config } from "../config";
import { resolveFfmpegBinaryPath } from "../utils/configValidator";
import { logger } from "../utils/logger";

const hashLogger = logger.child("AudioHash");

/**
 * Upper bound for one ffmpeg streamhash invocation. Demux-only hashing is
 * I/O-bound (~seconds even for large files on slow storage); a stuck mount
 * must not wedge the scan queue.
 */
const HASH_TIMEOUT_MS = 120_000;

/** streamhash emits one short line per stream; anything bigger is anomalous. */
const HASH_MAX_BUFFER_BYTES = 64 * 1024;

/** Matches ffmpeg `-f streamhash -hash sha256` output, e.g. `0,a,SHA256=<hex>`. */
const STREAMHASH_LINE_PATTERN = /^\d+,a,SHA256=([0-9a-fA-F]{64})$/m;

/**
 * Computes the tag-invariant content hash of a file's primary audio stream:
 * SHA-256 over the encoded audio packets (`ffmpeg -c copy -f streamhash`),
 * demux-only, no decode. Retagging a file does not change this hash; a
 * re-encode or quality upgrade does (see docs/designs/durable-track-identity.md).
 *
 * @param filePath Absolute path to the audio file.
 * @returns `"sha256:<hex>"` on success, or null when the file cannot be
 *   hashed (missing, corrupt, no audio stream, ffmpeg failure/timeout).
 *   Callers treat null as "identity unknown" and fall back to tag tiers.
 */
export async function computeAudioStreamHash(
    filePath: string,
): Promise<string | null> {
    if (!filePath || !filePath.trim()) {
        hashLogger.warn("Refusing to hash empty file path");
        return null;
    }

    const ffmpegBinary = resolveFfmpegBinaryPath(
        config.segmentedStreaming.ffmpegPathOverride,
    );
    const args = [
        "-hide_banner",
        "-nostats",
        "-v",
        "error",
        "-i",
        filePath,
        "-map",
        "0:a:0",
        "-c",
        "copy",
        "-f",
        "streamhash",
        "-hash",
        "sha256",
        "-",
    ];

    let stdout: string;
    try {
        stdout = await runFfmpeg(ffmpegBinary, args);
    } catch (error) {
        hashLogger.warn(`Failed to hash audio stream for ${filePath}`, {
            error,
        });
        return null;
    }

    const match = STREAMHASH_LINE_PATTERN.exec(stdout);
    if (!match) {
        hashLogger.warn(
            `Unparsable streamhash output for ${filePath} (${stdout.length} bytes)`,
        );
        return null;
    }

    return `sha256:${match[1].toLowerCase()}`;
}

/** Runs ffmpeg once with bounded time and output, resolving with stdout. */
function runFfmpeg(binary: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            binary,
            args,
            {
                timeout: HASH_TIMEOUT_MS,
                maxBuffer: HASH_MAX_BUFFER_BYTES,
                encoding: "utf8",
            },
            (error, stdout, stderr) => {
                if (error) {
                    const failureMessage =
                        stderr.trim() || "ffmpeg streamhash failed";
                    reject(
                        new Error(failureMessage, {
                            cause: error,
                        }),
                    );
                    return;
                }
                resolve(stdout);
            },
        );
    });
}

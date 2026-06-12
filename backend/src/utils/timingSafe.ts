import { timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison using crypto.timingSafeEqual().
 *
 * Prevents timing side-channel attacks on secret comparisons by ensuring
 * the comparison always takes the same amount of time regardless of how
 * many bytes match. Falls back safely when inputs differ in length.
 */
export function timingSafeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "utf-8");
    const bufB = Buffer.from(b, "utf-8");

    if (bufA.length !== bufB.length) {
        // Still run the comparison against itself to avoid length-based
        // timing leaks, then return false.
        timingSafeEqual(bufA, bufA);
        return false;
    }

    return timingSafeEqual(bufA, bufB);
}

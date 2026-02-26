import crypto from "crypto";
import path from "path";

interface BuildSha256CacheKeyInput {
    identity: string;
    suffix?: string;
    length?: number;
}

export const buildCachePath = (
    basePath: string,
    ...segments: string[]
): string => path.join(basePath, ...segments);

export const buildSha256CacheKey = ({
    identity,
    suffix,
    length = 24,
}: BuildSha256CacheKeyInput): string => {
    const payload = suffix ? `${identity}:${suffix}` : identity;
    return crypto.createHash("sha256").update(payload).digest("hex").slice(0, length);
};

export const isPastStaleWindow = (
    timestamp: Date | string | number,
    staleWindowMs: number,
    nowMs = Date.now()
): boolean => new Date(timestamp).getTime() < nowMs - staleWindowMs;

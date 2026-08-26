import { createHash } from "node:crypto";

const UNSIGNED_LASTFM_FIELDS = new Set(["format", "callback"]);

/** Creates the Last.fm MD5 API signature without exposing its signing input. */
export function createLastFmApiSignature(
    parameters: Readonly<Record<string, string>>,
    sharedSecret: string,
): string {
    const signingInput = Object.keys(parameters)
        .filter((key) => !UNSIGNED_LASTFM_FIELDS.has(key))
        .sort()
        .map((key) => `${key}${parameters[key]}`)
        .join("");
    return createHash("md5")
        .update(`${signingInput}${sharedSecret}`, "utf8")
        .digest("hex");
}

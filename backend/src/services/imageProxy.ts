import crypto from "crypto";
import { BRAND_USER_AGENT } from "../config/brand";
import {
    normalizeSafeOutboundUrl,
    resolveSafeOutboundUrl,
    resolveSafeOutboundRedirectTarget,
} from "./outboundUrlSafety";

/**
 * Maximum number of bytes accepted for a proxied external image. Cover art
 * is comfortably below this; anything larger is rejected instead of being
 * buffered into memory (checked against Content-Length when present and
 * enforced while the body is read).
 */
export const MAX_EXTERNAL_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB

/** Result of reading a response body under the external-image byte cap. */
export type BoundedResponseBodyResult =
    | { ok: true; buffer: Buffer }
    | {
          ok: false;
          error: "response_too_large";
          message: "External image exceeds maximum size";
      };

const RESPONSE_TOO_LARGE_RESULT = Object.freeze({
    ok: false,
    error: "response_too_large",
    message: "External image exceeds maximum size",
} as const);

/**
 * Normalizes a remote image URL with the shared outbound safety policy.
 */
export const normalizeExternalImageUrl = (rawUrl: string): string | null =>
    normalizeSafeOutboundUrl(rawUrl);

export type ExternalImageResult =
    | {
          ok: true;
          url: string;
          buffer: Buffer;
          contentType: string | null;
          etag: string;
      }
    | {
          ok: false;
          url: string;
          status: "invalid_url" | "not_found" | "fetch_error";
          message?: string;
      };

type ExternalImageFailure = Extract<ExternalImageResult, { ok: false }>;

async function fetchWithSafeRedirects(options: {
    url: string;
    timeoutMs: number;
    maxRedirects: number;
}): Promise<{ response: Response; finalUrl: string } | ExternalImageFailure> {
    const { url, timeoutMs, maxRedirects } = options;
    let currentUrl = url;

    for (
        let redirectCount = 0;
        redirectCount <= maxRedirects;
        redirectCount += 1
    ) {
        const response = await fetch(currentUrl, {
            headers: {
                "User-Agent": BRAND_USER_AGENT,
            },
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "manual",
        });

        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get("location");
        if (!isRedirect || !location) {
            return { response, finalUrl: currentUrl };
        }
        await response.body?.cancel().catch(() => {});

        const redirectedUrl = new URL(location, currentUrl).toString();
        const normalizedRedirect = await resolveSafeOutboundRedirectTarget(
            location,
            currentUrl,
        );
        if (!normalizedRedirect) {
            return {
                ok: false,
                url: redirectedUrl,
                status: "invalid_url",
                message: "Invalid redirect target",
            };
        }

        currentUrl = normalizedRedirect;
    }

    return {
        ok: false,
        url,
        status: "fetch_error",
        message: "Too many redirects",
    };
}

/**
 * Reads an external-image response body as a stream under a strict byte cap.
 * Oversized bodies return a code-owned error result after the response stream
 * is cancelled; no upstream response details are exposed.
 */
export async function readResponseBodyWithByteCap(
    response: Response,
    maxBytes = MAX_EXTERNAL_IMAGE_BYTES,
): Promise<BoundedResponseBodyResult> {
    if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > MAX_EXTERNAL_IMAGE_BYTES
    ) {
        throw new RangeError("Invalid external image byte cap");
    }

    const rawDeclaredLength = response.headers.get("content-length");
    const declaredLength =
        rawDeclaredLength === null ? null : Number(rawDeclaredLength);
    if (declaredLength !== null && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => {});
        return RESPONSE_TOO_LARGE_RESULT;
    }

    if (!response.body) {
        return { ok: true, buffer: Buffer.alloc(0) };
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
        for (let readCount = 0; readCount <= maxBytes; readCount += 1) {
            const { done, value } = await reader.read();
            if (done) {
                return {
                    ok: true,
                    buffer: Buffer.concat(chunks, totalBytes),
                };
            }
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel().catch(() => {});
                return RESPONSE_TOO_LARGE_RESULT;
            }
            chunks.push(Buffer.from(value));
        }
        await reader.cancel().catch(() => {});
        return RESPONSE_TOO_LARGE_RESULT;
    } finally {
        reader.releaseLock();
    }
}

/**
 * Fetches an external image with SSRF-safe URL/redirect handling, retries on
 * transient failures, and a byte cap (`maxBytes`, default
 * {@link MAX_EXTERNAL_IMAGE_BYTES}) enforced both via Content-Length and while
 * reading the body. Oversized images resolve to `{ ok: false, status:
 * "fetch_error" }` rather than throwing.
 */
export async function fetchExternalImage(options: {
    url: string;
    timeoutMs?: number;
    maxRedirects?: number;
    maxRetries?: number;
    maxBytes?: number;
}): Promise<ExternalImageResult> {
    const {
        url,
        timeoutMs = 15000,
        maxRedirects = 3,
        maxRetries = 3,
        maxBytes = MAX_EXTERNAL_IMAGE_BYTES,
    } = options;
    // Resolve-and-validate at the fetch entry point (the sync
    // normalizeExternalImageUrl pre-check used by callers is string-only).
    const safeUrl = await resolveSafeOutboundUrl(url);

    if (!safeUrl) {
        return {
            ok: false,
            url,
            status: "invalid_url",
            message: "Invalid or private URL",
        };
    }

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
            const redirectResult = await fetchWithSafeRedirects({
                url: safeUrl,
                timeoutMs,
                maxRedirects,
            });

            if ("ok" in redirectResult) {
                return redirectResult;
            }

            const { response, finalUrl } = redirectResult;

            if (response.status === 404) {
                await response.body?.cancel().catch(() => {});
                return {
                    ok: false,
                    url: finalUrl,
                    status: "not_found",
                };
            }

            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                const message = `${response.status} ${response.statusText}`;
                if (response.status >= 500 && attempt < maxRetries) {
                    await new Promise((resolve) =>
                        setTimeout(
                            resolve,
                            Math.min(500 * 2 ** (attempt - 1), 4000),
                        ),
                    );
                    continue;
                }
                return {
                    ok: false,
                    url: finalUrl,
                    status: "fetch_error",
                    message,
                };
            }

            const bodyResult = await readResponseBodyWithByteCap(
                response,
                maxBytes,
            );
            if (!bodyResult.ok) {
                return {
                    ok: false,
                    url: finalUrl,
                    status: "fetch_error",
                    message: bodyResult.message,
                };
            }
            const { buffer } = bodyResult;
            const contentType = response.headers.get("content-type");
            const etag = crypto.createHash("md5").update(buffer).digest("hex");

            return {
                ok: true,
                url: finalUrl,
                buffer,
                contentType,
                etag,
            };
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                await new Promise((resolve) =>
                    setTimeout(
                        resolve,
                        Math.min(500 * 2 ** (attempt - 1), 4000),
                    ),
                );
                continue;
            }
        }
    }

    return {
        ok: false,
        url: safeUrl,
        status: "fetch_error",
        message:
            lastError instanceof Error
                ? lastError.message
                : "Unknown fetch error",
    };
}
